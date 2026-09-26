#!/usr/bin/env node
/**
 * SDIS preview server (dependency-free, node:http only).
 *
 * Serves exactly two read-only trees of the repository for the Freebuff
 * preview tab — nothing else is exposed:
 *
 *   /preview/*   the hand-maintained project overview page (+ its assets)
 *   /docs/*      the Foundation documentation (raw markdown, text/plain)
 *
 * `/` redirects to /preview/index.html. Loopback-only by binding; no write
 * operations exist. PORT env overrides the default port; the chosen port is
 * recorded in .freebuff/run.md (port notes section).
 *
 * Run:  node preview/server.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// PORT env is honored ONLY when it is a usable positive integer — some
// sandbox environments export PORT=0, which would bind a random ephemeral
// port. 4173 is the recorded preview default (see .freebuff/run.md).
const PORT_ENV = Number(process.env.PORT);
const PORT = Number.isInteger(PORT_ENV) && PORT_ENV > 0 ? PORT_ENV : 4173;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function serveFile(res, absolutePath, contentType) {
  try {
    const body = await readFile(absolutePath);
    send(res, 200, body, contentType);
  } catch {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  const pathname = decodeURIComponent(url.pathname);

  // Exact allowlist: only these two read-only trees exist for the preview.
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { location: '/preview/index.html' });
    res.end();
    return;
  }
  if (pathname === '/preview' || pathname.startsWith('/preview/')) {
    const rel = normalize(pathname.slice('/preview/'.length)).replace(/^([.][.][\\/])+/, '');
    const target = join(REPO_ROOT, 'preview', rel);
    if (!target.startsWith(join(REPO_ROOT, 'preview'))) {
      send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
      return;
    }
    serveFile(res, target, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream');
    return;
  }
  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    const rel = normalize(pathname.slice('/docs/'.length)).replace(/^([.][.][\\/])+/, '');
    const target = join(REPO_ROOT, 'docs', rel);
    if (!target.startsWith(join(REPO_ROOT, 'docs'))) {
      send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
      return;
    }
    serveFile(res, target, MIME[extname(target).toLowerCase()] ?? 'text/plain; charset=utf-8');
    return;
  }
  send(res, 404, 'not found (only /preview/* and /docs/* are served)', 'text/plain; charset=utf-8');
});

server.listen(PORT, HOST, () => {
  const bound = /** @type {{ port: number }} */ (server.address());
  console.log(`SDIS preview: http://${HOST}:${bound.port}/ (requested: ${PORT}, repo root: ${REPO_ROOT})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
