// Ignite Business Manager — shared app shell.
// Every page under /app/ loads this first. Guards the session (bounce to the
// login page), injects the sidebar, and exposes: SESSION, api(), formatting
// helpers, toast(), modal helpers, and the Ctrl/Cmd-K search palette.

const SESSION_KEY = 'ignite_session';

const SESSION = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (saved && saved.token) return saved;
  } catch { /* fall through */ }
  return null;
})();

// Pages call requireAuth() at the top; login page does not.
function requireAuth() {
  if (!SESSION) location.replace('/');
}

function logoutLocal() {
  localStorage.removeItem(SESSION_KEY);
  location.replace('/');
}

async function api(path, opts = {}) {
  const headers = { Authorization: `Bearer ${SESSION ? SESSION.token : ''}`, ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { logoutLocal(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ------------------------------- helpers ---------------------------------- */

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function relTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}
// cents (integer) -> "$1,234.56"
function fmtMoney(cents, opts = {}) {
  const n = (Number(cents) || 0) / 100;
  const s = n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: opts.noCents ? 0 : 2, maximumFractionDigits: opts.noCents ? 0 : 2 });
  return s;
}
// "1,234.56" or "1234.5" -> integer cents
function dollarsToCents(v) {
  const n = Math.round(Number(String(v).replace(/[^0-9.\-]/g, '')) * 100);
  return Number.isFinite(n) ? n : 0;
}
// integer cents -> "1234.56" for a number input default value
function centsToInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

/* ---------------------------------- toast --------------------------------- */
let _toastTimer = null;
function toast(msg, isErr = false) {
  let el = document.getElementById('app-toast');
  if (!el) { el = document.createElement('div'); el.id = 'app-toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast${isErr ? ' err' : ''}`;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------------------------- modal --------------------------------- */
// openModal(innerHTML) -> the .modal element (already in the DOM). Wire buttons
// on it, then call closeModal() when done. Clicking the backdrop closes.
function openModal(innerHTML) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'app-modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHTML}</div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', escCloseModal);
  return backdrop.querySelector('.modal');
}
function closeModal() {
  const b = document.getElementById('app-modal-backdrop');
  if (b) b.remove();
  document.removeEventListener('keydown', escCloseModal);
}
function escCloseModal(e) { if (e.key === 'Escape') closeModal(); }

/* --------------------------------- shell ---------------------------------- */
const NAV_ITEMS = [
  { id: 'dashboard', href: '/app/', icon: '◆', label: 'Dashboard' },
  { id: 'calendar', href: '/app/calendar.html', icon: '▤', label: 'Calendar' },
  { id: 'tasks', href: '/app/tasks.html', icon: '✓', label: 'Tasks' },
  { id: 'clients', href: '/app/clients.html', icon: '◇', label: 'Clients' },
  { id: 'prospects', href: '/app/prospects.html', icon: '◈', label: 'Prospects' },
  { id: 'finances', href: '/app/finances.html', icon: '$', label: 'Finances' },
];

function initShell(activePage) {
  const root = document.getElementById('sidebar-root');
  if (!root || !SESSION) return;
  root.innerHTML = `
    <div class="sidebar-brand">
      <img src="/assets/ignite-logo.png" alt="Ignite Development" class="brand-logo" />
    </div>
    <div class="sidebar-search">
      <button type="button" id="shell-search-btn">🔍 Search<span class="kbd">Ctrl K</span></button>
    </div>
    <nav class="sidebar-nav">
      ${NAV_ITEMS.map((n) => `<a href="${n.href}" class="${n.id === activePage ? 'active' : ''}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`).join('')}
    </nav>
    <div class="sidebar-foot">
      <div class="who">${escapeHtml(SESSION.name || SESSION.email || '')}</div>
      <button type="button" id="shell-logout-btn">Log out</button>
    </div>`;
  document.getElementById('shell-logout-btn').addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${SESSION.token}` } }); } catch {}
    logoutLocal();
  });
  document.getElementById('shell-search-btn').addEventListener('click', openPalette);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if (e.key === 'Escape') closePalette();
  });
}

/* ---------------------------- search palette ------------------------------ */
function closePalette() { const p = document.getElementById('palette-backdrop'); if (p) p.remove(); }
function openPalette() {
  if (document.getElementById('palette-backdrop')) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'palette-backdrop';
  backdrop.id = 'palette-backdrop';
  backdrop.innerHTML = `
    <div class="palette">
      <input type="text" id="palette-input" placeholder="Search prospects, tasks, events, transactions…" autocomplete="off" />
      <div class="palette-results" id="palette-results"><p class="palette-empty">Type to search everything.</p></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closePalette(); });
  const input = document.getElementById('palette-input');
  input.focus();
  let selIndex = 0;
  let timer = null;

  async function run() {
    const q = input.value.trim();
    const box = document.getElementById('palette-results');
    if (!box) return;
    if (!q) { box.innerHTML = '<p class="palette-empty">Type to search everything.</p>'; return; }
    let results = [];
    try { const data = await api(`/api/search?q=${encodeURIComponent(q)}`); results = data.results || []; } catch {}
    if (!results.length) { box.innerHTML = '<p class="palette-empty">No matches.</p>'; return; }
    selIndex = Math.min(selIndex, results.length - 1);
    let lastGroup = '';
    box.innerHTML = results.map((h, i) => {
      const header = h.group !== lastGroup ? `<div class="palette-group">${escapeHtml(h.group)}</div>` : '';
      lastGroup = h.group;
      return `${header}<a class="palette-result ${i === selIndex ? 'sel' : ''}" data-i="${i}" href="${h.href}">
        <div class="pr-title">${escapeHtml(h.title)}</div>
        ${h.sub ? `<div class="pr-sub">${escapeHtml(h.sub)}</div>` : ''}</a>`;
    }).join('');
    box.querySelectorAll('.palette-result').forEach((a) => a.addEventListener('mouseenter', () => {
      selIndex = Number(a.dataset.i);
      box.querySelectorAll('.palette-result').forEach((x) => x.classList.toggle('sel', x === a));
    }));
  }
  input.addEventListener('input', () => { selIndex = 0; clearTimeout(timer); timer = setTimeout(run, 140); });
  input.addEventListener('keydown', (e) => {
    const results = [...document.querySelectorAll('.palette-result')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      selIndex = (selIndex + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      results.forEach((x, i) => x.classList.toggle('sel', i === selIndex));
      results[selIndex].scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && results[selIndex]) location.assign(results[selIndex].href);
  });
}
