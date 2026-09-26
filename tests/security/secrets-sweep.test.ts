/**
 * Security sweep: the repository must not contain credentials, private keys,
 * tokens, or real-world secret material outside ignored paths.
 *
 * Patterns are assembled from fragments so this file's own source never matches
 * the patterns it checks for.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const MAX_BYTES = 1024 * 1024;

const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(['-----BEGIN ', '[A-Z ]*', 'PRIVATE KEY-', '----'].join('')), // private keys
  new RegExp(['gh[pousr]_', '[A-Za-z0-9]{36,}'].join('')), // GitHub tokens
  new RegExp(['AKIA', '[0-9A-Z]{16}'].join('')), // AWS access keys
  new RegExp(['xox[baprs]-', '[A-Za-z0-9-]{10,}'].join('')), // Slack tokens
  new RegExp(['sk_live_', '[A-Za-z0-9]{16,}'].join('')), // Stripe live keys
  new RegExp(['AIza', '[0-9A-Za-z_-]{35}'].join('')), // Google API keys
];

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('security: repository secret sweep', () => {
  it('contains no credential material', () => {
    const files = walk(REPO_ROOT);
    assert.ok(files.length > 0, 'repository must contain files to sweep');
    const hits: string[] = [];
    for (const file of files) {
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size > MAX_BYTES) continue;
      const content = readFileSync(file, 'utf8');
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          hits.push(`${file} matched ${pattern}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });
});
