/**
 * SDIS Database Migration Runner
 *
 * Applies migrations in order (forward-only doctrine: there are no down
 * migrations — corrections ship as new forward migrations), tracks applied
 * migrations with SHA-256 checksums, and refuses to run when an
 * already-applied migration file was modified after the fact.
 */

import { getDatabase, Database } from './database';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface Migration {
  readonly id: string;
  readonly filename: string;
  readonly sql: string;
}

/** Raised when an applied migration file changed after application (DB-02). */
export class MigrationChecksumMismatchError extends Error {
  constructor(
    readonly migrationId: string,
    readonly filename: string,
  ) {
    super(
      `Migration ${migrationId} (${filename}) was modified after it was applied; ` +
        `history is immutable — ship a new forward migration instead`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

function sha256Hex(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export class MigrationRunner {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async ensureMigrationsTable(): Promise<void> {
    await this.db.query(`
            CREATE SCHEMA IF NOT EXISTS sdis;
            CREATE TABLE IF NOT EXISTS sdis.schema_migrations (
                id              TEXT PRIMARY KEY,
                filename        TEXT NOT NULL,
                applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                checksum        TEXT NOT NULL
            );
        `);
  }

  async getAppliedMigrations(): Promise<Set<string>> {
    await this.ensureMigrationsTable();
    const result = await this.db.query(
      'SELECT id FROM sdis.schema_migrations ORDER BY applied_at',
    );
    return new Set(result.rows.map((r) => r.id));
  }

  async getPendingMigrations(
    migrationsDir: string = join(process.cwd(), 'db', 'migrations'),
  ): Promise<Migration[]> {
    const applied = await this.getAppliedMigrations();
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending: Migration[] = [];
    for (const file of files) {
      const id = file.split('_')[0] ?? '';
      if (!applied.has(id)) {
        const sql = readFileSync(join(migrationsDir, file), 'utf-8');
        pending.push({ id, filename: file, sql });
      }
    }
    return pending;
  }

  async applyMigration(migration: Migration): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(migration.sql);

      // Record migration
      const checksum = sha256Hex(migration.sql);
      await client.query(
        'INSERT INTO sdis.schema_migrations (id, filename, checksum) VALUES ($1, $2, $3)',
        [migration.id, migration.filename, checksum],
      );
    });
  }

  /**
   * Verifies every already-applied migration file still matches its recorded
   * checksum (DB-02). History is immutable: any post-application edit aborts
   * the run before any new migration applies.
   */
  async verifyAppliedChecksums(
    migrationsDir: string = join(process.cwd(), 'db', 'migrations'),
  ): Promise<void> {
    await this.ensureMigrationsTable();
    const stored = await this.db.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM sdis.schema_migrations',
    );
    const recorded = new Map(stored.rows.map((row) => [row.id, row.checksum]));
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const id = file.split('_')[0] ?? '';
      const expected = recorded.get(id);
      if (expected === undefined) continue;
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      if (sha256Hex(sql) !== expected) {
        throw new MigrationChecksumMismatchError(id, file);
      }
    }
  }

  async runMigrations(migrationsDir?: string): Promise<number> {
    await this.verifyAppliedChecksums(
      migrationsDir ?? join(process.cwd(), 'db', 'migrations'),
    );
    const pending = await this.getPendingMigrations(migrationsDir);
    let applied = 0;

    for (const migration of pending) {
      console.log(`Applying migration ${migration.id}: ${migration.filename}`);
      await this.applyMigration(migration);
      applied++;
    }

    console.log(`Applied ${applied} migrations`);
    return applied;
  }

  async rollbackMigration(migrationId: string): Promise<void> {
    // Forward-only doctrine: there are no down migrations and none are
    // planned. Corrections ship as new forward migrations (see module docs).
    throw new Error(
      `Rollback not implemented for migration ${migrationId}. Create a forward migration instead.`,
    );
  }

  async getMigrationStatus(): Promise<
    { id: string; filename: string; applied_at: Date; checksum: string }[]
  > {
    await this.ensureMigrationsTable();
    const result = await this.db.query(
      'SELECT id, filename, applied_at, checksum FROM sdis.schema_migrations ORDER BY applied_at',
    );
    return result.rows;
  }
}

export async function runMigrations(db?: Database): Promise<void> {
  const runner = new MigrationRunner(db);
  await runner.runMigrations();
}
