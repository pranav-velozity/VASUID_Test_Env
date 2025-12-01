/*
 * Pinpoint Exec — Additive Live Widgets (No baseline changes)
 * - Mounts read-only KPIs, Radar (exceptions), Double-Donut (planned vs applied), and 3 exception cards
 * - Uses existing global state & helpers: state, weekEndISO, ymdFromCompletedAtInTZ, todayInTZ, mondayOfInTZ, toNum, aggregate, joinPOProgress
 * - No edits to existing routes/exports/logic; safe to include after current script.
 */
(function ExecLiveAdditive(){
  const BRAND = (typeof window.BRAND !== 'undefined') ? window.BRAND : '#990033';
  const BUSINESS_TZ = document.querySelector('meta[name="business-tz"]')?.content || 'Asia/Shanghai';

// --- Exec should not fetch; rely on Ops-populated window.state
const EXEC_USE_NETWORK = true;

// --- API base (normalized; always ends with /api)
const _rawBase =
  document.querySelector('meta[name="api-base"]')?.content
  || (typeof window.API_BASE !== 'undefined' ? window.API_BASE : location.origin);

const API_BASE = (() => {
  const b = String(_rawBase || '').replace(/\/+$/, ''); // strip trailing /
  if (/\/api$/i.test(b)) return b;                      // already ends with /api
  return b ? (b + '/api') : '/api';                     // append /api or default
})();

const g = (path) =>
  fetch(`${API_BASE}/${path}`, { headers: { 'Content-Type': 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));

// --- Robust fetchers with endpoint fallback -------------------
async function tryFetchJson(urls) {
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'Content-Type': 'application/json' } });
      if (r.ok) return r.json();
    } catch (_) {}
  }
  throw new Error('All endpoints failed: ' + urls.join(' | '));
}

function trimBase(base) { return String(base || '').replace(/\/+$/,''); }

async function fetchPlanForWeek(ws) {
  const base = trimBase(API_BASE);
return tryFetchJson([
  // API_BASE already includes /api
  `${base}/plan?weekStart=${ws}`,
  // fallback to non-/api base if the alias isn’t present
  `${base.replace(/\/api$/,'')}/plan/weeks/${ws}`
]);

}

async function fetchBinsForWeek(ws) {
  const base = trimBase(API_BASE);
return tryFetchJson([
  `${base}/bins?weekStart=${ws}`,
  `${base.replace(/\/api$/,'')}/bins/weeks/${ws}`
]);

}

async function fetchRecordsForWeek(ws, we) {
  const base = trimBase(API_BASE);
return tryFetchJson([
  `${base}/records?from=${ws}&to=${we}&status=complete`,
  `${base.replace(/\/api$/,'')}/records?from=${ws}&to=${we}&status=complete`
]);

}



 // --- Alias real app state if it lives somewhere else ---
  const _maybeState =
    window.state ||
    window.app?.state ||
    window.pinpoint?.state ||
    window.vo?.state ||
    window.store?.state ||
    window.__APP__?.state;

  if (_maybeState && !window.state) window.state = _maybeState;

  // ---------- Small utilities ----------
  const $ = (s)=>document.querySelector(s);
  const fmt = (n)=> Number(n||0).toLocaleString();
  const clamp = (v,min,max)=> Math.max(min, Math.min(max, v));
  const pct = (num,den)=> den>0 ? Math.round((num*100)/den) : 0;
  const weekEndISO = window.weekEndISO || function(ws){ const d=new Date(ws); d.setDate(d.getDate()+6); return toISODate(d); };
  function toISODate(v){
    if (typeof window.toISODate === 'function') return window.toISODate(v);
    const d = new Date(v); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }


// --- replace bizYMDFromRecord with this ---
function bizYMDFromRecord(r){
  if (r?.date_local || r?.date) {
    const raw = r.date_local || r.date;
    const s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{2}-\d{2}-\d{4}$/.test(s)) { const [d,m,y]=s.split('-'); return `${y}-${m}-${d}`; }
  }
  if (r?.completed_at && typeof window.ymdFromCompletedAtInTZ === 'function') {
    return window.ymdFromCompletedAtInTZ(r.completed_at, BUSINESS_TZ);
  }
  return '';
}

// ---------- Metric computations (scoped to selected week) ----------
function computeExecMetrics() {

let ws = window.state?.weekStart;
 if (!ws) {
    try {
      ws = (typeof window.todayInTZ === 'function' && typeof window.mondayOfInTZ === 'function')
        ? window.mondayOfInTZ(window.todayInTZ(BUSINESS_TZ))
        : (function(){ const d=new Date(); const day=(d.getDay()+6)%7; d.setHours(0,0,0,0); d.setDate(d.getDate()-day); return d.toISOString().slice(0,10);}());
    } catch { /* ignore */ }
  }
  if (!ws) return null;

  const we = (window.weekEndISO || function (ws) {
    const d = new Date(ws);
    d.setDate(d.getDate() + 6);
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  })(ws);

  const plan       = Array.isArray(window.state?.plan)    ? window.state.plan    : [];
  const recordsAll = Array.isArray(window.state?.records) ? window.state.records : [];
  const bins       = Array.isArray(window.state?.bins)    ? window.state.bins    : [];

  // Week records = in-range & "looks done"
  const wkRecords = recordsAll.filter(r => {
    const ymd = bizYMDFromRecord(r);
    if (!(ymd && ymd >= ws && ymd <= we)) return false;
    const st = String(r?.status || '').toLowerCase();
    return (st === 'complete' || st === 'applied' || !!r.uid || Number(r.qty || r.quantity || 0) > 0);
  });

  // Planned total (sum plan.target_qty)
  const plannedTotal = plan.reduce((s, p) => s + (window.toNum ? toNum(p.target_qty) : Number(p.target_qty || 0)), 0);

  // Applied total (sum qty/quantity if present, else 1 per record)
  const appliedTotal = wkRecords.reduce((s, r) => {
    const q = Number(r.qty ?? r.quantity ?? 1);
    return s + (Number.isFinite(q) && q > 0 ? q : 0);
  }, 0);

  const pct = (num, den) => den > 0 ? Math.round((num * 100) / den) : (num > 0 ? 100 : 0);
  const completionPct = pct(appliedTotal, plannedTotal);

  // Aggregates (if helper exists)
  const agg = (typeof window.aggregate === 'function') ? window.aggregate(wkRecords) : { byPO:new Map(), bySKU:new Map() };

  // Discrepancy % (SKU)
  const planBySKU = new Map();
  for (const p of plan) {
    const sku = String(p.sku_code || '').trim();
    if (!sku) continue;
    planBySKU.set(sku, (planBySKU.get(sku) || 0) + (window.toNum ? toNum(p.target_qty) : Number(p.target_qty || 0)));
  }
  let skuPctSum = 0, skuCnt = 0;
  for (const [sku, planned] of planBySKU.entries()) {
    const applied = agg.bySKU.get(sku) || 0;
    if (planned > 0) { skuPctSum += Math.abs(applied - planned) / planned; skuCnt++; }
  }
  const avgSkuDiscPct = Math.round((skuCnt ? (skuPctSum / skuCnt) : 0) * 100);

  // Discrepancy % (PO) + earliest due per PO
  const planByPO = new Map();
  const poDue = new Map();
  for (const p of plan) {
    const po = String(p.po_number || '').trim(); 
    if (!po) continue;
    planByPO.set(po, (planByPO.get(po) || 0) + (window.toNum ? toNum(p.target_qty) : Number(p.target_qty || 0)));
    const d = String(p.due_date || '').trim();
    if (!poDue.has(po)) poDue.set(po, d); else if (d && (!poDue.get(po) || d < poDue.get(po))) poDue.set(po, d);
  }
  let poPctSum = 0, poCnt = 0;
  for (const [po, planned] of planByPO.entries()) {
    const applied = agg.byPO.get(po) || 0;
    if (planned > 0) { poPctSum += Math.abs(applied - planned) / planned; poCnt++; }
  }
  const avgPoDiscPct = Math.round((poCnt ? (poPctSum / poCnt) : 0) * 100);

  // Duplicate UIDs (same SKU+UID >1)
  const pairCounts = new Map();
  for (const r of wkRecords) {
    const sku = String(r.sku_code || '').trim();
    const uid = String(r.uid || '').trim();
    if (!sku || !uid) continue;
    const k = `${sku}||${uid}`;
    pairCounts.set(k, (pairCounts.get(k) || 0) + 1);
  }
  let dupScanCount = 0;
  for (const c of pairCounts.values()) if (c > 1) dupScanCount += c;

  // Heavy bins + diversity
  const heavyBins  = (bins || []).filter(b => Number(b.weight_kg || 0) > 12);
  const heavyBinSet = new Set(heavyBins.map(b => String(b.mobile_bin || '').trim()).filter(Boolean));
  const heavyCount  = heavyBinSet.size;
  const skuByBin = new Map();
  for (const r of wkRecords) {
    const bin = String(r.mobile_bin || '').trim();
    const sku = String(r.sku_code || '').trim();
    if (!bin || !sku) continue;
    if (!skuByBin.has(bin)) skuByBin.set(bin, new Set());
    skuByBin.get(bin).add(sku);
  }
  let diversitySum = 0, diversityN = 0;
  for (const bin of heavyBinSet) { diversitySum += (skuByBin.get(bin)?.size || 0); diversityN++; }
  const avgDiversityHeavy = diversityN ? (diversitySum / diversityN) : 0;

  // Late appliers
  let lateCount = 0;
  for (const r of wkRecords) {
    const po = String(r.po_number || '').trim(); if (!po) continue;
    const due = poDue.get(po); if (!due) continue;
    const ymd = bizYMDFromRecord(r); if (!ymd) continue;
    if (ymd > due) lateCount++;
  }
  const lateRatePct = pct(lateCount, appliedTotal);

  // Pareto: gaps by PO×SKU
  const appliedPOSKU = new Map();
  for (const r of wkRecords) {
    const po  = String(r.po_number || '').trim();
    const sku = String(r.sku_code  || '').trim();
    if (!po || !sku) continue;
    const k = `${po}|||${sku}`;
    appliedPOSKU.set(k, (appliedPOSKU.get(k) || 0) + 1);
  }
  const plannedPOSKU = new Map();
  for (const p of plan) {
    const po  = String(p.po_number || '').trim();
    const sku = String(p.sku_code  || '').trim();
    if (!po || !sku) continue;
    const k = `${po}|||${sku}`;
    plannedPOSKU.set(k, (plannedPOSKU.get(k) || 0) + (window.toNum ? toNum(p.target_qty) : Number(p.target_qty || 0)));
  }
  const gaps = [];
  for (const [k, planned] of plannedPOSKU.entries()) {
    const applied = appliedPOSKU.get(k) || 0;
    const gap = planned - applied;
    if (gap !== 0) gaps.push({ k, gap, planned, applied });
  }
  gaps.sort((a,b) => Math.abs(b.gap) - Math.abs(a.gap));
  const topGap = gaps.slice(0, 5).map(g => {
    const [po, sku] = g.k.split('|||');
    return { po, sku, gap: g.gap, planned: g.planned, applied: g.applied };
  });

  return {
    ws, we,
    plannedTotal, appliedTotal, completionPct,
    avgSkuDiscPct, avgPoDiscPct,
    dupScanCount,
    heavyCount, avgDiversityHeavy,
    lateCount, lateRatePct,
    topGap
  };
}

  // ---------- SVG renderers ----------
  function radarSVG({axes, values, size=260}){
    const cx=size/2, cy=size/2, r=size*0.38; const n=axes.length; const toRad=(deg)=> (deg*Math.PI/180);
    const pts=[]; const gridSteps=4; // 25%, 50%, 75%, 100%
    for (let i=0;i<n;i++){ const angle = toRad(-90 + (360*i/n)); const vr = r * clamp(values[i], 0, 100)/100; const x = cx + vr*Math.cos(angle); const y = cy + vr*Math.sin(angle); pts.push([x,y]); }
    const poly = pts.map(p=> p.join(',')).join(' ');
    let grid='';
    for (let s=1; s<=gridSteps; s++){
      const rr = (r*s)/gridSteps; const ring=[];
      for (let i=0;i<n;i++){ const angle = toRad(-90 + (360*i/n)); ring.push((cx + rr*Math.cos(angle))+','+(cy + rr*Math.sin(angle))); }
      grid += `<polygon points="${ring.join(' ')}" fill="none" stroke="#e5e7eb" stroke-width="1" />`;
    }
    let spokes='';
    for (let i=0;i<n;i++){ const a=toRad(-90 + (360*i/n)); const x=cx + r*Math.cos(a), y=cy + r*Math.sin(a); spokes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e5e7eb" stroke-width="1" />`; }
    const labels = axes.map((t,i)=>{ const a=toRad(-90 + (360*i/n)); const lx=cx + (r+16)*Math.cos(a); const ly=cy + (r+16)*Math.sin(a); return `<text x="${lx}" y="${ly}" font-size="11" text-anchor="${Math.cos(a)>0? 'start':'end'}" dominant-baseline="middle" fill="#374151">${t}</text>`; }).join('');
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Exceptions radar">
      <g>${grid}${spokes}</g>
      <polygon points="${poly}" fill="${BRAND}20" stroke="${BRAND}" stroke-width="2" />
      ${labels}
    </svg>`;
  }

  function donutDoubleSVG(planned, applied, size=260){
    const cx=size/2, cy=size/2, r1=size*0.40, r2=size*0.30; // outer planned, inner applied
    const tau = Math.PI*2;
    function arc(pct,r){ const a = clamp(pct,0,100)*tau/100; const x = cx + r*Math.sin(a); const y = cy - r*Math.cos(a); const large = a>Math.PI?1:0; return `M ${cx} ${cy-r} A ${r} ${r} 0 ${large} 1 ${x} ${y}`; }
    const comp = pct(applied, planned);
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Planned vs applied">
      <circle cx="${cx}" cy="${cy}" r="${r1}" fill="none" stroke="#e5e7eb" stroke-width="16"/>
      <path d="${arc(100, r1)}" stroke="#e5e7eb" stroke-width="16" fill="none" />
      <path d="${arc( clamp( planned>0?100:0,0,100 ), r1)}" stroke="#cbd5e1" stroke-width="16" fill="none" />
      <circle cx="${cx}" cy="${cy}" r="${r2}" fill="none" stroke="#f1f5f9" stroke-width="16"/>
      <path d="${arc( clamp( planned>0? (applied*100/planned):0, 0, 100 ), r2)}" stroke="${BRAND}" stroke-width="16" fill="none" />
      <text x="${cx}" y="${cy-6}" text-anchor="middle" font-size="22" font-weight="700" fill="#111827">${fmt(applied)}</text>
      <text x="${cx}" y="${cy+16}" text-anchor="middle" font-size="12" fill="#6b7280">of ${fmt(planned)} • ${comp}%</text>
    </svg>`;
  }

  function sparklineSVG(values, width=280, height=60){
    if (!values.length) return `<svg width="${width}" height="${height}"></svg>`;
    const max = Math.max(...values, 1), min = Math.min(...values, 0);
    const step = width / Math.max(1, values.length-1);
    const pts = values.map((v,i)=>{
      const x = i*step; const y = height - ((v - min) / Math.max(1, max-min)) * (height-12) - 6;
      return `${x},${y}`;
    }).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      <polyline points="${pts}" fill="none" stroke="${BRAND}" stroke-width="2" />
    </svg>`;
  }

// ===== SVG Helpers (no libs) =====
const GREY  = '#e5e7eb';
const GREY_STROKE = '#d1d5db';

function _el(tag, attrs={}, children=[]) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  children.forEach(c => e.appendChild(c));
  return e;
}

function renderDonutWithBaseline(slot, planned, applied, opts = {}) {
  slot.innerHTML = '';

  // Stable, explicit size
  const size = Math.max(260, Math.min((opts.size || 340), 460));
  slot.style.minHeight = size + 'px';
  slot.style.display = 'flex';
  slot.style.alignItems = 'center';
  slot.style.justifyContent = 'center';
  slot.style.position = 'relative';

  // Thicker ring but same outer footprint
const BASE_STROKE   = 22; // was 16
const APPLIED_STROKE= 22; // was 16
const r = Math.round(size * 0.41) - Math.floor((BASE_STROKE - 16) / 2);

  const cx = size / 2, cy = size / 2;
  const CIRC = 2 * Math.PI * r;

  const svg = _el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, style: 'display:block;margin:auto' });

  // baseline ring
  svg.appendChild(_el('circle', {
    cx, cy, r,
    fill: 'none',
    stroke: GREY,
    'stroke-width': BASE_STROKE
  }));

  // applied ring
  const appliedArc = _el('circle', {
    cx, cy, r,
    fill: 'none',
    stroke: BRAND,
    'stroke-width': APPLIED_STROKE,
    'stroke-linecap': 'round',
    transform: `rotate(-90 ${cx} ${cy})`,
    'stroke-dasharray': CIRC,
    'stroke-dashoffset': CIRC
  });
  svg.appendChild(appliedArc);
  slot.appendChild(svg);

  // % label in the center
  const pctText = document.createElement('div');
  pctText.className = 'absolute inset-0 flex items-center justify-center text-sm text-gray-600';
  pctText.style.pointerEvents = 'none';
  slot.appendChild(pctText);

  // compute %
  let p;
  if (!Number.isFinite(planned) || planned <= 0) {
    p = (Number(applied) > 0) ? 1 : 0;
  } else {
    p = Math.max(0, Math.min(1, Number(applied || 0) / Number(planned)));
  }

  const dash = CIRC * (1 - p);
  appliedArc.style.transition = 'none';
  appliedArc.setAttribute('stroke-dashoffset', dash);
  pctText.textContent = Math.round(p * 100) + '%';
}

function renderRadarWithBaseline(slot, labels, baselineValues, actualValues, opts = {}) {
  slot.innerHTML = '';

  // Bigger, centered radar
  const displaySize = Math.max(360, Math.min((opts.size || 420), 520));
  const vbPad  = 64;                              // extra bleed for labels
  const vbSize = displaySize + vbPad * 2;
  const cx  = displaySize / 2, cy = displaySize / 2;
  const R   = (displaySize / 2) - 22;             // chart radius

  const svg = _el('svg', {
    viewBox: `${-vbPad} ${-vbPad} ${vbSize} ${vbSize}`,
    width: displaySize, height: displaySize, style: 'display:block;margin:auto'
  });

  const N = labels.length;
  const pt = (i, v) => {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI / N);
    const r = (Math.max(0, Math.min(100, v)) / 100) * R;
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  };
  const poly = vals => vals.map((v, i) => pt(i, v)).map(([x, y]) => `${x},${y}`).join(' ');

  // grid + spokes
  [20, 40, 60, 80, 100].forEach(t => {
    svg.appendChild(_el('circle', { cx, cy, r: (t / 100) * R, fill: 'none', stroke: GREY_STROKE, 'stroke-width': 1 }));
  });
  for (let i = 0; i < N; i++) {
    const [x, y] = pt(i, 100);
    svg.appendChild(_el('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: GREY_STROKE, 'stroke-width': 1 }));
  }

  // axis labels (slightly bigger)
  const labelR = R + 34;
  for (let i = 0; i < N; i++) {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI / N);
    const lx = cx + labelR * Math.cos(ang);
    const ly = cy + labelR * Math.sin(ang);
    const t = _el('text', {
      x: lx, y: ly, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': '18', 'font-weight': '600', fill: '#374151'
    });
    t.textContent = labels[i];
    svg.appendChild(t);
  }

  // polygons
  svg.appendChild(_el('polygon', {
    points: poly(baselineValues),
    fill: GREY, 'fill-opacity': 0.35, stroke: GREY_STROKE, 'stroke-width': 1
  }));
  if (actualValues && actualValues.length === N) {
    // NOTE: labels for actual values are intentionally removed
    svg.appendChild(_el('polygon', {
      points: poly(actualValues),
      fill: BRAND, 'fill-opacity': 0.18, stroke: BRAND, 'stroke-width': 2
    }));
  }

  slot.appendChild(svg);
}

// ---------- Timeline helpers & renderer ----------
function _businessDaysBack(isoYMD, n) {
  const d = new Date(isoYMD + 'T00:00:00');
  let left = Math.max(0, n|0);
  while (left > 0) {
    d.setDate(d.getDate() - 1);
    const wd = d.getDay(); // 0 Sun .. 6 Sat
    if (wd !== 0 && wd !== 6) left--;
  }
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function _toDate(ymd){ return new Date(ymd + 'T00:00:00'); }
function _clamp01(v){ return Math.max(0, Math.min(1, v)); }

function _mix(a,b,t){ return a + (b-a)*t; } // linear map

function renderExecTimeline(slot, m) {
  if (!slot) return;
slot.innerHTML = '';

  // ===== Helpers (declare before any use) =====

  // Tiny date helpers (pure)
  const parseYMD = (s) => {
    const [y, mo, d] = String(s).split('-').map(Number);
    return new Date(y, mo - 1, d);
  };
  const toYMD = (d) => {
    const y = d.getFullYear();
    const m2 = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m2}-${dd}`;
  };
  const addDaysYMD = (ymd, n) => {
    const d = parseYMD(ymd);
    d.setDate(d.getDate() + n);
    return toYMD(d);
  };
  const compareYMD = (a, b) => parseYMD(a).getTime() - parseYMD(b).getTime();

  // Business-day math
  const minusBusinessDaysFrom = (ymd, nBiz) => {
    let d = parseYMD(ymd);
    let left = nBiz;
    while (left > 0) {
      d.setDate(d.getDate() - 1);
      const dow = d.getDay(); // 0 Sun..6 Sat
      if (dow !== 0 && dow !== 6) left--;
    }
    return toYMD(d);
  };

  // Range clamp
  const clampYMD = (ymd, lo, hi) => {
    if (!ymd) return ymd;
    if (compareYMD(ymd, lo) < 0) return lo;
    if (compareYMD(ymd, hi) > 0) return hi;
    return ymd;
  };

  // Formatting helpers that depend on parseYMD
const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const shortDate = (ymd) => {
  const d = parseYMD(ymd);
  return `${monthShort[d.getMonth()]} ${String(d.getDate()).padStart(1,'0')}`;
};
const sameDay = (a,b) => a && b && compareYMD(a,b) === 0;



   // ---------- inputs from metrics/state
  const ws = m.ws;              // week start (Mon)
  const we = m.we;              // week end (Sun)
  if (!ws || !we) return;

  // baseline & plans
  const plannedBaseline   = minusBusinessDaysFrom(ws, 7);
  const inventoryPlanned  = ws;               // Mon
  const processingPlanned = addDaysYMD(ws, 4);// Fri
  const dispatchedPlanned = we;               // Sun

// Baseline (Actual) — optional override; only show if provided
const baselineActual = m.baselineActualYMD
  ? clampYMD(m.baselineActualYMD, minusBusinessDaysFrom(ws, 30), ws)
  : (window.state?.milestones?.baseline_actual_ymd
      ? clampYMD(window.state.milestones.baseline_actual_ymd, minusBusinessDaysFrom(ws, 30), ws)
      : null);

  // actuals (NO inference; only show if provided)
const inventoryActual  = m.inventoryActualYMD
  ? clampYMD(m.inventoryActualYMD, plannedBaseline, we)
  : null;

const processingActual = m.processingActualYMD
  ? clampYMD(m.processingActualYMD, plannedBaseline, we)
  : null;

const dispatchedActual = m.dispatchedActualYMD
  ? clampYMD(m.dispatchedActualYMD, plannedBaseline, addDaysYMD(we, 3))
  : null;


  // ---------- draw prelude (short, centered bar + piece-wise scale)
  const w0    = slot.clientWidth || slot.parentElement?.clientWidth || 0;
  const width = Math.max(720, w0 || 720);
  const height = 120;
  const pad    = 28;

  const inner      = width - pad * 2;
  const spanFactor = 0.82;                     // shorten bar (tweak 0.76–0.88)
  const span       = Math.round(inner * spanFactor);
  const originX    = pad + Math.round((inner - span) / 2);

  // small stub for Baseline→Mon, full segment for Mon→Sun
  const leftFrac    = 0.12;                    // tweak 0.10–0.18
  const leftSpan    = Math.round(span * leftFrac);
  const rightSpan   = span - leftSpan;
  const leftStartX  = originX;
  const rightStartX = originX + leftSpan;

  const tBaseline = parseYMD(plannedBaseline).getTime();
  const tMon      = parseYMD(ws).getTime();
  const tSun      = parseYMD(we).getTime();

  const scaleX = (ymd) => {
    const t = parseYMD(ymd).getTime();
    if (t <= tMon) {
      const p = (t - tBaseline) / Math.max(1, (tMon - tBaseline));   // 0..1 in stub
      return leftStartX + Math.round(Math.max(0, Math.min(1, p)) * leftSpan);
    } else {
      const p = (t - tMon) / Math.max(1, (tSun - tMon));              // 0..1 in week
      return rightStartX + Math.round(Math.max(0, Math.min(1, p)) * rightSpan);
    }
  };

  const svg = _el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width, height, style: 'display:block'
  });

// base bar (soft grey so it’s visible on white cards)
const barY = 72, barH = 12;
// Colors
const PLANNED_STROKE = '#EEC7D6';  // planned line
const ACTUAL_FILL    = BRAND;      // actual fill & dots
const ACTUAL_DOT     = BRAND;
const PLANNED_DOT    = '#EEC7D6';

svg.appendChild(_el('rect', {
  x: pad,
  y: barY,
  width: width - pad * 2,
  height: barH,
  rx: 6,
  ry: 6,
  fill: '#F3F4F6',
  stroke: '#E5E7EB',
  'stroke-width': 1
}));


// planned span (thin stroke) — START at Planned Baseline (left stub) and run to Dispatched (Plan)
const plannedStartX = scaleX(plannedBaseline);      // <-- changed
const plannedEndX   = scaleX(dispatchedPlanned);
svg.appendChild(_el('line', {
  x1: plannedStartX, y1: barY + barH / 2, x2: plannedEndX, y2: barY + barH / 2,
  stroke: PLANNED_STROKE, 'stroke-width': 3, 'stroke-linecap': 'round'
}));



    // ===== Actual progress fill =====
  // Priority: 1) Ops override %; 2) latest actual date among Dispatched/Processing/Inventory; 3) none -> no fill
  const fillStartX = scaleX(baselineActual || inventoryPlanned);
 
  // Case 1: Ops % override (uses display pct which falls back to the tile)
  if (m._opsDisplayPct != null) {
    const pct01 = Math.max(0, Math.min(100, m._opsDisplayPct)) / 100;

    // fill only the Mon→Sun segment by percentage
    const endX = rightStartX + Math.round(rightSpan * pct01);
    const x = Math.min(fillStartX, endX);
    const w = Math.max(2, Math.abs(endX - fillStartX));
    svg.appendChild(_el('rect', {
      x, y: barY + 2, width: w, height: barH - 4,
      rx: 5, ry: 5, fill: ACTUAL_FILL
    }));
  } else {
    // Case 2: infer from actual dates
    const latestActualYMD =
      (m.dispatchedActualYMD && clampYMD(m.dispatchedActualYMD, plannedBaseline, addDaysYMD(we, 3))) ||
      (m.processingActualYMD && clampYMD(m.processingActualYMD, plannedBaseline, we)) ||
      (m.inventoryActualYMD && clampYMD(m.inventoryActualYMD, plannedBaseline, we)) ||
      null;

    if (latestActualYMD) {
      const endX = scaleX(latestActualYMD);
      const x = Math.min(fillStartX, endX);
      const w = Math.max(2, Math.abs(endX - fillStartX));
      svg.appendChild(_el('rect', {
        x, y: barY + 2, width: w, height: barH - 4,
        rx: 5, ry: 5, fill: ACTUAL_FILL
      }));
    }
    // Else: no fill (cylinder stays grey)
  }

// % Complete label at progress end (default from tile; override if provided)
if (m._opsDisplayPct != null) {
  const pct01 = Math.max(0, Math.min(100, m._opsDisplayPct)) / 100;

  // position at end of Mon→Sun segment by percentage
  const labelX = rightStartX + Math.round(rightSpan * pct01);

  // keep inside the bar edges
  const minX = originX + 8;
  const maxX = originX + span - 8;
  const xClamped = Math.max(minX, Math.min(maxX, labelX));

  const t = _el('text', {
    x: xClamped,
    y: barY + barH + 30,            // sits a bit higher so it won’t clip
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    'font-size': '11',
    fill: '#374151'
  });
  t.textContent = `Completion — ${Math.round(m._opsDisplayPct)}%`;
  svg.appendChild(t);
}



// % Complete label at progress end (only if Ops % provided)
if (m._opsCompletionPct != null) {
  const pct01 = Math.max(0, Math.min(100, m._opsCompletionPct)) / 100;
  // label position is the end of Mon→Sun segment by percentage
  const labelX = rightStartX + Math.round(rightSpan * pct01);

  // keep label inside edges
  const minX = originX + 8;
  const maxX = originX + span - 8;
  const xClamped = Math.max(minX, Math.min(maxX, labelX));

  const labelEl = _el('text', {
    x: xClamped,
    y: barY + barH + 20,                   // below the bar
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    'font-size': '14',
    fill: '#374151'
  });
  labelEl.textContent = `Completion — ${Math.round(m._opsCompletionPct)}%`;
  svg.appendChild(labelEl);
}



// milestones (planned above, actuals below) — render ACTUALS first (under), PLANS last (on top)
const plannedDots = [
  {
    key: 'baselinePlan',
    ymd: plannedBaseline,
    label: `Planned (Baseline) — ${shortDate(plannedBaseline)}`,
    color: '#EEC7D6',
    where: 'above'
  },
  {
    key: 'inventoryPlan',
    ymd: inventoryPlanned,
    label: `Inventory (Plan) — ${shortDate(inventoryPlanned)}`,
    color: '#EEC7D6',
    where: 'above'
  },
  {
    key: 'processingPlan',
    ymd: processingPlanned,
    label: `Processing (Plan) — ${shortDate(processingPlanned)}`,
    color: '#EEC7D6',
    where: 'above'
  },
  {
    key: 'dispatchedPlan',
    ymd: dispatchedPlanned,
    label: `Dispatched (Plan) — ${shortDate(dispatchedPlanned)}`,
    color: '#EEC7D6',
    where: 'above'
  }
];

const actualDots = [
  baselineActual ? {
    key: 'baselineActual',
    ymd: baselineActual,
    label: `Baseline (Actual) — ${shortDate(baselineActual)}`,
    color: ACTUAL_DOT,
    where: 'below'
  } : null,
  inventoryActual ? {
    key: 'inventoryActual',
    ymd: inventoryActual,
    label: `Inventory (Actual) — ${shortDate(inventoryActual)}`,
    color: ACTUAL_DOT,
    where: 'below'
  } : null,
  processingActual ? {
    key: 'processingActual',
    ymd: processingActual,
    label: `Processing (Actual) — ${shortDate(processingActual)}`,
    color: ACTUAL_DOT,
    where: 'below'
  } : null,
  dispatchedActual ? {
    key: 'dispatchedActual',
    ymd: dispatchedActual,
    label: `Dispatched (Actual) — ${shortDate(dispatchedActual)}`,
    color: ACTUAL_DOT,
    where: 'below'
  } : null
].filter(Boolean);

// --- simple collision registry to stack labels that share (nearly) the same x
const labelBuckets = { above: [], below: [] };
const NEAR_PX = 14;   // how close before we treat as "same x"
const ROW_PX  = 12;   // vertical offset per stacked row



// Common renderer (kept identical to your current one)
function renderDot(d) {
  if (!d.ymd) return;

  const x  = scaleX(d.ymd);
  const cy = d.where === 'above' ? (barY - 18) : (barY + barH + 18);

  // Keep marks/labels slightly inside the bar edges
  const minX = originX + 8;
  const maxX = originX + span - 8;
  const xClamped = Math.max(minX, Math.min(maxX, x));

  // Gentle left/right nudges to avoid crowding near week end
  let xLabel = xClamped;
  if (d.key === 'processingPlan') xLabel -= 10;  // nudge left
  if (d.key === 'dispatchedPlan') xLabel += 10;  // nudge right

// --- stack labels when multiple land on (nearly) the same x
let row = 0;
const bucket = labelBuckets[d.where];
for (const prevX of bucket) {
  if (Math.abs(prevX - xClamped) < NEAR_PX) row++;
}
bucket.push(xClamped);

// push labels away from each other vertically; keep dots on the rail
const cyStacked = d.where === 'above'
  ? (cy - row * ROW_PX)  // stack upwards above the bar
  : (cy + row * ROW_PX); // stack downwards below the bar


  const yDot = d.where === 'above' ? (barY - 6) : (barY + barH + 6);

  // dot (use clamped x)
  svg.appendChild(_el('circle', { cx: xClamped, cy: yDot, r: 4, fill: d.color }));

  // label (use nudged x)
  if (d.label) {
    const labelEl = _el('text', {
      x: xLabel,
      y: cyStacked,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-size': '11',
      fill: '#374151'
    });
    labelEl.textContent = d.label;
    svg.appendChild(labelEl);
  }
}

// Draw order: actuals first (under), planned last (on top so they never “disappear”)
actualDots.forEach(renderDot);
plannedDots.forEach(renderDot);

  slot.appendChild(svg);
}  // end renderExecTimeline

// === Inject "Download summary" next to the old buttons, style like toolbar pill,
// === and hide "Download .doc" + "PO×SKU CSV" on the Exec page
function ensureSummaryBtn(clickHandler) {
  // Helper: find a button/anchor by text (case-insensitive, flexible spacing)
  function findBtnByText(txt) {
    const norm = (s) => String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const target = norm(txt);
    return Array.from(document.querySelectorAll('button, a')).find(el => norm(el.textContent).includes(target));
  }

  // We use the existing ".doc" button as an anchor point (as before)
  const docBtn = findBtnByText('download .doc');

  // Retry gently if header isn't mounted yet
  if (!docBtn) {
    if (!ensureSummaryBtn.__retryTimer) {
      ensureSummaryBtn.__retryTimer = setTimeout(() => {
        ensureSummaryBtn.__retryTimer = null;
        try { ensureSummaryBtn(clickHandler); } catch {}
      }, 300);
    }
    return;
  }

  // Hide legacy buttons on Exec page only
  if ((location.hash || '#dashboard') === '#exec') {
    // 1) "Download .doc"
    docBtn.style.display = 'none';

    // 2) "PO×SKU CSV" (sometimes rendered as POxSKU)
    const csvBtn = (
      findBtnByText('po×sku csv') ||
      findBtnByText('poxsku csv') ||
      findBtnByText('po sku csv')
    );
    if (csvBtn) csvBtn.style.display = 'none';
  }

  // Already added?
  if (document.getElementById('export-summary-btn')) return;

  // Build "Download summary" in the toolbar-pill style with a small icon
  const b = document.createElement('button');
  b.id = 'export-summary-btn';
  b.type = 'button';
  b.className = [
    // pill look, matching your other pages
    'inline-flex items-center gap-2',
    'px-3 py-1 rounded-full',
    'border shadow-sm',
    'text-gray-700 hover:bg-gray-50',
    'bg-white'
  ].join(' ');

  // small download icon (stroke matches toolbar icons)
  b.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" class="opacity-80">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <path d="M7 10l5 5 5-5"/>
      <path d="M12 15V3"/>
    </svg>
    <span>Download Summary</span>
  `;

  b.addEventListener('click', (e) => {
    e.preventDefault();
    try { clickHandler?.(); } catch (err) { console.error(err); }
  });

  // Insert right after where ".doc" used to be
  docBtn.parentNode.insertBefore(b, docBtn.nextSibling);
}





  // ---------- Cards render ----------
  function renderExec(){
    const host = $('#page-exec'); if (!host) return;
    if (!host.querySelector('#exec-live')){
  const wrap = document.createElement('div'); 
  wrap.id = 'exec-live';
  wrap.innerHTML = `
    <div class="grid grid-cols-1 gap-3">
      <!-- Tiles -->
      <div id="exec-tiles" class="grid grid-cols-2 sm:grid-cols-6 gap-3"></div>

            <!-- Charts row -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">

        <!-- Radar -->
        <div class="bg-white rounded-2xl border shadow p-3 flex flex-col max-h-[420px]" id="card-radar">
          <div class="text-base font-semibold">Exceptions Radar</div>
          <div class="text-xs text-gray-500">Risk-normalized (0–100)</div>
          <div class="flex-1 min-h-[260px] flex items-center justify-center">
            <div id="radar-slot" class="w-full flex items-center justify-center"></div>
          </div>
          <div id="radar-note" class="mt-2 text-xs text-gray-500 text-center"></div>
        </div>

        <!-- Donut -->
        <div class="bg-white rounded-2xl border shadow p-3 flex flex-col max-h-[420px]" id="card-donut">
          <div class="flex items-baseline justify-between">
            <div>
              <div class="text-base font-semibold leading-tight">Planned vs Applied</div>
              <div class="text-xs text-gray-500">Week scope (business TZ)</div>
            </div>
            <div id="donut-stats" class="text-sm font-semibold text-gray-700"></div>
          </div>
          <div class="flex-1 min-h-[260px] flex items-center justify-center">
            <div id="donut-slot" class="w-full flex items-center justify-center"></div>
          </div>
        </div>

      </div>

      <!-- Timeline -->
      <div class="bg-white rounded-2xl border shadow p-3 overflow-hidden" id="card-timeline">
<div class="flex items-center justify-between">
  <div>
    <div class="text-base font-semibold">Week Timeline</div>
    <div class="text-xs text-gray-500 -mt-0.5">Planned vs Actual</div>
  </div>
  <button id="timeline-edit-btn" class="text-xs px-2 py-1 rounded-full border text-gray-600 hover:bg-gray-50">
    Edit actuals
  </button>
    </div>
  <div id="timeline-editor" class="hidden mt-2">

  <div class="grid grid-cols-2 md:grid-cols-6 gap-2">

    <label class="text-xs text-gray-600">
      Baseline (Actual)
      <input id="ba-act" type="date" class="w-full border rounded px-2 py-1 text-sm">
    </label>

    <label class="text-xs text-gray-600">
      Inventory (Actual)
      <input id="in-act" type="date" class="w-full border rounded px-2 py-1 text-sm">
    </label>
    <label class="text-xs text-gray-600">
      Processing (Actual)
      <input id="pr-act" type="date" class="w-full border rounded px-2 py-1 text-sm">
    </label>
    <label class="text-xs text-gray-600">
      Dispatched (Actual)
      <input id="di-act" type="date" class="w-full border rounded px-2 py-1 text-sm">
    </label>
    <label class="text-xs text-gray-600">
      Completion %
      <input id="ops-pct" type="number" min="0" max="100" step="1" placeholder="0–100" class="w-full border rounded px-2 py-1 text-sm">
    </label>
    <div class="flex items-end gap-2">
      <button id="timeline-save" class="px-3 py-1 rounded bg-rose-700 text-white text-xs">Save</button>
      <button id="timeline-cancel" class="px-3 py-1 rounded border text-xs">Cancel</button>
    </div>
  </div>
</div>
<div id="timeline-slot" class="min-h-[140px] mt-2"></div>

      </div>


      <!-- Exception widgets -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="bg-white rounded-2xl border shadow p-4" id="card-pareto">
          <div class="text-base font-semibold mb-1">Top Gap Drivers (PO × SKU)</div>
          <div class="text-xs text-gray-500 mb-2">Planned − Applied</div>
          <div id="pareto-list" class="space-y-2"></div>
        </div>

        <div class="bg-white rounded-2xl border shadow p-4" id="card-heavy">
          <div class="text-base font-semibold mb-1">Heavy Bins Snapshot</div>
          <div class="text-xs text-gray-500 mb-2">weight_kg > 12</div>
          <table class="w-full text-sm"><thead class="text-gray-500">
            <tr><th class="text-left py-1 pr-2">Bin</th><th class="text-right py-1 pr-2">Units</th><th class="text-right py-1 pr-2">kg</th><th class="text-right py-1">SKU div.</th></tr>
          </thead><tbody id="heavy-body"><tr><td colspan="4" class="text-xs text-gray-400 text-center py-3">Loading…</td></tr></tbody></table>
          <div id="heavy-foot" class="text-xs text-gray-500 mt-2"></div>
        </div>

        <div class="bg-white rounded-2xl border shadow p-4" id="card-anom">
          <div class="text-base font-semibold mb-1">Intake Anomalies</div>
          <div class="text-xs text-gray-500 mb-2">Daily/Hourly sparkline</div>
          <div id="anom-spark"></div>
          <div id="anom-badges" class="mt-2 text-xs text-gray-600"></div>
        </div>
      </div>
    </div>`;
  host.appendChild(wrap);

  // paint ghost charts immediately
  renderDonutWithBaseline(document.getElementById('donut-slot'), 0, 0);
  renderRadarWithBaseline(
    document.getElementById('radar-slot'),
    ['Dup UIDs','Avg SKU %Δ','Avg PO %Δ','Heavy bins','Diversity (heavy)','Late appliers %'],
    [55,50,45,60,50,40],
    null,
    { size: 340 }
  );}

// ---- DEBUG: Exec data snapshot (runs once) ----
if (!window.__execDebugOnce) {
  window.__execDebugOnce = true;
  (function () {
    const out = {};
    out.hash = location.hash;
    out.execContainer = !!document.querySelector('#page-exec');
    out.execLive = !!document.querySelector('#exec-live');

    const s = window.state || {};
    out.stateKeys = Object.keys(s);
    out.weekStart = s.weekStart;
    out.planCount = Array.isArray(s.plan) ? s.plan.length : -1;
    out.recordsCount = Array.isArray(s.records) ? s.records.length : -1;
    out.binsCount = Array.isArray(s.bins) ? s.bins.length : -1;

    const plan = Array.isArray(s.plan) ? s.plan : [];
    out.planSample = plan.slice(0, 3).map(p => ({
      po: p.po_number, sku: p.sku_code, target_qty: p.target_qty, due_date: p.due_date
    }));

    const BUSINESS_TZ = document.querySelector('meta[name="business-tz"]')?.content || 'Asia/Shanghai';
    const toISODate = v => { const d=new Date(v); const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; };
    const weekEndISO = ws => { const d=new Date(ws); d.setDate(d.getDate()+6); return toISODate(d); };
    const bizYMDFromRecord = r => r?.date_local ? String(r.date_local).trim()
      : (r?.completed_at && typeof window.ymdFromCompletedAtInTZ==='function'
          ? window.ymdFromCompletedAtInTZ(r.completed_at, BUSINESS_TZ) : '');

    if (s.weekStart) {
      const ws = s.weekStart, we = weekEndISO(ws);
      out.weekEnd = we;
      const wk = (Array.isArray(s.records)? s.records:[]).filter(r=>{
        if (r?.status !== 'complete') return false;
        const ymd = bizYMDFromRecord(r);
        return ymd && ymd >= ws && ymd <= we;
      });
      out.wkRecordsCount = wk.length;
      out.wkRecordDatesSample = (s.records||[]).slice(0,5).map(r=>({
        uid:r.uid, status:r.status, date_local:r.date_local, completed_at:r.completed_at, ymd: bizYMDFromRecord(r)
      }));
    }

    const toNum = window.toNum || (x => Number(String(x||0).replace(/[, ]/g,'')));
    out.plannedTotal = plan.reduce((sum,p)=> sum + toNum(p.target_qty), 0);

    console.log('[Exec DEBUG] Snapshot below:');
    console.table(out.planSample);
    console.table(out.wkRecordDatesSample || []);
    console.log(out);
  })();
}



    const m = computeExecMetrics(); if (!m) return;

// cache for use outside this scope (e.g., PDF click handler)
window.__execLastMetrics = m;


const donutStatsEl = document.getElementById('donut-stats');
if (donutStatsEl) {
  donutStatsEl.textContent = `Planned ${fmt(m.plannedTotal)} · Applied ${fmt(m.appliedTotal)}`;
}


// compute sizes from actual slots (use stable sizes so charts don’t vanish)
const donutSlot = document.getElementById('donut-slot');
const radarSlot = document.getElementById('radar-slot');

// lock sensible sizes; avoid depending on parent heights which can be 0 during layout
const donutSize = 340;  // px canvas for donut
const radarSize = 420;  // px canvas for radar


    // Tiles
    const tiles = [
      {label:'Completion %', value: `${m.completionPct}%`},
      {label:'Duplicate UIDs', value: fmt(m.dupScanCount)},
      {label:'Avg SKU %Δ', value: `${m.avgSkuDiscPct}%`},
      {label:'Avg PO %Δ', value: `${m.avgPoDiscPct}%`},
      {label:'Heavy bins >12kg', value: fmt(m.heavyCount)},
      {label:'Late appliers', value: `${fmt(m.lateCount)} (${m.lateRatePct}%)`},
    ];
    const tilesWrap = $('#exec-tiles');
const tileHelp = {
  'Completion %': 'Applied units ÷ planned units for the week. If planned = 0: 100% when applied > 0, else 0%.',
  'Duplicate UIDs': 'Same SKU+UID scanned more than once during the week.',
  'Avg SKU %Δ': 'Avg absolute % diff per SKU: |applied − planned| ÷ planned.',
  'Avg PO %Δ': 'Avg absolute % diff per PO: |applied − planned| ÷ planned.',
  'Heavy bins >12kg': 'Distinct mobile bins with weight_kg > 12 this week.',
  'Late appliers': 'Applied after earliest PO due date (count and rate).'
};

tilesWrap.innerHTML = tiles.map(t=>
  `<div class="bg-white rounded-2xl border shadow p-4" title="${tileHelp[t.label] || ''}">
    <div class="text-xs text-gray-500">${t.label}</div>
    <div class="text-xl font-bold tabular-nums">${t.value}</div>
  </div>`
).join('');


    // Radar (normalize to risk index)
    const targets = {
      dup: 0, // any >0 is risk
      skuDisc: 5, // %
      poDisc: 5,  // %
      heavy: 3,   // count
      diversity: 4, // desired >=4 (invert)
      lateRate: 5 // %
    };
    const axes = ['Dup UIDs','Avg SKU %Δ','Avg PO %Δ','Heavy bins','Diversity (heavy)','Late appliers %'];
    const values = [
      clamp(m.dupScanCount>0 ? 100 : 0, 0, 100),
      clamp((m.avgSkuDiscPct/targets.skuDisc)*100, 0, 100),
      clamp((m.avgPoDiscPct/targets.poDisc)*100, 0, 100),
      clamp((m.heavyCount/targets.heavy)*100, 0, 100),
      clamp(((targets.diversity>0? (Math.max(0, targets.diversity - m.avgDiversityHeavy)/targets.diversity):0)*100), 0, 100),
      clamp((m.lateRatePct/targets.lateRate)*100, 0, 100)
    ];
        const topIdx = values.reduce((bi, v,i)=> v>values[bi]? i:bi, 0);
    $('#radar-note').textContent = `Top driver: ${axes[topIdx]} (${Math.round(values[topIdx])})`;

        // Pareto list
    const list = m.topGap.map(row=>{
      const sign = row.gap>0? '+' : ''; const color = row.gap>0? 'text-rose-600' : 'text-green-600';
      return `<div class="flex items-center justify-between text-sm">
        <div class="truncate"><span class="text-gray-500">${row.po}</span> · <span>${row.sku}</span></div>
        <div class="tabular-nums ${color}">${sign}${fmt(row.gap)}</div>
      </div>`;
    }).join('') || '<div class="text-xs text-gray-400">No gaps.</div>';
    $('#pareto-list').innerHTML = list;

    // Heavy bins tablelet
    const bins = Array.isArray(window.state?.bins) ? window.state.bins : [];
    const heavy = bins.filter(b=> Number(b.weight_kg||0) > 12);
    const ws = m.ws, we = m.we;
    // Build units & diversity from week records
    const wkRecords = (window.state?.records||[]).filter(r=>{
  const ymd = bizYMDFromRecord(r);
  if (!(ymd && ymd >= ws && ymd <= we)) return false;
  const st = String(r?.status || '').toLowerCase();
  return st === 'complete' || st === 'applied' || !!r.uid;
});

// Sorted unique YMDs for timeline (used to infer Processing Actual midpoint if needed)
m._wkDatesSorted = Array.from(new Set(
  wkRecords.map(r => bizYMDFromRecord(r)).filter(Boolean)
)).sort();


    const unitsByBin = new Map(); const skuSetByBin = new Map();
    for (const r of wkRecords){ const bin = String(r.mobile_bin||'').trim(); const sku = String(r.sku_code||'').trim(); if(!bin) continue; unitsByBin.set(bin,(unitsByBin.get(bin)||0)+1); if(sku){ if(!skuSetByBin.has(bin)) skuSetByBin.set(bin,new Set()); skuSetByBin.get(bin).add(sku); } }
    const rows = heavy.slice(0,3).map(b=>{
      const id = String(b.mobile_bin||'').trim();
      return `<tr class="odd:bg-gray-50">
        <td class="py-1 pr-2">${id||'—'}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${fmt(unitsByBin.get(id)||0)}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${Number(b.weight_kg||0).toFixed(1)}</td>
        <td class="py-1 text-right tabular-nums">${fmt(skuSetByBin.get(id)?.size||0)}</td>
      </tr>`;
    }).join('');
    $('#heavy-body').innerHTML = rows || `<tr><td colspan="4" class="text-xs text-gray-400 text-center py-3">No heavy bins this week.</td></tr>`;
    const avgDiv = m.avgDiversityHeavy ? m.avgDiversityHeavy.toFixed(2) : '0.00';
    $('#heavy-foot').textContent = `Heavy bins: ${fmt(m.heavyCount)} · Avg diversity: ${avgDiv}`;

    // Anomaly sparkline — simple daily buckets
    const dayLabels=[]; const counts=[];
    const start = new Date(ws+'T00:00:00');
    for (let i=0;i<7;i++){ const d=new Date(start); d.setDate(d.getDate()+i); const ymd=toISODate(d); dayLabels.push(ymd); counts.push(0); }
    for (const r of wkRecords){ const ymd=bizYMDFromRecord(r); const idx=dayLabels.indexOf(ymd); if (idx>=0) counts[idx]++; }
    $('#anom-spark').innerHTML = sparklineSVG(counts);
    // basic z-score flags
    const mean = counts.reduce((s,v)=>s+v,0)/Math.max(1,counts.length);
    const std = Math.sqrt(counts.reduce((s,v)=> s + Math.pow(v-mean,2),0)/Math.max(1,counts.length));
    let dips=0, spikes=0; const lo=mean - 1.5*std, hi=mean + 1.5*std;
    for (const v of counts){ if (v < lo) dips++; else if (v > hi) spikes++; }
    $('#anom-badges').textContent = `Dips: ${dips} · Spikes: ${spikes}`;


renderDonutWithBaseline(donutSlot, m.plannedTotal, m.appliedTotal, { size: donutSize });
renderRadarWithBaseline(radarSlot, axes, [55,50,45,60,50,40], values, { size: radarSize });

// (Optional) If you have actuals for this week, feed them explicitly:
/// m.inventoryActualYMD  = '2025-11-03'; // example
/// m.dispatchedActualYMD = '2025-11-09'; // example


// ---- Ops completion % (override) + display default from tile -------------
const _opsOverrideRaw =
  (window.state?.ops?.completion_pct ??
   window.state?.milestones?.completion_pct ??
   window.state?.completion_pct);

m._opsCompletionPct =
  (Number.isFinite(Number(_opsOverrideRaw))
    ? Math.max(0, Math.min(100, Number(_opsOverrideRaw)))
    : null);

// What we show on the timeline label by default (override wins, else tile %)
m._opsDisplayPct = (m._opsCompletionPct != null)
  ? m._opsCompletionPct
  : m.completionPct;  // from tiles


// ---- Feed actual dates for the timeline (Ops-entered only; no inference) ----
{
  const ms = window.state?.milestones || {};

  // Merge cached timeline actuals from localStorage (only if server/state didn't supply them)
  try {
    const wk = m.ws || window.state?.weekStart;
    if (wk) {
      const raw = localStorage.getItem(`exec:timeline:${wk}`);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && typeof cached === 'object') {
          ms.baseline_actual_ymd   = ms.baseline_actual_ymd   ?? cached.baseline_actual_ymd   ?? undefined;
          ms.inventory_actual_ymd  = ms.inventory_actual_ymd  ?? cached.inventory_actual_ymd  ?? undefined;
          ms.processing_actual_ymd = ms.processing_actual_ymd ?? cached.processing_actual_ymd ?? undefined;
          ms.dispatched_actual_ymd = ms.dispatched_actual_ymd ?? cached.dispatched_actual_ymd ?? undefined;
        }
      }
    }
  } catch (_) {
    // ignore cache errors
  }

  const invOverride  =
    ms.inventory_actual_ymd  ||
    window.state?.inventory_actual_ymd ||
    window.state?.inventoryActualYMD ||
    null;

  const procOverride =
    ms.processing_actual_ymd ||
    window.state?.processing_actual_ymd ||
    window.state?.processingActualYMD ||
    null;

  const dispOverride =
    ms.dispatched_actual_ymd ||
    window.state?.dispatched_actual_ymd ||
    window.state?.dispatchedActualYMD ||
    null;

  // Assign only Ops-entered values; otherwise keep null so the bar stays grey.
m.baselineActualYMD   = ms.baseline_actual_ymd || null;   
  m.inventoryActualYMD  = invOverride;
  m.processingActualYMD = procOverride;
  m.dispatchedActualYMD = dispOverride;
}

// Timeline (planned vs actual) — render once, here
const timelineSlot = document.getElementById('timeline-slot');
if (timelineSlot) renderExecTimeline(timelineSlot, m);

// now that DOM exists, (re)wire the editor idempotently
wireTimelineEditor(m);
}

// ===== Inline editor for actuals / Ops % =====
// ===== Inline editor for actuals / Ops % =====
function wireTimelineEditor(m) {
  const btn    = document.getElementById('timeline-edit-btn');
  const pane   = document.getElementById('timeline-editor');
  const save   = document.getElementById('timeline-save');
  const cancel = document.getElementById('timeline-cancel');
  const inAct  = document.getElementById('in-act');
  const prAct  = document.getElementById('pr-act');
  const diAct  = document.getElementById('di-act');
  const opsPct = document.getElementById('ops-pct');
const baAct = document.getElementById('ba-act');


function hydrateInputs() {
  const s  = window.state || {};
  const ms = s.milestones || {};

// 🔹 pull cached timeline edits for this week once, if state doesn’t have them
  try {
    const wk = s.weekStart || m.ws;
    if (wk) {
      const raw = localStorage.getItem(`exec:timeline:${wk}`);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && typeof cached === 'object') {
          ms.baseline_actual_ymd   = ms.baseline_actual_ymd   ?? cached.baseline_actual_ymd   ?? undefined;
          ms.inventory_actual_ymd  = ms.inventory_actual_ymd  ?? cached.inventory_actual_ymd  ?? undefined;
          ms.processing_actual_ymd = ms.processing_actual_ymd ?? cached.processing_actual_ymd ?? undefined;
          ms.dispatched_actual_ymd = ms.dispatched_actual_ymd ?? cached.dispatched_actual_ymd ?? undefined;
          // (optional) ms.completion_pct = ms.completion_pct ?? cached.completion_pct ?? undefined;
        }
      }
    }
  } catch (_) {}


  baAct.value = (ms.baseline_actual_ymd   || m.baselineActualYMD   || '').slice(0, 10);
  inAct.value = (ms.inventory_actual_ymd  || m.inventoryActualYMD  || '').slice(0, 10);
  prAct.value = (ms.processing_actual_ymd || m.processingActualYMD || '').slice(0, 10);
  diAct.value = (ms.dispatched_actual_ymd || m.dispatchedActualYMD || '').slice(0, 10);

  // Prefer ops override, then milestone override; leave empty if none
  const pctOverride =
    (s.ops && Number.isFinite(Number(s.ops.completion_pct)) ? Number(s.ops.completion_pct) :
     Number.isFinite(Number(ms.completion_pct)) ? Number(ms.completion_pct) :
     null);

  opsPct.value = (pctOverride == null) ? '' : String(pctOverride);

  // If no override is set, show the computed tile % as a hint
  opsPct.placeholder = (pctOverride == null)
    ? String(m.completionPct)
    : ''; // no placeholder when an explicit override exists
}


  // Bind once per page life; safe across re-renders
  if (!btn || !pane || !save || !cancel) return;
  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

baAct.value  = (window.state?.milestones?.baseline_actual_ymd || m.baselineActualYMD || '').slice(0,10);

  // Initial fill
  hydrateInputs();

// Show the computed tile % as a hint if no override is set
if (!opsPct.value) opsPct.placeholder = String(m.completionPct);


  btn.onclick = (e) => {
    e?.preventDefault?.();
    hydrateInputs();           // <-- refresh from latest state each time
    pane.classList.toggle('hidden');
  };

  cancel.onclick = (e) => {
    e?.preventDefault?.();
    pane.classList.add('hidden');
  };

save.onclick = (e) => {
  e?.preventDefault?.();

  const s  = window.state || (window.state = {});
  const ms = s.milestones || (s.milestones = {});

  // normalize to YYYY-MM-DD (first 10 chars)
  const norm = (x) => (x || '').trim().slice(0, 10) || undefined;

  const vBa  = norm(baAct.value);
  const vIn  = norm(inAct.value);
  const vPr  = norm(prAct.value);
  const vDi  = norm(diAct.value);
  const vPctRaw = (opsPct.value || '').trim();

  // write to state
  ms.baseline_actual_ymd   = vBa;
  ms.inventory_actual_ymd  = vIn;
  ms.processing_actual_ymd = vPr;
  ms.dispatched_actual_ymd = vDi;

  // 2) ⬇️ INSERT THIS COMPLETION-% BLOCK RIGHT HERE ⬇️
  const valNum = Number(vPctRaw);
  if (vPctRaw !== '' && Number.isFinite(valNum)) {
    const n = Math.round(Math.max(0, Math.min(100, valNum)));
    s.ops = s.ops || {};
    s.ops.completion_pct = n;
    ms.completion_pct    = n;
  } else {
    if (s.ops) delete s.ops.completion_pct;
    delete ms.completion_pct;
  }
  // 2) ⬆️ END INSERT ⬆️

  // Persist ONLY the timeline actuals (plus completion pct) per week
  try {
    const wk = s.weekStart;
    if (wk) {
      const payload = {
        baseline_actual_ymd:   ms.baseline_actual_ymd   || null,
        inventory_actual_ymd:  ms.inventory_actual_ymd  || null,
        processing_actual_ymd: ms.processing_actual_ymd || null,
        dispatched_actual_ymd: ms.dispatched_actual_ymd || null,
        completion_pct:        (ms.completion_pct ?? null)
      };
      localStorage.setItem(`exec:timeline:${wk}`, JSON.stringify(payload));
    }
  } catch (_) {
    // non-fatal
  }

  // Re-render and close panel
  window.dispatchEvent(new Event('state:ready'));
  document.getElementById('timeline-editor')?.classList.add('hidden');
};

}


// ===== PDF helpers (jsPDF + AutoTable + SVG capture) =====
async function __loadScript(src){
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function __ensurePdfLibs(){
  // already present?
  if (window.jspdf?.jsPDF && window.jspdf?.autoTable) return;

  // Load jsPDF UMD
  if (!window.jspdf?.jsPDF) {
    await __loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  }
  // Load AutoTable plugin
  if (!window.jspdf?.autoTable && !window.autoTable) {
    await __loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.3/dist/jspdf.plugin.autotable.min.js');
  }
}

function __serializeSvgToPngDataUrl(svgEl, scale = 2){
  return new Promise((resolve, reject) => {
    try {
      const xml = new XMLSerializer().serializeToString(svgEl);
      const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);

      const img = new Image();
      img.onload = () => {
        const w = svgEl.viewBox?.baseVal?.width  || svgEl.clientWidth  || 800;
        const h = svgEl.viewBox?.baseVal?.height || svgEl.clientHeight || 200;
        const canvas = document.createElement('canvas');
        canvas.width  = Math.max(1, Math.floor(w * scale));
        canvas.height = Math.max(1, Math.floor(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    } catch (err) { reject(err); }
  });
}


function _healthFromState(m) {
  // Try common places; normalize to a simple label
  const s = window.state || {};
  const raw =
    s.health?.status || s.health?.label || s.status ||
    s.health || ''; // allow a plain string

  const t = String(raw).toLowerCase();
  if (/healthy|good|green/.test(t)) return 'Healthy';
  if (/risk|at[\s-]?risk|red|poor|bad/.test(t)) return 'At Risk';
  if (/warn|attention|amber|yellow|caution/.test(t)) return 'Attention';
  // fallback: infer from completion if nothing supplied
  if (typeof m?.completionPct === 'number') {
    if (m.completionPct >= 90) return 'Healthy';
    if (m.completionPct >= 70) return 'Attention';
    return 'At Risk';
  }
  return ''; // don’t draw if truly unknown
}

function _drawHealthPill(doc, x, y, label) {
  if (!label) return;
  const styles = {
    'Healthy':   { fg: [255,255,255], bg: [5,150,105],  light: [231,246,239] }, // #059669 / #E7F6EF
    'Attention': { fg: [255,255,255], bg: [180,83,9],   light: [254,243,199] }, // #B45309 / #FEF3C7
    'At Risk':   { fg: [255,255,255], bg: [185,28,28],  light: [253,226,226] }  // #B91C1C / #FDE2E2
  }[label] || { fg: [255,255,255], bg: [107,114,128], light: [229,231,235] };

  const txt = `Health — ${label}`;
  doc.setFont('helvetica','bold'); doc.setFontSize(10);
  const tw = doc.getTextWidth(txt);
  const padX = 10, padY = 6, r = 12;
  const w = tw + padX*2, h = 20;

  // soft light halo
  doc.setDrawColor(...styles.light); doc.setFillColor(...styles.light);
  doc.roundedRect(x-2, y-2, w+4, h+4, r, r, 'F');

  // main pill
  doc.setFillColor(...styles.bg);
  doc.roundedRect(x, y, w, h, r, r, 'F');

  // text
  doc.setTextColor(...styles.fg);
  doc.text(txt, x + padX, y + h/2 + 3); // vertical centering nudge
  doc.setTextColor(0);
}



async function __buildExecSummaryPDF(m){
  const { jsPDF } = window.jspdf;

  // A4 landscape: 842 x 595 pt
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

// page frame (thin border on every page)
function drawFrame() {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  doc.setDrawColor(220);         // light grey
  doc.setLineWidth(0.8);
  doc.roundedRect(24, 24, w-48, h-48, 6, 6); // 24pt margin frame
}



  const margin = { l: 40, r: 40, t: 56, b: 48 };
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const ws = m.ws || '';
  const we = m.we || '';

  // ---------- helpers ----------
  function footer(pageLabel='') {
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.setDrawColor(220);
    doc.line(margin.l, pageH - margin.b + 12, pageW - margin.r, pageH - margin.b + 12);
    doc.text('Confidential — For internal use only', margin.l, pageH - margin.b + 28);
    if (pageLabel) doc.text(pageLabel, pageW - margin.r, pageH - margin.b + 28, { align: 'right' });
  }
  async function addSvg(svgEl, x, y, w, h) {
    if (!svgEl) return;
    try {
      const url = await __serializeSvgToPngDataUrl(svgEl, 2);
      doc.addImage(url, 'PNG', x, y, w, h);
    } catch (e) { console.warn('[PDF] svg capture failed', e); }
  }



  // ============= 1) COVER =============
  {
    const hasLogo = !!window.PINPOINT_LOGO_URL;
    if (hasLogo) {
      try { doc.addImage(window.PINPOINT_LOGO_URL, 'PNG', margin.l, margin.t - 32, 120, 28); } catch {}
    }
    doc.setFont('helvetica','bold'); doc.setFontSize(22);
    doc.text('TIC - VelOZity VAS Processing Summary', margin.l, margin.t + 12);

    const now = new Date();
    const pad2 = (n)=>String(n).padStart(2,'0');
    const downloaded = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;

    doc.setFont('helvetica','normal'); doc.setFontSize(12);
    doc.text(`Date of download: ${downloaded}`, margin.l, margin.t + 42);
    doc.text(`Week of execution: ${ws} to ${we}`, margin.l, margin.t + 62);

// Insert health pill just below the week range
const healthLabel = _healthFromState(m);   // use metrics for fallback inference
_drawHealthPill(doc, margin.l, margin.t + 74, healthLabel);

drawFrame();

    footer('Page 1');
  }
// ============= 2) INDEX =============
{
  doc.addPage(); drawFrame();
  const hasLogo = !!window.PINPOINT_LOGO_URL;
  if (hasLogo) {
    try { doc.addImage(window.PINPOINT_LOGO_URL, 'PNG', margin.l, margin.t - 32, 120, 28); } catch {}
  }

  // Title
  doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.text('Index', hasLogo ? (margin.l + 140) : margin.l, margin.t - 12);

  // ---- Left-aligned section list
  doc.setFont('helvetica','normal'); doc.setFontSize(12);
  const items = [
    '1. Executive Summary',
    '2. Weekly Execution Summary',
    '3. Exceptions Detail',
    '4. Data Appendix'
  ];
  let y = margin.t + 10;
  items.forEach((t)=>{ doc.text(t, margin.l, y); y += 18; });

  // ---- FULL-WIDTH, LEFT-ALIGNED Tile definitions (below the list)
  // Box geometry
  const boxX = margin.l;
  const boxY = y + 12;                               // just under the list
  const boxW = pageW - margin.l - margin.r;          // full printable width
  const innerPad = 10;                                // padding inside the box

  // Title + content we will render first to measure height
  doc.setFont('helvetica','bold'); doc.setFontSize(12);
  doc.text('Tile definitions', boxX + innerPad, boxY + 18);

// ---- ASCII-only definitions (avoid Unicode glyphs that jsPDF Helvetica lacks)
const defs = [
  ['Completion %',    'Applied units / planned units for the week. If planned = 0: show 100% when applied > 0, otherwise 0%.'],
  ['Duplicate UIDs',  'Count of scans where the same SKU+UID pair appears more than once during the week.'],
  ['Avg SKU % delta', 'Average absolute % difference per SKU: |applied - planned| / planned, averaged across SKUs in plan.'],
  ['Avg PO % delta',  'Average absolute % difference per PO: |applied - planned| / planned, averaged across POs in plan.'],
  ['Heavy bins >12kg','Distinct mobile bins with weight_kg > 12 observed in the week.'],
  ['Late appliers',   'Records where the applied date (business TZ) is later than the earliest due date of the record’s PO. Shows count and rate.']
];

// Two columns
doc.setFont('helvetica','normal'); doc.setFontSize(11);
const colGap = 16;
const colW   = Math.floor((boxW - innerPad*2 - colGap) / 2);

// Render into two columns with robust line-height
let cx = boxX + innerPad;
let cy = boxY + 36;
let maxY = cy;
const LINE = 13; // line height in pt

defs.forEach((row, i) => {
  const [k, v] = row;

  // key
  doc.setFont('helvetica','bold');
  doc.text(k, cx, cy);

  // value (wrapped)
  doc.setFont('helvetica','normal');
  const wrapped = doc.splitTextToSize(v, colW);
  const valueTop = cy + LINE;             // one line below the key
  doc.text(wrapped, cx, valueTop);

  // advance cursor
  const usedLines = 1 + wrapped.length;   // key + value lines
  cy = cy + usedLines * LINE + 6;         // small paragraph gap
  maxY = Math.max(maxY, cy);

  // jump to right column halfway
  if (i === Math.floor(defs.length / 2) - 1) {
    cx = boxX + innerPad + colW + colGap;
    cy = boxY + 36;
  }
});

// Draw container AFTER content so it hugs the text
const boxH = (maxY - (boxY + 6)) + innerPad;
doc.setDrawColor(255); // invisible box (keeps left alignment you wanted)
doc.roundedRect(boxX, boxY, boxW, Math.max(120, boxH), 6, 6, 'S');

  footer('Page 2');
}

  // ============= 3) ONE-PAGE EXEC SNAPSHOT =============
  {
    doc.addPage(); drawFrame();
    const hasLogo = !!window.PINPOINT_LOGO_URL;
    if (hasLogo) {
      try { doc.addImage(window.PINPOINT_LOGO_URL, 'PNG', margin.l, margin.t - 32, 120, 28); } catch {}
    }

    // Title + daterange
    doc.setFont('helvetica','bold'); doc.setFontSize(14);
    doc.text('1. Executive Summary', margin.l, margin.t - 12);
    doc.setFont('helvetica','normal'); doc.setFontSize(11);
    doc.text(`Week: ${ws} to ${we}`, pageW - margin.r, margin.t - 12, { align: 'right' });

    // Tiles (2 rows × 4)
// Replace the two labels in your Page 3 tiles array:
const tiles = [
  ['Completion %', `${m.completionPct ?? 0}%`],
  ['Planned',      Number(m.plannedTotal||0).toLocaleString()],
  ['Applied',      Number(m.appliedTotal||0).toLocaleString()],
  ['Dup UIDs',     String(m.dupScanCount||0)],
  ['Avg SKU % delta', `${m.avgSkuDiscPct ?? 0}%`],  // <-- changed
  ['Avg PO % delta',  `${m.avgPoDiscPct ?? 0}%`],   // <-- changed
  ['Heavy bins',      String(m.heavyCount||0)],
  ['Late appliers',   `${m.lateCount||0} (${m.lateRatePct||0}%)`],
];

    let y = margin.t + 6;
    const cols = 4, gutter = 8, cardH = 44;
    const cardW = (pageW - margin.l - margin.r - gutter*(cols-1)) / cols;
    const cardX = (i) => margin.l + (i % cols) * (cardW + gutter);
    const cardY = (i) => y + Math.floor(i / cols) * (cardH + gutter);

    tiles.forEach((t, i) => {
      const x = cardX(i), yy = cardY(i);
      doc.setDrawColor(235); doc.roundedRect(x, yy, cardW, cardH, 6, 6, 'S');
      doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(107);
      doc.text(t[0], x + 10, yy + 16);
      doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(17);
      doc.text(String(t[1]), x + cardW - 10, yy + 16, { align: 'right' });
      doc.setTextColor(0);
    });
    y += 2 * (cardH + gutter) + 12;

// Replace the old fitSvg with this:
function fitSvg(svgEl, maxW, maxH) {
  if (!svgEl) return { w: maxW, h: maxH };

  const vbW = svgEl.viewBox?.baseVal?.width  || svgEl.clientWidth  || parseFloat(svgEl.getAttribute('width'))  || 800;
  const vbH = svgEl.viewBox?.baseVal?.height || svgEl.clientHeight || parseFloat(svgEl.getAttribute('height')) || 800;

  // uniform scale to fit inside maxW × maxH
  const scale = Math.max(1e-6, Math.min(maxW / vbW, maxH / vbH));
  return { w: vbW * scale, h: vbH * scale };
}


// Charts row (two side-by-side)
const donutSvg = document.querySelector('#card-donut svg');
const radarSvg = document.querySelector('#card-radar svg');

const gap   = 12;
const maxW  = (pageW - margin.l - margin.r - gap) / 2;
const maxH  = 165;

const donutDims = fitSvg(donutSvg, maxW, maxH);
const radarDims = fitSvg(radarSvg, maxW, maxH);

const chartsTopY = y;  // keep a stable top

await addSvg(donutSvg, margin.l, chartsTopY, donutDims.w, donutDims.h);
await addSvg(radarSvg, margin.l + maxW + gap, chartsTopY, radarDims.w, radarDims.h);

// ---- captions under each chart
doc.setFont('helvetica', 'normal');
doc.setFontSize(11);
doc.setTextColor(60);

// centered under donut
doc.text(
  `Completion — ${Math.round(m.completionPct || 0)}%`,
  margin.l + donutDims.w / 2,
  chartsTopY + donutDims.h + 12,
  { align: 'center' }
);

// centered under radar
doc.text(
  'Exceptions Radar (0–100 risk scale)',
  margin.l + maxW + gap + (radarDims.w / 2),
  chartsTopY + radarDims.h + 12,
  { align: 'center' }
);

// advance y for timeline (after captions)
y = chartsTopY + Math.max(donutDims.h, radarDims.h) + 28;
doc.setTextColor(0);

// ---- timeline capture (force-render offscreen so we always get an SVG)
const tmp = document.createElement('div');
tmp.style.position = 'absolute';
tmp.style.left = '-99999px';
document.body.appendChild(tmp);
try {
  renderExecTimeline(tmp, m);                 // <- always render a fresh SVG for the PDF
  const svg = tmp.querySelector('svg');
  if (svg) {
    const tDims = fitSvg(svg, pageW - margin.l - margin.r, 110);
    await addSvg(svg, margin.l, y, tDims.w, tDims.h);
    y += tDims.h + 10;
  }
} finally {
  tmp.remove();
}
    footer('Page 3');
  }

// ============= 4) WEEKLY EXECUTION SUMMARY (POs & Mobile Bins) =============
{
  doc.addPage(); drawFrame();
  const hasLogo = !!window.PPINPOINT_LOGO_URL;
  if (hasLogo) { try { doc.addImage(window.PINPOINT_LOGO_URL, 'PNG', margin.l, margin.t - 32, 120, 28); } catch {} }

  doc.setFont('helvetica','bold'); doc.setFontSize(14);
  doc.text('3. Weekly Execution Summary', margin.l, margin.t - 12);

  // ---------- Aggregate by PO ----------
  const plan = Array.isArray(window.state?.plan) ? window.state.plan : [];
  const recs = Array.isArray(window.state?.records) ? window.state.records : [];

  const toNum = window.toNum || (x => Number(String(x||0).replace(/[, ]/g,'')));
  const ws = m.ws, we = m.we;
  const inWeek = (r) => {
    const ymd = (function(r){
      if (r?.date_local) return String(r.date_local).trim();
      if (r?.date) return String(r.date).trim();
      if (r?.completed_at && typeof window.ymdFromCompletedAtInTZ==='function') {
        const tz = document.querySelector('meta[name="business-tz"]')?.content || 'Asia/Shanghai';
        return window.ymdFromCompletedAtInTZ(r.completed_at, tz);
      }
      return '';
    })(r);
    return ymd && ymd >= ws && ymd <= we;
  };

  const plannedByPO = new Map();
  for (const p of plan) {
    const po = String(p.po_number || '').trim();
    if (!po) continue;
    plannedByPO.set(po, (plannedByPO.get(po) || 0) + toNum(p.target_qty));
  }

  const appliedByPO = new Map();
  for (const r of recs) {
    if (!inWeek(r)) continue;
    const po = String(r.po_number || '').trim();
    if (!po) continue;
    const q = Number.isFinite(Number(r.qty ?? r.quantity)) ? Number(r.qty ?? r.quantity) : 1;
    appliedByPO.set(po, (appliedByPO.get(po) || 0) + Math.max(0, q));
  }

  const allPOs = new Set([...plannedByPO.keys(), ...appliedByPO.keys()]);
  const poRows = [];
  for (const po of Array.from(allPOs).sort()) {
    const pl = plannedByPO.get(po)  || 0;
    const ap = appliedByPO.get(po)  || 0;
    const gp = pl - ap;
    poRows.push([po, pl.toLocaleString(), ap.toLocaleString(), gp.toLocaleString()]);
  }

  // ---------- AutoTable: PO summary ----------
  let y = margin.t + 6;
  const renderPOFallback = () => {
    doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.text('PO Summary (table unavailable)', margin.l, y); y += 14;
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    for (const row of poRows.slice(0, 20)) { doc.text(`${row[0]}   P:${row[1]}   A:${row[2]}   Gap:${row[3]}`, margin.l, y); y += 12; }
  };
  if (doc.autoTable) {
    try {
      doc.autoTable({
        startY: y,
        margin: { left: margin.l, right: margin.r },
        head: [['PO','Planned','Applied','Gap']],
        body: poRows,
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [48,48,48], textColor: [255,255,255] },
      });
      y = doc.lastAutoTable.finalY + 14;
    } catch { renderPOFallback(); }
  } else { renderPOFallback(); }

  // ---------- Aggregate by Mobile Bin ----------
  const bins = Array.isArray(window.state?.bins) ? window.state.bins : [];

  // bins may or may not have dates—helper to read one if present
  const binYMD = (b) => {
    const s = String(b?.created_at_local || b?.created_at || b?.date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{2}-\d{2}-\d{4}$/.test(s)) { const [d,m,y]=s.split('-'); return `${y}-${m}-${d}`; }
    return '';
  };

  const wkRecs = recs.filter(inWeek);
  const binsReferencedThisWeek = new Set(
    wkRecs.map(r => String(r.mobile_bin || '').trim()).filter(Boolean)
  );

  const binsInWeek = bins.filter(b => {
    const ymd = binYMD(b);
    if (ymd) return (ymd >= ws && ymd <= we);
    const id = String(b.mobile_bin || '').trim();
    return id && binsReferencedThisWeek.has(id);
  });

  const weightByBin = new Map();
  for (const b of binsInWeek) {
    const id = String(b.mobile_bin || '').trim(); if (!id) continue;
    const kg = Number(b.weight_kg || 0);
    if (!weightByBin.has(id) || (kg > 0 && (weightByBin.get(id) || 0) === 0)) {
      weightByBin.set(id, Number.isFinite(kg) ? kg : 0);
    }
  }

  const unitsByBin = new Map();
  for (const r of wkRecs) {
    const id = String(r.mobile_bin || '').trim(); if (!id) continue;
    unitsByBin.set(id, (unitsByBin.get(id) || 0) + 1);
  }

  const binIds = Array.from(new Set([...weightByBin.keys(), ...unitsByBin.keys()])).sort();
  const binRows = binIds.map(id => {
    const units = unitsByBin.get(id) || 0;
    const kg    = weightByBin.get(id) || 0;
    const avg   = units > 0 ? (kg / units) : 0;
    return [id, String(units), kg.toFixed(1), avg.toFixed(2)];
  });

  // ---------- AutoTable: Mobile bins ----------
  const renderBinsFallback = () => {
    doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.text('Mobile Bins (table unavailable)', margin.l, y); y += 14;
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    for (const row of binRows.slice(0, 24)) { doc.text(`${row[0]}   Units:${row[1]}   kg:${row[2]}   Avg:${row[3]}`, margin.l, y); y += 12; }
  };
  if (doc.autoTable) {
    try {
      doc.autoTable({
        startY: y,
        margin: { left: margin.l, right: margin.r },
        head: [['Mobile Bin','Units','Total kg','Avg kg/unit']],
        body: binRows,
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [48,48,48], textColor: [255,255,255] } // #303030
      });
      y = doc.lastAutoTable.finalY + 10;
    } catch { renderBinsFallback(); }
  } else { renderBinsFallback(); }

  footer(`Page ${doc.getNumberOfPages()}`);
}

  // ============= 5) EXCEPTIONS DETAIL =============
  {
    doc.addPage(); drawFrame();
    doc.setFont('helvetica','bold'); doc.setFontSize(14);
    doc.text('2. Exceptions Detail', margin.l, margin.t - 12);

    let y = margin.t + 2;

    // Top Gap Drivers (PO × SKU) — first 8 rows
    try {
      const head = [['PO','SKU','Planned','Applied','Gap']];
      const rows = (Array.isArray(m.topGap) ? m.topGap.slice(0,8) : []).map(g => [
        g.po || '', g.sku || '', String(g.planned ?? ''), String(g.applied ?? ''), String(g.gap ?? '')
      ]);
      doc.autoTable({
        startY: y,
        margin: { left: margin.l, right: margin.r },
        head, body: rows,
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [48,48,48], textColor: [255,255,255] } // #303030

      });
      y = doc.lastAutoTable.finalY + 12;
    } catch (e) { console.warn('[PDF] gaps table failed', e); }

    // Heavy Bins Snapshot — top 6
    try {
      const bins = Array.isArray(window.state?.bins) ? window.state.bins : [];
      const heavy = bins.filter(b => Number(b.weight_kg||0) > 12).slice(0,6);
      // compute units and sku diversity from week records
      const wkRecords = (window.state?.records || []).filter(r=>{
        const ymd = (function(r){
          if (r?.date_local) return String(r.date_local).trim();
          if (r?.date) return String(r.date).trim();
          if (r?.completed_at && typeof window.ymdFromCompletedAtInTZ==='function')
            return window.ymdFromCompletedAtInTZ(r.completed_at, document.querySelector('meta[name="business-tz"]')?.content || 'Asia/Shanghai');
          return '';
        })(r);
        return ymd && ymd >= ws && ymd <= we;
      });
      const unitsByBin = new Map(), skuSetByBin = new Map();
      for (const r of wkRecords) {
        const bin = String(r.mobile_bin||'').trim(); if (!bin) continue;
        unitsByBin.set(bin, (unitsByBin.get(bin)||0) + 1);
        const sku = String(r.sku_code||'').trim();
        if (sku) { if (!skuSetByBin.has(bin)) skuSetByBin.set(bin, new Set()); skuSetByBin.get(bin).add(sku); }
      }
      const head = [['Bin','Units','kg','SKU div.']];
      const rows = heavy.map(b => {
        const id = String(b.mobile_bin||'').trim();
        return [id || '—', String(unitsByBin.get(id)||0), String(Number(b.weight_kg||0).toFixed(1)), String(skuSetByBin.get(id)?.size || 0)];
      });
      doc.autoTable({
        startY: y,
        margin: { left: margin.l, right: margin.r },
        head, body: rows,
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [48,48,48], textColor: [255,255,255] } // #303030

      });
      y = doc.lastAutoTable.finalY + 12;
    } catch (e) { console.warn('[PDF] heavy bins table failed', e); }

    // Intake Anomalies — simple summary
    try {
      const sparkSvg = document.querySelector('#anom-spark svg');
      if (sparkSvg) {
        const imgW = (pageW - margin.l - margin.r) * 0.45;
        const vbW = sparkSvg.viewBox?.baseVal?.width || 280;
        const vbH = sparkSvg.viewBox?.baseVal?.height || 60;
        const imgH = Math.min(80, (imgW * vbH) / vbW);
        await addSvg(sparkSvg, margin.l, y, imgW, imgH);
      }
      const dipsSpikes = document.getElementById('anom-badges')?.textContent || '';
      doc.setFont('helvetica','normal'); doc.setFontSize(11);
      doc.text(dipsSpikes ? `Anomaly summary: ${dipsSpikes}` : 'Anomaly summary: —', margin.l, y + 95);
    } catch (e) { console.warn('[PDF] anomalies section failed', e); }

    footer('Page 4');
  }

// ============= 6) DATA APPENDIX =============
{
  doc.addPage(); drawFrame();
  doc.setFont('helvetica','bold'); doc.setFontSize(14);
  doc.text('3. Data Appendix', margin.l, margin.t - 12);

  try {
    const records = Array.isArray(window.state?.records) ? window.state.records : [];

    // Sort by PO then date
    const toYMD = (r) => (r.date_local || r.date || '');
    const sorted = [...records].sort((a,b) => {
      const pa = String(a.po_number || ''), pb = String(b.po_number || '');
      if (pa !== pb) return pa.localeCompare(pb);
      return String(toYMD(a)).localeCompare(String(toYMD(b)));
    });

    // Build grouped body: a PO header row followed by its rows (no weight, no qty)
    const body = [];
    let lastPO = null;
    for (const r of sorted) {
      const po = String(r.po_number || '').trim() || '—';
      if (po !== lastPO) {
        body.push([
          { content: `PO: ${po}`, colSpan: 6, styles: { fillColor: [242,242,242], fontStyle: 'bold' } }
        ]);
        lastPO = po;
      }
      body.push([
        r.uid || '',
        r.sku_code || '',
        r.mobile_bin || '',
        (r.status || ''),
        (r.date_local || r.date || ''),
        '' // keep total cols consistent with header colSpan
      ]);
    }

    doc.autoTable({
      startY: margin.t + 6,
      margin: { left: margin.l, right: margin.r },
      head: [['UID','SKU','Mobile Bin','Status','Date (Local)','']], // 6 columns total (last is empty to match group header colSpan)
      body,
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [48,48,48], textColor: [255,255,255] }, // #303030
      bodyStyles: { textColor: [40,40,40] },
      pageBreak: 'auto'
    });
  } catch (e) {
    console.warn('[PDF] AutoTable appendix failed:', e);
    doc.setFont('helvetica','italic'); doc.setFontSize(11);
    doc.text('Data appendix unavailable.', margin.l, margin.t + 24);
  }

  // show final page number
  const n = doc.getNumberOfPages();
  doc.setPage(n);
  footer(`Page ${n}`);
}


  return doc;
}


  // Render when Exec page is shown
  function onHash(){
    const hash = location.hash || '#dashboard';
    if (hash === '#exec') _execTryRender();
  }
  window.addEventListener('hashchange', onHash);
  // Also render once if Exec is already selected
  if ((location.hash||'#dashboard') === '#exec') setTimeout(_execTryRender, 0);

  // Re-render on week change from existing app
  const _oldSetWeek = window.setWeek;
  if (typeof _oldSetWeek === 'function'){
    window.setWeek = async function(ws){
      const r = await _oldSetWeek.apply(this, arguments);
      if ((location.hash||'#dashboard') === '#exec') setTimeout(_execTryRender, 0);
      return r;
    };
  }

async function _execLoadWeek(ws) {
  const s = window.state || (window.state = {});
  if (ws) s.weekStart = ws;
  // no fetch here on Exec
}

// Ensure state is populated for the selected week if Exec needs to fetch
async function execEnsureStateLoaded(ws) {
  const s = window.state || (window.state = {});
  const we = (window.weekEndISO || (w => { const d=new Date(w); d.setDate(d.getDate()+6); return d.toISOString().slice(0,10); }))(ws);

// Exec = read-only; do not fetch if disabled
if (EXEC_USE_NETWORK === false) {
// Ensure minimally required fields exist so downstream renderers are happy
if (!s.weekStart) s.weekStart = ws;
if (!Array.isArray(s.plan))    s.plan = [];
if (!Array.isArray(s.records)) s.records = [];
if (!Array.isArray(s.bins))    s.bins = [];
 return;
}


  const needPlan    = !Array.isArray(s.plan)    || s.plan.length === 0;
  const needRecords = !Array.isArray(s.records) || s.records.length === 0;
  const needBins    = !Array.isArray(s.bins);

  const [plan, records, bins] = await Promise.all([
    needPlan    ? fetchPlanForWeek(ws).catch(()=>[])         : Promise.resolve(s.plan),
    needRecords ? fetchRecordsForWeek(ws, we).then(x => x.records || []).catch(()=>[]) : Promise.resolve(s.records),
    needBins    ? fetchBinsForWeek(ws).catch(()=>[])         : Promise.resolve(s.bins),
  ]);

  s.plan    = Array.isArray(plan)    ? plan    : (s.plan || []);
  s.records = Array.isArray(records) ? records : (s.records || []);
  s.bins    = Array.isArray(bins)    ? bins    : (s.bins || []);
}



async function _execEnsureStateLoaded(ws) {
  const s = window.state || (window.state = {});
  if (ws) s.weekStart = ws;

  // compute weekEnd for records
  const we = (window.weekEndISO || (w => { const d=new Date(w); d.setDate(d.getDate()+6); return d.toISOString().slice(0,10); }))(s.weekStart);

  const needPlan    = !Array.isArray(s.plan)    || s.plan.length === 0;
  const needRecords = !Array.isArray(s.records) || s.records.length === 0;
  const needBins    = !Array.isArray(s.bins)    || s.bins.length === 0;

  if (!(needPlan || needRecords || needBins)) return;

  const [plan, records, bins] = await Promise.all([
    needPlan    ? fetchPlanForWeek(s.weekStart).catch(() => [])                                : Promise.resolve(s.plan),
    needRecords ? fetchRecordsForWeek(s.weekStart, we).then(x => x.records || []).catch(() => []) : Promise.resolve(s.records),
    needBins    ? fetchBinsForWeek(s.weekStart).catch(() => [])                                : Promise.resolve(s.bins),
  ]);

  s.plan    = Array.isArray(plan)    ? plan    : (s.plan || []);
  s.records = Array.isArray(records) ? records : (s.records || []);
  s.bins    = Array.isArray(bins)    ? bins    : (s.bins || []);
}


let _execBootTimer = null;


// --- Fallback: if Ops hasn't hydrated window.state on Exec, load minimal data once
async function __execEnsureStateLoaded() {
  const s = window.state || (window.state = {});

  // Ensure we at least have a weekStart
  if (!s.weekStart) {
    try {
      if (typeof window.todayInTZ === 'function' && typeof window.mondayOfInTZ === 'function') {
        const today = window.todayInTZ(BUSINESS_TZ);
        s.weekStart = window.mondayOfInTZ(today);
      } else {
        // plain Monday-of-week fallback
        const d = new Date();
        const day = (d.getDay() + 6) % 7; // 0 = Monday
        d.setHours(0,0,0,0);
        d.setDate(d.getDate() - day);
        s.weekStart = toISODate(d);
      }
    } catch {}
  }
  if (!s.weekStart) return; // nothing to do

  const ws = s.weekStart;
  const we = (window.weekEndISO || function (w) { const d=new Date(w); d.setDate(d.getDate()+6); return toISODate(d); })(ws);

  const hasPlan = Array.isArray(s.plan)    && s.plan.length > 0;
  const hasRecs = Array.isArray(s.records) && s.records.length > 0;
  const hasBins = Array.isArray(s.bins)    && s.bins.length > 0;
  if (hasPlan || hasRecs || hasBins) return; // already hydrated by Ops

  try {
    // Minimal endpoints: adjust the paths if your server uses different names
    const [plan, records, bins] = await Promise.all([
      g(`plan?weekStart=${ws}&weekEnd=${we}`),
      g(`records?weekStart=${ws}&weekEnd=${we}`),
      g(`bins?weekStart=${ws}&weekEnd=${we}`),
    ]);

    s.plan    = Array.isArray(plan)    ? plan    : [];
    s.records = Array.isArray(records) ? records : [];
    s.bins    = Array.isArray(bins)    ? bins    : [];

    // Let Exec render now, and also allow Ops to overwrite later if it wants
    window.dispatchEvent(new Event('state:ready'));
  } catch (e) {
    console.warn('[Exec fallback] fetch failed:', e);
  }
}


async function _execTryRender() {
  if (location.hash !== '#exec') return;

  const s = window.state || (window.state = {});

  // Keep the week Ops chose; only derive if still missing
  if (!s.weekStart && typeof window.todayInTZ === 'function' && typeof window.mondayOfInTZ === 'function') {
    try {
      const today = window.todayInTZ(BUSINESS_TZ);
      s.weekStart = window.mondayOfInTZ(today);
    } catch {}
  }
  if (!s.weekStart) return;


  // Ensure data exists at least once (fallback fetch), then continue
if (EXEC_USE_NETWORK) { 

await _execEnsureStateLoaded(s.weekStart); 
} 

const hasPlan = Array.isArray(s.plan) && s.plan.length > 0; 
const hasRecs = Array.isArray(s.records) && s.records.length > 0; 

if (!(hasPlan || hasRecs)) {
  if (EXEC_USE_NETWORK) {
    _execEnsureStateLoaded(s.weekStart)
      .then(() => {
  try {
    renderExec();

    // Add header "Download summary" and wire it to the PDF builder
ensureSummaryBtn(async () => {
  try {
    // use cached metrics or recompute as a fallback
    const metrics = window.__execLastMetrics || computeExecMetrics();
    if (!metrics) {
      alert('Sorry, metrics are not ready yet.');
      return;
    }

    await __ensurePdfLibs();
    const doc = await __buildExecSummaryPDF(metrics);
    const ws = (metrics.ws || window.state?.weekStart || '').replaceAll?.('-', '') || '';
    const fname = `VAS_Execution_Summary_${ws || 'week'}.pdf`;
    doc.save(fname);
  } catch (e) {
    console.error('[PDF] export failed:', e);
    alert('Sorry, failed to build the PDF. See console for details.');
  }
});

  } catch (e) {
    console.error('[Exec render error]', e);
  }
})

      .catch(e  => console.error('[Exec fetch error]', e));
  } else {
    // No network on Exec: render immediately with empty arrays (UI still shows baseline)
    try { renderExec(); } catch (e) { console.error('[Exec render error]', e); }
  }
  return;
}
 
try {
  renderExec();

ensureSummaryBtn(async () => {
  try {
    // use cached metrics or recompute as a fallback
    const metrics = window.__execLastMetrics || computeExecMetrics();
    if (!metrics) {
      alert('Sorry, metrics are not ready yet.');
      return;
    }

    await __ensurePdfLibs();
    const doc = await __buildExecSummaryPDF(metrics);
    const ws = (metrics.ws || window.state?.weekStart || '').replaceAll?.('-', '') || '';
    const fname = `VAS_Execution_Summary_${ws || 'week'}.pdf`;
    doc.save(fname);
  } catch (e) {
    console.error('[PDF] export failed:', e);
    alert('Sorry, failed to build the PDF. See console for details.');
  }
});

} catch (e) {
  console.error('[Exec render error]', e);
}


}


// 🔹 NEW: re-render exactly when the app signals data is ready
window.addEventListener('state:ready', _execTryRender);


  _execBootTimer = setInterval(_execTryRender, 600);
  document.addEventListener('visibilitychange', _execTryRender);
  setTimeout(_execTryRender, 0);


})();