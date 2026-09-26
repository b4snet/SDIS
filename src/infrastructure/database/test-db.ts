/**
 * SDIS Test Database Setup
 *
 * Provides a disposable PostgreSQL instance for testing.
 * Uses embedded-postgres for local development.
 */

import EmbeddedPostgres from 'embedded-postgres';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Database, setDatabaseInstance } from './database';
import { runMigrations } from './migrations';

let pgInstance: EmbeddedPostgres | null = null;
let pgProcessPid: number | undefined;
let testDb: Database | null = null;

export interface TestDbConfig {
  port?: number;
  persistent?: boolean;
}

async function waitForPostgres(instance: EmbeddedPostgres, port: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = instance.getPgClient('postgres');
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`PostgreSQL on port ${port} did not become ready`, {
    cause: lastError,
  });
}

export async function setupTestDatabase(config: TestDbConfig = {}): Promise<Database> {
  const port = config.port || 55433;
  const persistent = config.persistent || false;

  // Self-heal: a crashed prior run can leave a non-empty data directory behind,
  // which makes initdb refuse to start ("directory exists but is not empty").
  const dataDir = `./tmp/pg-test-${port}`;
  rmSync(dataDir, { recursive: true, force: true });

  pgInstance = new EmbeddedPostgres({
    port,
    databaseDir: dataDir,
    user: 'postgres',
    password: 'password',
    persistent,
    onLog: (message) => console.log(`[PG] ${message}`),
    onError: (error) => console.error(`[PG ERROR] ${error}`),
  });

  await pgInstance.initialise();
  await pgInstance.start();
  await waitForPostgres(pgInstance, port);
  // Remember the postmaster pid for the hard-kill fallback in teardown:
  // `embedded-postgres.stop()` registers its 'exit' listener AFTER the child
  // may already be gone, and can then never resolve — a wedged child would
  // hang the whole serial `node --test` run.
  pgProcessPid = (pgInstance as unknown as { process?: { pid?: number } }).process?.pid;

  // Create test database
  const client = pgInstance.getPgClient('postgres');
  try {
    await client.connect();
    await client.query('CREATE DATABASE sdis_test;').catch(() => {}); // Ignore if exists
  } finally {
    await client.end();
  }

  // Connect to test database
  const testDbConfig = {
    host: 'localhost',
    port,
    database: 'sdis_test',
    user: 'postgres',
    password: 'password',
    max: 10,
  };

  testDb = new Database(testDbConfig);
  setDatabaseInstance(testDb);

  // Run migrations
  await runMigrations(testDb);

  // Seed test data
  await seedTestData(testDb);

  return testDb;
}

export async function seedTestData(db: Database): Promise<void> {
  // The seed data will be inserted via the seed file
  const { readFileSync } = await import('fs');
  const { join } = await import('path');

  const seedPath = join(process.cwd(), 'db', 'seeds', '001_dev_seed.sql');
  const seedSql = readFileSync(seedPath, 'utf-8');

  await db.query(seedSql);
}

export async function teardownTestDatabase(): Promise<void> {
  if (testDb) {
    await testDb.close();
    testDb = null;
  }
  if (pgInstance) {
    const pid = pgProcessPid;
    let timer: NodeJS.Timeout | undefined;
    try {
      // Bound the teardown: if embedded-postgres.stop() cannot resolve (the
      // child already exited before its 'exit' listener was registered, or
      // taskkill hangs on locked files), force-kill the postmaster so the
      // serial test runner never wedges on a stuck child.
      await Promise.race([
        pgInstance.stop(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (pid) {
              spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
                stdio: 'ignore',
              });
            }
            resolve();
          }, 30000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      pgProcessPid = undefined;
      pgInstance = null;
    }
  }
  setDatabaseInstance(null as any);
}

export function getTestDb(): Database | null {
  return testDb;
}

// Jest-style setup/teardown helpers for Node test runner
export const testDbSetup = {
  async setup(): Promise<Database> {
    return setupTestDatabase();
  },
  async teardown(): Promise<void> {
    await teardownTestDatabase();
  },
};
