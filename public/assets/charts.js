// Ignite Business Manager — dependency-free inline-SVG charts.
// All builders return an SVG string; drop it into any container's innerHTML.

const CHART_COLORS = {
  orange: '#ff6b00',
  ink: '#ffffff',   // used for text on dark chart surfaces
  green: '#35c07a', // financial (money in / profit) — brightened for dark
  red: '#ff5a52',   // financial (money out) — brightened for dark
  muted: '#9a9184',
  grid: '#2a2620',
};
// Brand-only palette (orange / cream / grays) — a category breakdown is
// not profit/loss, so it must NOT use green/red. Tuned to read on dark.
const DONUT_PALETTE = ['#ff6b00', '#f2ede4', '#c9560a', '#9a9184', '#ff9a55', '#6b6459', '#ffc7a1', '#3a342c'];

function _money(cents) {
  const n = (Number(cents) || 0) / 100;
  if (Math.abs(n) >= 1000) return '$' + Math.round(n / 100) / 10 + 'k';
  return '$' + Math.round(n);
}

// Monthly revenue (green) vs expense (red) grouped bars + a profit line.
// months: [{ label, revenue, expense, profit }] with money in cents.
function monthlyBars(months) {
  const W = 560, H = 240, padL = 44, padR = 16, padT = 16, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = months.length || 1;
  const groupW = plotW / n;
  const barW = Math.min(26, groupW / 2.6);
  const maxVal = Math.max(1, ...months.map((m) => Math.max(m.revenue, m.expense)));
  const y = (v) => padT + plotH - (v / maxVal) * plotH;
  const x = (i) => padL + i * groupW + groupW / 2;

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (plotH / 4) * g;
    const val = maxVal * (1 - g / 4);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${CHART_COLORS.grid}" stroke-width="1"/>`;
    grid += `<text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="${CHART_COLORS.muted}">${_money(val)}</text>`;
  }
  let bars = '', labels = '', profitPts = [];
  months.forEach((m, i) => {
    const cx = x(i);
    const rX = cx - barW - 2, eX = cx + 2;
    bars += `<rect x="${rX}" y="${y(m.revenue)}" width="${barW}" height="${padT + plotH - y(m.revenue)}" rx="2" fill="${CHART_COLORS.green}"/>`;
    bars += `<rect x="${eX}" y="${y(m.expense)}" width="${barW}" height="${padT + plotH - y(m.expense)}" rx="2" fill="${CHART_COLORS.red}" opacity="0.85"/>`;
    labels += `<text x="${cx}" y="${H - 12}" text-anchor="middle" font-size="10" fill="${CHART_COLORS.muted}">${m.label}</text>`;
    const pv = Math.max(0, m.profit);
    profitPts.push([cx, y(pv)]);
  });
  const line = profitPts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const dots = profitPts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${CHART_COLORS.orange}"/>`).join('');

  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">
      ${grid}${bars}
      <path d="${line}" fill="none" stroke="${CHART_COLORS.orange}" stroke-width="2.5"/>${dots}
      ${labels}
    </svg>
    <div class="chart-legend">
      <span class="lg"><span class="sw" style="background:${CHART_COLORS.green}"></span>Revenue</span>
      <span class="lg"><span class="sw" style="background:${CHART_COLORS.red}"></span>Expenses</span>
      <span class="lg"><span class="sw" style="background:${CHART_COLORS.orange}"></span>Net profit</span>
    </div>
  </div>`;
}

// Donut for category breakdowns. segments: [{ label, value }] (value in cents).
function donutChart(segments, opts = {}) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0);
  const size = 180, r = 70, cx = size / 2, cy = size / 2, stroke = 26;
  if (total <= 0) return '<p class="empty">No data yet.</p>';
  const circ = 2 * Math.PI * r;
  let offset = 0, arcs = '', legend = '';
  segments.forEach((s, i) => {
    const frac = (s.value || 0) / total;
    const color = DONUT_PALETTE[i % DONUT_PALETTE.length];
    const len = frac * circ;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += len;
    legend += `<span class="lg"><span class="sw" style="background:${color}"></span>${escapeHtml(s.label)} · ${fmtMoney(s.value, { noCents: true })}</span>`;
  });
  const centerLabel = opts.centerLabel || fmtMoney(total, { noCents: true });
  return `<div class="chart-wrap" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;">
    <svg viewBox="0 0 ${size} ${size}" width="180" height="180" role="img">
      ${arcs}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="18" font-weight="700" fill="${CHART_COLORS.ink}">${escapeHtml(centerLabel)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10" fill="${CHART_COLORS.muted}">${escapeHtml(opts.centerSub || 'total')}</text>
    </svg>
    <div class="chart-legend" style="flex-direction:column;gap:6px;">${legend}</div>
  </div>`;
}
