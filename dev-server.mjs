/**
 * Ignite Business Manager — local dev server.
 *
 * Runs the REAL worker.js against Node-backed shims for the Cloudflare bindings,
 * so local testing exercises the exact production code path:
 *   - PORTAL_KV -> a file-backed key/value store (.data/kv.json), TTL-aware
 *   - ASSETS    -> serves files from ./public
 *
 * Why not wrangler? Its bundled `workerd` has no Windows-ARM64 build. Node 24 has
 * everything the worker needs globally (crypto.subtle, Request/Response, URL).
 *
 * Usage:  npm run dev   ->  http://localhost:8788
 * Reset local data:  delete the .data/ folder.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, normalize } from 'node:path';
import worker from './worker.js';

const PORT = process.env.PORT || 8788;
const PUBLIC_DIR = './public';
const DATA_DIR = './.data';
const KV_FILE = join(DATA_DIR, 'kv.json');

/* ------------------------------- KV shim ---------------------------------- */
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
let store = {};
try { store = JSON.parse(readFileSync(KV_FILE, 'utf8')); } catch {}
let saveTimer = null;
function saveKV() { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeFileSync(KV_FILE, JSON.stringify(store)), 40); }

const PORTAL_KV = {
  async get(key) {
    const e = store[key];
    if (!e) return null;
    if (e.exp && Date.now() > e.exp) { delete store[key]; saveKV(); return null; }
    return e.v;
  },
  async put(key, val, opts = {}) {
    store[key] = { v: String(val), exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 };
    saveKV();
  },
  async delete(key) { delete store[key]; saveKV(); },
  async list({ prefix = '' } = {}) {
    const keys = Object.keys(store).filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
    return { keys, list_complete: true, cursor: null };
  },
};

/* ----------------------------- ASSETS shim -------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp',
};
const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    // Prevent path traversal.
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (existsSync(file) && !file.endsWith('\\') && !file.endsWith('/')) {
      try {
        const data = readFileSync(file);
        const ext = file.slice(file.lastIndexOf('.'));
        return new Response(data, { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
      } catch {}
    }
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  },
};

/* ------------------------------ HTTP server ------------------------------- */
createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const response = await worker.fetch(request, { PORTAL_KV, ASSETS });
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'dev server error', detail: String(err && err.stack || err) }));
  }
}).listen(PORT, () => {
  console.log(`\n  Ignite Business Manager — dev server`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  Local data: ${KV_FILE}  (delete .data/ to reset)\n`);
});
