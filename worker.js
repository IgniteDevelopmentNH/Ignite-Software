/**
 * Ignite Business Manager — Cloudflare Worker API + static host
 *
 * One Worker serves the static frontend (public/) AND the JSON API, same origin
 * (no CORS needed for real browser traffic). Data lives in a Cloudflare KV
 * namespace bound as PORTAL_KV (see wrangler.toml). Modeled on the BlueLine
 * portal stack: single worker.js, KV storage, PBKDF2 password hashing, bearer
 * session tokens, static assets via the [assets] binding.
 *
 * Internal tool for the two owners of Ignite Development LLC — everything is
 * behind an owner login (no public/client role).
 *
 * KV layout:
 *   user:<email>        -> { name, email, salt, hash, iterations }
 *   session:<token>     -> email                         (TTL'd, 30 days)
 *   rl:<scope>:<ip>     -> { count, windowStart }         (TTL'd, rate limiting)
 *   prospect:<id>       -> prospect record
 *   task:<id>           -> task record
 *   event:<id>          -> calendar event record
 *   txn:<id>            -> financial transaction (money in integer cents)
 *   invoice:<id>        -> invoice record
 *   asset:<id>          -> asset record
 *
 * Money is always stored as an integer number of cents. Financial records
 * (transactions, invoices, assets) and CRM records are ARCHIVED (archived:true),
 * never hard-deleted; calendar events are hard-deleted.
 *
 * Endpoints (all /api/* except register/login require Authorization: Bearer):
 *   POST   /api/register             { name, email, password }  (allowlisted emails only)
 *   POST   /api/login                { email, password } -> { token, name, email }
 *   POST   /api/logout
 *   GET    /api/me
 *   GET    /api/dashboard
 *   GET    /api/search?q=
 *   GET|POST         /api/prospects           GET|PATCH|DELETE /api/prospects/:id
 *   GET|POST         /api/tasks               GET|PATCH|DELETE /api/tasks/:id
 *   GET|POST         /api/events              GET|PATCH|DELETE /api/events/:id
 *   GET|POST         /api/transactions        GET|PATCH|DELETE /api/transactions/:id
 *   GET|POST         /api/invoices            GET|PATCH|DELETE /api/invoices/:id
 *   GET|POST         /api/assets              GET|PATCH|DELETE /api/assets/:id
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITERATIONS = 100000;

// Only these emails may create an account (each once). Set OWNER_EMAILS in
// Cloudflare (comma-separated) to override without editing source.
const DEFAULT_OWNER_EMAILS = [
  'will@ignitedevelopment.net',
  'josh@ignitedevelopment.net',
  'contact@ignitedevelopment.net',
];

const RATE_LIMITS = {
  login: [10, 300], // 10 attempts / 5 min per IP
  register: [5, 3600], // 5 new accounts / hour per IP
};

/* ------------------------------- responses -------------------------------- */

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function resolveCorsOrigin(request, url, env) {
  const reqOrigin = request.headers.get('Origin');
  if (!reqOrigin) return null; // same-origin or non-browser
  const allowed = new Set([url.origin]);
  if (env.ALLOWED_ORIGIN) {
    for (const o of env.ALLOWED_ORIGIN.split(',')) {
      const t = o.trim();
      if (t) allowed.add(t);
    }
  }
  return allowed.has(reqOrigin) ? reqOrigin : null;
}

function json(data, status = 200, cors = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(cors) },
  });
}

/* ---------------------------- rate limiting ------------------------------- */

async function checkRateLimit(env, scope, ip) {
  const [limit, windowSec] = RATE_LIMITS[scope];
  const key = `rl:${scope}:${ip}`;
  const now = Date.now();
  let rec = null;
  try {
    const raw = await env.PORTAL_KV.get(key);
    if (raw) rec = JSON.parse(raw);
  } catch {}
  if (!rec || now - rec.windowStart >= windowSec * 1000) {
    rec = { count: 1, windowStart: now };
    await env.PORTAL_KV.put(key, JSON.stringify(rec), { expirationTtl: windowSec });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count += 1;
  const remaining = Math.max(1, windowSec - Math.floor((now - rec.windowStart) / 1000));
  await env.PORTAL_KV.put(key, JSON.stringify(rec), { expirationTtl: remaining });
  return true;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/* ------------------------------ crypto ------------------------------------ */

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes.buffer;
}
async function hashPassword(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBuf(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufToHex(derived);
}
function randomHex(byteLength) {
  return bufToHex(crypto.getRandomValues(new Uint8Array(byteLength)).buffer);
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function ownerEmails(env) {
  const raw = (env && env.OWNER_EMAILS) || '';
  const list = raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return new Set(list.length ? list : DEFAULT_OWNER_EMAILS);
}

/* --------------------------------- auth ----------------------------------- */

async function getSessionEmail(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return env.PORTAL_KV.get(`session:${m[1]}`);
}

async function handleRegister(request, env, cors) {
  if (!(await checkRateLimit(env, 'register', clientIp(request)))) {
    return json({ error: 'Too many attempts. Please try again later.' }, 429, cors);
  }
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { name, email, password } = body;
  if (!name || !isValidEmail(email) || !password || password.length < 8) {
    return json({ error: 'Name, a valid email, and a password of at least 8 characters are required.' }, 400, cors);
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!ownerEmails(env).has(normalizedEmail)) {
    return json({ error: 'This email is not authorized for an account.' }, 403, cors);
  }
  if (await env.PORTAL_KV.get(`user:${normalizedEmail}`)) {
    return json({ error: 'An account with this email already exists. Just log in.' }, 409, cors);
  }
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  await env.PORTAL_KV.put(
    `user:${normalizedEmail}`,
    JSON.stringify({ name, email: normalizedEmail, salt, hash, iterations: PBKDF2_ITERATIONS })
  );
  const token = randomHex(32);
  await env.PORTAL_KV.put(`session:${token}`, normalizedEmail, { expirationTtl: SESSION_TTL_SECONDS });
  return json({ token, name, email: normalizedEmail }, 201, cors);
}

async function handleLogin(request, env, cors) {
  if (!(await checkRateLimit(env, 'login', clientIp(request)))) {
    return json({ error: 'Too many login attempts. Please try again later.' }, 429, cors);
  }
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
  const { email, password } = body;
  if (!isValidEmail(email) || !password) return json({ error: 'Email and password are required.' }, 400, cors);
  const normalizedEmail = email.trim().toLowerCase();
  const userRaw = await env.PORTAL_KV.get(`user:${normalizedEmail}`);
  if (!userRaw) return json({ error: 'Invalid email or password.' }, 401, cors);
  const user = JSON.parse(userRaw);
  const attempted = await hashPassword(password, user.salt, user.iterations);
  if (!timingSafeEqual(attempted, user.hash)) return json({ error: 'Invalid email or password.' }, 401, cors);
  const token = randomHex(32);
  await env.PORTAL_KV.put(`session:${token}`, normalizedEmail, { expirationTtl: SESSION_TTL_SECONDS });
  return json({ token, name: user.name, email: normalizedEmail }, 200, cors);
}

async function handleLogout(request, env, cors) {
  const authHeader = request.headers.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) await env.PORTAL_KV.delete(`session:${m[1]}`);
  return json({ ok: true }, 200, cors);
}

async function handleMe(email, env, cors) {
  const userRaw = await env.PORTAL_KV.get(`user:${email}`);
  const user = userRaw ? JSON.parse(userRaw) : { email };
  return json({ email, name: user.name || email }, 200, cors);
}

/* --------------------------- KV entity plumbing --------------------------- */

// Small business => small data; list keys then fetch values. Fine at this scale.
async function listEntity(env, prefix) {
  const out = [];
  let cursor;
  do {
    const res = await env.PORTAL_KV.list({ prefix, cursor });
    const values = await Promise.all(res.keys.map((k) => env.PORTAL_KV.get(k.name)));
    for (const v of values) {
      if (!v) continue;
      try { out.push(JSON.parse(v)); } catch {}
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}
async function getEntity(env, prefix, id) {
  const raw = await env.PORTAL_KV.get(`${prefix}${id}`);
  return raw ? JSON.parse(raw) : null;
}
async function putEntity(env, prefix, rec) {
  await env.PORTAL_KV.put(`${prefix}${rec.id}`, JSON.stringify(rec));
  return rec;
}
function genId() {
  return `${Date.now().toString(36)}${randomHex(4)}`;
}
function nowISO() {
  return new Date().toISOString();
}

/* ------------------------------ normalizers ------------------------------- */
// Coerce/sanitize an incoming body into a stored record. Internal tool: we
// trust the two owners but still clamp types so the frontend/reports stay sane.

function str(v, max = 2000) {
  return v == null ? '' : String(v).slice(0, max);
}
function cents(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}
function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

const TXN_TYPES = ['revenue', 'expense', 'asset', 'contribution', 'distribution'];
const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue'];

// Prospects: name, company, contact, business location, business type, service (what they'd need).
function normalizeProspect(body, existing) {
  const base = existing || { id: genId(), createdAt: nowISO(), archived: false };
  return {
    ...base,
    name: str(body.name ?? base.name, 200),
    company: str(body.company ?? base.company, 200),
    contact: str(body.contact ?? base.contact, 200),
    location: str(body.location ?? base.location, 200),
    businessType: str(body.businessType ?? base.businessType, 200),
    service: str(body.service ?? base.service, 200),
    archived: typeof body.archived === 'boolean' ? body.archived : base.archived,
    updatedAt: nowISO(),
  };
}

const CLIENT_STATUSES = ['active', 'inactive'];

// Clients: name, company, contact, service (what we do for them), status.
function normalizeClient(body, existing) {
  const base = existing || { id: genId(), createdAt: nowISO(), archived: false };
  return {
    ...base,
    name: str(body.name ?? base.name, 200),
    company: str(body.company ?? base.company, 200),
    contact: str(body.contact ?? base.contact, 200),
    service: str(body.service ?? base.service, 200),
    status: oneOf(body.status ?? base.status, CLIENT_STATUSES, base.status || 'active'),
    archived: typeof body.archived === 'boolean' ? body.archived : base.archived,
    updatedAt: nowISO(),
  };
}

// Tasks: task, person responsible (Board columns key off this), due date,
// priority (low/medium/high), done/not.
function normalizeTask(body, existing) {
  const base = existing || { id: genId(), createdAt: nowISO(), archived: false };
  return {
    ...base,
    title: str(body.title ?? base.title, 300),
    owner: str(body.owner ?? base.owner, 200),
    due: str(body.due ?? base.due, 40),
    priority: oneOf(body.priority ?? base.priority, ['low', 'medium', 'high'], 'medium'),
    status: oneOf(body.status ?? base.status, ['todo', 'done'], 'todo'),
    archived: typeof body.archived === 'boolean' ? body.archived : base.archived,
    updatedAt: nowISO(),
  };
}

// A meeting-prep checklist item: { text, done }.
function normalizePrep(list, existing) {
  const src = Array.isArray(list) ? list : existing;
  if (!Array.isArray(src)) return [];
  return src.slice(0, 100).map((it) => ({
    text: str(it && it.text, 500),
    done: !!(it && it.done),
  })).filter((it) => it.text);
}

function normalizeEvent(body, existing) {
  const base = existing || { id: genId(), createdAt: nowISO() };
  return {
    ...base,
    title: str(body.title ?? base.title, 300),
    start: str(body.start ?? base.start, 40),
    end: str(body.end ?? base.end, 40),
    allDay: typeof body.allDay === 'boolean' ? body.allDay : !!base.allDay,
    location: str(body.location ?? base.location, 300),
    prospectId: str(body.prospectId ?? base.prospectId, 40),
    prep: normalizePrep(body.prep, base.prep),
    notes: str(body.notes ?? base.notes, 5000),
    updatedAt: nowISO(),
  };
}

function normalizeTransaction(body, existing) {
  const base = existing || { id: genId(), createdAt: nowISO(), archived: false };
  return {
    ...base,
    type: oneOf(body.type ?? base.type, TXN_TYPES, 'expense'),
    amountCents: body.amountCents != null ? Math.abs(cents(body.amountCents)) : Math.abs(base.amountCents || 0),
    date: str(body.date ?? base.date, 40) || nowISO().slice(0, 10),
    category: str(body.category ?? base.category, 120),
    description: str(body.description ?? base.description, 1000),
    owner: str(body.owner ?? base.owner, 200),
    prospectId: str(body.prospectId ?? base.prospectId, 40),
    archived: typeof body.archived === 'boolean' ? body.archived : base.archived,
    updatedAt: nowISO(),
  };
}

function normalizeInvoice(body, existing) {
  const base = existing || { id: genId(), createdAt: nowISO(), archived: false };
  return {
    ...base,
    number: str(body.number ?? base.number, 60),
    client: str(body.client ?? base.client, 200),
    amountCents: body.amountCents != null ? Math.abs(cents(body.amountCents)) : Math.abs(base.amountCents || 0),
    status: oneOf(body.status ?? base.status, INVOICE_STATUSES, 'draft'),
    issueDate: str(body.issueDate ?? base.issueDate, 40),
    dueDate: str(body.dueDate ?? base.dueDate, 40),
    paidDate: str(body.paidDate ?? base.paidDate, 40),
    notes: str(body.notes ?? base.notes, 2000),
    archived: typeof body.archived === 'boolean' ? body.archived : base.archived,
    updatedAt: nowISO(),
  };
}

function normalizeAsset(body, existing) {
  const base = existing || { id: genId(), createdAt: nowISO(), archived: false };
  return {
    ...base,
    name: str(body.name ?? base.name, 200),
    category: str(body.category ?? base.category, 120),
    purchaseCents: body.purchaseCents != null ? Math.abs(cents(body.purchaseCents)) : Math.abs(base.purchaseCents || 0),
    purchaseDate: str(body.purchaseDate ?? base.purchaseDate, 40),
    notes: str(body.notes ?? base.notes, 2000),
    archived: typeof body.archived === 'boolean' ? body.archived : base.archived,
    updatedAt: nowISO(),
  };
}

const ENTITIES = {
  clients: { prefix: 'client:', normalize: normalizeClient, key: 'clients', hardDelete: false },
  prospects: { prefix: 'prospect:', normalize: normalizeProspect, key: 'prospects', hardDelete: false },
  tasks: { prefix: 'task:', normalize: normalizeTask, key: 'tasks', hardDelete: false },
  events: { prefix: 'event:', normalize: normalizeEvent, key: 'events', hardDelete: true },
  transactions: { prefix: 'txn:', normalize: normalizeTransaction, key: 'transactions', hardDelete: false },
  invoices: { prefix: 'invoice:', normalize: normalizeInvoice, key: 'invoices', hardDelete: false },
  assets: { prefix: 'asset:', normalize: normalizeAsset, key: 'assets', hardDelete: false },
};

/* --------------------------- entity CRUD routes --------------------------- */

async function handleEntityCollection(entity, method, request, env, cors) {
  const cfg = ENTITIES[entity];
  if (method === 'GET') {
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get('archived') === '1';
    let list = await listEntity(env, cfg.prefix);
    if (!cfg.hardDelete && !includeArchived) list = list.filter((r) => !r.archived);
    return json({ [cfg.key]: list }, 200, cors);
  }
  if (method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
    const rec = cfg.normalize(body, null);
    await putEntity(env, cfg.prefix, rec);
    return json({ record: rec }, 201, cors);
  }
  return json({ error: 'Method not allowed' }, 405, cors);
}

async function handleEntityItem(entity, id, method, request, env, cors) {
  const cfg = ENTITIES[entity];
  const existing = await getEntity(env, cfg.prefix, id);
  if (!existing) return json({ error: 'Not found' }, 404, cors);
  if (method === 'GET') return json({ record: existing }, 200, cors);
  if (method === 'PATCH') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Invalid JSON body' }, 400, cors);
    const rec = cfg.normalize(body, existing);
    await putEntity(env, cfg.prefix, rec);
    return json({ record: rec }, 200, cors);
  }
  if (method === 'DELETE') {
    if (cfg.hardDelete) {
      await env.PORTAL_KV.delete(`${cfg.prefix}${id}`);
      return json({ ok: true, deleted: true }, 200, cors);
    }
    // Archive (soft-delete) for everything financial/CRM.
    const rec = { ...existing, archived: true, updatedAt: nowISO() };
    await putEntity(env, cfg.prefix, rec);
    return json({ ok: true, archived: true, record: rec }, 200, cors);
  }
  return json({ error: 'Method not allowed' }, 405, cors);
}

/* ------------------------------- dashboard -------------------------------- */

function txnSign(type) {
  // Money into the business is positive; money out is negative.
  return type === 'revenue' || type === 'contribution' ? 1 : -1;
}

async function handleDashboard(env, cors) {
  const [txns, invoices, tasks, events, prospects, clients, assets] = await Promise.all([
    listEntity(env, 'txn:'),
    listEntity(env, 'invoice:'),
    listEntity(env, 'task:'),
    listEntity(env, 'event:'),
    listEntity(env, 'prospect:'),
    listEntity(env, 'client:'),
    listEntity(env, 'asset:'),
  ]);
  const activeTxns = txns.filter((t) => !t.archived);
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth();

  let balanceCents = 0;
  let revenueYtd = 0, expenseYtd = 0, revenueMonth = 0, expenseMonth = 0;
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const series = {}; // monthKey -> { revenue, expense }

  for (const t of activeTxns) {
    balanceCents += txnSign(t.type) * (t.amountCents || 0);
    const d = new Date(t.date);
    if (isNaN(d)) continue;
    const mk = monthKey(d);
    if (!series[mk]) series[mk] = { revenue: 0, expense: 0 };
    if (t.type === 'revenue') series[mk].revenue += t.amountCents || 0;
    if (t.type === 'expense') series[mk].expense += t.amountCents || 0;
    if (d.getFullYear() === thisYear) {
      if (t.type === 'revenue') revenueYtd += t.amountCents || 0;
      if (t.type === 'expense') expenseYtd += t.amountCents || 0;
      if (d.getMonth() === thisMonth) {
        if (t.type === 'revenue') revenueMonth += t.amountCents || 0;
        if (t.type === 'expense') expenseMonth += t.amountCents || 0;
      }
    }
  }

  // Last 6 months of revenue/expense/profit for the chart.
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(thisYear, thisMonth - i, 1);
    const mk = monthKey(d);
    const s = series[mk] || { revenue: 0, expense: 0 };
    months.push({
      key: mk,
      label: d.toLocaleDateString('en-US', { month: 'short' }),
      revenue: s.revenue,
      expense: s.expense,
      profit: s.revenue - s.expense,
    });
  }

  const activeInvoices = invoices.filter((i) => !i.archived);
  const outstandingCents = activeInvoices
    .filter((i) => i.status === 'sent' || i.status === 'overdue')
    .reduce((sum, i) => sum + (i.amountCents || 0), 0);

  const openTasks = tasks.filter((t) => !t.archived && t.status !== 'done');
  const upcomingTasks = openTasks
    .filter((t) => t.due)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)))
    .slice(0, 6);

  const nowMs = Date.now();
  const upcomingEvents = events
    .filter((e) => e.start && new Date(e.start).getTime() >= nowMs - 86400000)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .slice(0, 6);

  const recentTxns = activeTxns
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 8);

  const activeProspectCount = prospects.filter((p) => !p.archived).length;
  const activeClientCount = clients.filter((c) => !c.archived).length;

  return json({
    balanceCents,
    revenueYtd, expenseYtd, netYtd: revenueYtd - expenseYtd,
    revenueMonth, expenseMonth, netMonth: revenueMonth - expenseMonth,
    outstandingInvoicesCents: outstandingCents,
    openTaskCount: openTasks.length,
    activeProspectCount,
    activeClientCount,
    assetCount: assets.filter((a) => !a.archived).length,
    months,
    upcomingTasks,
    upcomingEvents,
    recentTransactions: recentTxns,
  }, 200, cors);
}

/* -------------------------------- search ---------------------------------- */

async function handleSearch(request, env, cors) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return json({ results: [] }, 200, cors);
  const [clients, prospects, tasks, events, txns, invoices, assets] = await Promise.all([
    listEntity(env, 'client:'),
    listEntity(env, 'prospect:'),
    listEntity(env, 'task:'),
    listEntity(env, 'event:'),
    listEntity(env, 'txn:'),
    listEntity(env, 'invoice:'),
    listEntity(env, 'asset:'),
  ]);
  const results = [];
  const add = (group, title, sub, href, text) => {
    if (text.includes(q)) results.push({ group, title, sub, href });
  };
  clients.filter((c) => !c.archived).forEach((c) =>
    add('Clients', c.name || c.company || 'Client', c.company || c.contact,
      `/app/clients.html?q=${encodeURIComponent(c.name || '')}`,
      `${c.name} ${c.company} ${c.contact}`.toLowerCase()));
  prospects.filter((p) => !p.archived).forEach((p) =>
    add('Prospects', p.name || p.company || 'Prospect', p.company || p.contact,
      `/app/prospects.html?q=${encodeURIComponent(p.name || '')}`,
      `${p.name} ${p.company} ${p.contact} ${p.location} ${p.businessType} ${p.service}`.toLowerCase()));
  tasks.filter((t) => !t.archived).forEach((t) =>
    add('Tasks', t.title, [t.status === 'done' ? 'completed' : 'open', t.owner].filter(Boolean).join(' · '),
      `/app/tasks.html?q=${encodeURIComponent(t.title || '')}`,
      `${t.title} ${t.owner}`.toLowerCase()));
  events.forEach((e) =>
    add('Calendar', e.title, e.start ? String(e.start).slice(0, 10) : '',
      `/app/calendar.html`,
      `${e.title} ${e.location} ${e.notes}`.toLowerCase()));
  txns.filter((t) => !t.archived).forEach((t) =>
    add('Transactions', t.description || t.category || t.type, [t.type, t.date].filter(Boolean).join(' · '),
      `/app/finances.html?tab=transactions`,
      `${t.description} ${t.category} ${t.type}`.toLowerCase()));
  invoices.filter((i) => !i.archived).forEach((i) =>
    add('Invoices', i.number ? `${i.number} — ${i.client}` : i.client, i.status,
      `/app/finances.html?tab=revenue`,
      `${i.number} ${i.client} ${i.notes}`.toLowerCase()));
  assets.filter((a) => !a.archived).forEach((a) =>
    add('Assets', a.name, a.category,
      `/app/finances.html?tab=assets`,
      `${a.name} ${a.category} ${a.notes}`.toLowerCase()));
  return json({ results: results.slice(0, 30) }, 200, cors);
}

/* -------------------------------- router ---------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();
    const cors = resolveCorsOrigin(request, url, env);

    // Non-API paths -> static assets (login page + app HTML/CSS/JS).
    if (!pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(cors) });
    }

    try {
      // --- unauthenticated ---
      if (pathname === '/api/register' && method === 'POST') return await handleRegister(request, env, cors);
      if (pathname === '/api/login' && method === 'POST') return await handleLogin(request, env, cors);
      if (pathname === '/api/logout' && method === 'POST') return await handleLogout(request, env, cors);

      // --- everything else requires a session ---
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: 'Not authenticated' }, 401, cors);

      if (pathname === '/api/me' && method === 'GET') return await handleMe(email, env, cors);
      if (pathname === '/api/dashboard' && method === 'GET') return await handleDashboard(env, cors);
      if (pathname === '/api/search' && method === 'GET') return await handleSearch(request, env, cors);

      // Entity routes: /api/<entity>  and  /api/<entity>/<id>
      const parts = pathname.split('/').filter(Boolean); // ['api', entity, id?]
      if (parts.length >= 2 && parts[0] === 'api' && ENTITIES[parts[1]]) {
        const entity = parts[1];
        if (parts.length === 2) return await handleEntityCollection(entity, method, request, env, cors);
        if (parts.length === 3) return await handleEntityItem(entity, decodeURIComponent(parts[2]), method, request, env, cors);
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'Server error', detail: String(err && err.message || err) }, 500, cors);
    }
  },
};
