/**
 * dsh-paper-reader — Host half.
 *
 * The reader itself is a Client-only React plugin. The Host half exists for
 * one reason: PDF.js must run as an ES module + module Worker, so its static
 * files cannot ride inside the lazy Client bundle factory. This plugin serves
 * the vendored PDF.js distribution from its own package directory over a
 * loopback HTTP route that the Client half loads on demand:
 *
 *   GET /paper-reader/vendor/pdf.mjs          — PDF.js ES module (main thread)
 *   GET /paper-reader/vendor/pdf.worker.mjs   — PDF.js worker module
 *   GET /paper-reader/vendor/standard_fonts/* — base-14 font data
 *   GET /paper-reader/vendor/cmaps/*          — CJK cmaps
 *   GET /paper-reader/vendor/wasm/*, iccs/*   — optional decoders
 *
 * The route lives under `/paper-reader/` (mirroring dsh-better-sidebar's
 * `/sidebar/*` route convention) and is guarded against path traversal.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR_DIR = join(PACKAGE_ROOT, 'vendor');
const ROUTE_PREFIX = '/paper-reader/vendor';

/** Required Host services. */
export const inject = ['webServer'];

/** Extension → Content-Type; unknown extensions fall back to octet-stream. */
const MIME = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Resolve a request pathname under the vendor directory.
 * @param pathname - URL pathname starting with ROUTE_PREFIX.
 * @returns absolute path, or undefined when the request escapes the vendor root.
 */
function resolveVendorPath(pathname) {
  const rel = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length)).replace(/^\/+/, '');
  if (rel === '' || rel.includes('\0')) return undefined;
  const candidate = resolve(VENDOR_DIR, normalize(rel));
  const root = resolve(VENDOR_DIR);
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  return candidate;
}

/**
 * Serve one vendor file. GET and HEAD only; directories are refused.
 * @param req - Node request.
 * @param res - Node response.
 */
async function handleVendorRequest(req, res) {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const file = resolveVendorPath(pathname);
  if (file === undefined) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers = {
    'content-type': type,
    'content-length': String(info.size),
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  };
  if (method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  await new Promise((done) => {
    const stream = createReadStream(file);
    stream.on('error', () => {
      res.destroy();
      done();
    });
    stream.on('end', done);
    stream.pipe(res);
  });
}

/**
 * Host plugin body: own the vendor route for this fiber's lifetime.
 * @param ctx - Host context carrying the web server.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handleVendorRequest(req, res).catch((error) => {
            ctx.logger?.debug?.('paper-reader: vendor route failed', error);
            try {
              if (!res.headersSent) res.writeHead(500);
              res.end();
            } catch {
              /* response already gone */
            }
          });
        },
      }),
    'paper-reader: /paper-reader/vendor route',
  );
}
