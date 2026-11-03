#!/usr/bin/env node
/**
 * dsh-paper-reader test harness — zero-dependency static server.
 *
 * Serves the plugin's source files to a plain browser so the client chunks can
 * be exercised without the DSH Host/GUI (whose `/` needs auth). Route map:
 *
 *   /lib/*       -> dsh-paper-reader/lib/*        (chunk sources, index.js)
 *   /vendor/*    -> dsh-paper-reader/vendor/*     (PDF.js 6.3.289 + assets)
 *   /harness/*   -> dsh-paper-reader/harness/*    (shim, UMD React, pages)
 *   /fixtures/*  -> dsh-paper-reader/fixtures/*   (test PDFs and bad files)
 *   /            -> /harness/index.html           (manual scenario index)
 *
 * Everything else is a 404. Only GET/HEAD are answered; responses are
 * `no-store` so an edited chunk is picked up on the next page load (the HMR
 * analogue). Binds loopback only.
 *
 * Usage:
 *   node harness/serve.mjs [--port 7812] [--quiet]
 *   PORT=7812 node harness/serve.mjs
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HARNESS_DIR, '..');
export const DEFAULT_PORT = 7812;
export const DEFAULT_HOST = '127.0.0.1';

/** Extension -> Content-Type. `text/javascript` is required for .mjs dynamic import. */
const MIME = new Map(Object.entries({
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.icc': 'application/octet-stream',
}));

/** URL prefix -> absolute directory. Longest prefix wins (none overlap here). */
const ROUTES = [
  { prefix: '/lib/', dir: path.join(PROJECT_ROOT, 'lib') },
  { prefix: '/vendor/', dir: path.join(PROJECT_ROOT, 'vendor') },
  { prefix: '/harness/', dir: HARNESS_DIR },
  { prefix: '/fixtures/', dir: path.join(PROJECT_ROOT, 'fixtures') },
];

/**
 * Resolve a URL pathname to a file under the routed directory, or null.
 * @param {string} pathname decoded URL pathname
 * @returns {Promise<{file: string, mime: string} | null>}
 */
async function resolveFile(pathname) {
  const route = ROUTES.find((candidate) => pathname.startsWith(candidate.prefix));
  if (route === undefined) return null;
  const relative = decodeURIComponent(pathname.slice(route.prefix.length));
  if (relative === '' || relative.includes('\0')) return null;
  const candidate = path.resolve(route.dir, relative);
  const root = await realpath(route.dir).catch(() => path.resolve(route.dir));
  const real = await realpath(candidate).catch(() => null);
  // Reject path traversal and symlinks escaping the routed directory.
  if (real === null || (real !== root && !real.startsWith(root + path.sep))) return null;
  const info = await stat(real).catch(() => null);
  if (info === null || !info.isFile()) return null;
  const mime = MIME.get(path.extname(real).toLowerCase()) ?? 'application/octet-stream';
  return { file: real, mime, size: info.size };
}

/**
 * Build the harness HTTP server (does not listen).
 * @param {{quiet?: boolean}} [options]
 * @returns {import('node:http').Server}
 */
export function createHarnessServer(options = {}) {
  const quiet = options.quiet === true;
  return createServer(async (request, response) => {
    const started = process.hrtime.bigint();
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? DEFAULT_HOST}`);
    let status = 500;
    const finish = () => {
      if (quiet) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      process.stderr.write(`[harness] ${request.method} ${url.pathname} ${status} ${ms.toFixed(1)}ms\n`);
    };
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        status = 405;
        response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        response.end('method not allowed\n');
        return;
      }
      if (url.pathname === '/' || url.pathname === '/harness' || url.pathname === '/harness/') {
        status = 302;
        response.writeHead(302, { location: '/harness/index.html', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      const resolved = await resolveFile(url.pathname);
      if (resolved === null) {
        status = 404;
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`404 not found: ${url.pathname}\n`);
        return;
      }
      status = 200;
      response.writeHead(200, {
        'content-type': resolved.mime,
        'content-length': String(resolved.size),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        // PDF.js worker / wasm are same-origin; COEP off keeps things simple.
        'x-content-type-options': 'nosniff',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(resolved.file);
      stream.on('error', (error) => {
        process.stderr.write(`[harness] stream error ${resolved.file}: ${error.message}\n`);
        response.destroy(error);
      });
      stream.pipe(response);
    } catch (error) {
      status = 500;
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(`500 harness server error: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      response.on('finish', finish);
      response.on('close', finish);
    }
  });
}

/**
 * Start the harness server on a loopback port.
 * @param {{port?: number, host?: string, quiet?: boolean}} [options]
 * @returns {Promise<{server: import('node:http').Server, origin: string, port: number, close: () => Promise<void>}>}
 */
export async function startHarnessServer(options = {}) {
  const port = options.port ?? (process.env.PORT !== undefined ? Number(process.env.PORT) : DEFAULT_PORT);
  const host = options.host ?? DEFAULT_HOST;
  const server = createHarnessServer({ quiet: options.quiet ?? false });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    server,
    port: actualPort,
    origin: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** True when this module is the process entry (`node harness/serve.mjs`). */
function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet') || process.env.HARNESS_QUIET === '1';
  const portFlag = argv.indexOf('--port');
  const requestedPort = portFlag >= 0 ? Number(argv[portFlag + 1]) : undefined;
  if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 0)) {
    process.stderr.write(`dsh-paper-reader harness: invalid --port ${argv[portFlag + 1]}\n`);
    process.exit(2);
  }
  const started = await startHarnessServer({ port: requestedPort, quiet });
  process.stdout.write(`dsh-paper-reader harness: ${started.origin}/  (ctrl-c to stop)\n`);
  const shutdown = () => {
    started.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
