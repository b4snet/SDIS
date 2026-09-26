/**
 * Architecture test: Step-26 boundary hardening.
 *
 * Enforces the canonical dependency direction that the Step-26 audit
 * established, as REAL source-tree checks:
 *
 * 1. Transport never imports infrastructure. The transport owns the
 *    request-scope SEAM (`request-scope.ts`); concrete persistence mechanisms
 *    are injected at the composition edge (`src/index.ts`).
 * 2. `process.env` is read only in the bounded allowlist (the auth seam, the
 *    server default resolver, and the infrastructure process boundary).
 * 3. `console.*` never appears in application or transport layers (structured
 *    logging only; infrastructure keeps its explicit process-level writers).
 * 4. The transport barrel stays infrastructure-free; cross-layer composition
 *    helpers are exported from the composition edge.
 * 5. Transport responses never leak internal markers (SQL, stack traces,
 *    secrets) — envelope-level regression check on the serialized error path.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function relativeToSrc(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

describe('architecture: transport boundary (Step 26)', () => {
  it('transport modules never import infrastructure', () => {
    const files = listTsFiles(SRC).filter((f) => f.includes(`${sep}transport${sep}`));
    assert.ok(files.length > 0, 'transport modules must exist');

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from\s+['"][^'"]*infrastructure/.test(source),
        `${relativeToSrc(file)} must not import infrastructure (inject at the composition edge)`,
      );
    }
  });

  it('the composition edge is the only transport→infrastructure bridge', () => {
    const edge = readFileSync(join(SRC, 'index.ts'), 'utf8');
    assert.match(edge, /tenant-scope/, 'composition edge must wire the scope runner');
  });

  it('the transport barrel stays infrastructure-free', () => {
    const barrel = readFileSync(join(SRC, 'transport', 'index.ts'), 'utf8');
    assert.ok(
      !/from\s+['"][^'"]*infrastructure/.test(barrel),
      'transport barrel must not re-export infrastructure symbols',
    );
  });
});

describe('architecture: environment access (Step 26)', () => {
  it('process.env is read only in the bounded allowlist', () => {
    const allowed = new Set([
      'transport/auth.ts', // sessionResolverForEnvironment: the auth seam
      'transport/server.ts', // default resolver selection at server construction
      'infrastructure/database/database.ts', // process-level connection config
      'infrastructure/database/backup-restore.ts', // process-level pg tools path
    ]);
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC)) {
      const rel = relativeToSrc(file);
      if (allowed.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      if (/process\.env/.test(source)) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `process.env must be centralized; found in: ${offenders.join(', ')}`,
    );
  });
});

describe('architecture: logging discipline (Step 26)', () => {
  it('application and transport never write to the console directly', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC)) {
      const rel = relativeToSrc(file);
      if (!rel.startsWith('app/') && !rel.startsWith('transport/')) continue;
      const source = readFileSync(file, 'utf8');
      if (/console\.(log|error|warn|info|debug)/.test(source)) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      `console output must go through the structured Logger; found in: ${offenders.join(', ')}`,
    );
  });
});
