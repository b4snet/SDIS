/**
 * PostgreSQL readiness probe.
 *
 * Adapts the EXISTING `Database` pool to the provider-neutral
 * `DependencyProbe` port (`src/core/observability/health.ts`). One lightweight
 * `SELECT 1` through the existing pool — no second pool, no new schema, no
 * connection churn. The probe reports only a boolean: SQL text, errors, and
 * credentials never cross this boundary into probe results.
 */

import type { Database } from './database';

export function createPostgresReadinessProbe(db: Database): () => Promise<boolean> {
  return async () => {
    try {
      await db.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  };
}
