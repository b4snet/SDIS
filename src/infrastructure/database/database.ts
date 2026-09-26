/**
 * SDIS PostgreSQL Database Connection Manager
 *
 * Provides connection pooling and transaction management for the PostgreSQL adapters.
 *
 * RLS enforcement (migration 014 + `tenant-scope.ts`): when a request carries a
 * tenant scope, every statement issued through `query`/`transaction` runs as the
 * `sdis_app` role with `sdis.organization_id` / `sdis.facility_id` set, so the
 * database-level row-security policies apply to live requests. Statements
 * without an active scope keep running as the pool role (migrations, seeds,
 * service-level tooling) and are unaffected.
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import { currentTenantScope, type TenantScope } from './tenant-scope';
import { nullMetrics, type MetricsRegistry } from '../../core/observability/metrics';

/**
 * Injects the metrics sink for pool-level failure observability (Step 34).
 * Defaults to a silent registry; the composition edge wires the real one.
 * Infrastructure importing `core/observability` keeps the dependency direction
 * rule (domain never does; core imports nothing but types).
 */
export function setDatabaseMetrics(metrics: MetricsRegistry): void {
  databaseMetrics = metrics;
}

let databaseMetrics: MetricsRegistry = nullMetrics();

export interface DatabaseConfig extends PoolConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export class Database {
  private pool: Pool;
  private config: DatabaseConfig;

  constructor(config?: DatabaseConfig) {
    if (
      config === undefined &&
      process.env['NODE_ENV'] === 'production' &&
      !process.env['PGPASSWORD']
    ) {
      // DB-03: the built-in default password is a local-development
      // convenience. A production process without an explicit password must
      // fail fast instead of silently authenticating with a guessable default.
      throw new Error(
        'Database password is required in production (set PGPASSWORD or pass an explicit config); refusing the built-in default',
      );
    }
    this.config = config || {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'sdis',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'password',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    this.pool = new Pool(this.config);

    // Handle pool errors — counted on the bounded `sdis_dependency_failures_total
    // |postgres` series (Step 34) and logged WITHOUT credentials or SQL text.
    // Provider errors carry driver messages only; they never include the
    // connection string or the configured password.
    this.pool.on('error', (err) => {
      databaseMetrics.observeDependencyFailure('postgres');
      console.error('Unexpected database pool error:', err.message ?? err);
    });
  }

  async connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async query<T = any>(
    text: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const scope = currentTenantScope();
    if (!scope) {
      const client = await this.pool.connect();
      try {
        const result = await client.query(text, params);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      } finally {
        client.release();
      }
    }

    // Tenant-scoped statement: run as sdis_app with both GUCs set, then reset
    // the session before returning the client to the pool (no role/GUC leak).
    const client = await this.pool.connect();
    try {
      await stampSessionContext(client, scope);
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    } finally {
      await clearSessionContext(client);
      client.release();
    }
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const scope = currentTenantScope();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (scope) {
        // Role is session-scoped, so it must be reset after the transaction;
        // the GUCs use set_config(..., local) and roll back automatically.
        await stampLocalContext(client, scope);
      }
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      if (scope) {
        await resetRole(client);
      }
      client.release();
    }
  }

  /**
   * Runs `callback` inside a transaction as the `sdis_app` role with the given
   * tenant context — the explicit scope seam. This is the enforcing form of the
   * original helper: it switches to the application role, so RLS applies, and
   * resets role + GUCs before the client returns to the pool.
   */
  async withTenantContext<T>(
    organizationId: string,
    facilityId: string | null,
    userId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const scope: TenantScope = {
      organizationId,
      facilityId: facilityId ?? '',
      ...(userId ? { userId } : {}),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await stampLocalContext(client, scope);
      if (userId) {
        await client.query(`SELECT set_config('sdis.user_id', $1, true)`, [userId]);
      }
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await resetRole(client);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  getPool(): Pool {
    return this.pool;
  }
}

/**
 * Applies role + tenant GUCs for the whole session (used for single statements
 * where no transaction wraps the statement).
 */
async function stampSessionContext(
  client: PoolClient,
  scope: TenantScope,
): Promise<void> {
  await client.query('SET ROLE sdis_app');
  await client.query(`SELECT set_config('sdis.organization_id', $1, false)`, [
    scope.organizationId,
  ]);
  await client.query(`SELECT set_config('sdis.facility_id', $1, false)`, [
    scope.facilityId,
  ]);
}

/** Session-scope role, transaction-local GUCs (auto-rolled-back at COMMIT). */
async function stampLocalContext(client: PoolClient, scope: TenantScope): Promise<void> {
  await client.query('SET ROLE sdis_app');
  await client.query(`SELECT set_config('sdis.organization_id', $1, true)`, [
    scope.organizationId,
  ]);
  await client.query(`SELECT set_config('sdis.facility_id', $1, true)`, [
    scope.facilityId,
  ]);
}

/** Restores the session role so no borrowed client leaks the app role. */
async function resetRole(client: PoolClient): Promise<void> {
  await client.query('RESET ROLE').catch(() => undefined);
}

/** Clears GUCs and role before returning a client to the pool. */
async function clearSessionContext(client: PoolClient): Promise<void> {
  await client.query('RESET ROLE').catch(() => undefined);
  await client
    .query(`SELECT set_config('sdis.organization_id', '', false)`)
    .catch(() => undefined);
  await client
    .query(`SELECT set_config('sdis.facility_id', '', false)`)
    .catch(() => undefined);
}

// Singleton instance
let dbInstance: Database | null = null;

export function getDatabase(config?: DatabaseConfig): Database {
  if (!dbInstance) {
    dbInstance = new Database(config);
  }
  return dbInstance;
}

export function setDatabaseInstance(db: Database): void {
  dbInstance = db;
}
