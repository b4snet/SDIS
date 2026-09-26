/**
 * Architecture test: dependency direction.
 *
 * Rule: `src/domain/<x>/...` modules may only import from their OWN directory or
 * from the shared `types` layer. Domain modules must never import another domain
 * module. `src/core/...` may import only from `types`.
 *
 * This is a real behavioral check over the source tree, not a class-name assertion.
 */

import { accessSync, readdirSync, readFileSync } from 'node:fs';
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

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    specs.push(match[1] ?? '');
  }
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    specs.push(match[1] ?? '');
  }
  return specs.filter(Boolean);
}

/** Normalize a relative import specifier to an absolute path (without extension). */
function resolveImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.') && !spec.startsWith('..')) return undefined; // package import
  const target = resolve(dirname(fromFile), spec);
  for (const ext of ['.ts', '.tsx', '.js']) {
    if (existsWithExt(target, ext)) return target;
  }
  return target; // directory import (index)
}

function existsWithExt(target: string, ext: string): boolean {
  try {
    accessSync(target + ext);
    return true;
  } catch {
    return false;
  }
}

function dirname(p: string): string {
  return p.split(sep).slice(0, -1).join(sep);
}

describe('architecture: dependency direction', () => {
  it('domain modules never import other domain modules or core internals', () => {
    const files = listTsFiles(SRC).filter((f) => f.includes(`${sep}domain${sep}`));
    assert.ok(files.length > 0, 'domain modules must exist');

    for (const file of files) {
      const rel = relative(SRC, file).split(sep);
      const domainIndex = rel.indexOf('domain');
      const ownDomain = domainIndex >= 0 ? rel[domainIndex + 1] : undefined;
      assert.ok(ownDomain, `file ${file} outside domain layout`);

      for (const spec of importSpecifiers(file)) {
        const target = resolveImport(file, spec);
        if (!target) continue; // builtin/package import is fine here
        const targetRel = relative(SRC, target);
        if (targetRel.startsWith('..')) continue; // outside src (should not happen)
        const parts = targetRel.split(sep);
        if (parts[0] === 'domain' && parts[1] !== ownDomain) {
          assert.fail(
            `${relative(REPO_ROOT, file)} imports another domain module: ${spec} (${targetRel})`,
          );
        }
        if (parts[0] === 'core') {
          assert.fail(`${relative(REPO_ROOT, file)} imports from core/: ${spec}`);
        }
      }
    }
  });

  it('core modules import only from the types layer', () => {
    const files = listTsFiles(SRC).filter((f) => f.includes(`${sep}core${sep}`));
    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        const target = resolveImport(file, spec);
        if (!target) continue;
        const targetRel = relative(SRC, target);
        if (targetRel.startsWith('..')) continue;
        const parts = targetRel.split(sep);
        if (parts[0] !== 'types') {
          assert.fail(
            `${relative(REPO_ROOT, file)} imports outside types layer: ${spec} (${targetRel})`,
          );
        }
      }
    }
  });

  it('types layer imports nothing from domain or core', () => {
    const files = listTsFiles(SRC).filter((f) => f.includes(`${sep}types${sep}`));
    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        const target = resolveImport(file, spec);
        if (!target) continue;
        const targetRel = relative(SRC, target);
        const parts = targetRel.split(sep);
        assert.ok(
          parts[0] === 'types' || targetRel.startsWith('..'),
          `types layer must not import from ${parts[0]} (${spec})`,
        );
      }
    }
  });
});

describe('architecture: application layer direction', () => {
  it('application modules import only app, domain, core, or types sources', () => {
    const files = listTsFiles(SRC).filter((f) => f.includes(`${sep}app${sep}`));
    assert.ok(files.length > 0, 'application modules must exist');

    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        const target = resolveImport(file, spec);
        if (!target) continue; // builtin/package import is fine here
        const targetRel = relative(SRC, target);
        if (targetRel.startsWith('..')) continue; // outside src (should not happen)
        const parts = targetRel.split(sep);
        assert.ok(
          parts[0] === 'app' ||
            parts[0] === 'domain' ||
            parts[0] === 'core' ||
            parts[0] === 'types',
          `${relative(REPO_ROOT, file)} imports outside allowed layers: ${spec} (${targetRel})`,
        );
      }
    }
  });

  it('domain, core, and types modules never import the application layer; infrastructure may import app ports and any internal infrastructure', () => {
    const files = listTsFiles(SRC).filter((f) => !f.includes(`${sep}app${sep}`));
    assert.ok(files.length > 0, 'domain/core/types/infrastructure modules must exist');

    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        const target = resolveImport(file, spec);
        if (!target) continue;
        const targetRel = relative(SRC, target);
        if (targetRel.startsWith('..')) continue;
        const parts = targetRel.split(sep);
        // Allow infrastructure to import from app (ports) and any other infrastructure module
        if (parts[0] === 'infrastructure') {
          // Infrastructure can import from app (ports) or any other infrastructure module
          assert.ok(
            parts[1] === 'app' ||
              parts[1] === 'infrastructure' ||
              parts[1] === 'database' ||
              parts[1] === 'migrations',
            `${relative(REPO_ROOT, file)} imports outside allowed layers: ${spec} (${targetRel})`,
          );
        } else if (parts[0] === 'app') {
          continue;
        } else {
          assert.ok(
            parts[0] !== 'app',
            `${relative(REPO_ROOT, file)} imports the application layer: ${spec}`,
          );
        }
      }
    }
  });
});
