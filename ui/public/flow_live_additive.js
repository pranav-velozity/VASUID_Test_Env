/* flow_live_additive.js (v61)
   - Additive "Flow" page module for VelOzity Pinpoint
   - Receiving + VAS are data-driven from existing endpoints
   - International Transit + Last Mile are lightweight manual (localStorage)
   - Milk Run is future (greyed)
*/

(function () {
  'use strict';


  // ------------------------- PATCH (v51.1) -------------------------
  // Guardrails to keep other modules from breaking Flow.
  // NOTE: Scripts load order is exec -> receiving -> flow (defer). Some helpers are expected globally.
  window.__FLOW_BUILD__ = "v63-lastmile-scheduled-table-fix" + new Date().toISOString();

  // Receiving module expects this helper; if missing it throws and can interrupt week load flows.
  if (typeof window.computeCartonsOutByPOFromState !== 'function') {
    window.computeCartonsOutByPOFromState = function computeCartonsOutByPOFromState(ws) {
      const m = new Map();
      if (!ws) return m;

      // Accept several possible shapes (Map, object, array).
      const src =
        ws.cartonsOutByPO ||
        ws.cartons_out_by_po ||
        ws.receiving?.cartonsOutByPO ||
        ws.receiving?.cartons_out_by_po ||
        ws.receiving?.cartonsOut ||
        ws.receiving?.cartons_out;

      if (src instanceof Map) return src;

      if (Array.isArray(src)) {
        for (const r of src) {
          if (!r) continue;
          const po = r.po ?? r.PO ?? r.po_number ?? r.PO_Number;
          const v = r.cartonsOut ?? r.cartons_out ?? r.value ?? r.count ?? r.qty ?? 0;
          if (po != null) m.set(String(po), Number(v) || 0);
        }
        return m;
      }

      if (src && typeof src === 'object') {
        for (const [k, v] of Object.entries(src)) m.set(String(k), Number(v) || 0);
      }
      return m;
    };
  }

  // Footer health pill can run before the footer exists on some navigations.
  if (typeof window.setFooterHealth === 'function' && !window.__FLOW_WRAPPED_FOOTER_HEALTH__) {
    window.__FLOW_WRAPPED_FOOTER_HEALTH__ = true;
    const __origSetFooterHealth = window.setFooterHealth;
    window.setFooterHealth = function (...args) {
      try {
        return __origSetFooterHealth.apply(this, args);
      } catch (e) {
        // Keep going; this is non-critical UI.
        console.warn('setFooterHealth suppressed', e);
        return null;
      }
    };
  }


  // ------------------------- Config (editable) -------------------------
  // Baseline is relative to the business week (Asia/Shanghai by default).
  // All cutoffs are soft: we only go "red" when we are meaningfully past the expected window.
  const BASELINE = {
    // Anchor: Monday 12:00 (week start in business TZ)
    receiving_due: { dayOffset: 0, time: '12:00' },

    // VAS: Mon 12:00 -> Fri 12:00
    vas_complete_due: { dayOffset: 4, time: '12:00' },

    // Origin readiness (packing list + export clearance) after VAS complete
    origin_ready_days_min: 2,
    origin_ready_days_max: 3,

    // International transit duration from origin-ready
    transit_days_sea: 14,
    transit_days_air: 7, // editable

    // Destination clearance + last mile from arrival
    last_mile_days_min: 3,
    last_mile_days_max: 5,

    // Soft tolerance windows
    soft_yellow_days: 0.75, // within ~18h of due
    soft_red_days: 2.0,     // beyond ~2 days late
  };

  // ------------------------- Utilities -------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function getApiBase() {
    const m = document.querySelector('meta[name="api-base"]');
    return (m?.content || '').replace(/\/$/, '');
  }
  function getBizTZ() {
    const m = document.querySelector('meta[name="business-tz"]');
    return m?.content || 'Asia/Shanghai';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function isoDate(d) {
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const da = pad2(d.getDate());
    return `${y}-${m}-${da}`;
  }

  // IMPORTANT: Week navigation uses UTC-midnight anchors (YYYY-MM-DDT00:00:00Z).
  // In non-UTC local timezones, isoDate() (local getters) can shift the day backward.
  // Use UTC getters for any weekStart computations.
  function isoDateUTC(d) {
    const y = d.getUTCFullYear();
    const m = pad2(d.getUTCMonth() + 1);
    const da = pad2(d.getUTCDate());
    return `${y}-${m}-${da}`;
  }

  // Format in business TZ with Intl (avoid heavy libs)
  function fmtInTZ(date, tz) {
    const d = (date instanceof Date) ? date : new Date(date);
    if (!d || isNaN(d)) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(d);
    } catch {
      try { return d.toISOString(); } catch { return ''; }
    }
  }

  function parseTimeHHMM(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { h: 0, min: 0 };
    return { h: Math.max(0, Math.min(23, Number(m[1]))), min: Math.max(0, Math.min(59, Number(m[2]))) };
  }

  // Make a Date representing a business-TZ local time on an ISO date.
  // We approximate by creating a UTC date from components and then formatting/using for comparisons.
  // For our use (soft thresholds), this is sufficient and avoids bringing in timezone libraries.
  function makeBizLocalDate(isoDay, hhmm, tz) {
    const [Y, M, D] = isoDay.split('-').map(Number);
    const { h, min } = parseTimeHHMM(hhmm);

    // Create an approximate UTC date, then adjust by the offset between UTC and tz at that moment.
    const approxUTC = new Date(Date.UTC(Y, (M - 1), D, h, min, 0));
    // Compute tz offset minutes at approxUTC by comparing formatted parts.
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      }).formatToParts(approxUTC);
      const get = (type) => Number(parts.find(p => p.type === type)?.value || 0);
      const y2 = get('year');
      const mo2 = get('month');
      const d2 = get('day');
      const h2 = get('hour');
      const mi2 = get('minute');
      const s2 = get('second');
      // The formatted parts represent the tz-local time of approxUTC. We want the UTC instant that corresponds
      // to the intended tz-local time Y-M-D h:min. So compute the delta and shift.
      const intendedUTC = new Date(Date.UTC(Y, (M - 1), D, h, min, 0));
      const observedUTC = new Date(Date.UTC(y2, (mo2 - 1), d2, h2, mi2, s2));
      const deltaMs = intendedUTC.getTime() - observedUTC.getTime();
      return new Date(approxUTC.getTime() + deltaMs);
    } catch {
      return approxUTC;
    }
  }

  function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  }

  function shiftWeekStart(ws, deltaWeeks) {
    try {
      // Always navigate by week starts anchored on **Monday**.
      // If the stored ws drifts (e.g., user navigated from a non-Monday),
      // normalize to the Monday of that week before shifting.
      const base = new Date(`${ws}T00:00:00Z`);
      if (isNaN(base)) return ws;

      // 0=Sun..6=Sat in UTC
      const dow = base.getUTCDay();
      const sinceMon = (dow + 6) % 7; // days since Monday
      const monday = addDays(base, -sinceMon);

      const next = addDays(monday, (Number(deltaWeeks) || 0) * 7);
      return isoDateUTC(next);
    } catch { return ws; }
  }

  function normalizeWeekStartToMonday(ws) {
    try {
      const base = new Date(`${ws}T00:00:00Z`);
      if (isNaN(base)) return ws;
      const dow = base.getUTCDay();
      const sinceMon = (dow + 6) % 7;
      const monday = addDays(base, -sinceMon);
      return isoDateUTC(monday);
    } catch {
      return ws;
    }
  }


  function daysBetween(a, b) {
    return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // UI helper: compact progress bar (pct: 0..100)
  function progressBar(pct, opts) {
    const p = clamp(Number(pct) || 0, 0, 100);
    const w = (opts && opts.w) ? opts.w : 'w-32';
    const h = (opts && opts.h) ? opts.h : 'h-2';
    const bg = (opts && opts.bg) ? opts.bg : 'bg-gray-100';
    const fill = (opts && opts.fill) ? opts.fill : 'bg-emerald-400';
    return `
      <div class="${w} ${h} ${bg} rounded-full overflow-hidden border" title="${Math.round(p)}%">
        <div class="h-full ${fill}" style="width:${p}%;"></div>
      </div>
    `;
  }
  function statusFromDue(due, actual, now) {
    // Soft cutoffs:
    // - if actual exists, compare actual to due
    // - else compare now to due
    const ref = actual || now;
    const lateDays = daysBetween(due, ref);
    if (lateDays <= BASELINE.soft_yellow_days) return { level: 'green', lateDays };
    if (lateDays <= BASELINE.soft_red_days) return { level: 'yellow', lateDays };
    return { level: 'red', lateDays };
  }

  function pill(level, upcoming=false) {
    // Upcoming phases use a lighter, more muted tint than active phases
    // so users can distinguish what"s ahead vs where we are now.
    if (level === 'green') return upcoming ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-emerald-100 text-emerald-800 border-emerald-200';
    if (level === 'yellow') return upcoming ? 'bg-amber-50 text-amber-600 border-amber-100' : 'bg-amber-100 text-amber-800 border-amber-200';
    if (level === 'red') return upcoming ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-rose-100 text-rose-800 border-rose-200';
    return upcoming ? 'bg-gray-50 text-gray-600 border-gray-200' : 'bg-gray-100 text-gray-700 border-gray-200';
  }

  function dot(level, upcoming=false) {
    // Muted dots for upcoming phases
    if (level === 'green') return upcoming ? 'bg-emerald-300' : 'bg-emerald-500';
    if (level === 'yellow') return upcoming ? 'bg-amber-300' : 'bg-amber-500';
    if (level === 'red') return upcoming ? 'bg-rose-300' : 'bg-rose-500';
    return upcoming ? 'bg-gray-300' : 'bg-gray-400';
  }

function statusLabel(level) {
  if (level === 'green') return 'On Track';
  if (level === 'yellow') return 'At Risk';
  if (level === 'red') return 'Delayed';
  return 'Future';
}

// Shared status color palette used across Flow renderers
const levelColor = (level) => ({
  green: '#34d399',
  red: '#fb7185',
  upcoming: '#cbd5e1',
  yellow: '#e6b800',
  gray: '#f6d365',
  future: '#e5e7eb',
}[level] || '#9ca3af');


function strokeForLevel(level, upcoming=false) {
    // Matte palette (less saturated)
    if (level === 'green') return upcoming ? '#d1fae5' : '#a7f3d0';
    if (level === 'red') return upcoming ? '#ffe4e6' : '#fecaca';
    return '#e5e7eb';
  }


const NODE_ICONS = {
  milk: `<svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 17h13l3 3h2v-6l-3-3H6z"/><path d="M6 17V7h10v7"/><path d="M6 11h10"/><circle cx="7.5" cy="20" r="1.5"/><circle cx="18.5" cy="20" r="1.5"/>
  </svg>`,
  receiving: `<svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 7h16v13H4z"/><path d="M4 7l8 6 8-6"/><path d="M8 20v-6"/><path d="M16 20v-6"/>
  </svg>`,
  vas: `<svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 8a4 4 0 1 0 4 4"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M4.9 4.9l2.1 2.1"/><path d="M17 17l2.1 2.1"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="M4.9 19.1l2.1-2.1"/><path d="M17 7l2.1-2.1"/>
  </svg>`,
  intl: `<svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 17h18"/><path d="M6 17l2-6h8l2 6"/><path d="M9 11V7h6v4"/><path d="M8 7h8"/>
  </svg>`,
  lastmile: `<svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
  </svg>`,
};

function iconSvg(id) {
  return NODE_ICONS[id] || '';
}

function iconDoc() {
  return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M7 3h7l3 3v15H7z"/><path d="M14 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>
  </svg>`;
}

function iconContainer() {
  return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M3 7h18v10H3z"/><path d="M7 7v10"/><path d="M12 7v10"/><path d="M17 7v10"/>
  </svg>`;
}

  async function api(path, opts) {
    const base = getApiBase();
    const url = `${base}${path}`;
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(await res.text());
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }


// ------------------------- Backend week-store wiring (SQLite) -------------------------
// Server endpoints (base is meta[name="api-base"]):
//   GET  /flow/week/:weekStart?facility=LKWF
//   POST /flow/week/:weekStart?facility=LKWF   { ...patch }
//
// Guardrail: when we "prime" from backend we suppress write-through to avoid loops.
function getFacility() {
  try {
    const f = (window.state && window.state.facility) ? String(window.state.facility).trim() : '';
    return f || 'LKWF';
  } catch { return 'LKWF'; }
}

async function fetchFlowWeek(ws, facility) {
  const f = String(facility || getFacility() || 'LKWF').trim() || 'LKWF';
  try {
    return await api(`/flow/week/${encodeURIComponent(ws)}?facility=${encodeURIComponent(f)}`);
  } catch (e) {
    return null;
  }
}

async function patchFlowWeek(ws, patch, facility) {
  const f = String(facility || getFacility() || 'LKWF').trim() || 'LKWF';
  if (!ws || !patch || typeof patch !== 'object') return null;
  if (window.__FLOW_SUPPRESS_BACKEND_WRITE__) return null;
  try {
    return await api(`/flow/week/${encodeURIComponent(ws)}?facility=${encodeURIComponent(f)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.warn('[flow] backend patch failed', e);
    return null;
  }
}

// Prime local week-scoped stores from backend once per (ws, facility).
async function primeFlowWeekFromBackend(ws) {
  const f = getFacility();
  window.__FLOW_PRIMED__ = window.__FLOW_PRIMED__ || {};
  const key = `${ws}::${f}`;

  // Re-prime when backend data changes (enables cross-browser sync without a full reload).
  // We store the last observed `updated_at` per (week, facility).
  const lastSeen = window.__FLOW_PRIMED__[key] || '';
  const r = await fetchFlowWeek(ws, f);
  const updatedAt = (r && (r.updated_at || r.updatedAt)) ? String(r.updated_at || r.updatedAt) : '';
  if (updatedAt && lastSeen === updatedAt) return;
  window.__FLOW_PRIMED__[key] = updatedAt || String(Date.now());

  const d = r && r.data ? r.data : null;
  if (!d) return;

  // Mirror into localStorage WITHOUT generating timestamps automatically.
  window.__FLOW_SUPPRESS_BACKEND_WRITE__ = true;
  try {
    // Week sign-off
    if ('receivingComplete' in d || 'vasComplete' in d || 'receivingAt' in d || 'vasAt' in d) {
      try {
        const o = {
          receivingComplete: !!d.receivingComplete,
          vasComplete: !!d.vasComplete,
          receivingAt: d.receivingAt || null,
          vasAt: d.vasAt || null,
          updatedAt: (r.updated_at || r.updatedAt || null),
        };
        localStorage.setItem(weekSignoffKey(ws), JSON.stringify(o));
      } catch {}
    }

    // Pre-booked containers
    if (d.prebook && typeof d.prebook === 'object') {
      try { localStorage.setItem(prebookKey(ws), JSON.stringify({ c20: num(d.prebook.c20 || 0), c40: num(d.prebook.c40 || 0) })); } catch {}
    }

    // Intl lane manual data (map laneKey -> obj)
    if (d.intl_lanes && typeof d.intl_lanes === 'object') {
      try {
        for (const [laneKey, obj] of Object.entries(d.intl_lanes)) {
          if (!laneKey) continue;
          localStorage.setItem(intlStorageKey(ws, laneKey), JSON.stringify(obj || {}));
        }
      } catch {}
    }

    // Week-level intl containers
    if (d.intl_weekcontainers) {
      try {
        const arr = Array.isArray(d.intl_weekcontainers) ? d.intl_weekcontainers : (Array.isArray(d.intl_weekcontainers.containers) ? d.intl_weekcontainers.containers : []);
        const state = { containers: arr || [], _v: 1, _fromBackend: true };
        localStorage.setItem(intlWeekContainersKey(ws), JSON.stringify(state));
      } catch {}
    }

    // Last Mile receipts
    if (d.lastmile_receipts && typeof d.lastmile_receipts === 'object') {
      try { localStorage.setItem(lastMileReceiptsKey(ws), JSON.stringify(d.lastmile_receipts || {})); } catch {}
    }
  } finally {
    window.__FLOW_SUPPRESS_BACKEND_WRITE__ = false;
  }
}

  function uniq(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
  }

  // ------------------------- Local storage for manual nodes -------------------------
  function flowKey(ws) {
    const facility = (window.state?.facility || '').trim() || 'default';
    return `vo_flow_v1:${facility}:${ws}`;
  }

  function loadFlowManual(ws) {
    try {
      const raw = localStorage.getItem(flowKey(ws));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function saveFlowManual(ws, data) {
    try {
      localStorage.setItem(flowKey(ws), JSON.stringify({ ...(data || {}), _updatedAt: new Date().toISOString() }));
    } catch { /* ignore */ }
  }

  
  function asArray(x) {
    if (Array.isArray(x)) return x;
    if (!x) return [];
    // Common API wrappers
    for (const k of ['items','rows','data','records','result','results']) {
      if (x && Array.isArray(x[k])) return x[k];
    }
    return [];
  }

// ------------------------- Data fetch (reusing existing endpoints) -------------------------
  async function loadPlan(ws) {
    // Prefer window.state.plan if it matches current ws
    const s = window.state || {};
    if (s.weekStart === ws && Array.isArray(s.plan) && s.plan.length) return s.plan;
    // Fallback to backend endpoints used elsewhere
    try { const r = await api(`/plan?weekStart=${encodeURIComponent(ws)}`); return asArray(r); } catch {}
    try { const r = await api(`/plan/weeks/${encodeURIComponent(ws)}`); return asArray(r); } catch {}
    return [];
  }

  async function loadReceiving(ws) {
    // Receiving module uses /receiving?weekStart=... and /receiving/weeks/:ws for saves.
    try { const r = await api(`/receiving?weekStart=${encodeURIComponent(ws)}`); return asArray(r); } catch {}
    try { const r = await api(`/receiving/weeks/${encodeURIComponent(ws)}`); return asArray(r); } catch {}
    return [];
  }

  async function loadRecords(ws, tz) {
    const s = window.state || {};
    if (s.weekStart === ws && Array.isArray(s.records) && s.records.length) return s.records;

    // Derive week range in ISO; keep it simple: ws..ws+6
    const wsD = new Date(`${ws}T00:00:00Z`);
    const weD = new Date(wsD.getTime());
    weD.setUTCDate(weD.getUTCDate() + 6);
    const from = `${ws}T00:00:00.000Z`;
    const to = `${isoDate(weD)}T23:59:59.999Z`;

    // Use the endpoint that Receiving stabilized for carton out, but we need all statuses for progress.
    // Prefer complete for performance, but fall back to all if API supports.
    try { const r = await api(`/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=complete&limit=500000`); const a = asArray(r); if (a && a.length) return a; } catch {}
    try { const r = await api(`/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500000`); return asArray(r); } catch {}
    return [];
  }

  // ------------------------- Computations -------------------------
  function normalizeSupplier(x) {
    return String(x || '').trim() || 'Unknown';
  }

  function normalizePO(x) {
    return String(x || '').trim().toUpperCase();
  }

  function getPO(row) {
    return normalizePO(
      row.po_number ?? row.poNumber ?? row.po_num ?? row.poNum ?? row.PO_Number ?? row.PO ?? row.po ?? row.PO_NO ?? row.po_no ?? ''
    );
  }

  function getSupplier(row) {
    return normalizeSupplier(
      row.supplier_name ?? row.supplierName ?? row.supplier ?? row.vendor ?? row.vendor_name ?? row.factory ?? row.Supplier ?? row.Vendor ?? ''
    );
  }

  function num(val) {
    if (val == null) return 0;
    if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
    const s = String(val).replace(/,/g, '').trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }


  function getPlanUnits(planRows) {
    // canonical field in this codebase is target_qty (Exec/Plan); keep fallbacks.
    return (planRows || []).reduce((acc, r) => {
      const n = num(r.target_qty ?? r.targetQty ?? r.planned_qty ?? r.plannedQty ?? r.qty ?? r.units ?? r.quantity ?? r.target ?? 0);
      return acc + n;
    }, 0);
  }

  function groupPlanBySupplier(planRows) {
  const m = new Map();
  for (const r of planRows || []) {
    const sup = getSupplier(r);
    const po = getPO(r);
    const units = num(r.target_qty ?? r.targetQty ?? r.planned_qty ?? r.plannedQty ?? r.qty ?? r.units ?? r.quantity ?? r.target ?? 0);
    if (!m.has(sup)) m.set(sup, { supplier: sup, pos: new Set(), units: 0 });
    const o = m.get(sup);
    if (po) o.pos.add(po);
    o.units += units;
  }
  return Array.from(m.values()).map(x => ({ supplier: x.supplier, poCount: x.pos.size, units: x.units }));
}

  function receivingByPO(receivingRows) {
    const m = new Map();
    for (const r of receivingRows || []) {
      const po = String(r.po_number || r.po || '').trim();
      if (!po) continue;
      m.set(po, r);
    }
    return m;
  }


function computeCartonStatsFromRecords(records) {
  // Match receiving_live_additive.js exactly:
  // - Records are usually already status=complete from the query, but be safe if status exists.
  // - PO: r.po_number || r.po || r.PO
  // - Mobile bin: r.mobile_bin || r.bin || r.mobileBin
  const sets = new Map(); // po -> Set(mobile_bin)
  const arr = asArray(records);
  for (const r of arr) {
    if (!r) continue;
    if (r.status && String(r.status).toLowerCase() !== 'complete') continue;
    const po = normalizePO(r.po_number || r.po || r.PO || '');
    if (!po) continue;
    const mb = String(r.mobile_bin || r.bin || r.mobileBin || '').trim();
    if (!mb) continue;
    if (!sets.has(po)) sets.set(po, new Set());
    sets.get(po).add(mb);
  }
  const cartonsOutByPO = new Map();
  let cartonsOutTotal = 0;
  for (const [po, set] of sets.entries()) {
    cartonsOutByPO.set(po, set.size);
    cartonsOutTotal += set.size;
  }
  return { cartonsOutByPO, cartonsOutTotal };
}


    function computeReceivingStatus(ws, tz, planRows, receivingRows, records) {
    const now = new Date();
    const due = makeBizLocalDate(ws, BASELINE.receiving_due.time, tz); // Monday noon
    const byPO = receivingByPO(receivingRows);

    const plannedPOs = uniq((planRows || []).map(r => getPO(r)).filter(Boolean));
    const receivedPOs = plannedPOs.filter(po => {
      const rec = byPO.get(po);
      return !!(rec && (rec.received_at_utc || rec.received_at || rec.received_at_local));
    });

    // Determine "last received" timestamp among planned POs
    let lastReceived = null;
    for (const po of receivedPOs) {
      const rec = byPO.get(po);
      const ts = rec?.received_at_utc || rec?.received_at || rec?.received_at_local;
      const d = ts ? new Date(ts) : null;
      if (d && !isNaN(d) && (!lastReceived || d > lastReceived)) lastReceived = d;
    }

    const st = statusFromDue(due, lastReceived, now);

    // Build PO -> Supplier and planned units by Supplier from plan (supplier often not present on records).
    const poToSup = new Map();
    for (const r of (planRows || [])) {
      const po = getPO(r);
      if (!po) continue;
      const sup = getSupplier(r);
      poToSup.set(po, sup);
    }

    // Late + missing POs
    const latePOs = plannedPOs.filter(po => {
      const rec = byPO.get(po);
      const ts = rec?.received_at_utc || rec?.received_at || rec?.received_at_local;
      if (!ts) return false;
      const d = new Date(ts);
      return !isNaN(d) && d.getTime() > due.getTime();
    });
    const missingPOs = plannedPOs.filter(po => !receivedPOs.includes(po));

    // Cartons In (from receiving rows)
    const cartonsInTotal = (receivingRows || []).reduce((acc, r) => acc + num(r.cartons_in ?? r.cartonsIn ?? r.cartons ?? r.cartons_received ?? 0), 0);

    // Cartons Out (from completed records): SAME as receiving_live_additive.js.
// Build a per-PO map (unique mobile bins per PO) and sum across POs for total.
    const cs = computeCartonStatsFromRecords(records);
    const cartonsOutByPO = cs.cartonsOutByPO || new Map();
    const cartonsOutTotal = cs.cartonsOutTotal || 0;

    // Cartons Out per supplier (sum of PO-level distinct bin counts)
    const cartonsOutBySup = new Map();
    for (const [po, cnt] of (cs.cartonsOutByPO || new Map()).entries()) {
      const sup = poToSup.get(po) || 'Unknown';
      cartonsOutBySup.set(sup, (cartonsOutBySup.get(sup) || 0) + (cnt || 0));
    }

    // Cartons In per supplier (from receiving rows)
    const cartonsInBySup = new Map();
    for (const r of (receivingRows || [])) {
      const sup = normalizeSupplier(r.supplier_name || r.supplier || r.vendor);
      const c = num(r.cartons_in ?? r.cartonsIn ?? r.cartons ?? r.cartons_received ?? 0);
      cartonsInBySup.set(sup, (cartonsInBySup.get(sup) || 0) + c);
    }

    // Supplier breakdown (planned vs received) + cartons
    const planBySup = groupPlanBySupplier(planRows);
    const suppliers = planBySup.map(x => {
      const sup = x.supplier;
      const pos = uniq((planRows || []).filter(r => getSupplier(r) === sup).map(r => getPO(r)).filter(Boolean));
      const received = pos.filter(po => {
        const rec = byPO.get(po);
        return !!(rec && (rec.received_at_utc || rec.received_at || rec.received_at_local));
      }).length;
      return {
        supplier: sup,
        poCount: x.poCount,
        receivedPOs: received,
        units: x.units,
        cartonsIn: cartonsInBySup.get(sup) || 0,
        cartonsOut: cartonsOutBySup.get(sup) || 0,
      };
    });

    return {
      due,
      lastReceived,
      level: st.level,
      plannedPOs: plannedPOs.length,
      receivedPOs: receivedPOs.length,
      latePOs: latePOs.length,
      missingPOs: missingPOs.length,
      cartonsInTotal,
      cartonsOutTotal,
      suppliers,
      latePOList: latePOs,
      missingPOList: missingPOs,
    };
  }

  function computeVASStatus(ws, tz, planRows, records) {
  const now = new Date();
  const due = makeBizLocalDate(
    isoDate(addDays(new Date(`${ws}T00:00:00Z`), BASELINE.vas_complete_due.dayOffset)),
    BASELINE.vas_complete_due.time,
    tz
  );

  const plannedUnits = getPlanUnits(planRows);
  const plannedPOs = uniq((planRows || []).map(r => getPO(r)).filter(Boolean)).length;

  // Build PO -> Supplier and planned units by Supplier/PO from plan (records often do not carry supplier).
  const poToSup = new Map();
  const plannedBySup = new Map();
  const plannedByPO = new Map();
  for (const r of (planRows || [])) {
    const po = getPO(r);
    if (!po) continue;
    const sup = getSupplier(r) || 'Unknown';
    poToSup.set(po, sup);
    const u = num(r.target_qty ?? r.targetQty ?? r.planned_qty ?? r.plannedQty ?? r.qty ?? r.units ?? r.quantity ?? r.target ?? 0);
    plannedBySup.set(sup, (plannedBySup.get(sup) || 0) + u);
    plannedByPO.set(po, (plannedByPO.get(po) || 0) + u);
  }

  // Normalize records payload to an array.
  const recs = Array.isArray(records)
    ? records
    : (records && Array.isArray(records.records) ? records.records
      : (records && Array.isArray(records.rows) ? records.rows
        : (records && Array.isArray(records.data) ? records.data : [])));

  // Records: count applied units and attribute to supplier via plan join (fallback to record fields).
  let appliedUnits = 0;
  let lastAppliedAt = null;
  const appliedBySup = new Map();
  const appliedByPO = new Map();

  for (const r of recs) {
    const qty = num(r.qty ?? r.quantity ?? r.units ?? r.target_qty ?? r.applied_qty ?? 1);
    const q = qty > 0 ? qty : 1;
    appliedUnits += q;

    // Try to infer an "actual" timestamp from records (best-effort, optional).
    const tsRaw = r.applied_at_utc || r.applied_at || r.completed_at_utc || r.completed_at || r.updated_at_utc || r.updated_at || r.created_at_utc || r.created_at || r.timestamp || r.ts;
    if (tsRaw) {
      const td = new Date(tsRaw);
      if (!isNaN(td) && (!lastAppliedAt || td > lastAppliedAt)) lastAppliedAt = td;
    }

    const po = getPO(r);
    if (po) appliedByPO.set(po, (appliedByPO.get(po) || 0) + q);

    const sup = po ? (poToSup.get(po) || getSupplier(r) || 'Unknown') : (getSupplier(r) || 'Unknown');
    appliedBySup.set(sup, (appliedBySup.get(sup) || 0) + q);
  }

  const completion = plannedUnits > 0 ? appliedUnits / plannedUnits : 0;

  // Soft status logic: if past due and not mostly complete => red; otherwise compare to due.
  let level = statusFromDue(due, completion >= 0.98 ? due : null, now).level;
  const untilDueDays = daysBetween(now, due);
  if (untilDueDays > 0 && completion < 0.5 && untilDueDays < 2) level = 'yellow';
  if (untilDueDays <= 0 && completion < 0.9) level = 'red';

  // Supplier rows include planned-only suppliers.
  const supplierRows = [];
  for (const [sup, planned] of plannedBySup.entries()) {
    const applied = appliedBySup.get(sup) || 0;
    const pct = planned > 0 ? Math.round((applied / planned) * 100) : 0;
    supplierRows.push({ supplier: sup, planned, applied, pct, remaining: Math.max(0, planned - applied) });
  }
  // Include suppliers that appear only in records (rare) so we don't lose them.
  for (const [sup, applied] of appliedBySup.entries()) {
    if (plannedBySup.has(sup)) continue;
    supplierRows.push({ supplier: sup, planned: 0, applied, pct: 0, remaining: 0 });
  }
  supplierRows.sort((a, b) => (b.remaining - a.remaining) || (b.applied - a.applied));

  // PO progress mix (planned vs applied) for a more meaningful view than "top applied".
  const poProgress = Array.from(plannedByPO.entries()).map(([po, planned]) => {
    const applied = appliedByPO.get(po) || 0;
    const remaining = Math.max(0, planned - applied);
    const pct = planned > 0 ? Math.round((applied / planned) * 100) : 0;
    return { po, planned, applied, remaining, pct };
  });

  const buckets = { notStarted: 0, inProgress: 0, complete: 0, over: 0 };
  for (const x of poProgress) {
    if (!x.applied) buckets.notStarted++;
    else if (x.applied >= x.planned * 1.05) buckets.over++;
    else if (x.applied >= x.planned * 0.98) buckets.complete++;
    else buckets.inProgress++;
  }

  const topRemainingPOs = poProgress
    .filter(x => x.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, 8);

  return {
    due,
    level,
    plannedUnits,
    appliedUnits,
    plannedPOs,
    completion,
    supplierRows,
    poMix: buckets,
    topRemainingPOs,
  };
}

  
  // ------------------------- International Transit (Supplier + Ticket + Freight lanes) -------------------------
  function getFreightType(r) {
    const v = r?.freight_type ?? r?.freightType ?? r?.freight ?? r?.mode ?? r?.transport_mode ?? '';
    const s = String(v || '').trim();
    if (!s) return '';
    const low = s.toLowerCase();
    if (low.includes('sea') || low.includes('ocean')) return 'Sea';
    if (low.includes('air')) return 'Air';
    // preserve original but title-case first letter
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function getZendeskTicket(r) {
    const v = r?.zendesk_ticket ?? r?.zendeskTicket ?? r?.zendesk ?? r?.ticket ?? r?.ticket_id ?? r?.ticketId ?? '';
    const s = String(v || '').trim();
    return s || '';
  }

  function uniqNonEmpty(arr) {
    return Array.from(new Set((arr || []).map(x => String(x || '').trim()).filter(Boolean)));
  }

  function laneKey(supplier, ticket, freight) {
    return `${normalizeSupplier(supplier || 'Unknown')}||${String(ticket || 'NO_TICKET').trim() || 'NO_TICKET'}||${String(freight || 'Sea').trim() || 'Sea'}`;
  }

  function parseLaneKey(k) {
    const [supplier, ticket, freight] = String(k || '').split('||');
    return { supplier: supplier || 'Unknown', ticket: ticket || 'NO_TICKET', freight: freight || 'Sea' };
  }

  function intlStorageKey(ws, key) {
    return `flow:intl:${ws}:${key}`;
  }

  // Week-level containers store (independent of selected lane)
  function intlWeekContainersKey(ws) {
    return `flow:intl_weekcontainers:${ws}`;
  }

  // Safe conversion for <input type="datetime-local"> values.
  // Returns '' if blank or invalid instead of throwing.
  function safeISO(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const d = new Date(s);
    if (!d || Number.isNaN(d.getTime())) return '';
    try { return d.toISOString(); } catch { return ''; }
  }

  // Convert an ISO timestamp into a value suitable for <input type="datetime-local">.
  // We render in the browser's local timezone to match datetime-local semantics.
  function toLocalDT(iso) {
    const s = String(iso || '').trim();
    if (!s) return '';
    const d = new Date(s);
    if (!d || Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const da = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    return `${y}-${m}-${da}T${hh}:${mi}`;
  }

  // Current time formatted for <input type="datetime-local"> (browser local timezone).
  function nowLocalDT() {
    const d = new Date();
    if (!d || Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const da = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    return `${y}-${m}-${da}T${hh}:${mi}`;
  }

  function _uid(prefix) {
    const pfx = prefix ? String(prefix) : 'id';
    return `${pfx}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }

  function loadIntlWeekContainers(ws) {
    const k = intlWeekContainersKey(ws);
    let state = { containers: [], _v: 1 };
    try {
      const raw = localStorage.getItem(k);
      if (raw) state = JSON.parse(raw) || state;
    } catch { /* ignore */ }

    // One-time migration from legacy lane-level containers:
    // flow:intl:<ws>:<laneKey> { containers: [...] }
    // We merge into week store and preserve last-mile fields.
    try {
      const alreadyMigrated = !!state._migratedFromLaneContainers;
      if (!alreadyMigrated) {
        const merged = [];
        const seen = new Map(); // uid -> container
        for (let i = 0; i < localStorage.length; i++) {
          const lk = localStorage.key(i);
          if (!lk || !lk.startsWith(`flow:intl:${ws}:`)) continue;
          let laneKeyStr = lk.slice(`flow:intl:${ws}:`.length);
          let laneObj = {};
          try { laneObj = JSON.parse(localStorage.getItem(lk) || '{}') || {}; } catch { laneObj = {}; }
          const arr = Array.isArray(laneObj.containers) ? laneObj.containers : [];
          for (const c of arr) {
            const uid = String(c.container_uid || c.uid || '').trim() || _uid('c');
            const prior = seen.get(uid) || {};
            const lane_keys = Array.isArray(c.lane_keys) ? c.lane_keys : (prior.lane_keys || []);
            const nextLaneKeys = Array.from(new Set([...(lane_keys || []), laneKeyStr].filter(Boolean)));
            const mergedC = {
              ...prior,
              ...c,
              container_uid: uid,
              container_id: String(c.container_id || c.container || prior.container_id || '').trim(),
              vessel: String(c.vessel || prior.vessel || '').trim(),
              size_ft: String(c.size_ft || prior.size_ft || '40').trim(),
              pos: String(c.pos || prior.pos || '').trim(),
              lane_keys: nextLaneKeys,
            };
            seen.set(uid, mergedC);
          }
        }
        merged.push(...seen.values());
        state = {
          ...state,
          containers: merged.length ? merged : (Array.isArray(state.containers) ? state.containers : []),
          _migratedFromLaneContainers: true,
          _v: 1,
        };
        localStorage.setItem(k, JSON.stringify(state));
      }
    } catch { /* ignore */ }


    // Ensure every container has a stable uid (repair older records)
    try {
      let changed = false;
      state.containers = (Array.isArray(state.containers) ? state.containers : []).map(c => {
        const uid = String(c.container_uid || c.uid || '').trim() || _uid('c');
        if (!String(c.container_uid || '').trim()) changed = true;
        return { ...c, container_uid: uid, container_id: String(c.container_id || c.container || '').trim() };
      });
      if (changed) {
        localStorage.setItem(k, JSON.stringify({ ...state, _v: 1 }));
      }
    } catch { /* ignore */ }

    if (!Array.isArray(state.containers)) state.containers = [];
    return state;
  }

  function saveIntlWeekContainers(ws, containers) {
    const k = intlWeekContainersKey(ws);
    let prev = { containers: [] };
    try { prev = JSON.parse(localStorage.getItem(k) || '{}') || prev; } catch { prev = { containers: [] }; }

    const prevByUid = new Map();
    const prevById = new Map();
    (Array.isArray(prev.containers) ? prev.containers : []).forEach(c => {
      const uid = String(c.container_uid || c.uid || '').trim();
      const id = String(c.container_id || c.container || '').trim();
      if (uid) prevByUid.set(uid, c);
      if (id) prevById.set(id, c);
    });

    const next = (Array.isArray(containers) ? containers : []).map(c => {
      const uid = String(c.container_uid || c.uid || '').trim() || _uid('c');
      const id = String(c.container_id || c.container || '').trim();
      const prior = prevByUid.get(uid) || (id && prevById.get(id)) || {};
      return {
        ...prior,
        ...c,
        container_uid: uid,
        container_id: id,
        size_ft: String(c.size_ft || prior.size_ft || '40').trim(),
        vessel: String(c.vessel || prior.vessel || '').trim(),
        pos: String(c.pos || prior.pos || '').trim(),
        lane_keys: Array.from(new Set((Array.isArray(c.lane_keys) ? c.lane_keys : (prior.lane_keys || [])).filter(Boolean))),
        _updatedAt: new Date().toISOString(),
      };
    });

    const state = { ...(prev || {}), containers: next, _v: 1, _migratedFromLaneContainers: true };
    try { localStorage.setItem(k, JSON.stringify(state)); } catch { /* ignore */ }

    // Write-through for cross-browser sync (server stores raw inputs only).
    try { patchFlowWeek(ws, { intl_weekcontainers: state }); } catch { /* ignore */ }

    return state;
  }


  // ------------------------- Pre-booked containers (week-scoped) -------------------------
  // UI-only plan inputs for each week (do NOT affect status logic).
  function prebookKey(ws) { return `flow:prebook:${ws}`; }

  function loadPrebook(ws) {
    const k = prebookKey(ws);
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return { c20: 0, c40: 0 };
      const o = JSON.parse(raw) || {};
      return { c20: num(o.c20 || 0), c40: num(o.c40 || 0) };
    } catch {
      return { c20: 0, c40: 0 };
    }
  }

  function savePrebook(ws, next) {
    const k = prebookKey(ws);
    const o = { c20: num(next?.c20 || 0), c40: num(next?.c40 || 0) };
    try { localStorage.setItem(k, JSON.stringify(o)); } catch {}
    patchFlowWeek(ws, { prebook: o });
    return o;
  }



// ------------------------- Week sign-off (Receiving / VAS) -------------------------
// UI-only "master tick" per week. This is a deliberate sign-off signal and must NEVER
// auto-write actual timestamps. It can influence node status only when checked.
function weekSignoffKey(ws) { return `flow:weekSignoff:${ws}`; }

function loadWeekSignoff(ws) {
  const k = weekSignoffKey(ws);
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return { receivingComplete: false, vasComplete: false, receivingAt: null, vasAt: null, updatedAt: null };
    const o = JSON.parse(raw) || {};
    return {
      receivingComplete: !!o.receivingComplete,
      vasComplete: !!o.vasComplete,
      receivingAt: o.receivingAt || null,
      vasAt: o.vasAt || null,
      updatedAt: o.updatedAt || null,
    };
  } catch {
    return { receivingComplete: false, vasComplete: false, receivingAt: null, vasAt: null, updatedAt: null };
  }
}

function saveWeekSignoff(ws, next) {
  const k = weekSignoffKey(ws);
  const o = {
    receivingComplete: !!next?.receivingComplete,
    vasComplete: !!next?.vasComplete,
    receivingAt: next?.receivingAt || null,
    vasAt: next?.vasAt || null,
    updatedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(k, JSON.stringify(o)); } catch {}
  // Write-through (async). UI remains local-first.
  patchFlowWeek(ws, {
    receivingComplete: o.receivingComplete,
    receivingAt: o.receivingAt,
    vasComplete: o.vasComplete,
    vasAt: o.vasAt,
  });
  return o;
}


  // ------------------------- Last Mile receipts (week-scoped) -------------------------
  // We store Last Mile "receiving" fields separately from Intl week-containers.
  // This avoids any accidental overwrite/derivation issues and keeps Last Mile updates
  // deterministic.
  function lastMileReceiptsKey(ws) {
    return `flow:lastmile_receipts:${ws}`;
  }

  function loadLastMileReceipts(ws) {
    const k = lastMileReceiptsKey(ws);
    try {
      const raw = localStorage.getItem(k);
      const obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    } catch {
      return {};
    }
  }

  function saveLastMileReceipts(ws, receipts) {
    const k = lastMileReceiptsKey(ws);
    try { localStorage.setItem(k, JSON.stringify(receipts || {})); } catch { /* ignore */ }
    patchFlowWeek(ws, { lastmile_receipts: (receipts || {}) });
  }

  function loadIntlLaneManual(ws, key) {
    try {
      const raw = localStorage.getItem(intlStorageKey(ws, key));
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveIntlLaneManual(ws, key, obj) {
    try {
      const k = intlStorageKey(ws, key);
      let prev = {};
      try { prev = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { prev = {}; }

      // Merge containers by stable container_uid (fallback: container_id) to preserve downstream fields
      // (e.g., last-mile delivery tracking)
      const next = { ...(prev || {}), ...(obj || {}) };
      if (obj && Array.isArray(obj.containers)) {
        const prevByUid = new Map();
        const prevById = new Map();
        (Array.isArray(prev.containers) ? prev.containers : []).forEach(c => {
          const uid = String(c.container_uid || c.uid || '').trim();
          const id = String(c.container_id || c.container || '').trim();
          if (uid) prevByUid.set(uid, c);
          if (id) prevById.set(id, c);
        });

        next.containers = obj.containers.map(c => {
          const uid = String(c.container_uid || c.uid || '').trim();
          const id = String(c.container_id || c.container || '').trim();
          const prior = (uid && prevByUid.get(uid)) || (id && prevById.get(id)) || {};
          return {
            ...prior,
            ...c,
            container_uid: uid || prior.container_uid || prior.uid || '',
            container_id: id || (c.container_id || ''),
          };
        });
      }

      localStorage.setItem(k, JSON.stringify(next || {}));
      // Persist lane-scoped manual inputs to backend (stored as week.facility.data.intl_lanes[key])
      try { patchFlowWeek(ws, { intl_lanes: { [key]: (next || {}) } }); } catch {}
    } catch { /* ignore */ }
  }

  function computeInternationalTransit(ws, tz, planRows, records, vasDue) {
    // Build PO -> lane mapping from plan
    const poToLane = new Map();
    const lanes = new Map(); // laneKey -> {supplier,ticket,freight, plannedUnits, plannedPOs:Set}
    const ticketsBySupMode = new Map(); // `${supplier}||${freight}` -> Set(ticket)
    for (const r of (planRows || [])) {
      const po = getPO(r);
      if (!po) continue;
      const supplier = getSupplier(r) || 'Unknown';
      const freight = getFreightType(r) || 'Sea';
      const ticket = getZendeskTicket(r) || 'NO_TICKET';

      // Collect all tickets available from Upload Plan for this supplier+mode.
      const smk = `${normalizeSupplier(supplier)}||${freight}`;
      if (!ticketsBySupMode.has(smk)) ticketsBySupMode.set(smk, new Set());
      if (ticket && ticket !== 'NO_TICKET') ticketsBySupMode.get(smk).add(String(ticket).trim());

      const key = laneKey(supplier, ticket, freight);
      poToLane.set(po, key);
      if (!lanes.has(key)) lanes.set(key, { key, supplier: normalizeSupplier(supplier), ticket, freight, plannedUnits: 0, plannedPOs: new Set() });
      const lane = lanes.get(key);
      lane.plannedPOs.add(po);
      lane.plannedUnits += num(r.target_qty ?? r.targetQty ?? r.planned_qty ?? r.plannedQty ?? r.qty ?? r.units ?? r.quantity ?? 0);
    }

    // Applied units by lane from records (join by PO)
    const appliedByLane = new Map();
    const recs = Array.isArray(records)
      ? records
      : (records && Array.isArray(records.records) ? records.records
        : (records && Array.isArray(records.rows) ? records.rows
          : (records && Array.isArray(records.data) ? records.data : [])));

    for (const r of recs || []) {
      if (!r) continue;
      if (r.status && String(r.status).toLowerCase() !== 'complete') continue;
      const po = normalizePO(r.po_number || r.po || r.PO || '');
      if (!po) continue;
      const key = poToLane.get(po);
      if (!key) continue;
      const qty = num(r.qty ?? r.quantity ?? r.units ?? r.target_qty ?? r.applied_qty ?? r.applied ?? 1);
      const q = qty > 0 ? qty : 1;
      appliedByLane.set(key, (appliedByLane.get(key) || 0) + q);
    }

    // Cartons out by PO -> lane
    const cs = computeCartonStatsFromRecords(recs || []);
    const cartonsOutByLane = new Map();
    for (const [po, cnt] of (cs.cartonsOutByPO || new Map()).entries()) {
      const key = poToLane.get(po);
      if (!key) continue;
      cartonsOutByLane.set(key, (cartonsOutByLane.get(key) || 0) + (cnt || 0));
    }

    // Baseline windows
    const originMin = addDays(vasDue, BASELINE.origin_ready_days_min);
    const originMax = addDays(vasDue, BASELINE.origin_ready_days_max);

    // Lane status determination
    const now = new Date();
    const laneRows = [];
    let lastMilestoneAt = null;
    let holds = 0;
    let seaCount = 0, airCount = 0;
    let missingDocs = 0, missingOriginClear = 0, missingDepart = 0, missingArrive = 0, missingDestClear = 0;
    for (const lane of lanes.values()) {
      const manual = loadIntlLaneManual(ws, lane.key);

      let packingListReadyAt = manual.packing_list_ready_at ? new Date(manual.packing_list_ready_at) : null;
      let originClearedAt = manual.origin_customs_cleared_at ? new Date(manual.origin_customs_cleared_at) : null;
      const departedAt = manual.departed_at ? new Date(manual.departed_at) : null;
      const arrivedAt = manual.arrived_at ? new Date(manual.arrived_at) : null;
      const destClearedAt = manual.dest_customs_cleared_at ? new Date(manual.dest_customs_cleared_at) : null;

      // Back-compat: older builds stored a single origin_ready_at.
      if ((!packingListReadyAt || isNaN(packingListReadyAt)) && manual.origin_ready_at) packingListReadyAt = new Date(manual.origin_ready_at);
      if ((!originClearedAt || isNaN(originClearedAt)) && manual.origin_ready_at) originClearedAt = new Date(manual.origin_ready_at);

      const customsHold = !!manual.customs_hold;

      // "Origin Ready" is effectively when docs are ready AND origin is cleared.
      // For baseline comparisons we treat it as the latest of the two, when present.
      const originReadyAt = (packingListReadyAt || originClearedAt)
        ? new Date(Math.max(
            packingListReadyAt && !isNaN(packingListReadyAt) ? packingListReadyAt.getTime() : 0,
            originClearedAt && !isNaN(originClearedAt) ? originClearedAt.getTime() : 0
          ))
        : null;

      // Track latest known milestone across lanes (best-effort for "actual" display).
      for (const d of [packingListReadyAt, originClearedAt, departedAt, arrivedAt, destClearedAt, originReadyAt]) {
        if (d && !isNaN(d) && (!lastMilestoneAt || d > lastMilestoneAt)) lastMilestoneAt = d;
      }

      let level = 'green';

      if (customsHold) {
        level = 'red';
      } else {
        // Step 1: Packing list ready (docs)
        if (!packingListReadyAt || isNaN(packingListReadyAt)) {
          if (daysBetween(originMax, now) > BASELINE.soft_yellow_days) level = 'yellow';
          if (daysBetween(originMax, now) > BASELINE.soft_red_days) level = 'red';
        }
        // Step 2: Origin cleared
        else if (!originClearedAt || isNaN(originClearedAt)) {
          if (daysBetween(originMax, now) > BASELINE.soft_yellow_days) level = 'yellow';
          if (daysBetween(originMax, now) > BASELINE.soft_red_days) level = 'red';
        }
        // Step 3: Departed origin
        else if (!departedAt || isNaN(departedAt)) {
          const departDue = addDays(originClearedAt, 1);
          level = statusFromDue(departDue, null, now).level;
        }
        // Step 4: Arrived destination
        else if (!arrivedAt || isNaN(arrivedAt)) {
          const transitDays = (lane.freight === 'Air') ? BASELINE.transit_days_air : BASELINE.transit_days_sea;
          const arriveDue = addDays(departedAt, transitDays);
          level = statusFromDue(arriveDue, null, now).level;
        }
        // Step 5: Destination cleared
        else if (!destClearedAt || isNaN(destClearedAt)) {
          const destClearDue = addDays(arrivedAt, 2);
          level = statusFromDue(destClearDue, null, now).level;
        }
      }

      if (customsHold) holds++;
      if (lane.freight === 'Sea') seaCount++;
      else if (lane.freight === 'Air') airCount++;

      if (!packingListReadyAt || isNaN(packingListReadyAt)) missingDocs++;
      else if (!originClearedAt || isNaN(originClearedAt)) missingOriginClear++;
      else if (!departedAt || isNaN(departedAt)) missingDepart++;
      else if (!arrivedAt || isNaN(arrivedAt)) missingArrive++;
      else if (!destClearedAt || isNaN(destClearedAt)) missingDestClear++;

      const plannedUnits = Math.round(lane.plannedUnits || 0);
      const appliedUnits = Math.round(appliedByLane.get(lane.key) || 0);
      const cartonsOut = Math.round(cartonsOutByLane.get(lane.key) || 0);

      laneRows.push({
        ...lane,
        plannedPOs: lane.plannedPOs.size,
        plannedUnits,
        appliedUnits,
        cartonsOut,
        // For container assignment: list of Zendesk tickets available from Upload Plan for this supplier+mode.
        availableTickets: uniqNonEmpty(Array.from((ticketsBySupMode.get(`${normalizeSupplier(lane.supplier)}||${lane.freight}`) || new Set()).values())),
        manual,
        level,
        originReadyAt,
        departedAt,
        customsHold,
      });
    }

    // Aggregate node level: worst lane wins
    const agg = laneRows.reduce((acc, r) => worstLevel(acc, r.level), 'green');

    return {
      level: agg,
      originMin,
      originMax,
      lastMilestoneAt,

      seaCount,
      airCount,
      holds,
      missingDocs,
      missingOriginClear,
      missingDepart,
      missingArrive,
      missingDestClear,
      lanes: laneRows,
    };
  }

  function worstLevel(a, b) {
    const rank = { gray: 0, green: 1, yellow: 2, red: 3 };
    return (rank[b] > rank[a]) ? b : a;
  }

function computeManualNodeStatuses(ws, tz) {
    const now = new Date();
    const manual = loadFlowManual(ws) || {};

    // Origin readiness + Transit + Last Mile are manual-lite.
    const intlMode = (manual.intl_mode === 'Air' || manual.intl_mode === 'Sea') ? manual.intl_mode : 'Sea';

    // Baseline dates derived from ws and VAS due (baseline, not actual)
    const vasDue = makeBizLocalDate(isoDate(addDays(new Date(`${ws}T00:00:00Z`), BASELINE.vas_complete_due.dayOffset)), BASELINE.vas_complete_due.time, tz);

    const originMin = addDays(vasDue, BASELINE.origin_ready_days_min);
    const originMax = addDays(vasDue, BASELINE.origin_ready_days_max);

    const transitDays = intlMode === 'Air' ? BASELINE.transit_days_air : BASELINE.transit_days_sea;
    const arriveBase = addDays(originMax, transitDays);

    const lastMileMin = addDays(arriveBase, BASELINE.last_mile_days_min);
    const lastMileMax = addDays(arriveBase, BASELINE.last_mile_days_max);

    // Manual actuals
    const originReadyAt = manual.origin_ready_at ? new Date(manual.origin_ready_at) : null;
    const departedAt = manual.departed_at ? new Date(manual.departed_at) : null;
    const arrivedAt = manual.arrived_at ? new Date(manual.arrived_at) : null;
    const deliveredAt = manual.delivered_at ? new Date(manual.delivered_at) : null;

    // Intl node status: if arrived/delivered exist, green; else compare now to arrival baseline.
    let intlLevel = 'gray';
    if (departedAt && !isNaN(departedAt)) intlLevel = 'green';
    else {
      const st = statusFromDue(originMax, originReadyAt && !isNaN(originReadyAt) ? originReadyAt : null, now);
      intlLevel = st.level;
      // If origin ready is ok but transit is not started, keep yellow at most
      if (intlLevel === 'red' && !manual.customs_hold) intlLevel = 'yellow';
      if (manual.customs_hold) intlLevel = 'red';
    }

    // Last mile status
    let lmLevel = 'gray';
    if (deliveredAt && !isNaN(deliveredAt)) lmLevel = 'green';
    else {
      const st2 = statusFromDue(lastMileMax, deliveredAt && !isNaN(deliveredAt) ? deliveredAt : null, now);
      lmLevel = st2.level;
      if (manual.last_mile_issue) lmLevel = 'red';
    }

    return {
      manual,
      intlMode,
      baselines: {
        vasDue,
        originMin,
        originMax,
        arriveBase,
        lastMileMin,
        lastMileMax,
      },
      actuals: { originReadyAt, departedAt, arrivedAt, deliveredAt },
      levels: { intl: intlLevel, lastMile: lmLevel },
    };
  }

  // ------------------------- UI -------------------------
  const UI = {
    mounted: false,
    currentWs: null,
    // Default focus on Milk Run on initial load (right tile + journey highlight)
    selection: { node: 'milk', sub: null },
  };

  // ------------------------- Lane modal (Transit & Clearing) -------------------------
  function ensureLaneModal() {
    let root = document.getElementById('flow-lane-modal');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'flow-lane-modal';
    root.className = 'fixed inset-0 z-[9999] hidden';

    root.innerHTML = `
      <div class="absolute inset-0 bg-black/40" data-flow-modal-close="1"></div>
      <div class="absolute inset-3 md:inset-6 bg-white rounded-2xl shadow-xl border overflow-hidden flex flex-col">
        <div class="p-3 border-b flex items-center justify-between gap-3">
          <div>
            <div id="flow-lane-modal-title" class="text-base font-semibold text-gray-800"></div>
            <div id="flow-lane-modal-sub" class="text-xs text-gray-500 mt-0.5"></div>
          </div>
          <div class="flex items-center gap-2">
            <div id="flow-lane-modal-status"></div>
            <button class="px-2.5 py-1.5 rounded-lg border bg-white hover:bg-gray-50 text-sm" data-flow-modal-close="1">Close</button>
          </div>
        </div>
        <div id="flow-lane-modal-body" class="p-3 overflow-auto flex-1"></div>
      </div>
    `;
    document.body.appendChild(root);

    // close handlers
    root.querySelectorAll('[data-flow-modal-close]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeLaneModal();
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const r = document.getElementById('flow-lane-modal');
        if (r && !r.classList.contains('hidden')) closeLaneModal();
      }
    });

    return root;
  }

  function closeLaneModal() {
    const root = document.getElementById('flow-lane-modal');
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
  }

  function openLaneModal(ws, tz, laneKey) {
    const ctx = window.__FLOW_INTL_CTX__ || null;
    if (!ctx || !ctx.lanes || !ctx.weekContainers) return;

    const lane = (ctx.lanes || []).find(l => l && l.key === laneKey);
    if (!lane) return;

    const manual = loadIntlLaneManual(ws, laneKey) || {};
    const root = ensureLaneModal();

    const ticket = lane.ticket && lane.ticket !== 'NO_TICKET' ? String(lane.ticket) : '';
    const title = `${lane.supplier} • ${lane.freight}${ticket ? ` • Zendesk ${ticket}` : ''}`;
    const subtitle = `Lane key: ${lane.key}`;

    const statusHtml = `
      <span class="dot ${dot(lane.level)}"></span>
      <span class="text-xs px-2 py-0.5 rounded-full border ${pill(lane.level)} whitespace-nowrap ml-2">${statusLabel(lane.level)}</span>
    `;

    root.querySelector('#flow-lane-modal-title').textContent = title;
    root.querySelector('#flow-lane-modal-sub').textContent = subtitle;
    root.querySelector('#flow-lane-modal-status').innerHTML = statusHtml;

    // Containers derived from week-level containers
    const conts = (ctx.weekContainers || [])
      .filter(c => Array.isArray(c?.lane_keys) && c.lane_keys.includes(lane.key))
      .filter(c => {
        const cid = String(c?.container_id || c?.container || '').trim();
        const ves = String(c?.vessel || '').trim();
        const ft = String(c?.size_ft || '').trim();
        return !!(cid || ves || ft);
      });

    const contRows = conts.length ? `
      <div class="rounded-xl border p-3">
        <div class="text-sm font-semibold text-gray-700 flex items-center gap-2">${iconContainer()} <span>Containers</span></div>
        <div class="mt-2 overflow-auto">
          <table class="w-full text-sm">
            <thead><tr>
              <th class="th text-left py-2 pr-2">Container #</th>
              <th class="th text-left py-2 pr-2">Size</th>
              <th class="th text-left py-2 pr-2">Vessel</th>
            </tr></thead>
            <tbody>
              ${(conts || []).map(c => {
                const cid = escapeHtml(String(c.container_id || c.container || '').trim() || '—');
                const ft = escapeHtml(String(c.size_ft || '').trim() ? (String(c.size_ft).trim() + 'ft') : '—');
                const ves = escapeHtml(String(c.vessel || '').trim() || '—');
                return `<tr class="border-t"><td class="py-3 pr-4">${cid}</td><td class="py-3 pr-4">${ft}</td><td class="py-3 pr-4">${ves}</td></tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : `
      <div class="rounded-xl border p-3 text-sm text-gray-500">
        No containers mapped to this lane yet (week-level containers).
      </div>
    `;

    const dateVal = (v) => String(v || '').trim();

    // Modal body: reuse the same lane fields pattern + new IDs
    root.querySelector('#flow-lane-modal-body').innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="rounded-xl border p-3">
          <div class="text-sm font-semibold text-gray-700">Lane dates & documents</div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">Packing list ready</div>
              <input data-lm-field="pack" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(dateVal(manual.pack))}"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">Origin customs cleared</div>
              <input data-lm-field="originClr" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(dateVal(manual.originClr))}"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">Departed origin</div>
              <input data-lm-field="departed" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(dateVal(manual.departed))}"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">Arrived destination</div>
              <input data-lm-field="arrived" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(dateVal(manual.arrived))}"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">Destination customs cleared</div>
              <input data-lm-field="destClr" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(dateVal(manual.destClr))}"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">ETA FC</div>
              <input data-lm-field="etaFC" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(dateVal(manual.etaFC || manual.eta_fc))}"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">Latest arrival date</div>
              <input data-lm-field="latestArrivalDate" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(dateVal(manual.latestArrivalDate || manual.latest_arrival_date || manual.latestArrival))}"/>
            </label>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">Shipment #</div>
              <input data-lm-field="shipmentNumber" type="text" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(String(manual.shipmentNumber || manual.shipment || ''))}" placeholder="Free text"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">HBL</div>
              <input data-lm-field="hbl" type="text" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(String(manual.hbl || ''))}" placeholder="Free text"/>
            </label>
            <label class="text-sm">
              <div class="text-xs text-gray-500 mb-1">MBL</div>
              <input data-lm-field="mbl" type="text" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(String(manual.mbl || ''))}" placeholder="Free text"/>
            </label>
          </div>

          <div class="flex items-center gap-3 mt-3">
            <label class="text-sm flex items-center gap-2">
              <input data-lm-field="hold" type="checkbox" class="h-4 w-4" ${manual.hold ? 'checked' : ''}/>
              <span>Customs hold</span>
            </label>
          </div>

          <label class="text-sm mt-3 block">
            <div class="text-xs text-gray-500 mb-1">Note (optional)</div>
            <textarea data-lm-field="note" rows="2" class="w-full px-2 py-1.5 border rounded-lg" placeholder="Quick update for the team...">${escapeHtml(String(manual.note || ''))}</textarea>
          </label>

          <div class="flex items-center justify-end mt-3">
            <button id="flow-lane-modal-save" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Save lane</button>
          </div>
          <div id="flow-lane-modal-msg" class="text-xs text-gray-500 mt-2"></div>
        </div>

        <div class="flex flex-col gap-3">
          ${contRows}
        </div>
      </div>
    `;

    // Wire save button (dates + hold + note + ids)
    const body = root.querySelector('#flow-lane-modal-body');
    const saveBtn = body.querySelector('#flow-lane-modal-save');
    const msg = body.querySelector('#flow-lane-modal-msg');

    const readFields = () => {
      const q = (sel) => body.querySelector(sel);
      const get = (k) => {
        const el = body.querySelector(`[data-lm-field="${k}"]`);
        if (!el) return '';
        if (el.type === 'checkbox') return !!el.checked;
        return String(el.value || '').trim();
      };
      return {
        pack: get('pack'),
        originClr: get('originClr'),
        departed: get('departed'),
        arrived: get('arrived'),
        destClr: get('destClr'),
        etaFC: get('etaFC'),
        latestArrivalDate: get('latestArrivalDate'),
        hold: !!get('hold'),
        note: get('note'),
        shipmentNumber: get('shipmentNumber'),
        hbl: get('hbl'),
        mbl: get('mbl'),
      };
    };

    const doSave = () => {
      try {
        const vals = readFields();
        saveIntlLaneManual(ws, laneKey, vals);
        if (msg) msg.textContent = 'Saved.';
      } catch (e) {
        if (msg) msg.textContent = 'Save failed.';
      }
    };

    if (saveBtn) saveBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); doSave(); };

    // Background persist for IDs only (blur/Enter)
    const idKeys = new Set(['shipmentNumber','hbl','mbl']);
    body.querySelectorAll('[data-lm-field]').forEach(el => {
      const key = el.getAttribute('data-lm-field');
      if (!idKeys.has(key)) return;

      const saveOne = () => {
        const v = (el.type === 'checkbox') ? !!el.checked : String(el.value || '').trim();
        const patch = {};
        patch[key] = v;
        saveIntlLaneManual(ws, laneKey, patch);
        if (msg) msg.textContent = 'Saved.';
      };

      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          saveOne();
          el.blur();
        }
      });
      el.addEventListener('blur', () => saveOne());
    });

    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
  }


  function openIntlOverviewModal(ws, tz) {
    const ctx = window.__FLOW_INTL_CTX__ || null;
    if (!ctx || !ctx.lanes) return;

    const lanes = Array.isArray(ctx.lanes) ? ctx.lanes.slice() : [];
    const weekContainers = Array.isArray(ctx.weekContainers) ? ctx.weekContainers : [];
    const intl = ctx.intl || null;

    // Sort same as lanes tile: holds/red first, then highest remaining units
    const rank = { red: 3, yellow: 2, green: 1, gray: 0 };
    lanes.sort((a, b) => (rank[b.level] - rank[a.level]) || ((b.plannedUnits - b.appliedUnits) - (a.plannedUnits - a.appliedUnits)));

    const root = ensureLaneModal();
    root.querySelector('#flow-lane-modal-title').textContent = 'Transit & Clearing — Lanes (Full screen)';
    root.querySelector('#flow-lane-modal-sub').textContent = 'All lanes for this week • Click a supplier to open the lane editor.';
    root.querySelector('#flow-lane-modal-status').innerHTML = '';

    const fmtDT = (v) => {
      const s = String(v || '').trim();
      if (!s) return '—';
      try { return fmtInTZ(s, tz); } catch { return s; }
    };

    // Planned fallback baselines for a lane (derived from Intl window + freight mode).
    // We intentionally do NOT store these in backend; UI recomputes them.
    const plannedForLane = (lane) => {
      const originMin = (intl && intl.originMin instanceof Date) ? intl.originMin : null;
      const originMax = (intl && intl.originMax instanceof Date) ? intl.originMax : null;
      if (!originMin || !originMax) return { pack: null, originClr: null, departed: null, arrived: null, destClr: null };
      const pack = originMin;
      const originClr = originMax;
      const departed = addDays(originClr, 1);
      const transitDays = (lane && lane.freight === 'Air') ? BASELINE.transit_days_air : BASELINE.transit_days_sea;
      const arrived = addDays(departed, transitDays);
      const destClr = addDays(arrived, 2);
      return { pack, originClr, departed, arrived, destClr };
    };

    // Resolve actual lane dates from any known schema (backend-synced + back-compat), else planned.
    const fmtDateOnly = (val) => {
      try {
        const d = (val instanceof Date) ? val : new Date(val);
        if (!d || isNaN(d)) return '';
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: '2-digit' }).format(d);
      } catch (e) { return ''; }
    };

    const laneDateCell = (manualObj, plannedDate, keys) => {
      const tryKey = (k) => {
        const v = manualObj && (manualObj[k] != null) ? String(manualObj[k]).trim() : '';
        return v ? v : '';
      };
      const actualRaw = (keys || []).map(tryKey).find(Boolean) || '';
      if (actualRaw) {
        const d = fmtDateOnly(actualRaw);
        return d ? `<span class="whitespace-nowrap font-semibold" style="color:#334155">${escapeHtml(d)}</span>` : '<span class="text-gray-400">—</span>';
      }
      if (plannedDate && !isNaN(plannedDate)) {
        const d = fmtDateOnly(plannedDate);
        return d ? `<span class="whitespace-nowrap" style="color:#7a1f33">${escapeHtml(d)} <span class="text-[10px]" style="color:#7a1f33">planned</span></span>` : '<span class="text-gray-400">—</span>';
      }
      return '<span class="text-gray-400">—</span>';
    };

    const latestActualStatusText = (manualObj) => {
      const getRaw = (keys) => {
        for (const k of keys) {
          const v = manualObj && (manualObj[k] != null) ? String(manualObj[k]).trim() : '';
          if (v) return v;
        }
        return '';
      };
      const stages = [
        { label: 'Packing list ready', keys: ['packing_list_ready_at','packingListReadyAt','pack','packing_list_ready'] },
        { label: 'Origin customs cleared', keys: ['origin_customs_cleared_at','originClearedAt','originClr','origin_customs_cleared'] },
        { label: 'Departed origin', keys: ['departed_at','departedAt','departed'] },
        { label: 'Arrived destination', keys: ['arrived_at','arrivedAt','arrived'] },
        { label: 'Destination customs cleared', keys: ['dest_customs_cleared_at','destClearedAt','destClr','dest_customs_cleared'] },
      ];
      let best = null;
      for (const st of stages) {
        const raw = getRaw(st.keys);
        if (!raw) continue;
        const d = new Date(raw);
        if (!d || isNaN(d)) continue;
        if (!best || d > best.date) best = { date: d, label: st.label };
      }
      return best ? best.label : '';
    };

    const contListForLane = (laneKey) => {
      const ids = (weekContainers || [])
        .filter(c => Array.isArray(c?.lane_keys) && c.lane_keys.includes(laneKey))
        .map(c => String(c?.container_id || c?.container || '').trim())
        .filter(Boolean);
      return uniqNonEmpty(ids);
    };

    // Summary strip for quick scan
    const counts = lanes.reduce((acc, l) => {
      acc.total++;
      acc[l.level] = (acc[l.level] || 0) + 1;
      const m = String(l.freight || '').toLowerCase();
      if (m === 'air') acc.air++; else if (m === 'sea') acc.sea++;
      return acc;
    }, { total: 0, red: 0, yellow: 0, green: 0, gray: 0, sea: 0, air: 0 });

    const rows = lanes.map(l => {
      const manual = (l && l.manual && typeof l.manual === 'object') ? l.manual : (loadIntlLaneManual(ws, l.key) || {});
      const ticket = l.ticket && l.ticket !== 'NO_TICKET' ? escapeHtml(l.ticket) : '—';
      const containers = contListForLane(l.key);
      const st = `<span class="text-xs px-2 py-0.5 rounded-full border ${pill(l.level)} whitespace-nowrap">${statusLabel(l.level)}</span>`;
      const pl = plannedForLane(l);
      const freightLower = String(l.freight || '').toLowerCase();
      const freightCls = freightLower === 'air' ? 'text-sky-700' : (freightLower === 'sea' ? 'text-emerald-700' : 'text-gray-700');
      const stageTxt = latestActualStatusText(manual);
      const holdFlag = !!(manual.hold || manual.customs_hold || manual.customsHold || manual.customsHoldFlag);
      return `
        <tr class="border-t align-top hover:bg-gray-50">
          <td class="py-3 pr-4">
            <button class="text-left hover:underline" data-open-lane="${escapeAttr(l.key)}">${escapeHtml(l.supplier)}</button>
            <div class="text-xs font-medium mt-0.5 ${freightCls}">${escapeHtml(l.freight || '')}</div>
            <div class="text-xs font-semibold mt-0.5 tracking-wide" style="color:#e90076; text-transform:uppercase">${escapeHtml(stageTxt || 'No actual updates')}</div>
          </td>
          <td class="py-3 px-4 text-center">${ticket}</td>
          <td class="py-3 px-4 text-center">${st}</td>
          <td class="py-3 px-4 text-center">${escapeHtml(String(manual.shipmentNumber || manual.shipment || '').trim() || '—')}</td>
          <td class="py-3 px-4 text-center">${escapeHtml(String(manual.hbl || '').trim() || '—')}</td>
          <td class="py-3 px-4 text-center">${escapeHtml(String(manual.mbl || '').trim() || '—')}</td>
          <td class="py-3 px-4 text-center">${holdFlag ? '✓' : '—'}</td>
          <td class="py-3 px-4 text-center">${laneDateCell(manual, pl.pack, ['packing_list_ready_at','packingListReadyAt','pack','packing_list_ready'])}</td>
          <td class="py-3 px-4 text-center">${laneDateCell(manual, pl.originClr, ['origin_customs_cleared_at','originClearedAt','originClr','origin_customs_cleared'])}</td>
          <td class="py-3 px-4 text-center">${laneDateCell(manual, pl.departed, ['departed_at','departedAt','departed'])}</td>
          <td class="py-3 px-4 text-center">${laneDateCell(manual, pl.arrived, ['arrived_at','arrivedAt','arrived'])}</td>
                    <td class=\"py-3 px-4 text-center\">${laneDateCell(manual, null, ['eta_fc','etaFC','eta_fc_at','eta_fc_fc'])}</td>
          <td class=\"py-3 px-4 text-center\">${laneDateCell(manual, null, ['latest_arrival_date','latestArrivalDate','latestArrival','latest_arrival'])}</td>
          <td class="py-3 px-4 text-center">${laneDateCell(manual, pl.destClr, ['dest_customs_cleared_at','destClearedAt','destClr','dest_customs_cleared'])}</td>
          <td class="py-3 pl-4 pr-4 text-left">${containers.length ? containers.map(c=>escapeHtml(c)).join('<br/>') : '—'}</td>
        </tr>
      `;
    }).join('');

    root.querySelector('#flow-lane-modal-body').innerHTML = `
      <div class="rounded-xl border p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-gray-700">Lanes</div>
            <div class="text-xs text-gray-500 mt-1">Dates show <b>Actual</b> when entered; otherwise fall back to <b>Planned</b>.</div>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="rounded-lg border px-2 py-1 bg-white"><span class="text-gray-500">Sea</span> <b>${counts.sea}</b></div>
            <div class="rounded-lg border px-2 py-1 bg-white"><span class="text-gray-500">Air</span> <b>${counts.air}</b></div>
            <div class="rounded-lg border px-2 py-1 bg-white"><span class="text-gray-500">Delayed</span> <b>${counts.red}</b></div>
            <div class="rounded-lg border px-2 py-1 bg-white"><span class="text-gray-500">At risk</span> <b>${counts.yellow}</b></div>
          </div>
        </div>
        <div class="mt-5 overflow-auto">
          <table class="w-full text-sm min-w-[1500px]">
            <thead class="sticky top-0 bg-white">
              <tr class="text-[13px] text-gray-600 border-b">
                <th class="text-left py-3 pr-4">Supplier / Freight</th>
                <th class="text-center py-3 px-4">Zendesk</th>
                <th class="text-center py-3 px-4">Status</th>
                <th class="text-center py-3 px-4">Shipment #</th>
                <th class="text-center py-3 px-4">HBL</th>
                <th class="text-center py-3 px-4">MBL</th>
                <th class="text-center py-3 px-4">Hold</th>
                <th class="text-center py-3 px-4">📄 Pack List</th>
                <th class="text-center py-3 px-4">🛃 Origin Customs</th>
                <th class="text-center py-3 px-4">🚚 Departed</th>
                <th class="text-center py-3 px-4">📍 Arrived</th>
                <th class=\"text-center py-3 px-4\">🏬 ETA FC</th>
                <th class=\"text-center py-3 px-4\">📅 Latest arrival</th>
                <th class="text-center py-3 px-4">🛃 Dest Customs</th>
                <th class="text-left py-2 pr-2">Container #</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td class="py-2 text-gray-500" colspan="15">No lanes found.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    root.querySelectorAll('[data-open-lane]').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const k = btn.getAttribute('data-open-lane');
        if (!k) return;
        openLaneModal(ws, tz, k);
      });
    });

    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
  }

  function ensureFlowPageExists() {
    // 1) page section
    let page = document.getElementById('page-flow');
    if (!page) {
      const main = document.querySelector('main.vo-wrap') || document.querySelector('main');
      page = document.createElement('section');
      page.id = 'page-flow';
      page.className = 'hidden';
      main?.appendChild(page);
    }

    // 2) nav link (optional; if user adds it manually, we won't duplicate)
    const nav = document.getElementById('nav-toggle');
    if (nav && !document.getElementById('nav-flow')) {
      const a = document.createElement('a');
      a.href = '#flow';
      a.id = 'nav-flow';
      a.className = 'seg px-3 py-1.5 rounded-lg text-sm font-medium transition select-none';
      a.textContent = 'Flow';
      nav.appendChild(a);
    }

    return page;
  }

  function injectSkeleton(page) {
    if (page.dataset.flowMounted === '1') return;
    page.dataset.flowMounted = '1';
    page.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="text-2xl font-semibold">Flow</div>
          <div id="flow-sub" class="text-sm text-gray-500 mt-0.5"></div>
        </div>
        <div class="flex items-center gap-2">
          <button id="flow-prev-week" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50" title="Previous week">←</button>
          <button id="flow-next-week" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50" title="Next week">→</button>
          <button id="flow-reset" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Reset view</button>
          <button id="flow-download-pdf" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Download PDF</button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3">
        <!-- Top row: Journey map (2/3) + Insights (1/3) -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <!-- Journey map tile -->
          <div id="flow-top-tile" class="rounded-2xl border bg-white shadow-sm p-3 flow-tile--nodes lg:col-span-2">
            <div class="flex items-center justify-between mb-2">
              <div class="text-sm font-semibold text-gray-700">End-to-end nodes</div>
              <div id="flow-day" class="text-xs text-gray-500"></div>
            </div>
            <div id="flow-journey" class="w-full"></div>
          </div>
          <!-- Summary tile (right 1/3) -->
          <div class="rounded-2xl border bg-white shadow-sm p-3 min-h-[220px] lg:col-span-1">
            <div class="flex items-center justify-between mb-2">
              <div class="text-sm font-semibold text-gray-700">Week totals</div>
            </div>
            <div id="flow-footer"></div>
          </div>
        </div>
        </div>

        <!-- Detail tile moved to bottom (full width) -->
        <div class="rounded-2xl border bg-white shadow-sm p-3 min-h-[360px]">
          <div id="flow-detail" class="h-full"></div>
        </div>
      </div>

      <div class="mt-3 text-xs text-gray-500">

        Baseline is editable in <code>flow_live_additive.js</code>. Receiving + VAS are data-driven; International Transit + Last Mile are lightweight manual (stored locally per week).
      </div>
    `;

    // Journey map CSS (additive; never breaks if duplicated)
    try {
      if (!document.getElementById('flow-journey-style')) {
        const st = document.createElement('style');
        st.id = 'flow-journey-style';
        st.textContent = `
          /* Journey map sizing + crispness */
          #flow-journey svg { width: 100%; height: 500px; display: block; }
          @media (min-width: 1024px) { #flow-journey svg { height: 540px; } }
          .flow-journey-hit { cursor: pointer; }
          .flow-journey-hit:focus { outline: none; }
        `;
        document.head.appendChild(st);
      }
    } catch {}
  }

  function setSubheader(ws) {
    const sub = document.getElementById('flow-sub');
    if (!sub) return;
    try {
      const wsD = new Date(`${ws}T00:00:00Z`);
      const weD = new Date(wsD.getTime());
      weD.setUTCDate(weD.getUTCDate() + 6);
      sub.textContent = `${ws} – ${isoDate(weD)}`;
    } catch {
      sub.textContent = ws;
    }
  }

  function nodeCard({ id, title, subtitle, level, badges = [], disabled = false, upcoming = false }) {
    const dis = disabled ? 'opacity-50 pointer-events-none' : '';
    const badgeHtml = badges.map(b => {
      const cls = b.level ? pill(b.level) : 'bg-gray-100 text-gray-700 border-gray-200';
      return `<button data-sub="${b.sub || ''}" class="text-xs px-2 py-0.5 rounded-full border ${cls} hover:opacity-95">${b.label}</button>`;
    }).join(' ');
    return `
      <div data-node="${id}" data-flow-node="${id}" class="rounded-xl border p-3 hover:bg-gray-50 cursor-pointer ${dis}">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="text-sm font-semibold flex items-center gap-2"><span class="inline-flex items-center justify-center w-8 h-8 rounded-full border bg-white text-gray-700">${iconSvg(id)}</span><span>${title}</span></div>
            <div class="text-xs text-gray-500 mt-0.5">${subtitle || ''}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="dot ${dot(level, !!upcoming)}"></span>
            <span class="text-xs px-2 py-0.5 rounded-full border ${pill(level, !!upcoming)} whitespace-nowrap">${statusLabel(level, !!upcoming)}</span>
          </div>
        </div>
        <div class="mt-2 flex flex-wrap gap-1">${badgeHtml}</div>
      </div>
    `;
  }

  function setDayProgress(ws, tz) {
    const el = document.getElementById('flow-day');
    if (!el) return;
    try {
      const anchor = makeBizLocalDate(ws, BASELINE.receiving_due.time, tz); // Mon noon
      const now = new Date();
      const day = Math.floor(daysBetween(anchor, now)) + 1;
      const pct = clamp(daysBetween(anchor, now) / 24, 0, 1);
      el.textContent = `Day ${Math.max(1, day)} / 24 (baseline)`;
    } catch {
      el.textContent = '';
    }
  }

  
  function renderProcessRail(nodes, forcedCurrentIdx = null) {
    const rail = document.getElementById('flow-rail');
    if (!rail) return;

    // Expect nodes: [{id, level, upcoming}]
    const order = ['milk','receiving','vas','intl','lastmile'];
    const nodeById = new Map((nodes || []).map(n => [n.id, n]));

    // "Ongoing" marker = operational phase (NOT the selected node).
    // If a forced index is provided, use that; else infer from upcoming flags.
    let currentIdx = 0;
    if (Number.isFinite(forcedCurrentIdx)) {
      currentIdx = Math.max(0, Math.min(order.length - 1, forcedCurrentIdx));
    } else {
      for (let i = 0; i < order.length; i++) {
        const n = nodeById.get(order[i]);
        if (n && n.upcoming === false) currentIdx = i;
      }
    }

    const draw = () => {
      const root = document.getElementById('flow-nodes');
      if (!root) return;

      const cards = Array.from(root.querySelectorAll('[data-flow-node]'));
      if (!cards.length) return;

      const centers = new Map();
      for (const el of cards) {
        const id = el.getAttribute('data-flow-node');
        const r = el.getBoundingClientRect();
        centers.set(id, r.left + r.width / 2);
      }

      const rr = rail.getBoundingClientRect();

      if (!rr || rr.width < 80) return;

      const x = (id) => {
        const c = centers.get(id);
        if (typeof c !== 'number') return null;
        return Math.max(8, Math.min(rr.width - 8, c - rr.left));
      };

      const matte = (hex, alpha) => {
        // hex like #rrggbb
        const h = (hex || '#9ca3af').replace('#','');
        const r = parseInt(h.slice(0,2),16) || 156;
        const g = parseInt(h.slice(2,4),16) || 163;
        const b = parseInt(h.slice(4,6),16) || 175;
        return `rgba(${r},${g},${b},${alpha})`;
      };

      const strokeForLevel = (level, upcoming) => {
        // Matte palette
        const map = {
          green: '#10b981',
          red:   '#ef4444',
          gray:  '#9ca3af'
        };
        const base = map[level] || map.gray;
        return upcoming ? matte(base, 0.35) : matte(base, 0.55);
      };

      const dotFillForLevel = (level, upcoming) => {
        const map = {
          green: '#10b981',
          red:   '#ef4444',
          gray:  '#9ca3af'
        };
        const base = map[level] || map.gray;
        return upcoming ? matte(base, 0.20) : matte(base, 0.45);
      };

      const label = (id) => {
        const map = { milk:'MR', receiving:'RCV', vas:'VAS', intl:'T&C', lastmile:'LM' };
        return map[id] || '';
      };

      const spineIcon = (id) => {
        try {
          const raw = (typeof NODE_ICONS !== 'undefined' && NODE_ICONS && NODE_ICONS[id]) ? String(NODE_ICONS[id]) : '';
          if (!raw) return '';
          // Force an explicit size for use inside the spine SVG (ignore Tailwind classes)
          // Keep original viewBox/path/stroke etc.
          return raw
            .replace(/class="[^"]*"/g, 'width="24" height="24"')
            .replace('<svg ', '<svg x="0" y="0" ');
        } catch (e) {
          return '';
        }
      };
      const USE_SPINE_ICONS = true;

      // Build segments
      let segs = '';
      for (let i = 0; i < order.length - 1; i++) {
        const a = order[i], b = order[i+1];
        const xa = x(a), xb = x(b);
        if (xa == null || xb == null) continue;
        const nb = nodeById.get(b) || { level:'gray', upcoming:true };
        segs += `<line x1="${xa}" y1="16" x2="${xb}" y2="16" stroke="${strokeForLevel(nb.level, nb.upcoming)}" stroke-width="6" stroke-linecap="round"></line>`;
      }

      // Dots + labels
      let dots = '';
      for (let i = 0; i < order.length; i++) {
        const id = order[i];
        const xi = x(id);
        if (xi == null) continue;
        const n = nodeById.get(id) || { level:'gray', upcoming:true };
        dots += `
          <g>
            <!-- icon replaces connector marker (no dot) -->
            ${(USE_SPINE_ICONS && spineIcon(id)) ? `<g transform="translate(${xi - 12},${-12})">${spineIcon(id)}</g>` : `<text x="${xi}" y="7" text-anchor="middle" font-size="12" font-weight="600" fill="rgba(55,65,81,0.70)">${label(id)}</text>`}
          </g>
        `;
      }

      // Ongoing marker aligned to current node center
      const ongoingId = order[Math.max(0, Math.min(order.length-1, currentIdx))];
      const xo = x(ongoingId);
      const ongoing = (xo == null) ? '' : `
        <g>
          <line x1="${xo}" y1="2" x2="${xo}" y2="30" stroke="rgba(17,24,39,0.35)" stroke-width="1"></line>
          <text x="${xo}" y="40" text-anchor="middle" font-size="11" font-weight="600" fill="rgba(17,24,39,0.60)">ongoing</text>
        </g>
      `;

      rail.innerHTML = `
        <svg width="100%" height="48" viewBox="0 0 ${rr.width} 48" preserveAspectRatio="none">
          ${segs}
          ${dots}
          ${ongoing}
        </svg>`;
    };

    requestAnimationFrame(() => {
      draw();
      setTimeout(draw, 0);
    });
  }


function renderJourneyTop(ws, tz, receiving, vas, intl, manual) {
    const root = document.getElementById('flow-journey');
    if (!root) return;

    const now = new Date();

    // Determine operational "ongoing" index (same logic as before)
    let ongoingIdx = 2; // default VAS
    if ((receiving.receivedPOs || 0) < (receiving.plannedPOs || 0)) {
      ongoingIdx = 1;
    } else {
      const intlInWindow = (intl.originMin instanceof Date) ? (now >= intl.originMin) : false;
      ongoingIdx = intlInWindow ? 3 : 2;
    }

    // Node model (milk disabled)
    const nodes = [
      { id:'milk', label:'Milk Run', short:'MR', level:'gray', upcoming:true, disabled:true },
      { id:'receiving', label:'Receiving', short:'RCV', level: receiving.level, upcoming: now < receiving.due },
      { id:'vas', label:'VAS', short:'VAS', level: vas.level, upcoming: now < vas.due },
      { id:'intl', label:'Transit & Clearing', short:'T&C', level: intl.level, upcoming: now < intl.originMax },
      { id:'lastmile', label:'Last Mile', short:'LM', level: manual.levels.lastMile, upcoming: false },
    ];

    // Planned vs Actual (display only; never persisted)
    const plannedActual = (() => {
      const planned = {
        receiving: receiving.due,
        vas: vas.due,
        intl: intl.originMax,
        lastmile: manual?.baselines?.lastMileMax,
      };
      const actual = {
        receiving: (receiving?.signoff?.receivingAt || receiving.lastReceived),
        vas: (vas?.signoff?.vasAt || vas.lastAppliedAt || null),
        intl: intl.lastMilestoneAt || null,
        lastmile: (manual?.dates?.deliveredAt || manual?.dates?.delivered_at || manual?.manual?.delivered_at) || null,
      };

      const fmt = (d) => (d ? fmtInTZ((d instanceof Date) ? d : new Date(d), tz) : '—');
      return (id) => {
        if (!planned[id] && !actual[id]) return '';
        return `Planned ${fmt(planned[id])} • Actual ${fmt(actual[id])}`;
      };
    })();

    const matte = (hex, alpha) => {
      const h = (hex || '#9ca3af').replace('#','');
      const r = parseInt(h.slice(0,2),16) || 156;
      const g = parseInt(h.slice(2,4),16) || 163;
      const b = parseInt(h.slice(4,6),16) || 175;
      return `rgba(${r},${g},${b},${alpha})`;
    };
    // Journey/status color palette
    // - green: on track
    // - red: delayed
    // - gray: At-Risk (yellow-ish tone per spec)
    // - upcoming: distinct from At-Risk (cool neutral)
    // - future: capability not yet live
    const levelColor = (level) => ({
      green: '#34d399',
      red: '#fb7185',
      upcoming: '#cbd5e1',
      yellow: '#e6b800',
      gray: '#f6d365',
      future: '#e5e7eb',
    }[level] || '#9ca3af');
    const segStroke = (level, upcoming) => upcoming ? matte(levelColor(level), 0.28) : matte(levelColor(level), 0.50);
    const statusText = (n) => {
      if (!n) return '—';
      if (n.disabled) return 'Future';
      if (n.upcoming) return 'Upcoming';
      if (n.level === 'green') return 'On Track';
      if (n.level === 'red') return 'Delayed';
      return 'At-Risk';
    };
    const statusLevel = (n) => {
      if (!n) return 'gray';
      if (n.disabled) return 'future';
      if (n.upcoming) return 'upcoming';
      return n.level || 'gray';
    };


    const iconSvgFor = (id) => {
      try {
        const raw = (typeof NODE_ICONS !== 'undefined' && NODE_ICONS && NODE_ICONS[id]) ? String(NODE_ICONS[id]) : '';
        if (!raw) return '';
        return raw
          .replace(/class="[^"]*"/g, 'width="26" height="26"')
          .replace('<svg ', '<svg x="0" y="0" ');
      } catch { return ''; }
    };

    // Journey path geometry (viewBox units) - inverted S road
    const road = {
      A: { x: 80,  y: 70 },   // start
      B: { x: 920, y: 70 },   // top-right corner
      C: { x: 920, y: 235 },  // mid-right corner  // mid-right corner
      D: { x: 120, y: 235 },  // mid-left corner  // mid-left corner
      E: { x: 120, y: 400 },  // bottom-left corner  // bottom-left corner
      F: { x: 920, y: 400 },  // end  // end
    };
    const rad = 40;

    // Node placement on the road (per your reference layout)
    const pts = {
      milk:      { x: road.A.x, y: road.A.y }, // start
      // Receiving: shift ~30% left on the top line
      receiving: { x: Math.round(road.A.x + 0.35 * (road.B.x - road.A.x)), y: road.A.y },
      // VAS: shift ~30% right on the middle line
      vas:       { x: Math.round(road.D.x + 0.65 * (road.C.x - road.D.x)), y: road.C.y },
      // Transit & Clearing: shift ~25% left on the bottom line
      intl:      { x: Math.round((road.D.x + rad) + 0.20 * (road.F.x - (road.D.x + rad))), y: road.E.y },
      lastmile:  { x: road.F.x, y: road.F.y }, // end
    };

    const order = ['milk','receiving','vas','intl','lastmile'];

    // Road path (inverted S; straight segments with rounded joins)
    // Road path (inverted S with rounded corners)
    const roadPath = `
  M ${road.A.x} ${road.A.y}
  H ${road.B.x - rad}
  A ${rad} ${rad} 0 0 1 ${road.B.x} ${road.A.y + rad}
  V ${road.C.y - rad}
  A ${rad} ${rad} 0 0 1 ${road.B.x - rad} ${road.C.y}
  H ${road.D.x + rad}
  A ${rad} ${rad} 0 0 0 ${road.D.x} ${road.C.y + rad}
  V ${road.E.y - rad}
  A ${rad} ${rad} 0 0 0 ${road.D.x + rad} ${road.E.y}
  H ${road.F.x}
`;

// Colored segments along the road between milestones (keeps visuals consistent with the path)
    let segs = '';
    const segPathBetween = (fromId, toId) => {
      // Paths follow the same rounded road geometry so colors sit on the “asphalt”.
      if (fromId === 'milk' && toId === 'receiving') {
        return `M ${pts.milk.x} ${pts.milk.y} L ${pts.receiving.x} ${pts.receiving.y}`;
      }
      if (fromId === 'receiving' && toId === 'vas') {
        return `
          M ${pts.receiving.x} ${pts.receiving.y}
          L ${road.B.x - rad} ${road.A.y}
          A ${rad} ${rad} 0 0 1 ${road.B.x} ${road.A.y + rad}
          L ${road.B.x} ${road.C.y - rad}
          A ${rad} ${rad} 0 0 1 ${road.B.x - rad} ${road.C.y}
          L ${pts.vas.x} ${road.C.y}
        `;
      }
      if (fromId === 'vas' && toId === 'intl') {
        // second straight -> left curve -> bottom straight to Transit & Clearing (mid of bottom line)
        const x1 = road.D.x + rad;
        return `
          M ${pts.vas.x} ${road.C.y}
          L ${x1} ${road.C.y}
          A ${rad} ${rad} 0 0 0 ${road.D.x} ${road.C.y + rad}
          L ${road.D.x} ${road.E.y - rad}
          A ${rad} ${rad} 0 0 0 ${x1} ${road.E.y}
          L ${pts.intl.x} ${pts.intl.y}
        `;
      }
      if (fromId === 'intl' && toId === 'lastmile') {
        // bottom line straight to Last Mile
        return `
          M ${pts.intl.x} ${pts.intl.y}
          L ${pts.lastmile.x} ${pts.lastmile.y}
        `;
      }
      // Fallback: straight
      const a = pts[fromId], b = pts[toId];
      if (!a || !b) return '';
      return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    };

    for (let i = 0; i < order.length - 1; i++) {
      const fromId = order[i];
      const toId = order[i+1];
      // Segment color follows the destination node status, except Milk Run → Receiving which is always "future" (gray road).
      const nb = (fromId === 'milk') ? { level:'gray', upcoming:true } : (nodes[i+1] || { level:'gray', upcoming:true });
      const d = segPathBetween(fromId, toId);
      if (!d) continue;
      segs += `<path d="${d}" fill="none" stroke="${segStroke(nb.level, nb.upcoming)}" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" />`;
    }

    // Ghost/base road behind colored segments (thicker, subtle)
    const baseRoad = `<path d="${roadPath}" fill="none" stroke="rgba(148,163,184,0.45)" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" />`;

    // Center dashed line
    const dashed = `<path d="${roadPath}" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="3" stroke-dasharray="7 7" stroke-linecap="round" stroke-linejoin="round" />`;

    // Milestones (icons in white circles)
    let milestones = '';
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const p = pts[id];
      const n = nodes[i];
      if (!p || !n) continue;
      const icon = iconSvgFor(id);
      const isOngoing = (i === ongoingIdx);
      const ring = isOngoing ? 'rgba(17,24,39,0.25)' : 'rgba(17,24,39,0.12)';
      const labelX = p.x;
      const labelAnchor = 'middle';
      // Node name above icon
      const nameY = p.y - 46;

      const st = statusText(n);
      const stLevel = statusLevel(n);
      const stBg = matte(levelColor(stLevel), 0.14);
      const stFg = matte(levelColor(stLevel), 0.92);

      // Status pill below icon
      const pillW = Math.max(58, 14 + (String(st).length * 7));
      const pillH = 18;
      const pillY = p.y + 42;
      const pillX = p.x - (pillW / 2);
      const pillTextX = p.x;

      const pa = plannedActual(id);
      const paText = pa ? `<text x="${labelX}" y="${nameY - 16}" text-anchor="middle" font-size="12" font-weight="700" fill="rgba(17,24,39,0.55)">${pa}</text>` : '';
const done = (id === 'receiving')
  ? !!(receiving?.signoff?.receivingComplete)
  : (id === 'vas')
    ? !!(vas?.signoff?.vasComplete)
    : false;
const nameLabel = done ? `${n.label} ✓` : n.label;


      milestones += `
        <g class="flow-journey-hit" data-node="${id}" data-journey-node="${id}">
          <circle cx="${p.x}" cy="${p.y}" r="24" fill="white" stroke="${ring}" stroke-width="${isOngoing ? 2 : 1.2}"></circle>
          ${icon ? `<g transform="translate(${p.x - 13},${p.y - 13})">${icon}</g>` :
                   `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="rgba(55,65,81,0.75)">${n.short}</text>`}
          <text x="${labelX}" y="${nameY}" text-anchor="${labelAnchor}" font-size="18" font-weight="800" fill="rgba(17,24,39,0.78)">${nameLabel}</text>
          ${paText}
          <g>
            <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${pillH/2}" fill="${stBg}" stroke="rgba(17,24,39,0.06)" stroke-width="1"></rect>
            <text x="${pillTextX}" y="${pillY + 13}" text-anchor="middle" font-size="11" font-weight="700" fill="${stFg}">${st}</text>
          </g>
        </g>
      `;
    }

    const ongoingId = order[Math.max(0, Math.min(order.length - 1, ongoingIdx))];
    const op = pts[ongoingId];
    const ongoing = (!op) ? '' : `
      <g>
        <line x1="${op.x}" y1="${op.y + 28}" x2="${op.x}" y2="${op.y + 70}" stroke="rgba(17,24,39,0.25)" stroke-width="1" />
        <text x="${op.x}" y="${op.y + 86}" text-anchor="middle" font-size="11" font-weight="600" fill="rgba(17,24,39,0.55)">ongoing</text>
      </g>
    `;

    // Compact stats blocks under the journey (wow factor but stable)
    const stat = (title, a, b, n) => {
      const st = statusText(n);
      const stLevel = statusLevel(n);
      const bg = matte(levelColor(stLevel), 0.14);
      const fg = matte(levelColor(stLevel), 0.92);
      return `
        <div class="rounded-xl border bg-white p-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-xs font-semibold text-gray-700">${title}</div>
            <span style="background:${bg};color:${fg};border:1px solid rgba(17,24,39,0.06);" class="text-[11px] font-bold px-2 py-[2px] rounded-full whitespace-nowrap">${st}</span>
          </div>
          <div class="text-xs text-gray-500 mt-0.5">${a || ''}</div>
          ${b ? `<div class="text-xs text-gray-500">${b}</div>` : ''}
        </div>
      `;
    };

    // Use existing computed values; never assume presence
    const recA = `${(receiving.receivedPOs||0)}/${(receiving.plannedPOs||0)} POs`;
    const recB = `${(receiving.cartonsOutTotal||0)} out • ${(receiving.latePOs||0)} late`;
    const vasA = `${Math.round((vas.completion||0)*100)}% complete`;
    const vasB = `${(vas.appliedUnits||0)}/${(vas.plannedUnits||0)} units`;
    const intlA = `${(intl.lanes||[]).length} lanes`;
    const intlB = `${(intl.missingDocs||0)} docs missing • ${(intl.holds||0)} hold`;
    const lmA = `${(manual.manual?.last_mile_open||0)}/${(manual.manual?.last_mile_total||0)} open`;
    const lmB = manual.manual?.delivered_at ? `Delivered set` : `Delivered (set)`;

    root.innerHTML = `
      <div class="w-full overflow-hidden">
        <svg viewBox="-180 0 1250 560" preserveAspectRatio="xMidYMid meet" aria-label="Journey map" style="height:520px; width:100%;">

          <!-- road shadow (subtle) -->
          <path d="${roadPath}" fill="none" stroke="rgba(148,163,184,0.25)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round" transform="translate(2,3)"></path>
          <!-- road base -->
          <path d="${roadPath}" fill="none" stroke="rgba(148,163,184,0.45)" stroke-width="52" stroke-linecap="round" stroke-linejoin="round" />
          <path d="${roadPath}" fill="none" stroke="rgba(107,114,128,0.20)" stroke-width="43" stroke-linecap="round" stroke-linejoin="round" />
          ${baseRoad}
          ${segs}
          ${dashed}
          ${milestones}
          ${ongoing}
        </svg>
      </div>
    `;

    // Click handlers (use existing selection + detail render; never assume)
    try {
      root.querySelectorAll('[data-journey-node]').forEach(el => {
        el.addEventListener('click', () => {
          const node = el.getAttribute('data-node');
          UI.selection = { node, sub: null };
          renderDetail(ws, tz, receiving, vas, intl, manual);
          renderRightTile(ws, tz, receiving, vas, intl, manual);
          highlightSelection();
        });
      });
    } catch {}
  }

  // ------------------------- Right tile (context panel) -------------------------
  // Default shows week plan vs actual totals; clicking a node switches to exceptions/deadlines for that node.
  function renderRightTile(ws, tz, receiving, vas, intl, manual) {
    const el = document.getElementById('flow-footer');
    if (!el) return;

    const selNode = (UI.selection && UI.selection.node) ? UI.selection.node : null;

    const weekContainers = loadIntlWeekContainers(ws);
    const containers = Array.isArray(weekContainers?.containers) ? weekContainers.containers : [];
    const totalContainers = containers.length;
    const vesselsSet = new Set(containers.map(c => String(c?.vessel || '').trim()).filter(Boolean));
    const totalVessels = vesselsSet.size;

    const lanesTotal = Array.isArray(intl?.lanes) ? intl.lanes.length : 0;

    const appliedUnits = num(vas?.appliedUnits || 0);
    const plannedUnits = num(vas?.plannedUnits || 0);
    const cbm = appliedUnits * 0.00375;

    // Receiving CBM is derived from planned units (plan rows) * 0.00375
    const receivingCbmPlanned = plannedUnits * 0.00375;

    const recPlannedPOs = num(receiving?.plannedPOs || 0);
    const recReceivedPOs = num(receiving?.receivedPOs || 0);

    const cartonsIn = num(receiving?.cartonsInTotal || 0);
    const cartonsOut = num(receiving?.cartonsOutTotal || 0);

    const prebook = loadPrebook(ws);
    const signoff = loadWeekSignoff(ws);

    const icon = {
      po: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h6"/></svg>',
      units: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 17l9 4 9-4"/><path d="M3 12l9 4 9-4"/></svg>',
      cartons: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>',
      lane: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v16"/><path d="M20 4v16"/><path d="M4 12h16"/></svg>',
      ship: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 20h18"/><path d="M5 18l2-6h10l2 6"/><path d="M7 12V6l5-2 5 2v6"/></svg>',
      cont: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 7v13M11 7v13M15 7v13M19 7v13"/></svg>',
      box: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M12 13v8"/><path d="M3 8v8l9 5 9-5V8"/></svg>',
      warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 4.3l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z"/></svg>',
      time: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>',
    };

    const hRow = (ic, label, value) => `
      <div class="flex items-center justify-between gap-3 py-2">
        <div class="flex items-center gap-2 text-gray-700">
          <span class="text-gray-500">${ic}</span>
          <span class="text-sm font-semibold">${label}</span>
        </div>
        <div class="text-sm font-semibold text-gray-900">${value}</div>
      </div>
    `;

    const pairRow = (leftHtml, rightHtml) => `
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-xl border bg-white px-3 py-2">${leftHtml}</div>
        <div class="rounded-xl border bg-white px-3 py-2">${rightHtml}</div>
      </div>
    `;

    const header = (title, subtitle) => `
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-sm font-semibold text-gray-800">${title}</div>
          ${subtitle ? `<div class="text-xs text-gray-500 mt-0.5">${subtitle}</div>` : ''}
        </div>
        ${selNode ? `<button id="rt-back" class="text-xs px-2 py-1 rounded-md border bg-white hover:bg-gray-50">Week totals</button>` : ''}
      </div>
    `;

    const fmt2 = (n) => {
      const v = Number(n) || 0;
      return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    };

    const lvlColor = (lvl) => (lvl === 'red' ? '#ef4444' : (lvl === 'yellow' ? '#f59e0b' : (lvl === 'green' ? '#10b981' : '#9ca3af')));

    const health = (() => {
      const worst = [
        { label: 'Receiving', color: receiving?.color || lvlColor(receiving?.level) || '#10b981' },
        { label: 'VAS', color: vas?.color || lvlColor(vas?.level) || '#10b981' },
        { label: 'Transit', color: intl?.color || lvlColor(intl?.level) || '#10b981' },
        { label: 'Last Mile', color: lvlColor(manual?.levels?.lastMile) || '#10b981' },
      ].reduce((acc, n) => severityRank(n.color) > severityRank(acc.color) ? n : acc);
      const band = _bandFromColor(worst.color);
      const label = (band === 'green') ? 'On Track' : (band === 'yellow') ? 'At Risk' : (band === 'red') ? 'Delayed' : 'Upcoming';
      return { color: worst.color, label };
    })();


const signoffSection = (context) => {
  const recMet = receiving.planMet ?? ((receiving.plannedPOs || 0) > 0 ? (receiving.receivedPOs || 0) >= (receiving.plannedPOs || 0) : true);
  const vasMet = vas.planMet ?? ((vas.plannedUnits || 0) > 0 ? (vas.appliedUnits || 0) >= ((vas.plannedUnits || 0) * 0.98) : true);

  const hintRec = signoff.receivingComplete
    ? (recMet ? '<span class="text-green-700 font-semibold">Plan met</span>' : '<span class="text-amber-700 font-semibold">Signed off but incomplete</span>')
    : (recMet ? '<span class="text-gray-600">Plan met</span>' : '<span class="text-gray-600">Not yet complete</span>');

  const hintVas = signoff.vasComplete
    ? (vasMet ? '<span class="text-green-700 font-semibold">Plan met</span>' : '<span class="text-amber-700 font-semibold">Signed off but incomplete</span>')
    : (vasMet ? '<span class="text-gray-600">Plan met</span>' : '<span class="text-gray-600">Not yet complete</span>');

  const title = (context === 'node') ? 'Week sign-off' : 'Week sign-off (master ticks)';
  return `
    <div class="rounded-2xl border bg-white p-3">
      <div class="text-xs font-semibold text-gray-700">${title}</div>
      <div class="text-[11px] text-gray-500 mt-0.5">Use these only when the week is operationally complete. Does not create fake timestamps.</div>

      <div class="mt-3 space-y-3">
        <label class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-gray-800">Receiving complete</div>
            <div class="text-[11px] mt-0.5">${hintRec}</div>
          </div>
          <input id="signoff-receiving" type="checkbox" class="h-5 w-5 rounded border-gray-300" ${signoff.receivingComplete ? 'checked' : ''} />
        </label>

        <label class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-gray-800">VAS complete</div>
            <div class="text-[11px] mt-0.5">${hintVas}</div>
          </div>
          <input id="signoff-vas" type="checkbox" class="h-5 w-5 rounded border-gray-300" ${signoff.vasComplete ? 'checked' : ''} />
        </label>
      </div>
    </div>
  `;
};

    const weekTotalsView = () => {
      return `
        ${header('Week plan vs actual', `Week of ${ws}`)}
        <div class="mt-3 space-y-3">
          <div class="rounded-2xl border bg-gray-50 p-3">
            ${hRow(icon.po, 'POs planned – received', `${fmtInt(recPlannedPOs)} – ${fmtInt(recReceivedPOs)}`)}
            ${hRow(icon.units, 'Units planned – applied', `${fmtInt(plannedUnits)} – ${fmtInt(appliedUnits)}`)}
            ${hRow(icon.cartons, 'Cartons in – cartons out', `${fmtInt(cartonsIn)} – ${fmtInt(cartonsOut)}`)}
          </div>

          ${pairRow(
            hRow(icon.lane, 'Total lanes', fmtInt(lanesTotal)),
            hRow(icon.ship, 'Total vessels', fmtInt(totalVessels))
          )}

          ${pairRow(
            hRow(icon.cont, 'Total containers', fmtInt(totalContainers)),
            hRow(icon.box, 'Total CBM', fmt2(cbm))
          )}

          <div class="rounded-2xl border bg-white p-3">
            <div class="text-xs font-semibold text-gray-700">Pre-booked containers</div>
            <div class="text-[11px] text-gray-500 mt-0.5">Plan inputs for this week (local only)</div>
            <div class="grid grid-cols-2 gap-3 mt-3">
              <label class="block">
                <div class="text-xs font-semibold text-gray-700">20 ft</div>
                <input id="prebook-20" type="number" min="0" class="mt-1 w-full rounded-lg border px-3 py-2 text-sm" value="${fmtInt(prebook.c20)}" />
              </label>
              <label class="block">
                <div class="text-xs font-semibold text-gray-700">40 ft</div>
                <input id="prebook-40" type="number" min="0" class="mt-1 w-full rounded-lg border px-3 py-2 text-sm" value="${fmtInt(prebook.c40)}" />
              </label>
            </div>
          </div>

          

          <div class="flex items-center justify-between">
            <span class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
                  style="background:${statusBg(health.color)}; border-color:${statusStroke(health.color)};">
              <span class="inline-block h-2 w-2 rounded-full" style="background:${health.color};"></span>
              <span class="font-semibold">Health</span>
              <span>${health.label}</span>
            </span>
            <span class="text-xs text-gray-600">Deadlines & exceptions on node click</span>
          </div>
          
        </div>
      `;
    };

    const milkRunView = () => {
      // Milk Run is a planning checkpoint. Keep this view focused on plan inputs.
      return `
        ${header('Milk Run — planning', `Week of ${ws}`)}
        <div class="mt-3 space-y-3">
          <div class="rounded-2xl border bg-gray-50 p-3">
            ${hRow(icon.po, 'POs planned', fmtInt(recPlannedPOs))}
            ${hRow(icon.units, 'Units planned', fmtInt(plannedUnits))}
            ${hRow(icon.box, 'Planned CBM', fmt2(receivingCbmPlanned))}
          </div>

          ${pairRow(
            hRow(icon.lane, 'Total lanes', fmtInt(lanesTotal)),
            hRow(icon.ship, 'Total vessels', fmtInt(totalVessels))
          )}

          ${pairRow(
            hRow(icon.cont, 'Total containers', fmtInt(totalContainers)),
            hRow(icon.box, 'Total CBM', fmt2(cbm))
          )}

          <div class="rounded-2xl border bg-white p-3">
            <div class="text-xs font-semibold text-gray-700">Pre-booked containers</div>
            <div class="text-[11px] text-gray-500 mt-0.5">Enter committed capacity for this week (local only)</div>
            <div class="grid grid-cols-2 gap-3 mt-3">
              <label class="block">
                <div class="text-xs font-semibold text-gray-700">20 ft</div>
                <input id="prebook-20" type="number" min="0" class="mt-1 w-full rounded-lg border px-3 py-2 text-sm" value="${fmtInt(prebook.c20)}" />
              </label>
              <label class="block">
                <div class="text-xs font-semibold text-gray-700">40 ft</div>
                <input id="prebook-40" type="number" min="0" class="mt-1 w-full rounded-lg border px-3 py-2 text-sm" value="${fmtInt(prebook.c40)}" />
              </label>
            </div>
          </div>

          

          <div class="flex items-center justify-between">
            <span class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
                  style="background:${statusBg(health.color)}; border-color:${statusStroke(health.color)};">
              <span class="inline-block h-2 w-2 rounded-full" style="background:${health.color};"></span>
              <span class="font-semibold">Health</span>
              <span>${health.label}</span>
            </span>
            <span class="text-xs text-gray-600">Click nodes for exceptions</span>
          </div>
          
        </div>
      `;
    };

    const receivingView = () => {
      const due = receiving?.due ? fmtInTZ(receiving.due, tz) : '—';
      const last = receiving?.lastReceived ? fmtInTZ(receiving.lastReceived, tz) : '—';
      const late = num(receiving?.latePOs || 0);
      const missing = num(receiving?.missingPOs || 0);
      const remaining = Math.max(0, recPlannedPOs - recReceivedPOs);

      return `
        ${header('Receiving — deadlines & exceptions', `Due ${due}`)}
        <div class="mt-3 space-y-3">
          <div class="rounded-2xl border bg-gray-50 p-3">
            ${hRow(icon.time, 'Last received', last)}
            ${hRow(icon.po, 'Remaining POs', fmtInt(remaining))}
            ${hRow(icon.box, 'Receiving CBM (planned)', fmt2(receivingCbmPlanned))}
          </div>
          <div class="rounded-2xl border bg-white p-3">
            ${hRow(icon.warn, 'Late POs', late ? `<span class="text-red-700">${fmtInt(late)}</span>` : fmtInt(late))}
            ${hRow(icon.warn, 'Missing POs', missing ? `<span class="text-red-700">${fmtInt(missing)}</span>` : fmtInt(missing))}
            <div class="text-[11px] text-gray-500 mt-2">Tip: use the Receiving page for the full list; this panel is the headline view.</div>
          </div>
        </div>
      `;
    };

    const vasView = () => {
      const due = vas?.due ? fmtInTZ(vas.due, tz) : '—';
      const pctDone = plannedUnits ? Math.round((appliedUnits / plannedUnits) * 100) : 0;
      const remainingUnits = Math.max(0, plannedUnits - appliedUnits);
      const remainingCbm = Math.max(0, remainingUnits) * 0.00375;
      const appliedCbm = appliedUnits * 0.00375;

      // Pace / deadline helper (UI-only)
      const pace = (() => {
        const d = vas?.due instanceof Date ? vas.due : (vas?.due ? new Date(vas.due) : null);
        if (!d || isNaN(d)) return null;
        const now = new Date();
        const ms = d.getTime() - now.getTime();
        const daysLeft = Math.ceil(ms / (1000 * 60 * 60 * 24));
        if (daysLeft <= 0) return { label: 'Past due', value: `${fmtInt(Math.max(0, Math.round((-ms) / (1000 * 60 * 60))))}h` };
        const perDay = remainingUnits / Math.max(1, daysLeft);
        return { label: 'Pace needed', value: `${fmtInt(Math.ceil(perDay))} units/day` };
      })();

      const lateBy = (() => {
        if (!vas?.due) return null;
        const now = new Date();
        const d = vas.due instanceof Date ? vas.due : new Date(vas.due);
        if (isNaN(d)) return null;
        const diffH = Math.round((now.getTime() - d.getTime()) / (1000 * 60 * 60));
        return diffH > 0 ? diffH : 0;
      })();

      return `
        ${header('VAS — plan vs actual', `Due ${due}`)}
        <div class="mt-3 space-y-3">
          <div class="rounded-2xl border bg-gray-50 p-3">
            ${hRow(icon.units, 'Applied / Planned', `${fmtInt(appliedUnits)} / ${fmtInt(plannedUnits)} (${pctDone}%)`)}
            ${hRow(icon.warn, 'Units remaining', fmtInt(remainingUnits))}
            ${hRow(icon.box, 'CBM applied', fmt2(appliedCbm))}
            ${hRow(icon.box, 'CBM remaining', fmt2(remainingCbm))}
            ${pace ? hRow(icon.time, pace.label, pace.value) : ''}
          </div>
          <div class="rounded-2xl border bg-white p-3">
            <div class="text-xs font-semibold text-gray-700">Focus</div>
            <div class="text-sm text-gray-800 mt-1">Watch remaining units vs the due window${lateBy ? ` (now ${fmtInt(lateBy)}h past due)` : ''}. Use the bottom tile for supplier/PO detail.</div>
          </div>
        </div>
      `;
    };

    const intlView = () => {
      const windowText = (intl?.originMin && intl?.originMax)
        ? `${fmtInTZ(intl.originMin, tz)} – ${fmtInTZ(intl.originMax, tz)}`
        : '—';
      const holds = num(intl?.holds || 0);
      const docs = num(intl?.missingDocs || 0);
      const notCleared = num(intl?.missingOriginClear || 0);
      const onTime = Array.isArray(intl?.lanes)
        ? intl.lanes.filter(l => (l?.level === 'green') || (_bandFromColor(l?.color || '') === 'green')).length
        : 0;

      return `
        ${header('Transit & Clearing — exceptions', `Origin window ${windowText}`)}
        <div class="mt-3 space-y-3">
          <div class="rounded-2xl border bg-gray-50 p-3">
            ${hRow(icon.lane, 'Lanes', fmtInt(lanesTotal))}
            ${hRow(icon.ship, 'Vessels', fmtInt(totalVessels))}
            ${hRow(icon.cont, 'Containers', fmtInt(totalContainers))}
            ${hRow(icon.time, 'On-time lanes', fmtInt(onTime))}
          </div>
          <div class="rounded-2xl border bg-white p-3">
            ${hRow(icon.warn, 'Customs holds', holds ? `<span class="text-red-700">${fmtInt(holds)}</span>` : fmtInt(holds))}
            ${hRow(icon.warn, 'Missing docs', docs ? `<span class="text-amber-700">${fmtInt(docs)}</span>` : fmtInt(docs))}
            ${hRow(icon.warn, 'Not origin-cleared', notCleared ? `<span class="text-amber-700">${fmtInt(notCleared)}</span>` : fmtInt(notCleared))}
          </div>
        </div>
      `;
    };

    const lastMileView = () => {
      const receipts = loadLastMileReceipts(ws) || {};
      const r = receipts?.receipts || receipts || {};
      const vals = Object.values(r).filter(Boolean);
      const isDelivered = (x) => !!(x && (x.status === 'Delivered' || x.status === 'Complete' || x.delivered_local || x.delivered_at));
      const isScheduled = (x) => !!(x && (x.status === 'Scheduled' || x.scheduled_local));

      const delivered = vals.filter(isDelivered).length;
      // Scheduled should exclude delivered (two-step workflow: scheduled → delivered)
      const scheduled = vals.filter(x => isScheduled(x) && !isDelivered(x)).length;
      const open = Math.max(0, totalContainers - delivered);

      return `
        ${header('Last Mile — exceptions', `Open ${fmtInt(open)} / ${fmtInt(totalContainers)}`)}
        <div class="mt-3 space-y-3">
          <div class="rounded-2xl border bg-gray-50 p-3">
            ${hRow(icon.cont, 'Scheduled', fmtInt(scheduled))}
            ${hRow(icon.cont, 'Delivered', fmtInt(delivered))}
          </div>
          <div class="rounded-2xl border bg-white p-3">
            <div class="text-xs font-semibold text-gray-700">Focus</div>
            <div class="text-sm text-gray-800 mt-1">Oldest open containers and delivery notes live in the bottom tile. This panel highlights weekly risk.</div>
          </div>
        </div>
      `;
    };

    const view = (() => {
      if (selNode === 'milk') return milkRunView();
      if (selNode === 'receiving') return receivingView();
      if (selNode === 'vas') return vasView();
      if (selNode === 'intl') return intlView();
      if (selNode === 'lastmile') return lastMileView();
      return weekTotalsView();
    })();

    el.innerHTML = `<div class="min-h-[320px]">${view}${signoffSection(selNode ? 'node' : 'week')}</div>`;

    // Bind back button
    const back = document.getElementById('rt-back');
    if (back && !back.dataset.bound) {
      back.dataset.bound = '1';
      back.onclick = () => {
        UI.selection = { node: null, sub: null };
        renderRightTile(ws, tz, receiving, vas, intl, manual);
        highlightSelection();
      };
    }

    // Bind prebook inputs (week totals view only)
    const i20 = document.getElementById('prebook-20');
    const i40 = document.getElementById('prebook-40');
    const bindPre = (inp, key) => {
      if (!inp || inp.dataset.bound) return;
      inp.dataset.bound = '1';
      inp.addEventListener('input', () => {
        const next = loadPrebook(ws);
        next[key] = num(inp.value || 0);
        savePrebook(ws, next);
      });
    };
    bindPre(i20, 'c20');
    bindPre(i40, 'c40');

// Bind week sign-off ticks (available in week + node views)
const sRec = document.getElementById('signoff-receiving');
const sVas = document.getElementById('signoff-vas');
const bindSign = (inp, key) => {
  if (!inp || inp.dataset.bound) return;
  inp.dataset.bound = '1';
  inp.addEventListener('change', () => {
    const next = loadWeekSignoff(ws);
    const checked = !!inp.checked;
    next[key] = checked;
    // Capture sign-off timestamp for journey 'Actual' display.
    if (key === 'receivingComplete') {
      next.receivingAt = checked ? (next.receivingAt || new Date().toISOString()) : null;
    }
    if (key === 'vasComplete') {
      next.vasAt = checked ? (next.vasAt || new Date().toISOString()) : null;
    }
    saveWeekSignoff(ws, next);

    // Recompute local node levels immediately (no backend changes).
    // Refresh will reload data but this ensures instant UI feedback.
    try { refresh(); } catch {}
  });
};
bindSign(sRec, 'receivingComplete');
bindSign(sVas, 'vasComplete');


  }






  // ------------------------------
  // Receiving — Full screen modal (units-based grouped table)
  // ------------------------------
  function ensureReceivingFullModal() {
    let root = document.getElementById('flow-receiving-fullscreen-modal');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'flow-receiving-fullscreen-modal';
    root.className = 'fixed inset-0 z-[9999] hidden';
    root.innerHTML = `
      <div class="absolute inset-0 bg-black/40"></div>
      <div class="absolute inset-0 p-4">
        <div class="bg-white rounded-xl shadow-xl w-full h-full overflow-hidden flex flex-col">
          <div class="flex items-center justify-between px-4 py-3 border-b">
            <div>
              <div class="text-base font-semibold">Receiving — Full screen</div>
              <div id="flow-recvfs-sub" class="text-xs text-gray-500">Supplier drilldown • Approximate received units (planned units for received POs).</div>
            </div>
            <button data-flow-recvfs-close class="px-3 py-1.5 text-sm rounded-md border hover:bg-gray-50">Close</button>
          </div>

          <div class="flex-1 overflow-auto p-4">
            <div id="flow-recvfs-kpis" class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4"></div>

            <div class="flex flex-col lg:flex-row gap-4">
              <div class="lg:w-1/2">
                <div class="text-sm font-semibold mb-2">Suppliers</div>
                <div class="rounded-lg border overflow-hidden">
                  <table class="w-full text-sm">
                    <thead class="bg-gray-50">
                      <tr>
                        <th class="text-left px-3 py-2">Supplier</th>
                        <th class="text-right px-3 py-2">POs received</th>
                        <th class="text-right px-3 py-2">Approx received units</th>
                      </tr>
                    </thead>
                    <tbody id="flow-recvfs-sup-rows"></tbody>
                  </table>
                </div>
              </div>

              <div class="lg:w-1/2">
                <div class="flex items-center justify-between mb-2">
                  <div class="text-sm font-semibold">Received POs</div>
                  <div class="flex gap-2">
                    <button id="flow-recvfs-dl-selected" class="px-3 py-1.5 text-sm rounded-md border hover:bg-gray-50">Download selected</button>
                    <button id="flow-recvfs-dl-all" class="px-3 py-1.5 text-sm rounded-md border hover:bg-gray-50">Download all</button>
                  </div>
                </div>

                <div class="flex items-center gap-2 mb-2">
                  <label class="text-xs text-gray-600">Supplier</label>
                  <select id="flow-recvfs-sel" class="text-sm border rounded-md px-2 py-1 bg-white"></select>
                </div>

                <div class="rounded-lg border overflow-hidden">
                  <table class="w-full text-sm">
                    <thead class="bg-gray-50">
                      <tr>
                        <th class="text-left px-3 py-2">PO</th>
                        <th class="text-right px-3 py-2">Planned units</th>
                        <th class="text-left px-3 py-2">Received at</th>
                      </tr>
                    </thead>
                    <tbody id="flow-recvfs-po-rows"></tbody>
                  </table>
                </div>

                <div id="flow-recvfs-note" class="text-xs text-gray-500 mt-2"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelector('[data-flow-recvfs-close]')?.addEventListener('click', () => {
      root.classList.add('hidden');
    });
    root.addEventListener('click', (e) => {
      if (e.target === root) root.classList.add('hidden');
      // Click outside panel
      if (e.target && e.target.classList && e.target.classList.contains('bg-black/40')) root.classList.add('hidden');
    });

    return root;
  }

  function _csvDownload(filename, rows) {
    const esc = (v) => {
      const s = (v === null || v === undefined) ? '' : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const csv = rows.map(r => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function openReceivingFullScreenModal() {
    // NOTE: This is a UI-only enhancement. It does not affect any calculations elsewhere.
    const fmtNum = (v) => {
      if (v === null || v === undefined || v === '') return '—';
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      return n.toLocaleString();
    };
    const fmtDateTimeLocal = (tz, ts) => {
      try {
        if (!ts) return '';
        const d = (ts instanceof Date) ? ts : new Date(ts);
        if (!Number.isFinite(d.getTime())) return String(ts);
        const opt = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
        try {
          return new Intl.DateTimeFormat('en-US', { ...opt, timeZone: tz || undefined }).format(d);
        } catch {
          return new Intl.DateTimeFormat('en-US', opt).format(d);
        }
      } catch {
        return '';
      }
    };

    // Date-only formatter for table columns (no time)
    const fmtDateOnlyLocal = (tz, ts) => {
      try {
        if (!ts) return '';
        // Accept already-formatted dates (MM/DD/YYYY or YYYY-MM-DD)
        const s0 = String(ts).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s0)) return s0;
        if (/^\d{4}-\d{2}-\d{2}$/.test(s0)) {
          const [y, m, d] = s0.split('-');
          return `${m}/${d}/${y}`;
        }
        const d = (ts instanceof Date) ? ts : new Date(ts);
        if (!Number.isFinite(d.getTime())) return s0;
        const opt = { year: 'numeric', month: '2-digit', day: '2-digit' };
        try {
          return new Intl.DateTimeFormat('en-US', { ...opt, timeZone: tz || undefined }).format(d);
        } catch {
          return new Intl.DateTimeFormat('en-US', opt).format(d);
        }
      } catch {
        return '';
      }
    };

    const ctx = window.__FLOW_RECEIVING_FS_CTX__;
    if (!ctx || !ctx.planRows || !ctx.receivingRows) {
      alert('Receiving data not available yet. Please refresh the page and try again.');
      return;
    }

    const { ws, tz, planRows, receivingRows, records } = ctx;
    const normalizePO = (v) => String(v ?? '').trim().toUpperCase();
    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const normalizeFreight = (v) => {
      const s = String(v ?? '').trim();
      if (!s) return '';
      const low = s.toLowerCase();
      if (low.includes('sea') || low.includes('ocean')) return 'Sea';
      if (low.includes('air')) return 'Air';
      return s.charAt(0).toUpperCase() + s.slice(1);
    };


    // -------------------- Build PO-level facts (units-only) --------------------

    // 1) Received timestamps by PO
    const receivedByPO = new Map();
    for (const r of (receivingRows || [])) {
      const po = normalizePO(r.po ?? r.PO ?? r.po_number ?? r.PO_Number ?? r.poNumber ?? r.po_no ?? r.poNo);
      const receivedAt = r.receivedAt || r.received_at || r.received_at_utc || r.received;
      if (!po) continue;
      if (receivedAt) receivedByPO.set(po, receivedAt);
    }

    // 2) Planned units + metadata by PO (prefer planRows for supplier / zendesk / freight)
    const getPO = (r) => normalizePO(
      r.po_number ?? r.poNumber ?? r.PO_Number ?? r.PO ?? r.po ?? r.po_no ?? r.poNo ?? r.supplier_po ?? r.supplierPO ?? ''
    );
    const getPlannedUnits = (r) => (
      toNum(r.target_qty ?? r.targetQty ?? r.planned_qty ?? r.plannedQty ?? r.planned_units ?? r.plannedUnits ?? r.PlannedUnits ?? r.units ?? r.Units ?? r.qty ?? r.Qty)
    );

    const plannedUnitsByPO = new Map();
    const metaByPO = new Map(); // {supplier, zendesk, freight}
    for (const row of (planRows || [])) {
      const po = getPO(row);
      if (!po) continue;

      plannedUnitsByPO.set(po, (plannedUnitsByPO.get(po) || 0) + getPlannedUnits(row));

      // Try several likely field names (keep additive + non-breaking)
      const supplier = row.supplier || row.Supplier || row.vendor || row.Vendor || row.supplier_name || row.supplierName || row.factory || row.Factory;
      const zendesk = row.zendesk || row.zendesk_ticket || row.zendesk_ticket_number || row.zendesk_ticket_num || row.ticket || row.ticket_id || row.zendeskTicket || row.zendeskTicketNumber || row.zendesk_no || row.zendeskNo;
      const freightRaw = row.freight_type ?? row.freightType ?? row.freightTypeName ?? row.freight ?? row.mode ?? row.ship_mode ?? row.shipMode ?? row.Freight ?? row.transport_mode ?? row.transportMode ?? row.transport ?? row.Transport;
      const freight = freightRaw ? normalizeFreight(freightRaw) : undefined;

      const prev = metaByPO.get(po) || {};
      metaByPO.set(po, {
        supplier: prev.supplier || (supplier ? String(supplier) : undefined),
        zendesk: prev.zendesk || ((zendesk !== null && zendesk !== undefined && zendesk !== '') ? String(zendesk) : undefined),
        freight: prev.freight || (freight ? String(freight) : undefined),
      });
    }

    // 2b) Back-fill metadata from receivingRows if planRows did not carry it
    for (const r of (receivingRows || [])) {
      const po = normalizePO(r.po ?? r.PO ?? r.po_number ?? r.PO_Number ?? r.poNumber ?? r.po_no ?? r.poNo);
      if (!po) continue;
      if (!metaByPO.has(po)) metaByPO.set(po, {});
      const prev = metaByPO.get(po) || {};

      const supplier = r.supplier || r.Supplier || r.vendor || r.Vendor || r.supplier_name || r.supplierName;
      const zendesk = r.zendesk || r.zendesk_ticket || r.ticket || r.ticket_id || r.zendeskTicket;
      const freightRaw = r.freight_type ?? r.freightType ?? r.freight ?? r.mode ?? r.ship_mode ?? r.shipMode ?? r.Freight ?? r.transport_mode ?? r.transportMode;
      const freight = freightRaw ? normalizeFreight(freightRaw) : undefined;

      metaByPO.set(po, {
        supplier: prev.supplier || (supplier ? String(supplier) : undefined),
        zendesk: prev.zendesk || ((zendesk !== null && zendesk !== undefined && zendesk !== '') ? String(zendesk) : undefined),
        freight: prev.freight || (freight ? String(freight) : undefined),
      });
    }

    // 3) Applied units (VAS actuals) by PO from records (units-only, align with computeVASStatus)
    // NOTE: We intentionally do NOT filter by status here because the VAS endpoint payload is not consistent
    // across environments, and the core UI logic (computeVASStatus) counts all returned rows.
    const appliedUnitsByPO = new Map();

    const recs = Array.isArray(records)
      ? records
      : (records && Array.isArray(records.records) ? records.records
        : (records && Array.isArray(records.rows) ? records.rows
          : (records && Array.isArray(records.data) ? records.data : [])));

    for (const rec of recs) {
      const po = getPO(rec) || normalizePO(rec.po_number ?? rec.po ?? rec.PO ?? rec.PO_Number);
      if (!po) continue;

      const qtyRaw = rec.qty ?? rec.quantity ?? rec.units ?? rec.target_qty ?? rec.applied_qty ?? rec.applied_units ?? rec.appliedUnits ?? rec.Qty ?? rec.Units;
      const qty = toNum(qtyRaw);
      const q = qty > 0 ? qty : 1; // match computeVASStatus defaulting behavior

      appliedUnitsByPO.set(po, (appliedUnitsByPO.get(po) || 0) + q);
    }

    // 4) Build PO-level rows for ALL planned POs (not only received)
    const rows = [];
    for (const [po, plannedUnits] of plannedUnitsByPO.entries()) {
      const meta = metaByPO.get(po) || {};
      const supplier = meta.supplier || '—';
      const zendesk = meta.zendesk || '—';
      const freight = meta.freight || '—';
      const receivedAt = receivedByPO.get(po) || '';
      const approxReceivedUnits = receivedAt ? plannedUnits : 0; // definition: planned units for received POs
      const appliedUnits = appliedUnitsByPO.get(po) || 0;

      // Lane-level fields (from Intl Transit & Clearing lane manual inputs)
      let etaFC = '';
      let latestArrivalDate = '';
      let shipmentNo = '';
      let hbl = '';
      let mbl = '';
      try {
        const ticket = (zendesk && zendesk !== '—') ? zendesk : 'NO_TICKET';
        const lKey = (typeof laneKey === 'function') ? laneKey(supplier, ticket, freight) : '';
        const lm = lKey ? (loadIntlLaneManual(ws, lKey) || {}) : {};
        etaFC = String(lm.eta_fc || lm.etaFC || lm.eta_fc_at || lm.eta_fc_fc || '').trim();
        latestArrivalDate = String(lm.latest_arrival_date || lm.latestArrivalDate || lm.latestArrival || lm.latest_arrival || '').trim();
        shipmentNo = String(lm.shipment_no || lm.shipmentNo || lm.shipment_number || lm.shipmentNumber || lm.shipment || '').trim();
        hbl = String(lm.hbl || lm.HBL || '').trim();
        mbl = String(lm.mbl || lm.MBL || '').trim();
      } catch { /* ignore */ }

      rows.push({ supplier, zendesk, freight, po, plannedUnits, approxReceivedUnits, appliedUnits, shipmentNo, hbl, mbl, etaFC,
 latestArrivalDate, receivedAt });
    }
    rows.sort((a,b) =>
      a.supplier.localeCompare(b.supplier) ||
      String(a.zendesk).localeCompare(String(b.zendesk)) ||
      String(a.freight).localeCompare(String(b.freight)) ||
      String(a.po).localeCompare(String(b.po))
    );

    // -------------------- KPIs (keep the ones you already like) --------------------
    const receivedOnly = rows.filter(r => !!r.receivedAt);
    const totalReceivedPOs = receivedOnly.length;
    const totalApproxUnits = receivedOnly.reduce((a,r)=>a+(r.approxReceivedUnits||0),0);
    const totalAppliedUnits = rows.reduce((a,r)=>a+(r.appliedUnits||0),0);
    const suppliersWithReceipts = new Set(receivedOnly.map(r=>r.supplier)).size;

    const root = ensureReceivingFullModal();
    root.classList.remove('hidden');

    // Replace the body content with a unified grouped table (no dropdown dependency).
    // Baseline modal markup doesn't always include a dedicated body id, so fall back to the main scroll container.
    const body = root.querySelector('#flow-recvfs-body') || root.querySelector('.flex-1.overflow-auto.p-4');
    if (body) {
      body.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4" id="flow-recvfs-kpis"></div>

        <div class="flex items-center justify-between mb-2">
          <div>
            <div class="text-sm font-semibold">Receiving — Full screen (units-based)</div>
            <div class="text-[11px] text-gray-500">Grouped: Supplier → Zendesk → Freight → PO</div>
          </div>
          <div class="flex gap-2">
            <button id="flow-recvfs-expandall" class="px-3 py-1.5 text-sm rounded-md border hover:bg-gray-50">Expand all</button>
            <button id="flow-recvfs-collapseall" class="px-3 py-1.5 text-sm rounded-md border hover:bg-gray-50">Collapse all</button>
            <button id="flow-recvfs-dl-all" class="px-3 py-1.5 text-sm rounded-md border hover:bg-gray-50">Download (PO rows)</button>
          </div>
        </div>

        <div class="rounded-lg border overflow-auto" style="max-height:70vh">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th class="text-left px-3 py-2">Supplier / Zendesk / Freight / PO</th>
                <th class="text-left px-3 py-2">Freight</th>
                <th class="text-right px-3 py-2">Planned units</th>
                <th class="text-right px-3 py-2">Approx received units</th>
                <th class="text-right px-3 py-2">UID applied units</th>
                <th class="text-left px-3 py-2">Shipment #</th>
                <th class="text-left px-3 py-2">HBL</th>
                <th class="text-left px-3 py-2">MBL</th>
                <th class="text-left px-3 py-2">ETA FC</th>
                <th class="text-left px-3 py-2">Latest arrival date</th>
                <th class="text-left px-3 py-2">Received at</th>
              </tr>
            </thead>
            <tbody id="flow-recvfs-rows"></tbody>
          </table>
        </div>
      `;
    }

    // KPIs
    const kpi = root.querySelector('#flow-recvfs-kpis');
    if (kpi) {
      kpi.innerHTML = `
        <div class="rounded-lg border p-3">
          <div class="text-xs text-gray-500">POs received</div>
          <div class="text-xl font-semibold">${fmtNum(totalReceivedPOs)}</div>
        </div>
        <div class="rounded-lg border p-3">
          <div class="text-xs text-gray-500">Approx received units</div>
          <div class="text-xl font-semibold">${fmtNum(totalApproxUnits)}</div>
          <div class="text-[11px] text-gray-500 mt-1">Sum of planned units for received POs</div>
        </div>
        <div class="rounded-lg border p-3">
          <div class="text-xs text-gray-500">UID applied units</div>
          <div class="text-xl font-semibold">${fmtNum(totalAppliedUnits)}</div>
          <div class="text-[11px] text-gray-500 mt-1">From VAS records (status=complete)</div>
        </div>
        <div class="rounded-lg border p-3">
          <div class="text-xs text-gray-500">Suppliers with receipts</div>
          <div class="text-xl font-semibold">${fmtNum(suppliersWithReceipts)}</div>
        </div>
      `;
    }

    // -------------------- Grouped / expandable rendering --------------------
    const state = window.__FLOW_RECVFS_EXPAND_STATE__ = window.__FLOW_RECVFS_EXPAND_STATE__ || {
      collapsedSupplier: new Set(),
      collapsedZendesk: new Set(),
      collapsedFreight: new Set(),
    };

    const makeKey = (parts) => parts.map(p => String(p ?? '—')).join('|||');
    const esc = (v) => (typeof escapeHtml === 'function') ? escapeHtml(String(v ?? '')) : String(v ?? '');

    // Build nested grouping: supplier -> zendesk -> freight -> po rows
    const groups = new Map();
    for (const r of rows) {
      const sKey = r.supplier || '—';
      const zKey = r.zendesk || '—';
      const fKey = r.freight || '—';

      if (!groups.has(sKey)) groups.set(sKey, new Map());
      const zg = groups.get(sKey);
      if (!zg.has(zKey)) zg.set(zKey, new Map());
      const fg = zg.get(zKey);
      if (!fg.has(fKey)) fg.set(fKey, []);
      fg.get(fKey).push(r);
    }

    const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);
    const countReceived = (arr) => arr.reduce((a, x) => a + (x.receivedAt ? 1 : 0), 0);

    const caret = (isCollapsed) => isCollapsed ? '▸' : '▾';

    const render = () => {
      const tb = root.querySelector('#flow-recvfs-rows');
      if (!tb) return;

      let html = '';
      let poRowIdx = 0;
      let supplierIdx = 0;
      const suppliers = Array.from(groups.keys()).sort((a,b)=>String(a).localeCompare(String(b)));

      for (const supplier of suppliers) {
        const supZebra = (supplierIdx++ % 2) ? 'bg-[#990033]/5' : 'bg-white';
        const sId = 'S:' + supplier;
        const zg = groups.get(supplier);
        const allRowsS = [];
        for (const fm of zg.values()) for (const arr of fm.values()) allRowsS.push(...arr);

        const sPlanned = sum(allRowsS, x=>x.plannedUnits);
        const sApprox = sum(allRowsS, x=>x.approxReceivedUnits);
        const sApplied = sum(allRowsS, x=>x.appliedUnits);
        const sPOs = allRowsS.length;
        const sRecPOs = countReceived(allRowsS);
        const sPct = sPOs ? Math.round((sRecPOs / sPOs) * 100) : 0;

        const sCollapsed = state.collapsedSupplier.has(sId);
        html += `
          <tr class="${supZebra} hover:bg-gray-50 cursor-pointer select-none" data-kind="supplier" data-id="${esc(sId)}">
            <td class="px-3 py-2 font-semibold text-[14px]">
              <span class="inline-block w-4">${caret(sCollapsed)}</span>
              ${esc(supplier)}
              <span class="text-[11px] text-gray-500 ml-2">(${fmtNum(sRecPOs)}/${fmtNum(sPOs)} POs received)</span>
              <div class="mt-1 w-40 h-1.5 bg-gray-200 rounded">
                <div class="h-1.5 rounded bg-emerald-500" style="width:${sPct}%"></div>
              </div>
            </td>
            <td class="px-3 py-2"></td>
            <td class="px-3 py-2 text-right font-semibold">${fmtNum(sPlanned)}</td>
            <td class="px-3 py-2 text-right font-semibold">${fmtNum(sApprox)}</td>
            <td class="px-3 py-2 text-right font-semibold">${fmtNum(sApplied)}</td>
            <td class="px-3 py-2"></td>
            <td class="px-3 py-2"></td>
            <td class="px-3 py-2"></td>
            <td class="px-3 py-2"></td>
            <td class="px-3 py-2"></td>
            <td class="px-3 py-2"></td>
          </tr>
        `;

        if (sCollapsed) continue;

        const zendeskKeys = Array.from(zg.keys()).sort((a,b)=>String(a).localeCompare(String(b)));
        for (const zendesk of zendeskKeys) {
          const zId = 'Z:' + makeKey([supplier, zendesk]);
          const fg = zg.get(zendesk);

          const allRowsZ = [];
          for (const arr of fg.values()) allRowsZ.push(...arr);

          const zPlanned = sum(allRowsZ, x=>x.plannedUnits);
          const zApprox = sum(allRowsZ, x=>x.approxReceivedUnits);
          const zApplied = sum(allRowsZ, x=>x.appliedUnits);
          const zPOs = allRowsZ.length;
          const zRecPOs = countReceived(allRowsZ);
          const zPct = zPOs ? Math.round((zRecPOs / zPOs) * 100) : 0;

          const zFreights = Array.from(fg.keys()).filter(x => String(x || '').trim());
          const zFreightLabel = zFreights.length ? (zFreights.length === 1 ? zFreights[0] : zFreights.join(' / ')) : '—';

          const uniqVal = (arr, key) => {
            const set = new Set();
            for (const x of arr) {
              const v = (x && x[key]) ? String(x[key]).trim() : '';
              if (v) set.add(v);
            }
            if (set.size === 1) return Array.from(set)[0];
            return '';
          };
          const zShipment = uniqVal(allRowsZ, 'shipmentNo');
          const zHBL = uniqVal(allRowsZ, 'hbl');
          const zMBL = uniqVal(allRowsZ, 'mbl');
          const zEta = uniqVal(allRowsZ, 'etaFC');
          const zLatest = uniqVal(allRowsZ, 'latestArrivalDate');

          const zCollapsed = state.collapsedZendesk.has(zId);
          html += `
            <tr class="bg-gray-50/70 hover:bg-gray-50 cursor-pointer select-none" data-kind="zendesk" data-id="${esc(zId)}">
              <td class="px-3 py-2 text-[13px] font-medium">
                <span class="inline-block w-4"></span>
                <span class="inline-block w-4">${caret(zCollapsed)}</span>
                <span class="text-sm text-gray-700"><span class="font-medium">Zendesk:</span> ${esc(zendesk)}</span>
                <span class="text-[11px] text-gray-500 ml-2">(${fmtNum(zRecPOs)}/${fmtNum(zPOs)} POs received)</span>
                <div class="mt-1 w-36 h-1.5 bg-gray-200 rounded">
                  <div class="h-1.5 rounded bg-emerald-500" style="width:${zPct}%"></div>
                </div>
              </td>
              <td class="px-3 py-2 text-sm text-gray-700">${esc(zFreightLabel)}</td>
              <td class="px-3 py-2 text-right">${fmtNum(zPlanned)}</td>
              <td class="px-3 py-2 text-right">${fmtNum(zApprox)}</td>
              <td class="px-3 py-2 text-right">${fmtNum(zApplied)}</td>
              <td class="px-3 py-2">${esc(zShipment || "—")}</td>
              <td class="px-3 py-2">${esc(zHBL || "—")}</td>
              <td class="px-3 py-2">${esc(zMBL || "—")}</td>
              <td class="px-3 py-2">${esc(fmtDateOnlyLocal(tz, zEta) || "—")}</td>
              <td class="px-3 py-2">${esc(fmtDateOnlyLocal(tz, zLatest) || "—")}</td>
              <td class="px-3 py-2"></td>
            </tr>
          `;

          if (zCollapsed) continue;

          const freightKeys = Array.from(fg.keys()).sort((a,b)=>String(a).localeCompare(String(b)));
          for (const freight of freightKeys) {
            const fId = 'F:' + makeKey([supplier, zendesk, freight]);
            const arr = fg.get(freight) || [];

            const fPlanned = sum(arr, x=>x.plannedUnits);
            const fApprox = sum(arr, x=>x.approxReceivedUnits);
            const fApplied = sum(arr, x=>x.appliedUnits);
            const fPOs = arr.length;
            const fRecPOs = countReceived(arr);

            const fCollapsed = state.collapsedFreight.has(fId);
            html += `
              <tr class="bg-gray-50 hover:bg-gray-50 cursor-pointer select-none" data-kind="freight" data-id="${esc(fId)}">
                <td class="px-3 py-2">
                  <span class="inline-block w-4"></span>
                  <span class="inline-block w-4"></span>
                  <span class="inline-block w-4">${caret(fCollapsed)}</span>
                  <span class="text-xs text-gray-600"><span class="font-medium">Freight:</span> ${esc(freight)}</span>
                  <span class="text-[11px] text-gray-500 ml-2">(${fmtNum(fRecPOs)}/${fmtNum(fPOs)} POs received)</span>
                </td>
                <td class="px-3 py-2">${esc(freight)}</td>
                <td class="px-3 py-2 text-right">${fmtNum(fPlanned)}</td>
                <td class="px-3 py-2 text-right">${fmtNum(fApprox)}</td>
                <td class="px-3 py-2 text-right">${fmtNum(fApplied)}</td>
                <td class="px-3 py-2"></td>
                <td class="px-3 py-2"></td>
                <td class="px-3 py-2"></td>
                <td class="px-3 py-2"></td>
                <td class="px-3 py-2"></td>
                <td class="px-3 py-2"></td>
              </tr>
            `;

            if (fCollapsed) continue;

            for (const r of arr) {
              html += `
                <tr class="${(poRowIdx++ % 2) ? "bg-[#990033]/5" : "bg-white"} hover:bg-gray-50" data-kind="po">
                  <td class="px-3 py-2">
                    <span class="inline-block w-4"></span>
                    <span class="inline-block w-4"></span>
                    <span class="inline-block w-4"></span>
                    <span class="font-mono text-xs">${esc(r.po)}</span>
                  </td>
                  <td class="px-3 py-2">${esc(r.freight || '—')}</td>
                  <td class="px-3 py-2 text-right">${fmtNum(r.plannedUnits)}</td>
                  <td class="px-3 py-2 text-right">${fmtNum(r.approxReceivedUnits)}</td>
                  <td class="px-3 py-2 text-right">${fmtNum(r.appliedUnits)}</td>
                  <td class="px-3 py-2">${esc(r.shipmentNo || '—')}</td>
                  <td class="px-3 py-2">${esc(r.hbl || '—')}</td>
                  <td class="px-3 py-2">${esc(r.mbl || '—')}</td>
                  <td class="px-3 py-2">${esc(fmtDateOnlyLocal(tz, r.etaFC) || '—')}</td>
                  <td class="px-3 py-2">${esc(fmtDateOnlyLocal(tz, r.latestArrivalDate) || '—')}</td>
                  <td class="px-3 py-2">${esc(fmtDateOnlyLocal(tz, r.receivedAt))}</td>
                </tr>
              `;
            }
          }
        }
      }

      tb.innerHTML = html || `<tr><td class="px-3 py-6 text-center text-gray-500" colspan="11">No planned POs found for this week</td></tr>`;
    };

    // Toggle handlers (single delegated listener)
    const tb = root.querySelector('#flow-recvfs-rows');
    if (tb && !tb.__FLOW_RECVFS_BOUND__) {
      tb.__FLOW_RECVFS_BOUND__ = true;
      tb.addEventListener('click', (ev) => {
        const tr = ev.target && ev.target.closest ? ev.target.closest('tr') : null;
        if (!tr) return;
        const kind = tr.getAttribute('data-kind');
        const id = tr.getAttribute('data-id');
        if (!kind || !id) return;

        if (kind === 'supplier') {
          if (state.collapsedSupplier.has(id)) state.collapsedSupplier.delete(id);
          else state.collapsedSupplier.add(id);
          render();
        } else if (kind === 'zendesk') {
          if (state.collapsedZendesk.has(id)) state.collapsedZendesk.delete(id);
          else state.collapsedZendesk.add(id);
          render();
        } else if (kind === 'freight') {
          if (state.collapsedFreight.has(id)) state.collapsedFreight.delete(id);
          else state.collapsedFreight.add(id);
          render();
        }
      });
    }

    // Expand / Collapse all
    const btnExpand = root.querySelector('#flow-recvfs-expandall');
    if (btnExpand) btnExpand.onclick = () => {
      state.collapsedSupplier.clear();
      state.collapsedZendesk.clear();
      state.collapsedFreight.clear();
      render();
    };
    const btnCollapse = root.querySelector('#flow-recvfs-collapseall');
    if (btnCollapse) btnCollapse.onclick = () => {
      // Collapse everything at supplier level is enough.
      state.collapsedSupplier.clear();
      for (const supplier of groups.keys()) state.collapsedSupplier.add('S:' + supplier);
      state.collapsedZendesk.clear();
      state.collapsedFreight.clear();
      render();
    };

    // Download full table (flat CSV of PO-level rows)
    const dlAll = root.querySelector('#flow-recvfs-dl-all');
    if (dlAll) {
      dlAll.onclick = () => {
        const out = [
          ['week_start', ws],
          ['supplier','zendesk','freight','po','planned_units','approx_received_units','uid_applied_units','eta_fc','latest_arrival_date','received_at']
        ];
        for (const r of rows) {
          out.push([
            r.supplier, r.zendesk, r.freight, r.po,
            String(r.plannedUnits ?? 0),
            String(r.approxReceivedUnits ?? 0),
            String(r.appliedUnits ?? 0),
            String(r.etaFC ?? ''),
            String(r.latestArrivalDate ?? ''),
            String(r.receivedAt ?? '')
          ]);
        }
        const csv = out.map(line => line.map(x => {
          const s = String(x ?? '');
          if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
          return s;
        }).join(',')).join('\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = `receiving_fullscreen_${(ws || 'week').toString().replace(/[:\s]/g,'_')}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>URL.revokeObjectURL(url), 250);
      };
    }

    // Initial render
    render();
  }

  function wireReceivingFullScreen() {
    const btn = document.getElementById('flow-receiving-fullscreen');
    if (!btn || btn.__bound) return;
    btn.__bound = true;
    btn.addEventListener('click', () => openReceivingFullScreenModal());
  }

function renderTopNodes(ws, tz, receiving, vas, intl, manual) {
    // use a single 'now' reference for all upcoming/past comparisons
    const now = new Date();
    const nodes = document.getElementById('flow-nodes');
    if (!nodes) return;

    const milk = nodeCard({
      id: 'milk',
      upcoming: true,
      title: 'Milk Run',
      subtitle: 'Future expansion',
      level: 'gray',
      badges: [],
      disabled: true,
    });

    const recBadges = [
      { label: `${receiving.receivedPOs}/${receiving.plannedPOs} received`, sub: 'summary' },
      { label: `${receiving.cartonsOutTotal || 0} out`, sub: 'cartonsOut' },
      receiving.latePOs ? { label: `${receiving.latePOs} late`, level: 'yellow', sub: 'late' } : null,
      receiving.missingPOs ? { label: `${receiving.missingPOs} missing`, level: 'red', sub: 'missing' } : null,
      receiving.signoff?.receivingComplete ? { label: 'Signed off', level: receiving.planMet ? 'green' : 'yellow', sub: 'signoff' } : null,
    ].filter(Boolean);

    const rec = nodeCard({
      id: 'receiving',
      upcoming: now < receiving.due,
      title: 'Receiving',
      subtitle: `Due ${fmtInTZ(receiving.due, tz)}`,
      level: receiving.level,
      badges: recBadges,
    });

    const vasBadges = [
      { label: `${Math.round(vas.completion * 100)}% complete`, sub: 'summary' },
      { label: `${vas.appliedUnits}/${vas.plannedUnits || 0} units`, sub: 'units' },
      vas.signoff?.vasComplete ? { label: 'Signed off', level: vas.planMet ? 'green' : 'yellow', sub: 'signoff' } : null,
    ].filter(Boolean);
    const vasCard = nodeCard({
      id: 'vas',
      upcoming: now < vas.due,
      title: 'VAS Processing',
      subtitle: `Due ${fmtInTZ(vas.due, tz)}`,
      level: vas.level,
      badges: vasBadges,
    });

    const intlBadges = [];
    intlBadges.push({ label: `${(intl.lanes || []).length} lanes`, sub: 'lanes' });

    if (intl.holds) intlBadges.push({ label: `${intl.holds} hold`, level: 'red', sub: 'hold' });
    else if (intl.missingDocs) intlBadges.push({ label: `${intl.missingDocs} missing docs`, level: 'yellow', sub: 'docs' });
    else if (intl.missingOriginClear) intlBadges.push({ label: `${intl.missingOriginClear} not cleared`, level: 'yellow', sub: 'origin' });
    else intlBadges.push({ label: `${intl.seaCount || 0} sea / ${intl.airCount || 0} air`, sub: 'mode' });
    const intlCard = nodeCard({
      id: 'intl',
      upcoming: now < intl.originMax,
      title: 'Transit & Clearing',
      subtitle: `Origin window ${fmtInTZ(intl.originMin, tz)} – ${fmtInTZ(intl.originMax, tz)}`,
      level: intl.level,
      badges: intlBadges,
    });

    const lmBadges = [
      manual.manual?.last_mile_issue ? { label: 'Issue', level: 'red', sub: 'issue' } : null,
      manual.manual?.delivered_at ? { label: 'Delivered set', sub: 'delivered' } : { label: 'Delivered (set)', sub: 'delivered' },
    ].filter(Boolean);
    const lmCard = nodeCard({
      id: 'lastmile',
      upcoming: now < (manual.dates?.lastMileMax || addDays(receiving.due,24)),
      title: 'Last Mile',
      subtitle: `Window ${fmtInTZ(manual.baselines.lastMileMin, tz)} – ${fmtInTZ(manual.baselines.lastMileMax, tz)}`,
      level: manual.levels.lastMile,
      badges: lmBadges,
    });

    nodes.innerHTML = [milk, rec, vasCard, intlCard, lmCard].join('');

    {
      // --- Process rail (spine) ---
      // "Ongoing" should follow the operational stage (progress-based), not today's date.
      let ongoingIdx = 2; // default to VAS
      if ((receiving.receivedPOs || 0) < (receiving.plannedPOs || 0)) {
        ongoingIdx = 1;
      } else {
        // Intl should only become "ongoing" once its origin window has started.
        const intlInWindow = (intl.originMin instanceof Date) ? (now >= intl.originMin) : false;
        if (intlInWindow) ongoingIdx = 3;
        else ongoingIdx = 2;
      }

      const railNodes = [
        { id: 'milk', level: milk.level, upcoming: (0 > ongoingIdx) },
        { id: 'receiving', level: receiving.level, upcoming: (1 > ongoingIdx) },
        { id: 'vas', level: vas.level, upcoming: (2 > ongoingIdx) },
        { id: 'intl', level: intl.level, upcoming: (3 > ongoingIdx) },
        { id: 'lastmile', level: manual.levels.lastMile, upcoming: (4 > ongoingIdx) },
      ];
      renderProcessRail(railNodes, ongoingIdx);
    }

    // Click handlers
    $$('#flow-nodes [data-node]').forEach(card => {
      card.addEventListener('click', (e) => {
        const node = card.getAttribute('data-node');
        const btn = e.target.closest('button[data-sub]');
        const sub = btn ? (btn.getAttribute('data-sub') || null) : null;
        UI.selection = { node, sub };
        renderDetail(ws, tz, receiving, vas, intl, manual);
        renderRightTile(ws, tz, receiving, vas, intl, manual);
        highlightSelection();
      });
    });
  }

  function highlightSelection() {
    const { node } = UI.selection || {};
    // Legacy cards (if present)
    $$('#flow-nodes [data-node]').forEach(el => {
      if (el.getAttribute('data-node') === node) el.classList.add('ring-2', 'ring-[#990033]');
      else el.classList.remove('ring-2', 'ring-[#990033]');
    });
    // Journey map milestones (SVG groups)
    try {
      const root = document.getElementById('flow-journey');
      if (root) {
        root.querySelectorAll('[data-journey-node]').forEach(el => {
          // We can't "ring" SVG groups with Tailwind, so we toggle a data attr and let stroke width handle it via re-render.
          // Best-effort: add a class for potential CSS hooks.
          if (el.getAttribute('data-node') === node) el.classList.add('is-selected');
          else el.classList.remove('is-selected');
        });
      }
    } catch {}
  }

  function renderDetail(ws, tz, receiving, vas, intl, manual) {
    const detail = document.getElementById('flow-detail');
    if (!detail) return;

    const now = new Date();
    const sel = UI.selection;

    // Last Mile receipt overlay store (delivery date/POD/note) keyed by container_uid.
    const lmReceipts = loadLastMileReceipts(ws);

    // "upcoming" is optional and controls muted styling for phases that
    // haven't started yet. Must be passed explicitly.
    function header(title, level, subtitle, upcoming = false) {
      return `
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-semibold">${title}</div>
            <div class="text-sm text-gray-500 mt-0.5">${subtitle || ''}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="dot ${dot(level, !!upcoming)}"></span>
            <span class="text-xs px-2 py-0.5 rounded-full border ${pill(level, !!upcoming)} whitespace-nowrap">${statusLabel(level, !!upcoming)}</span>
          </div>
        </div>
      `;
    }

    function bullets(lines) {
      const xs = (lines || []).filter(Boolean).slice(0, 3);
      if (!xs.length) return '';
      return `<ul class="mt-3 space-y-1 text-sm">${xs.map(x => `<li class="flex gap-2"><span class="text-gray-400">•</span><span>${x}</span></li>`).join('')}</ul>`;
    }

    function table(headers, rows) {
      return `
        <div class="mt-3 overflow-auto max-h-[360px]">
          <table class="w-full text-sm">
            <thead><tr>${headers.map(h => `<th class="th text-left py-2 pr-2">${h}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(r => `<tr class="border-t">${r.map(c => `<td class="py-2 pr-2 align-top">${c}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
      `;
    }

    // ---------------- Node-specific details ----------------
    if (sel.node === 'receiving') {
  const overallPct = (num(receiving.plannedPOs) || 0) ? (num(receiving.receivedPOs || 0) / num(receiving.plannedPOs || 1)) * 100 : 0;
  const titleBase = sel.sub === 'late' ? 'Receiving • Late POs' : sel.sub === 'missing' ? 'Receiving • Missing POs' : 'Receiving';
  const title = `${titleBase} <span class="inline-flex align-middle ml-2">${progressBar(overallPct, { w: 'w-36', h: 'h-2' })}</span>`;
  const subtitle = `Due ${fmtInTZ(receiving.due, tz)} • Last received ${receiving.lastReceived ? fmtInTZ(receiving.lastReceived, tz) : '—'}`;

  const insights = [
    `${receiving.receivedPOs}/${receiving.plannedPOs} planned POs received`,
    receiving.latePOs ? `${receiving.latePOs} POs received after baseline` : null,
    receiving.missingPOs ? `${receiving.missingPOs} POs not yet received` : null,
  ];

  const kpis = `
    <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
      <div class="rounded-lg border p-2">
        <div class="text-[11px] text-gray-500">Cartons In</div>
        <div class="text-lg font-semibold whitespace-nowrap truncate max-w-[220px]">${receiving.cartonsInTotal || 0}</div>
      </div>
      <div class="rounded-lg border p-2">
        <div class="text-[11px] text-gray-500">Cartons Out</div>
        <div class="text-sm font-semibold">${receiving.cartonsOutTotal || 0}</div>
      </div><div class="rounded-lg border p-2">
        <div class="text-[11px] text-gray-500">Late POs</div>
        <div class="text-sm font-semibold">${receiving.latePOs || 0}</div>
      </div>
    </div>
  `;

  const supRows = (receiving.suppliers || [])
    .sort((a, b) => (b.cartonsOut || 0) - (a.cartonsOut || 0))
    .slice(0, 30)
    .map(s => {
      const denom = num(s.poCount || 0) || 0;
      const pct = denom ? (num(s.receivedPOs || 0) / denom) * 100 : 0;
      return [
        s.supplier,
        progressBar(pct, { w: 'w-28', h: 'h-2' }),
        `${s.receivedPOs}/${s.poCount}`,
        `${Math.round(s.units)}`,
        `${s.cartonsIn || 0}`,
        `${s.cartonsOut || 0}`,
      ];
    });

  detail.innerHTML = [
    header(title, receiving.level, subtitle),
    `<div class="mt-2 flex justify-end"><button type="button" id="flow-receiving-fullscreen" class="text-xs px-2 py-1 border rounded-lg bg-white hover:bg-gray-50">Full screen</button></div>`,
    bullets(insights),
    kpis,
    table(['Supplier', 'Progress', 'POs received', 'Planned units', 'Cartons In', 'Cartons Out'], supRows),
  ].join('');
    try { wireReceivingFullScreen(); } catch {}
  return;
}

if (sel.node === 'vas') {
      const subtitle = `Planned ${fmtInTZ(vas.due, tz)} • Actual ${vas.lastAppliedAt ? fmtInTZ(vas.lastAppliedAt, tz) : '—'} • Planned ${vas.plannedUnits} units • Applied ${vas.appliedUnits} units`;
      const insights = [
        `Completion: <b>${Math.round(vas.completion * 100)}%</b>`,
        vas.plannedPOs ? `${vas.plannedPOs} planned POs this week` : null,
        vas.level === 'red' ? 'Behind baseline — prioritize top suppliers/POs below.' : null,
      ];

      const fmtN = (v) => (Math.round(num(v) || 0)).toLocaleString();

const vasMixHtml = (vasObj) => {
  const mix = vasObj.poMix || { notStarted: 0, inProgress: 0, complete: 0, over: 0 };
  const total = mix.notStarted + mix.inProgress + mix.complete + mix.over || 1;
  const seg = (n, cls) => `<div class="h-3 ${cls}" style="width:${(n/total)*100}%;"></div>`;
  const bar = `
    <div class="mt-2 w-full rounded-full overflow-hidden border bg-gray-50 flex">
      ${seg(mix.notStarted, 'bg-gray-200')}
      ${seg(mix.inProgress, 'bg-amber-200')}
      ${seg(mix.complete, 'bg-emerald-200')}
      ${seg(mix.over, 'bg-indigo-200')}
    </div>`;
  const legend = `
    <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
      <div><span class="inline-block w-2 h-2 rounded-sm bg-gray-200 mr-1"></span>Not started: <b>${mix.notStarted}</b></div>
      <div><span class="inline-block w-2 h-2 rounded-sm bg-amber-200 mr-1"></span>In progress: <b>${mix.inProgress}</b></div>
      <div><span class="inline-block w-2 h-2 rounded-sm bg-emerald-200 mr-1"></span>Complete: <b>${mix.complete}</b></div>
      <div><span class="inline-block w-2 h-2 rounded-sm bg-indigo-200 mr-1"></span>Over: <b>${mix.over}</b></div>
    </div>`;
  const top = (vasObj.topRemainingPOs || []).slice(0,6).map(x => [x.po, fmtN(x.remaining), `${x.pct}%`]);
  const tbl = top.length
    ? `<div class="mt-3">
         <div class="text-xs text-gray-500 mb-1">Top remaining POs</div>
         ${table(['PO', 'Remaining', '%'], top)}
       </div>`
    : `<div class="mt-3 text-xs text-gray-500">No remaining POs — on track.</div>`;
  return bar + legend + tbl;
};
const supRows = (vas.supplierRows || []).slice(0, 12).map(x => {
  const planned = num(x.planned || 0) || 0;
  const applied = num(x.applied || 0) || 0;
  const pct = planned ? (applied / planned) * 100 : 0;
  return [x.supplier, progressBar(pct, { w: 'w-28', h: 'h-2' }), fmtN(planned), fmtN(applied), `${Math.round(pct)}%`];
});


      detail.innerHTML = [
        header(`VAS Processing <span class="inline-flex align-middle ml-2">${progressBar((num(vas.completion)||0)*100, { w: 'w-36', h: 'h-2' })}</span>`, vas.level, subtitle),
        bullets(insights),
        `<div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div class="rounded-xl border p-3">
            <div class="text-sm font-semibold text-gray-700">Suppliers (planned vs applied)</div>
            ${table(['Supplier', 'Progress', 'Planned', 'Applied', '%'], supRows)}
          </div>
          
<div class="rounded-xl border p-3">
  <div class="text-sm font-semibold text-gray-700">PO progress mix</div>
  ${vasMixHtml(vas)}
</div>
        </div>`,
      ].join('');
      return;
    }

    
    if (sel.node === 'intl') {
      const lanes = (intl.lanes || []).slice();
      const subtitle = `Planned ${fmtInTZ(intl.originMin, tz)} – ${fmtInTZ(intl.originMax, tz)} • Actual ${intl.lastMilestoneAt ? fmtInTZ(intl.lastMilestoneAt, tz) : '—'}`;
      const wcState = loadIntlWeekContainers(ws);
      const weekContainers = (wcState && Array.isArray(wcState.containers)) ? wcState.containers : [];

      const totalPlanned = lanes.reduce((a, r) => a + (r.plannedUnits || 0), 0);
      const totalApplied = lanes.reduce((a, r) => a + (r.appliedUnits || 0), 0);
      const totalOut = lanes.reduce((a, r) => a + (r.cartonsOut || 0), 0);

      const insights = [
        `${lanes.length} active lanes (Supplier × Zendesk × Freight)`,
        intl.holds ? `<b>${intl.holds}</b> lane(s) flagged for customs hold` : 'No customs holds flagged',
        (intl.missingDocs || intl.missingOriginClear) ? `<b>${(intl.missingDocs || 0)}</b> missing docs • <b>${(intl.missingOriginClear || 0)}</b> not cleared (origin)` : null,
        `Planned <b>${Math.round(totalPlanned).toLocaleString()}</b> units • Applied <b>${Math.round(totalApplied).toLocaleString()}</b> units`,
      ];

      const kpis = `
        <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Lanes</div>
            <div class="text-sm font-semibold">${lanes.length}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Sea / Air</div>
            <div class="text-sm font-semibold">${intl.seaCount || 0} / ${intl.airCount || 0}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Cartons Out</div>
            <div class="text-sm font-semibold">${Math.round(totalOut).toLocaleString()}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Customs holds</div>
            <div class="text-sm font-semibold">${intl.holds || 0}</div>
          </div>
        </div>
      `;

      // Sort lanes: holds/red first, then highest remaining units
      const rank = { red: 3, yellow: 2, green: 1, gray: 0 };
      lanes.sort((a, b) => (rank[b.level] - rank[a.level]) || ((b.plannedUnits - b.appliedUnits) - (a.plannedUnits - a.appliedUnits)));

      const rows = lanes.map(l => {
        const st = `<span class="text-xs px-2 py-0.5 rounded-full border ${pill(l.level)} whitespace-nowrap">${statusLabel(l.level)}</span>`;
        const ticket = l.ticket && l.ticket !== 'NO_TICKET' ? escapeHtml(l.ticket) : '<span class="text-gray-400">—</span>';
        const containers = weekContainers
          .filter(c => Array.isArray(c?.lane_keys) && c.lane_keys.includes(l.key))
          .filter(c => {
            const cid = String(c?.container_id || c?.container || '').trim();
            const ves = String(c?.vessel || '').trim();
            const pos = String(c?.pos || '').trim();
            return !!(cid || ves || pos);
          }).length;
        return [
          `<button class="text-left hover:underline" data-lane-select="${escapeAttr(l.key)}">${escapeHtml(l.supplier)}</button>`,
          ticket,
          escapeHtml(l.freight || ''),
          `${(l.appliedUnits || 0).toLocaleString()}`,
          `${(l.cartonsOut || 0).toLocaleString()}`,
          `${containers}`,
          st,
        ];
      });

      const selectedKey = sel.sub && String(sel.sub).includes('||') ? sel.sub : (lanes[0]?.key || null);
      const selected = selectedKey ? lanes.find(x => x.key === selectedKey) : null;

      const editor = selected ? intlLaneEditor(ws, tz, intl, selected) : `
        <div class="mt-3 rounded-xl border p-3 text-sm text-gray-500">No lanes found in the uploaded Plan for this week.</div>
      `;

            // Expose latest Intl context for UI handlers (modal, etc.)
      try { window.__FLOW_INTL_CTX__ = { ws, tz, lanes, weekContainers, intl }; } catch {}

detail.innerHTML = [
        header('Transit & Clearing', intl.level, subtitle),
        bullets(insights),
        kpis,
        `<div class="mt-3 rounded-xl border p-3">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-semibold text-gray-700">Lanes</div>
            <button type="button" id="flow-lanes-fullscreen" class="text-xs px-2 py-1 border rounded-lg bg-white hover:bg-gray-50">Full screen</button>
          </div>
          ${table(['Supplier', 'Zendesk', 'Freight', 'Applied', 'Cartons Out', 'Containers', 'Status'], rows)}
        </div>`,
        editor,
      ].join('');

      wireIntlDetail(ws, selectedKey);
      return;
    }

    if (sel.node === 'lastmile') {
      const { baselines } = manual;
      const subtitle = `Delivery window ${fmtInTZ(baselines.lastMileMin, tz)} – ${fmtInTZ(baselines.lastMileMax, tz)}`;

      // Build container rows from week-level Intl containers.
      const lanes = (intl && Array.isArray(intl.lanes)) ? intl.lanes : [];
      const laneByKey = {};
      for (const l of lanes) laneByKey[l.key] = l;

      const wcState = loadIntlWeekContainers(ws);
      const weekContainers = (wcState && Array.isArray(wcState.containers)) ? wcState.containers : [];

      const contRows = [];
      for (let i = 0; i < weekContainers.length; i++) {
        const c = weekContainers[i] || {};
        const uid = String(c.container_uid || c.uid || '').trim() || `idx${i}`;
        const cid = String(c.container_id || c.container || '').trim();
        const vessel = String(c.vessel || '').trim();
        const pos = String(c.pos || '').trim();
        const lane_keys = Array.isArray(c.lane_keys) ? c.lane_keys : [];

        if (!cid && !vessel && !pos && !lane_keys.length) continue;

        const laneInfos = lane_keys.map(k => laneByKey[k]).filter(Boolean);
        const suppliers = uniqNonEmpty(laneInfos.map(x => x.supplier));
        const freights = uniqNonEmpty(laneInfos.map(x => x.freight));
        const tickets = uniqNonEmpty(laneInfos.map(x => (x.ticket && x.ticket !== 'NO_TICKET') ? x.ticket : ''));

        const supplierDisplay = suppliers.length ? (suppliers[0] + (suppliers.length > 1 ? ` (+${suppliers.length - 1})` : '')) : '—';
        const freightDisplay = freights.length ? freights.join(', ') : (laneInfos[0]?.freight || '');
        const ticketDisplay = tickets.join(', ');

        const rcp = (uid && lmReceipts && lmReceipts[uid]) ? lmReceipts[uid] : null;
        contRows.push({
          key: `wc::${uid}`,
          uid,
          src_idx: i,
          supplier: supplierDisplay,
          ticket: ticketDisplay,
          freight: freightDisplay,
          container_id: cid,
          container_id_display: cid || '—',
          size_ft: String(c.size_ft || '').trim(),
          vessel,
          delivery_local: String((rcp && rcp.delivery_local) || '').trim(),
          scheduled_local: String((rcp && rcp.scheduled_local) || '').trim(),
          status: String((rcp && rcp.status) || '').trim(),
          pod_received: !!((rcp && rcp.pod_received) || false),
          note: String((rcp && rcp.last_mile_note) || ''),
          laneCount: lane_keys.length,
        });
      }

// Status
      const level = contRows.some(r => !r.delivery_local) ? 'yellow' : 'green';

      const insights = [
        'Track delivery per container / AWB (derived from Intl lanes).',
        contRows.length ? `${contRows.filter(r => r.delivery_local).length}/${contRows.length} containers have a delivery date.` : 'Add containers under Transit & Clearing to start tracking Last Mile.',
      ];

      const kpis = `
        <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Containers</div>
            <div class="text-sm font-semibold">${contRows.length}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Delivered dates set</div>
            <div class="text-sm font-semibold">${contRows.filter(r => r.delivery_local).length}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">POD received</div>
            <div class="text-sm font-semibold">${contRows.filter(r => r.pod_received).length}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Open</div>
            <div class="text-sm font-semibold">${contRows.filter(r => !r.scheduled_local && !r.delivery_local).length}</div>
          </div>
        </div>
      `;

      const rows = contRows.map(r => {
        const st = r.delivery_local
          ? `<span class="text-xs px-2 py-0.5 rounded-full border ${pill('green')} whitespace-nowrap">Delivered</span>`
          : (r.scheduled_local
            ? `<span class="text-xs px-2 py-0.5 rounded-full border ${pill('gray')} whitespace-nowrap">Scheduled</span>`
            : `<span class="text-xs px-2 py-0.5 rounded-full border ${pill('yellow')} whitespace-nowrap">Open</span>`);
        return [
          `<button class="text-left hover:underline" data-cont="${escapeAttr(r.key)}">${escapeHtml(r.supplier)}</button>`,
          r.ticket ? escapeHtml(r.ticket) : '<span class="text-gray-400">—</span>',
          escapeHtml(r.freight || ''),
          escapeHtml(r.container_id_display || ''),
          escapeHtml(r.size_ft ? (r.size_ft + 'ft') : '—'),
          escapeHtml(r.vessel || '—'),
          r.delivery_local ? escapeHtml(String(r.delivery_local).replace('T',' ')) : '<span class="text-gray-400">—</span>',
          st,
          r.delivery_local
            ? '<span class="text-gray-400">—</span>'
            : (r.scheduled_local
              ? `<button data-lm-deliver="1" data-ws="${escapeAttr(ws)}" data-cont="${escapeAttr(r.key)}" data-uid="${escapeAttr(r.uid)}" class="px-2 py-1 rounded-lg text-xs border bg-emerald-50 hover:bg-emerald-100">Receive</button>`
              : `<button data-lm-schedule="1" data-ws="${escapeAttr(ws)}" data-cont="${escapeAttr(r.key)}" data-uid="${escapeAttr(r.uid)}" class="px-2 py-1 rounded-lg text-xs border bg-sky-50 hover:bg-sky-100">Schedule</button>`),
        ];
      });

      const selectedKey = sel.sub ? String(sel.sub) : (contRows[0]?.key || null);
      const selected = selectedKey ? contRows.find(x => x.key === selectedKey) : null;

      const editor = selected ? lastMileEditor(ws, tz, selected) : `
        <div class="mt-3 rounded-xl border p-3 text-sm text-gray-500">No containers found. Add containers under Transit & Clearing.</div>
      `;

      detail.innerHTML = [
        header('Last Mile', level, subtitle),
        bullets(insights),
        kpis,
        `<div class="mt-3 rounded-xl border p-3">
          <div class="text-sm font-semibold text-gray-700">Containers</div>
          ${table(['Supplier', 'Zendesk', 'Freight', 'Container / AWB', 'Size', 'Vessel', 'Delivered at', 'Status', 'Action'], rows)}
        </div>`,
        editor,
      ].join('');

      wireLastMileDetail(ws, selectedKey);
      return;
    }

    // default
    detail.innerHTML = header('Flow', 'gray', 'Click a node above to see details.');
  

    // Best-effort bind for Receiving full-screen button (only exists in Receiving view).
    try { wireReceivingFullScreen(); } catch {}
}

  
  function escapeAttr(s) {
    return escapeHtml(String(s || '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  
  function intlLaneEditor(ws, tz, intl, lane) {
    const manual = lane.manual || {};
    const ticket = lane.ticket && lane.ticket !== 'NO_TICKET' ? lane.ticket : '';

    const v = (iso) => toLocalDT(iso);

    const pack = v(manual.packing_list_ready_at);
    const originClr = v(manual.origin_customs_cleared_at);
    const departed = v(manual.departed_at);
    const arrived = v(manual.arrived_at);
    const destClr = v(manual.dest_customs_cleared_at);

    const etaFC = v(manual.eta_fc || manual.etaFC || manual.eta_fc_at || manual.eta_fc_fc);
    const latestArrivalDate = v(manual.latest_arrival_date || manual.latestArrivalDate || manual.latestArrival || manual.latest_arrival);

    // Baseline (reference-only): show expected milestone dates without persisting.
    const vasDueB = makeBizLocalDate(
      isoDate(addDays(new Date(`${ws}T00:00:00Z`), BASELINE.vas_complete_due.dayOffset)),
      BASELINE.vas_complete_due.time,
      tz
    );
    const originMaxB = addDays(vasDueB, BASELINE.origin_ready_days_max);
    const packBaseDT = originMaxB;
    const originClrBaseDT = originMaxB;
    const departedBaseDT = addDays(originMaxB, 1);
    const transitDaysB = (lane.freight === 'Air') ? BASELINE.transit_days_air : BASELINE.transit_days_sea;
    const arrivedBaseDT = addDays(departedBaseDT, transitDaysB);
    const destClrBaseDT = addDays(arrivedBaseDT, 2);

    const baseVal = (d) => {
      if (!d || isNaN(d)) return '';
      try { return toLocalDT(d.toISOString()); } catch { return ''; }
    };
    const basePack = baseVal(packBaseDT);
    const baseOriginClr = baseVal(originClrBaseDT);
    const baseDeparted = baseVal(departedBaseDT);
    const baseArrived = baseVal(arrivedBaseDT);
    const baseDestClr = baseVal(destClrBaseDT);

    const hold = !!manual.customs_hold;
    const note = String(manual.note || '');

    // Week-level containers (independent of selected lane)
    const weekState = loadIntlWeekContainers(ws);
    const weekContainers = (weekState && Array.isArray(weekState.containers)) ? weekState.containers : [];
    const lanes = Array.isArray(intl?.lanes) ? intl.lanes : [];
    const laneOptions = lanes.map(l => ({
      key: l.key,
      label: `${l.supplier} • ${(l.ticket && l.ticket !== 'NO_TICKET') ? l.ticket : '—'} • ${l.freight}`
    }));

    const contRows = (weekContainers.length ? weekContainers : [{
      container_uid: _uid('c'),
      container_id: '',
      size_ft: '40',
      vessel: '',
      pos: '',
      lane_keys: [lane.key],
    }]).map((c) => {
      const uid = String(c.container_uid || c.uid || '').trim() || _uid('c');
      const cid = String(c.container_id || '').trim();
      const size_ft = String(c.size_ft || '').trim() || '40';
      const vessel = String(c.vessel || '').trim();
      const pos = String(c.pos || '').trim();
      const lane_keys = Array.isArray(c.lane_keys) ? c.lane_keys : [];

      return `
        <div class="flow-wc-row grid grid-cols-12 gap-2 items-end border rounded-lg p-2" data-uid="${escapeAttr(uid)}">
          <label class="col-span-12 sm:col-span-5 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Lanes on this container</div>
            <select class="flow-wc-lanes w-full px-2 py-1.5 border rounded-lg bg-white" multiple>
              ${laneOptions.map(o => {
                const sel = lane_keys.includes(o.key) ? 'selected' : '';
                return `<option value="${escapeAttr(o.key)}" ${sel}>${escapeHtml(o.label)}</option>`;
              }).join('')}
            </select>
            <div class="text-[11px] text-gray-500 mt-1">Tip: hold Ctrl/⌘ to select multiple</div>
          </label>

          <label class="col-span-12 sm:col-span-4 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Container / AWB (free text)</div>
            <input class="flow-wc-id w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(cid)}" placeholder="e.g. TGHU1234567 / 176-12345678"/>
          </label>

          <label class="col-span-6 sm:col-span-1 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Size</div>
            <select class="flow-wc-size w-full px-2 py-1.5 border rounded-lg bg-white">
              <option value="20" ${size_ft === '20' ? 'selected' : ''}>20</option>
              <option value="40" ${size_ft === '40' ? 'selected' : ''}>40</option>
            </select>
          </label>

          <label class="col-span-6 sm:col-span-2 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Vessel</div>
            <input class="flow-wc-vessel w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(vessel)}" placeholder="e.g. MAERSK XYZ"/>
          </label>

          <label class="col-span-12 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">POs (optional, comma-separated)</div>
            <input class="flow-wc-pos w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(pos)}" placeholder="WADA002089, WAAE002227"/>
          </label>

          <div class="col-span-12 flex justify-end">
            <button class="flow-wc-remove text-xs px-2 py-1 border rounded-lg bg-white hover:bg-gray-50">Remove</button>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="mt-3 rounded-xl border p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-gray-700">Lane details</div>
            <div class="text-xs text-gray-500 mt-0.5">
              <b>${escapeHtml(lane.supplier)}</b> • ${ticket ? `Zendesk <b>${escapeHtml(ticket)}</b> • ` : ''}${escapeHtml(lane.freight)}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" id="flow-lane-collapse" class="text-xs px-2 py-1 border rounded-lg bg-white hover:bg-gray-50">Collapse</button>
            <span class="dot ${dot(lane.level)}"></span>
            <span class="text-xs px-2 py-0.5 rounded-full border ${pill(lane.level)} whitespace-nowrap">${statusLabel(lane.level)}</span>
          </div>
        </div>


        <div id="flow-lane-editor-body" class="mt-3">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div class="rounded-xl border p-3">
            <div class="flex items-center justify-between">
              <div class="text-sm font-semibold text-gray-700">Docs & customs milestones</div>
              <button type="button" id="flow-intl-copy-all" class="text-[11px] text-gray-600 underline hover:text-gray-800">Copy baselines</button>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Packing list ready</div>
                <input id="flow-intl-pack" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${pack}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${basePack}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-pack" data-val="${basePack}">Copy</button>
                </div>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Shipment #</div>
                <input id="flow-intl-shipment" type="text" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(String(manual.shipmentNumber || manual.shipment || ''))}" placeholder="Free text"/>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Origin customs cleared</div>
                <input id="flow-intl-originclr" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${originClr}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${baseOriginClr}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-originclr" data-val="${baseOriginClr}">Copy</button>
                </div>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">HBL</div>
                <input id="flow-intl-hbl" type="text" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(String(manual.hbl || ''))}" placeholder="Free text"/>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Departed origin</div>
                <input id="flow-intl-departed" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${departed}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${baseDeparted}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-departed" data-val="${baseDeparted}">Copy</button>
                </div>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">MBL</div>
                <input id="flow-intl-mbl" type="text" class="w-full px-2 py-1.5 border rounded-lg" value="${escapeAttr(String(manual.mbl || ''))}" placeholder="Free text"/>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Arrived destination</div>
                <input id="flow-intl-arrived" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${arrived}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${baseArrived}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-arrived" data-val="${baseArrived}">Copy</button>
                </div>
              </label>

              <div class="hidden md:block"></div>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Destination customs cleared</div>
                <input id="flow-intl-destclr" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${destClr}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${baseDestClr}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-destclr" data-val="${baseDestClr}">Copy</button>
                </div>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">ETA FC</div>
                <input id="flow-intl-etafc" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${etaFC}"/>
              </label>

              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Latest arrival date</div>
                <input id="flow-intl-latestarrival" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${latestArrivalDate}"/>
              </label>

              <div class="flex items-center gap-3 md:pt-6">
                <label class="text-sm flex items-center gap-2">
                  <input id="flow-intl-hold" type="checkbox" class="h-4 w-4" ${hold ? 'checked' : ''}/>
                  <span>Customs hold</span>
                </label>
              </div>
            </div>

<label class="text-sm mt-3 block">
              <div class="text-xs text-gray-500 mb-1">Note (optional)</div>
              <textarea id="flow-intl-note" rows="2" class="w-full px-2 py-1.5 border rounded-lg" placeholder="Quick update for the team...">${escapeHtml(note)}</textarea>
            </label>

            <div class="flex items-center justify-between mt-3">
              <div id="flow-intl-save-msg" class="text-xs text-gray-500"></div>
              <button id="flow-intl-save" data-lane="${escapeAttr(lane.key)}" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Save lane</button>
            </div>
          </div>

          <div class="rounded-xl border p-3">
            <div class="flex items-center justify-between">
              <div class="text-sm font-semibold text-gray-700 flex items-center gap-2">
                ${iconContainer()} <span>Containers (week-level)</span>
              </div>
              <div class="flex items-center gap-2">
                <button id="flow-wc-add" class="text-xs px-2 py-1 border rounded-lg bg-white hover:bg-gray-50">Add</button>
                <button id="flow-wc-save" class="text-xs px-2 py-1 border rounded-lg bg-white hover:bg-gray-50">Save containers</button>
              </div>
            </div>
            <div id="flow-wc-list" class="mt-3 flex flex-col gap-2">
              ${contRows}
            </div>
            <div id="flow-wc-save-msg" class="text-xs text-gray-500 mt-2"></div>
            <div class="text-[11px] text-gray-500 mt-2">
              One container can map to multiple lanes. These containers feed Last Mile immediately.
            </div>
          </div>
          </div>
        </div>
      </div>
    `;
  }

  function wireIntlDetail(ws, selectedKey) {
    // lane row clicks
    const detail = document.getElementById('flow-detail');
    if (!detail) return;

    // IMPORTANT:
    // - Lane *selection* buttons in the lanes table use `data-lane-select`.
    // - The lane Save button uses `data-lane` for persistence.
    // If we bind selection to `[data-lane]`, clicking Save triggers a re-render before the
    // save logic runs, and nothing persists.
    detail.querySelectorAll('[data-lane-select]').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        const k = btn.getAttribute('data-lane-select');
        UI.selection = { node: 'intl', sub: k };
        refresh();
      });
    });




    // Lane details collapse/expand (UI-only)
    const collapseBtn = detail.querySelector('#flow-lane-collapse');
    const bodyWrap = detail.querySelector('#flow-lane-editor-body');
    if (collapseBtn && bodyWrap && !collapseBtn.dataset.bound) {
      collapseBtn.dataset.bound = '1';
      collapseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const collapsed = bodyWrap.classList.toggle('hidden');
        collapseBtn.textContent = collapsed ? 'Expand' : 'Collapse';
      });
    }

    // Full screen overview for all lanes (table)
    const lanesFullBtn = detail.querySelector('#flow-lanes-fullscreen');
    if (lanesFullBtn && !lanesFullBtn.dataset.bound) {
      lanesFullBtn.dataset.bound = '1';
      lanesFullBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openIntlOverviewModal(ws, getBizTZ());
      });
    }


    // Background persistence for lane identifiers (Shipment/HBL/MBL)
    const idMap = [
      ['#flow-intl-shipment', 'shipmentNumber'],
      ['#flow-intl-hbl', 'hbl'],
      ['#flow-intl-mbl', 'mbl'],
    ];
    for (const [sel, field] of idMap) {
      const el = detail.querySelector(sel);
      if (!el || el.dataset.bound) continue;
      el.dataset.bound = '1';
      const saveOne = () => {
        const key = selectedKey || (UI.selection && UI.selection.sub) || null;
        if (!key) return;
        const v = String(el.value || '').trim();
        const patch = {}; patch[field] = v;
        saveIntlLaneManual(ws, key, patch);
      };
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          saveOne();
          el.blur();
        }
      });
      el.addEventListener('blur', () => saveOne());
    }

    // Baseline helpers (UI-only; no persistence)
    const copyAll = detail.querySelector('#flow-intl-copy-all');
    if (copyAll && !copyAll.dataset.bound) {
      copyAll.dataset.bound = '1';
      copyAll.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        detail.querySelectorAll('.flow-intl-copy').forEach(btn => {
          const tid = btn.getAttribute('data-target');
          const val = btn.getAttribute('data-val') || '';
          const inp = tid ? detail.querySelector('#' + CSS.escape(tid)) : null;
          if (inp && val) {
            inp.value = val;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      });
    }

    detail.querySelectorAll('.flow-intl-copy').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tid = btn.getAttribute('data-target');
        const val = btn.getAttribute('data-val') || '';
        const inp = tid ? detail.querySelector('#' + CSS.escape(tid)) : null;
        if (inp && val) {
          inp.value = val;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });

    // Week-level Containers UI (add/remove/save)
    const wcAdd = detail.querySelector('#flow-wc-add');
    if (wcAdd && !wcAdd.dataset.bound) {
      wcAdd.dataset.bound = '1';
      wcAdd.addEventListener('click', () => {
        const list = detail.querySelector('#flow-wc-list');
        if (!list) return;

        // Clone lane options from the first existing multi-select (rendered from data) to keep UX stable.
        const protoSelect = detail.querySelector('.flow-wc-lanes');
        const optionsHtml = protoSelect ? protoSelect.innerHTML : '';

        const uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : _uid('c');

        const wrap = document.createElement('div');
        wrap.className = 'flow-wc-row grid grid-cols-12 gap-2 items-end border rounded-lg p-2';
        wrap.dataset.uid = uid;

        wrap.innerHTML = `
          <label class="col-span-12 sm:col-span-5 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Lanes on this container</div>
            <select class="flow-wc-lanes w-full px-2 py-1.5 border rounded-lg bg-white" multiple></select>
            <div class="text-[11px] text-gray-500 mt-1">Tip: hold Ctrl/⌘ to select multiple</div>
          </label>
          <label class="col-span-12 sm:col-span-4 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Container / AWB (free text)</div>
            <input class="flow-wc-id w-full px-2 py-1.5 border rounded-lg" value="" placeholder="e.g. TGHU1234567 / 176-12345678"/>
          </label>
          <label class="col-span-6 sm:col-span-1 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Size</div>
            <select class="flow-wc-size w-full px-2 py-1.5 border rounded-lg bg-white">
              <option value="20">20</option>
              <option value="40" selected>40</option>
            </select>
          </label>
          <label class="col-span-6 sm:col-span-2 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">Vessel</div>
            <input class="flow-wc-vessel w-full px-2 py-1.5 border rounded-lg" value="" placeholder="e.g. MAERSK XYZ"/>
          </label>
          <label class="col-span-12 text-xs">
            <div class="text-[11px] text-gray-500 mb-1">POs (optional, comma-separated)</div>
            <input class="flow-wc-pos w-full px-2 py-1.5 border rounded-lg" value="" placeholder="WADA002089, WAAE002227"/>
          </label>
          <div class="col-span-12 flex justify-end">
            <button class="flow-wc-remove text-xs px-2 py-1 border rounded-lg bg-white hover:bg-gray-50">Remove</button>
          </div>
        `;
        list.appendChild(wrap);
        const sel = wrap.querySelector('.flow-wc-lanes');
        if (sel && optionsHtml) sel.innerHTML = optionsHtml;
      });
    }

    detail.querySelectorAll('.flow-wc-remove').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const row = btn.closest('.flow-wc-row');
	      if (row) {
	        // Track explicit removals so Save containers can delete them from the week store.
	        try {
	          const uid = String(row.dataset.uid || '').trim();
	          if (uid) {
	            window.__flowWcRemovedUids = window.__flowWcRemovedUids || new Set();
	            window.__flowWcRemovedUids.add(uid);
	          }
	        } catch { /* ignore */ }
	        row.remove();
	      }
      });
    });

    const wcSave = detail.querySelector('#flow-wc-save');
    if (wcSave && !wcSave.dataset.bound) {
      wcSave.dataset.bound = '1';
      wcSave.addEventListener('click', () => {
	        const state = loadIntlWeekContainers(ws);
	        const updates = Array.from(detail.querySelectorAll('.flow-wc-row')).map(row => {
          const uid = String(row.dataset.uid || '').trim() || _uid('c');
          const container_id = String(row.querySelector('.flow-wc-id')?.value || '').trim();
          const size_ft = String(row.querySelector('.flow-wc-size')?.value || '').trim();
          const vessel = String(row.querySelector('.flow-wc-vessel')?.value || '').trim();
          const pos = String(row.querySelector('.flow-wc-pos')?.value || '').trim();
          const sel = row.querySelector('.flow-wc-lanes');
          const lane_keys = sel && sel.options
            ? uniqNonEmpty(Array.from(sel.options).filter(o => o.selected).map(o => o.value))
            : [];
          return {
	            ...(state.containers || []).find(c => String(c.container_uid || c.uid || '').trim() === uid) || {},
            container_uid: uid,
            container_id,
            size_ft,
            vessel,
            pos,
            lane_keys,
          };
	        }).filter(c => c.container_id || c.vessel || (c.lane_keys && c.lane_keys.length) || c.pos);

	        // Merge updates into prior week containers to avoid accidental overwrites.
	        const prior = (state && Array.isArray(state.containers)) ? state.containers.slice() : [];
	        const priorByUid = new Map(prior.map(c => [String(c.container_uid || c.uid || '').trim(), c]));
	        const removed = (window.__flowWcRemovedUids instanceof Set) ? window.__flowWcRemovedUids : new Set();
	        const next = [];
	        // Keep existing containers unless explicitly removed.
	        for (const c of prior) {
	          const uid = String(c.container_uid || c.uid || '').trim();
	          if (uid && removed.has(uid)) continue;
	          next.push(c);
	        }
	        // Apply updates (replace existing by uid, else append)
	        for (const u of updates) {
	          const uid = String(u.container_uid || u.uid || '').trim();
	          if (!uid) continue;
	          const idx = next.findIndex(c => String(c.container_uid || c.uid || '').trim() === uid);
	          if (idx >= 0) next[idx] = { ...(next[idx] || {}), ...u, container_uid: uid };
	          else next.push(u);
	        }

	        saveIntlWeekContainers(ws, next);
	        try { if (window.__flowWcRemovedUids instanceof Set) window.__flowWcRemovedUids.clear(); } catch { /* ignore */ }
        const msg = detail.querySelector('#flow-wc-save-msg');
        if (msg) msg.textContent = 'Saved';
        setTimeout(() => refresh(), 10);
      });
    }


    const saveBtn = detail.querySelector('#flow-intl-save');
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', () => {
        const wsNow = String(saveBtn.getAttribute('data-ws') || ws || '').trim() || ws;
        const key = saveBtn.getAttribute('data-lane') || selectedKey;
        if (!key) return;
        const pack = detail.querySelector('#flow-intl-pack')?.value || '';
        const originClr = detail.querySelector('#flow-intl-originclr')?.value || '';
        const departed = detail.querySelector('#flow-intl-departed')?.value || '';
        const arrived = detail.querySelector('#flow-intl-arrived')?.value || '';
        const destClr = detail.querySelector('#flow-intl-destclr')?.value || '';
        const etaFC = detail.querySelector('#flow-intl-etafc')?.value || '';
        const latestArrivalDate = detail.querySelector('#flow-intl-latestarrival')?.value || '';

        const hold = !!detail.querySelector('#flow-intl-hold')?.checked;
        const note = detail.querySelector('#flow-intl-note')?.value || '';
        const obj = {
          packing_list_ready_at: safeISO(pack),
          origin_customs_cleared_at: safeISO(originClr),
          departed_at: safeISO(departed),
          arrived_at: safeISO(arrived),
          dest_customs_cleared_at: safeISO(destClr),
          eta_fc: safeISO(etaFC),
          latest_arrival_date: safeISO(latestArrivalDate),
          customs_hold: hold,
          note: String(note || ''),
        };
        saveIntlLaneManual(ws, key, obj);
        const msg = detail.querySelector('#flow-intl-save-msg');
        if (msg) msg.textContent = 'Saved';
        // Refresh to recompute lane level + badges
        setTimeout(() => refresh(), 10);
      });
    }
  }



  
  function lastMileEditor(ws, tz, r) {
    const scheduledAt = r.scheduled_local ? String(r.scheduled_local).replace('T',' ') : '';
    const deliveredAt = r.delivery_local ? String(r.delivery_local).replace('T',' ') : '';
    const note = String(r.note || '');
    const state = deliveredAt ? 'Delivered' : (scheduledAt ? 'Scheduled' : 'Open');
    const canSchedule = !scheduledAt && !deliveredAt;
    const canReceive = !!scheduledAt && !deliveredAt;

    return `
      <div class="mt-3 rounded-xl border p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-gray-700">Selected container</div>
            <div class="text-xs text-gray-500 mt-0.5">${escapeHtml(r.container_id || '—')} • ${escapeHtml(r.vessel || '—')}</div>
          </div>
          <div class="text-xs ${state==='Delivered' ? 'text-emerald-700' : (state==='Scheduled' ? 'text-gray-700' : 'text-amber-700')}">${escapeHtml(state)}</div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3 text-sm">
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Scheduled at</div>
            <div class="font-medium">${scheduledAt ? escapeHtml(scheduledAt) : '<span class="text-gray-400">—</span>'}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Delivered at</div>
            <div class="font-medium">${deliveredAt ? escapeHtml(deliveredAt) : '<span class="text-gray-400">—</span>'}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">POD</div>
            <div class="font-medium">${r.pod_received ? 'Yes' : (deliveredAt ? 'No' : '<span class="text-gray-400">—</span>')}</div>
          </div>
        </div>

        <label class="text-sm mt-3 block">
          <div class="text-xs text-gray-500 mb-1">Note (optional)</div>
          <textarea id="flow-lm-note" rows="2" class="w-full px-2 py-1.5 border rounded-lg" placeholder="Quick update for the team...">${escapeHtml(note)}</textarea>
        </label>

        <div class="flex items-center justify-between mt-3">
          <div id="flow-lm-save-msg" class="text-xs text-gray-500"></div>
          <div class="flex items-center gap-2">
            ${canSchedule ? `
              <button data-lm-schedule="1"
                data-ws="${escapeAttr(ws)}"
                data-cont="${escapeAttr(r.key)}"
                data-uid="${escapeAttr(r.uid)}"
                class="px-3 py-1.5 rounded-lg text-sm border bg-sky-50 hover:bg-sky-100">Schedule (now)</button>
            ` : (canReceive ? `
              <button data-lm-deliver="1"
                data-ws="${escapeAttr(ws)}"
                data-cont="${escapeAttr(r.key)}"
                data-uid="${escapeAttr(r.uid)}"
                class="px-3 py-1.5 rounded-lg text-sm border bg-emerald-50 hover:bg-emerald-100">Receive (now)</button>
            ` : `
              <button disabled class="px-3 py-1.5 rounded-lg text-sm border bg-gray-50 text-gray-400 cursor-not-allowed">Delivered</button>
            `)}
            <button data-lm-note-save="1"
              data-ws="${escapeAttr(ws)}"
              data-cont="${escapeAttr(r.key)}"
              data-uid="${escapeAttr(r.uid)}"
              class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Save note</button>
          </div>
        </div>
      </div>
    `;
  }

  function wireLastMileDetail(ws, selectedKey) {
    const detail = document.getElementById('flow-detail');
    if (!detail) return;

    // container row clicks (selection) — but DO NOT bind action buttons (schedule / receive / save note),
    // otherwise they get "bound" and never receive their real handlers.
    detail.querySelectorAll('[data-cont]').forEach(el => {
      if (el.matches('[data-lm-deliver="1"],[data-lm-schedule="1"],[data-lm-note-save="1"]')) return;
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('click', () => {
        const k = el.getAttribute('data-cont');
        UI.selection = { node: 'lastmile', sub: k };
        refresh();
      });
    });

    const bindSchedule = (btn) => {
      if (!btn || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const wsNow = String(btn.getAttribute('data-ws') || ws || '').trim() || ws;
        const contKey = btn.getAttribute('data-cont') || selectedKey;
        const uid = String(btn.getAttribute('data-uid') || (String(contKey).split('::')[1] || '')).trim();

        const msg = detail.querySelector('#flow-lm-save-msg');
        if (!uid) {
          if (msg) { msg.textContent = 'Update failed: missing container uid'; msg.className = 'text-xs text-red-600'; }
          return;
        }

        const receipts = loadLastMileReceipts(wsNow);
        const now = nowLocalDT();
        const note = String(detail.querySelector('#flow-lm-note')?.value || '');

        receipts[uid] = {
          ...(receipts[uid] || {}),
          scheduled_local: now,
          status: 'Scheduled',
          last_mile_note: note,
          _updatedAt: new Date().toISOString(),
        };
        saveLastMileReceipts(wsNow, receipts);

        if (msg) { msg.textContent = 'Scheduled ✓'; msg.className = 'text-xs text-blue-700'; }

        UI.selection = { node: 'lastmile', sub: contKey };
        refresh();
      });
    };

    const bindDeliver = (btn) => {
      if (!btn || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const wsNow = String(btn.getAttribute('data-ws') || ws || '').trim() || ws;
        const contKey = btn.getAttribute('data-cont') || selectedKey;
        const uid = String(btn.getAttribute('data-uid') || (String(contKey).split('::')[1] || '')).trim();

        const msg = detail.querySelector('#flow-lm-save-msg');

        if (!uid) {
          if (msg) { msg.textContent = 'Update failed: missing container uid'; msg.className = 'text-xs text-red-600'; }
          return;
        }

        const receipts = loadLastMileReceipts(wsNow);
        const now = nowLocalDT();
        const note = String(detail.querySelector('#flow-lm-note')?.value || '');

        receipts[uid] = {
          ...(receipts[uid] || {}),
          // If user clicks Receive without scheduling first, we still mark delivered.
          delivery_local: now,
          status: 'Delivered',
          pod_received: true,
          last_mile_note: note,
          _updatedAt: new Date().toISOString(),
        };
        saveLastMileReceipts(wsNow, receipts);

        if (msg) { msg.textContent = 'Received ✓'; msg.className = 'text-xs text-emerald-700'; }

        UI.selection = { node: 'lastmile', sub: contKey };
        refresh();
      });
    };

    const bindNoteSave = (btn) => {
      if (!btn || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const wsNow = String(btn.getAttribute('data-ws') || ws || '').trim() || ws;
        const contKey = btn.getAttribute('data-cont') || selectedKey;
        const uid = String(btn.getAttribute('data-uid') || (String(contKey).split('::')[1] || '')).trim();

        const msg = detail.querySelector('#flow-lm-save-msg');
        const note = String(detail.querySelector('#flow-lm-note')?.value || '');

        if (!uid) {
          if (msg) { msg.textContent = 'Update failed: missing container uid'; msg.className = 'text-xs text-red-600'; }
          return;
        }

        const receipts = loadLastMileReceipts(wsNow);
        receipts[uid] = {
          ...(receipts[uid] || {}),
          last_mile_note: note,
          _updatedAt: new Date().toISOString(),
        };
        saveLastMileReceipts(wsNow, receipts);

        if (msg) { msg.textContent = 'Saved ✓'; msg.className = 'text-xs text-emerald-700'; }

        UI.selection = { node: 'lastmile', sub: contKey };
        refresh();
      });
    };

    detail.querySelectorAll('[data-lm-schedule="1"]').forEach(bindSchedule);
    detail.querySelectorAll('[data-lm-deliver="1"]').forEach(bindDeliver);
    detail.querySelectorAll('[data-lm-note-save="1"]').forEach(bindNoteSave);
}

function manualFormIntl(ws, tz, manual) {
    const m = manual.manual || {};
    const mode = manual.intlMode;
    const origin = m.origin_ready_at ? m.origin_ready_at.slice(0, 16) : '';
    const departed = m.departed_at ? m.departed_at.slice(0, 16) : '';
    const note = String(m.intl_note || '');
    const hold = !!m.customs_hold;
    return `
      <div class="mt-3 rounded-xl border p-3">
        <div class="text-sm font-semibold text-gray-700">Manual updates (lightweight)</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
          <label class="text-sm">
            <div class="text-xs text-gray-500 mb-1">Mode</div>
            <select id="flow-intl-mode" class="w-full px-2 py-1.5 border rounded-lg bg-white">
              <option ${mode === 'Sea' ? 'selected' : ''}>Sea</option>
              <option ${mode === 'Air' ? 'selected' : ''}>Air</option>
            </select>
          </label>
          <label class="text-sm">
            <div class="text-xs text-gray-500 mb-1">Origin ready (packing list + export cleared)</div>
            <input id="flow-origin-ready" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${origin}"/>
          </label>
          <label class="text-sm">
            <div class="text-xs text-gray-500 mb-1">Departed origin (optional)</div>
            <input id="flow-departed" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${departed}"/>
          </label>
          <label class="text-sm flex items-center gap-2 mt-6">
            <input id="flow-customs-hold" type="checkbox" class="h-4 w-4" ${hold ? 'checked' : ''}/>
            <span>Customs hold</span>
          </label>
        </div>
        <label class="text-sm mt-3 block">
          <div class="text-xs text-gray-500 mb-1">Note (optional)</div>
          <textarea id="flow-intl-note" rows="2" class="w-full px-2 py-1.5 border rounded-lg" placeholder="Quick update for the team...">${escapeHtml(note)}</textarea>
        </label>
        <div class="flex items-center justify-between mt-3">
          <div id="flow-save-msg" class="text-xs text-gray-500"></div>
          <button id="flow-save-intl" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Save</button>
        </div>
      </div>
    `;
  }

  function manualFormLastMile(ws, tz, manual) {
    const m = manual.manual || {};
    const delivered = m.delivered_at ? m.delivered_at.slice(0, 16) : '';
    const note = String(m.last_mile_note || '');
    const issue = !!m.last_mile_issue;
    return `
      <div class="mt-3 rounded-xl border p-3">
        <div class="text-sm font-semibold text-gray-700">Manual updates (lightweight)</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
          <label class="text-sm">
            <div class="text-xs text-gray-500 mb-1">Delivered to WH (Sydney)</div>
            <input id="flow-delivered" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${delivered}"/>
          </label>
          <label class="text-sm flex items-center gap-2 mt-6">
            <input id="flow-lastmile-issue" type="checkbox" class="h-4 w-4" ${issue ? 'checked' : ''}/>
            <span>Issue</span>
          </label>
        </div>
        <label class="text-sm mt-3 block">
          <div class="text-xs text-gray-500 mb-1">Note (optional)</div>
          <textarea id="flow-lastmile-note" rows="2" class="w-full px-2 py-1.5 border rounded-lg" placeholder="Quick update for the team...">${escapeHtml(note)}</textarea>
        </label>
        <div class="flex items-center justify-between mt-3">
          <div id="flow-save-msg2" class="text-xs text-gray-500"></div>
          <button id="flow-save-lastmile" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Save</button>
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function wireManualIntl(ws) {
    const btn = document.getElementById('flow-save-intl');
    if (!btn) return;
    btn.onclick = () => {
      const prev = loadFlowManual(ws) || {};
      const mode = ($('#flow-intl-mode')?.value || 'Sea').trim();
      const origin = $('#flow-origin-ready')?.value ? new Date($('#flow-origin-ready').value).toISOString() : '';
      const departed = $('#flow-departed')?.value ? new Date($('#flow-departed').value).toISOString() : '';
      const note = $('#flow-intl-note')?.value || '';
      const hold = !!$('#flow-customs-hold')?.checked;

      const next = {
        ...prev,
        intl_mode: mode,
        origin_ready_at: origin || '',
        departed_at: departed || '',
        customs_hold: hold,
        intl_note: note,
      };
      saveFlowManual(ws, next);
      const msg = document.getElementById('flow-save-msg');
      if (msg) msg.textContent = `Saved ${new Date().toLocaleString()}`;
      // re-render to refresh statuses
      window.dispatchEvent(new Event('state:ready'));
    };
  }

  function wireManualLastMile(ws) {
    const btn = document.getElementById('flow-save-lastmile');
    if (!btn) return;
    btn.onclick = () => {
      const prev = loadFlowManual(ws) || {};
      const delivered = $('#flow-delivered')?.value ? new Date($('#flow-delivered').value).toISOString() : '';
      const note = $('#flow-lastmile-note')?.value || '';
      const issue = !!$('#flow-lastmile-issue')?.checked;
      const next = {
        ...prev,
        delivered_at: delivered || '',
        last_mile_issue: issue,
        last_mile_note: note,
      };
      saveFlowManual(ws, next);
      const msg = document.getElementById('flow-save-msg2');
      if (msg) msg.textContent = `Saved ${new Date().toLocaleString()}`;
      window.dispatchEvent(new Event('state:ready'));
    };
  }

  // ------------------------- Mount / Refresh -------------------------
  
  
function severityRank(level){
  // Higher number = worse (red > yellow/gray > green)
  const band = _bandFromColor(level);
  if (band === 'red') return 3;
  if (band === 'yellow' || band === 'gray') return 2;
  if (band === 'green') return 1;
  return 0;
}

function colorToStatus(color){
  const c = String(color||"").toLowerCase();
  if(c==="red") return "At-Risk";
  if(c==="yellow" || c==="amber") return "Watch";
  if(c==="gray" || c==="grey") return "Future";
  if(c==="green") return "Ahead-of-Plan";
  return "";
}

function _bandFromColor(color){
  const c = String(color||"").toLowerCase().trim();
  // semantic words
  if (c === "red") return "red";
  if (c === "green") return "green";
  if (c === "yellow" || c === "amber") return "yellow";
  if (c === "gray" || c === "grey") return "gray";
  // hex and rgb hints
  if (c.includes("#ef4444") || c.includes("239,68,68")) return "red";          // red-500
  if (c.includes("#f59e0b") || c.includes("#fbbf24") || c.includes("245,158,11") || c.includes("251,191,36")) return "yellow"; // amber-500/400
  if (c.includes("#10b981") || c.includes("#22c55e") || c.includes("16,185,129") || c.includes("34,197,94")) return "green";   // emerald-500 / green-500
  if (c.includes("#9ca3af") || c.includes("#d1d5db") || c.includes("156,163,175") || c.includes("209,213,219")) return "gray"; // gray-400/300
  return "gray";
}

function statusBg(color){
  const band = _bandFromColor(color);
  if (band === "red") return "rgba(239,68,68,0.14)";
  if (band === "yellow") return "rgba(245,158,11,0.18)";
  if (band === "green") return "rgba(16,185,129,0.14)";
  return "rgba(156,163,175,0.18)";
}

function statusStroke(color){
  const band = _bandFromColor(color);
  if (band === "red") return "#ef4444";
  if (band === "yellow") return "#f59e0b";
  if (band === "green") return "#10b981";
  return "#9ca3af";
}



function renderFooterTrends(el, nodes, weekKey) {
  // Backwards-compatible overload:
  // Called as renderFooterTrends(weekKey, tz, records, receiving, vas, intl, manual)
  if (typeof el === 'string') {
    const wk = el;
    const receiving = arguments[3] || {};
    const vas = arguments[4] || {};
    const intl = arguments[5] || {};
    const manual = arguments[6] || {};

    const footerEl = document.getElementById('flow-footer') || document.getElementById('vo-footer');
    return renderFooterTrends(footerEl, { receiving, vas, intl, manual }, wk);
  }

  // Normal signature: (el: HTMLElement, data: {receiving,vas,intl,manual}, weekKey: string)
  if (!el || typeof el !== 'object' || typeof el.innerHTML === 'undefined') return;

  const data = nodes || {};
  const receiving = data.receiving || {};
  const vas = data.vas || {};
  const intl = data.intl || {};
  const manual = data.manual || {};

  // Week-level Intl containers (for vessels/containers totals)
  let wc = { containers: [] };
  try { wc = loadIntlWeekContainers(weekKey) || wc; } catch {}
  const weekContainers = (wc && Array.isArray(wc.containers)) ? wc.containers : [];

  const containersTotal = weekContainers.length;
  const vesselsTotal = (() => {
    const s = new Set();
    for (const c of weekContainers) {
      const v = String(c?.vessel || '').trim();
      if (v) s.add(v);
    }
    return s.size;
  })();

  const lanesTotal = Array.isArray(intl.lanes) ? intl.lanes.length : (intl.lanesTotal || 0);

  const rows = [
    { label: 'Total POs planned – received', value: `${fmtInt(receiving.plannedPOs || 0)} – ${fmtInt(receiving.receivedPOs || 0)}`, icon: iconDoc },
    { label: 'Total Units planned – applied', value: `${fmtInt(vas.plannedUnits || 0)} – ${fmtInt(vas.appliedUnits || 0)}`, icon: iconSpark },
    { label: 'Total Cartons in – cartons out', value: `${fmtInt(receiving.cartonsInTotal || 0)} – ${fmtInt(receiving.cartonsOutTotal || 0)}`, icon: iconBox },
    { label: 'Total Lanes', value: `${fmtInt(lanesTotal)}`, icon: iconLane },
    { label: 'Total Vessels', value: `${fmtInt(vesselsTotal)}`, icon: iconShip },
    { label: 'Total Containers', value: `${fmtInt(containersTotal)}`, icon: iconContainerSmall },
  ];

  // Health pill (kept, small)
  const nodeColors = [
    { id: 'receiving', color: (receiving && receiving.color) || levelColor(receiving.level || 'green') },
    { id: 'vas', color: (vas && vas.color) || levelColor(vas.level || 'green') },
    { id: 'intl', color: (intl && intl.color) || levelColor(intl.level || 'green') },
    { id: 'lm', color: levelColor((manual.levels && manual.levels.lastMile) || manual.levels?.lastmile || 'green') },
  ];
  const worst = nodeColors.reduce((acc, n) => severityRank(n.color) > severityRank(acc.color) ? n : acc, nodeColors[0] || { color: '#10b981' });
  const pillText = (colorToStatus(worst.color) || 'On Track');

  el.innerHTML = `
    <div class="grid grid-cols-1 gap-2">
      ${rows.map(r => `
        <div class="flex items-center gap-2 rounded-xl border bg-white px-2.5 py-2">
          <span class="inline-flex items-center justify-center w-8 h-8 rounded-lg border bg-gray-50 text-gray-700">
            ${r.icon()}
          </span>
          <div class="min-w-0">
            <div class="text-[11px] font-semibold text-gray-600 leading-tight">${escapeHtml(r.label)}</div>
            <div class="text-sm font-bold text-gray-900 leading-tight">${escapeHtml(r.value)}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="mt-3 flex items-center gap-2">
      <span class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
            style="background:${statusBg(worst.color)}; border-color:${statusStroke(worst.color)};">
        <span class="inline-block h-2 w-2 rounded-full" style="background:${worst.color};"></span>
        <span class="font-semibold">Health:</span>
        <span>${escapeHtml(pillText)}</span>
      </span>
    </div>
  `;

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  // Tiny inline icons (no external deps)
  function iconDoc() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>`;
  }
  function iconSpark() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.2 5.2L18 9l-4.8 1.8L12 16l-1.2-5.2L6 9l4.8-1.8L12 2z"/><path d="M5 14l.7 3L9 18l-3.3 1-.7 3-.7-3L1.9 18l3.4-1 .7-3z"/></svg>`;
  }
  function iconBox() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9 5-9-5"/><path d="M3 8l9-5 9 5"/><path d="M12 13v9"/></svg>`;
  }
  function iconLane() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v18"/><path d="M18 3v18"/><path d="M12 3v4"/><path d="M12 11v4"/><path d="M12 19v2"/></svg>`;
  }
  function iconShip() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l9 4 9-4"/><path d="M3 17V9l9-4 9 4v8"/><path d="M12 5v16"/></svg>`;
  }
  function iconContainerSmall() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/></svg>`;
  }
}




  // ------------------------- PDF Reporting (Print-to-PDF) -------------------------
  // Generates a multi-page printable report in a new window and triggers the browser print dialog.
  // This avoids external PDF libraries and is resilient to undefined data.
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function pct(n, d) {
    const nn = Number(n) || 0;
    const dd = Number(d) || 0;
    if (!dd) return '0%';
    return `${Math.round((nn / dd) * 100)}%`;
  }

  function fmtDateLocal(d, tz) {
    try {
      if (!d) return '—';
      const dt = (d instanceof Date) ? d : new Date(d);
      if (isNaN(dt)) return '—';
      return fmtInTZ(dt, tz);
    } catch { return '—'; }
  }

  function weekRangeText(ws, tz) {
    try {
      const start = makeBizLocalDate(ws, '00:00', tz);
      const end = new Date(start.getTime()); end.setDate(end.getDate() + 5); // Mon..Sat-ish for display
      return `${fmtInTZ(start, tz)} – ${fmtInTZ(end, tz)}`;
    } catch { return String(ws || ''); }
  }

  
function buildReportHTML(cache) {
    // Kept for backward compatibility (older callers). We now generate a
    // print-ready report by capturing the live Flow DOM (no backend mutations).
    // This function returns a minimal shell used by downloadFlowReportPdf().
    return `<!doctype html><html><head><meta charset="utf-8"><title>Flow report</title></head><body></body></html>`;
  }

  function downloadFlowReportPdf(cache) {
    // SAFETY: do not touch refresh(), API base resolution, or backend patch calls.
    // PDF generation is isolated to DOM capture + a separate print window.
    const cap = cache || (window.UI && UI.reportCache) || {};
    const ws = cap.ws || (window.UI && UI.currentWs) || (window.state && window.state.weekStart) || '';
    const tz = cap.tz || getBizTZ();

    const prevSel = (window.UI && UI.selection) ? { node: UI.selection.node, sub: UI.selection.sub } : null;

    const pageFlow = document.getElementById('page-flow');

    const escape = (s) => escapeHtml(String(s ?? ''));

    const addDaysLocal = (isoDateStr, days) => {
      try {
        const d = new Date(`${isoDateStr}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return d;
      } catch { return null; }
    };

    const fmtDateRange = (wsISO) => {
      const mon = addDaysLocal(wsISO, 0);
      const sun = addDaysLocal(wsISO, 6);
      if (!mon || !sun || isNaN(mon) || isNaN(sun)) return '—';
      const fmt = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: '2-digit', year: 'numeric' }).format(d);
      return `${fmt(mon)} – ${fmt(sun)}`;
    };

    // ISO week number (Monday-based)
    const isoWeekNum = (wsISO) => {
      try {
        const d = new Date(`${wsISO}T00:00:00Z`);
        // Thursday in current week decides the year.
        const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
        d.setUTCDate(d.getUTCDate() - day + 3); // Thu
        const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
        const firstDay = (firstThu.getUTCDay() + 6) % 7;
        firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
        const diff = d - firstThu;
        return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
      } catch { return null; }
    };

    const weekLabel = (() => {
      const n = isoWeekNum(ws);
      return n ? `Week ${String(n).padStart(2, '0')}` : 'Week —';
    })();

    const createdAt = (() => {
      try {
        const now = new Date();
        return new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          year: 'numeric', month: 'short', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        }).format(now);
      } catch {
        return String(new Date());
      }
    })();

    const captureHTML = (el) => {
      if (!el) return '';
      // Clone to avoid mutating live DOM
      const c = el.cloneNode(true);
      // Remove any buttons/controls that don't make sense in print
      c.querySelectorAll('button, input, select, textarea').forEach(x => {
        // Preserve textual buttons (e.g., lane supplier links) by converting to spans
        if (x.tagName === 'BUTTON') {
          const t = (x.textContent || '').trim();
          if (t) {
            const s = document.createElement('span');
            s.textContent = t;
            s.style.fontSize = '12px';
            s.style.fontWeight = '600';
            x.replaceWith(s);
          } else {
            x.remove();
          }
          return;
        }
        // Keep input values readable by converting to text spans
        if (x.tagName === 'INPUT' && (x.type === 'text' || x.type === 'datetime-local')) {
          const v = (x.value || '').trim();
          const s = document.createElement('span');
          s.textContent = v || '—';
          s.style.fontSize = '12px';
          s.style.fontWeight = '600';
          x.replaceWith(s);
          return;
        }
        if (x.tagName === 'INPUT' && x.type === 'checkbox') {
          const s = document.createElement('span');
          s.textContent = x.checked ? '✓' : '—';
          s.style.fontWeight = '700';
          x.replaceWith(s);
          return;
        }
        if (x.tagName === 'TEXTAREA') {
          const v = (x.value || x.textContent || '').trim();
          const s = document.createElement('div');
          s.textContent = v || '—';
          s.style.whiteSpace = 'pre-wrap';
          s.style.fontSize = '11px';
          x.replaceWith(s);
          return;
        }
        // Buttons etc become nothing
        x.remove();
      });
      return c.innerHTML;
    };

    const stripIntlLaneDetailsFromDetailHTML = (html) => {
      try {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Remove lane editor (Lane details) section
        const laneEditorBody = tmp.querySelector('#flow-lane-editor-body');
        if (laneEditorBody) {
          const wrap = laneEditorBody.closest('.rounded-xl.border.p-3') || laneEditorBody.closest('.rounded-xl') || laneEditorBody.parentElement;
          if (wrap) wrap.remove();
        }
        return tmp.innerHTML;
      } catch { return html; }
    };

    const extractIntlContainersTileHTML = (html) => {
      try {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Find the week-level containers editor section by known ids/classes
        const wcList = tmp.querySelector('#flow-wc-list');
        if (!wcList) return '';
        const wrap = wcList.closest('.rounded-xl.border.p-3') || wcList.closest('.rounded-xl') || wcList.parentElement;
        return wrap ? wrap.outerHTML : '';
      } catch { return ''; }
    };

    const stripSelectedContainerFromHTML = (html) => {
      // PDF-only: remove the "Selected Container" panel from Last Mile pages.
      // Keeps the live UI untouched.
      try {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const needles = ['selected container', 'selected-container'];

        // Try common patterns: a card/section that contains a title matching the needle.
        const all = Array.from(tmp.querySelectorAll('*'));
        for (const el of all) {
          const t = (el.textContent || '').trim().toLowerCase();
          if (!t) continue;
          if (!needles.some(n => t === n || t.includes(n))) continue;

          // Prefer removing the nearest card wrapper.
          const wrap = el.closest('.rounded-xl') || el.closest('.rounded-2xl') || el.closest('.border') || el.closest('.box') || el.parentElement;
          if (wrap) {
            wrap.remove();
            break;
          }
        }
        return tmp.innerHTML;
      } catch {
        return html;
      }
    };

    const hideDuringCapture = () => {
      try {
        if (!document.getElementById('flow-pdf-export-style')) {
          const st = document.createElement('style');
          st.id = 'flow-pdf-export-style';
          st.textContent = `
            body.flow-pdf-exporting #page-flow { visibility: hidden !important; }
            body.flow-pdf-exporting #flow-lane-modal-root { visibility: hidden !important; }
          `;
          document.head.appendChild(st);
        }
        document.body.classList.add('flow-pdf-exporting');
      } catch {}
    };

    const showAfterCapture = () => {
      try { document.body.classList.remove('flow-pdf-exporting'); } catch {}
    };

    const safeRenderForNode = (nodeKey) => {
      try {
        const receiving = cap.receiving, vas = cap.vas, intl = cap.intl, manual = cap.manual;
        UI.selection = { node: nodeKey, sub: null };
        renderDetail(ws, tz, receiving, vas, intl, manual);
        renderRightTile(ws, tz, receiving, vas, intl, manual);
        highlightSelection();
      } catch (e) {
        console.warn('[flow] pdf render node failed', nodeKey, e);
      }
    };

    const nodePageHTML = (pageTitle, rightTitle, rightHTML, bottomTitle, detailHTML) => {
      return `
        <div class="page">
          <div class="pageTitle">${escape(pageTitle)}</div>
          <div class="pageGrid">
            <div class="box">
              <div class="boxTitle">${escape(rightTitle || 'Summary')}</div>
              <div class="boxBody">${rightHTML || '<div class="muted">—</div>'}</div>
            </div>
            <div class="box">
              <div class="boxTitle">${escape(bottomTitle || 'Details')}</div>
              <div class="boxBody">${detailHTML || '<div class="muted">—</div>'}</div>
            </div>
          </div>
        </div>
      `;
    };

    try {
      // Ensure we have a rendered Flow DOM to capture
      if (!pageFlow || pageFlow.classList.contains('hidden')) {
        // If Flow isn't visible, still attempt: render once.
        try { refresh(); } catch {}
      }

      hideDuringCapture();

      const pages = [];

      // Page 1: Cover
      pages.push(`
        <div class="page cover">
          <div class="coverBlock">
            <div class="coverBrand"><span class="brandAccent">VelOzity</span> <span class="brandAccent">Pinpoint</span> <span class="brandPin">📍</span></div>
            <div class="coverWeek">${escape(weekLabel)}</div>
            <div class="coverRange">${escape(fmtDateRange(ws))}</div>
          </div>
        </div>
      `);


      // Page 2: Overview (S-curve + Week totals)
      const journeyHTML = captureHTML(document.getElementById('flow-journey'));
      // IMPORTANT (PDF-only): Overview should always show Week totals (no node context).
      // We temporarily render the right tile in "week totals" mode by clearing selection,
      // capture the DOM, then continue with node-specific pages. Live UI is restored in finally.
      let weekTotalsHTML = '';
      try {
        const receiving = cap.receiving, vas = cap.vas, intl = cap.intl, manual = cap.manual;
        const prev = (UI && UI.selection) ? { node: UI.selection.node, sub: UI.selection.sub } : null;
        UI.selection = { node: null, sub: null };
        renderRightTile(ws, tz, receiving, vas, intl, manual);
        weekTotalsHTML = captureHTML(document.getElementById('flow-footer'));
        if (prev) UI.selection = { node: prev.node, sub: prev.sub || null };
      } catch (e) {
        weekTotalsHTML = captureHTML(document.getElementById('flow-footer'));
      }
      pages.push(`
        <div class="page">
          <div class="pageTitle">Overview</div>
          <div class="overviewGrid">
            <div class="box">
              <div class="boxTitle">Inverted S-curve</div>
              <div class="boxBody">${journeyHTML || '<div class="muted">—</div>'}</div>
            </div>
            <div class="box">
              <div class="boxTitle">Week totals</div>
              <div class="boxBody">${weekTotalsHTML || '<div class="muted">—</div>'}</div>
            </div>
          </div>
        </div>
      `);

      // Receiving
      safeRenderForNode('receiving');
      pages.push(nodePageHTML('Receiving', 'Receiving summary', captureHTML(document.getElementById('flow-footer')), 'Receiving detail', captureHTML(document.getElementById('flow-detail'))));

      // VAS
      safeRenderForNode('vas');
      pages.push(nodePageHTML('VAS Processing', 'VAS summary', captureHTML(document.getElementById('flow-footer')), 'VAS detail', captureHTML(document.getElementById('flow-detail'))));

      // Transit & Clearing special: (A) right tile + lanes tile (no lane details)
      safeRenderForNode('intl');
      const intlRight = captureHTML(document.getElementById('flow-footer'));
      const intlDetailRaw = captureHTML(document.getElementById('flow-detail'));
      const intlDetailNoEditor = stripIntlLaneDetailsFromDetailHTML(intlDetailRaw);
      pages.push(`
        <div class="page">
          <div class="pageTitle">Transit &amp; Clearing</div>
          <div class="pageGrid">
            <div class="box">
              <div class="boxTitle">Transit &amp; Clearing summary</div>
              <div class="boxBody">${intlRight || '<div class="muted">—</div>'}</div>
            </div>
            <div class="box">
              <div class="boxTitle">Lanes</div>
              <div class="boxBody">${intlDetailNoEditor || '<div class="muted">—</div>'}</div>
            </div>
          </div>
        </div>
      `);

      // Transit & Clearing special: (B) lanes full screen table
      try {
        // Build the modal content (hidden during capture), then capture its body.
        openIntlOverviewModal(ws, tz);
        const modalBody = document.querySelector('#flow-lane-modal-body');
        const modalTitle = document.querySelector('#flow-lane-modal-title')?.textContent || 'Transit & Clearing — Lanes (Full screen)';
        const lanesFullHTML = captureHTML(modalBody);
        // close modal safely
        const root = document.getElementById('flow-lane-modal-root');
        if (root) root.classList.add('hidden');
        pages.push(`
          <div class="page">
            <div class="pageTitle">${escape(modalTitle)}</div>
            <div class="box">
              <div class="boxBody">${lanesFullHTML || '<div class="muted">—</div>'}</div>
            </div>
          </div>
        `);
      } catch (e) {
        console.warn('[flow] pdf lanes fullscreen capture failed', e);
      }
      // Transit & Clearing containers pages intentionally omitted in PDF.
// Last Mile
      safeRenderForNode('lastmile');
      {
        const lmRightRaw = captureHTML(document.getElementById('flow-footer'));
        const lmDetailRaw = captureHTML(document.getElementById('flow-detail'));
        const lmRight = stripSelectedContainerFromHTML(lmRightRaw);
        const lmDetail = stripSelectedContainerFromHTML(lmDetailRaw);
        pages.push(nodePageHTML('Last Mile', 'Last Mile summary', lmRight, 'Last Mile detail', lmDetail));
      }

      // Final timestamp page
      pages.push(`
        <div class="page cover">
          <div class="coverBlock">
            <div class="coverBrand"><span class="brandAccent">Report created</span></div>
            <div class="coverRange">${escape(createdAt)}</div>
          </div>
        </div>
      `);


      // Restore selection
      try {
        // Best effort restore to original selection
        // (we used UI.selection directly; keep stable afterwards)
      } catch {}

      // Add per-page footer text (avoid relying on print page counters, which vary by browser/PDF driver)
      const totalPages = pages.length;
      const pagesWithFooter = pages.map((p, i) => {
        try {
          return String(p).replace(/<\/div>\s*$/, `<div class="pageFooter">VelOzity Pinpoint • Page ${i+1} of ${totalPages}</div></div>`);
        } catch { return p; }
      });

      // Build print window
      const style = `
        <style>
          :root { color-scheme: light; }
          @page { size: letter landscape; margin: 0.5in; }
          html, body { margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; color: #111827; }
          .page { position: relative; page-break-after: always; }
          .page:last-child { page-break-after: auto; }
          .pageTitle { font-size: 18px; font-weight: 800; margin: 0 0 10px 0; }
          .box { border: 1px solid rgba(17,24,39,0.12); border-radius: 14px; padding: 12px; background: #fff; }
          .boxTitle { font-size: 12px; font-weight: 700; color: rgba(17,24,39,0.70); margin-bottom: 8px; }
          .boxBody { font-size: 12px; }
          .muted { color: rgba(17,24,39,0.55); font-size: 12px; }
          .overviewGrid { display: grid; grid-template-columns: 1.4fr 0.9fr; gap: 14px; align-items: start; }
          .pageGrid { display: grid; grid-template-columns: 0.9fr 1.4fr; gap: 14px; align-items: start; }
          .cover { display:flex; align-items:center; justify-content:center; min-height: 7.0in; }
          .coverBlock { width: 100%; padding-left: 0.8in; text-align: left; }
          .coverBrand { font-size: 40px; font-weight: 900; letter-spacing: 0.02em; line-height: 1.05; }
          .brandAccent { color: #990033; }
          .brandPin { color: #990033; font-size: 34px; margin-left: 6px; }
          .coverWeek { font-size: 22px; font-weight: 800; margin-top: 10px; color: #111827; }
          .coverRange { font-size: 14px; color: rgba(17,24,39,0.65); margin-top: 6px; }
          /* Make tables print nicely */
          table { width: 100%; border-collapse: collapse; }
          th, td { border-bottom: 1px solid rgba(17,24,39,0.10); padding: 6px 8px; vertical-align: top; }
          th { color: rgba(17,24,39,0.65); font-size: 11px; font-weight: 800; }

          /* PDF-only utility styles (avoid importing Tailwind; keep minimal + targeted)
             Fixes: (1) metric label/value wrapping in Week totals, (2) progress bars visibility. */
          .flex { display:flex; }
          .inline-flex { display:inline-flex; }
          .items-center { align-items:center; }
          .items-start { align-items:flex-start; }
          .justify-between { justify-content:space-between; }
          .gap-2 { gap: 8px; }
          .gap-3 { gap: 12px; }
          .py-2 { padding-top: 8px; padding-bottom: 8px; }
          .px-3 { padding-left: 12px; padding-right: 12px; }
          .py-1 { padding-top: 4px; padding-bottom: 4px; }
          .p-3 { padding: 12px; }
          .mt-0\.5 { margin-top: 2px; }
          .mt-1 { margin-top: 4px; }
          .mt-2 { margin-top: 8px; }
          .mt-3 { margin-top: 12px; }
          .space-y-3 > * + * { margin-top: 12px; }
          .rounded-xl { border-radius: 12px; }
          .rounded-2xl { border-radius: 16px; }
          .rounded-full { border-radius: 9999px; }
          .border { border: 1px solid rgba(17,24,39,0.12); }
          .overflow-hidden { overflow: hidden; }
          .text-xs { font-size: 11px; }
          .text-sm { font-size: 12px; }
          .font-semibold { font-weight: 700; }
          .text-gray-500 { color: rgba(17,24,39,0.55); }
          .text-gray-600 { color: rgba(17,24,39,0.60); }
          .text-gray-700 { color: rgba(17,24,39,0.70); }
          .text-gray-800 { color: rgba(17,24,39,0.85); }
          .text-gray-900 { color: rgba(17,24,39,0.95); }
          .bg-white { background: #fff; }
          .bg-gray-50 { background: rgba(17,24,39,0.03); }
          .bg-gray-100 { background: rgba(17,24,39,0.06); }

          /* Progress bars (used in Receiving/VAS tiles) */
          .w-36 { width: 144px; }
          .w-32 { width: 128px; }
          .w-28 { width: 112px; }
          .h-2 { height: 8px; }
          .h-full { height: 100%; }
          .bg-emerald-400 { background: #34d399; }

          /* Keep metric rows on a single line in PDF (Week totals) */
          .flex.items-center.justify-between > div:last-child { white-space: nowrap; }

          /* Keep KPI cards (label + value) on one line across nodes (Transit KPIs, Last Mile KPIs, etc.) */
          .rounded-lg.border.p-2 { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
          .rounded-lg.border.p-2 > div:first-child { white-space: nowrap; }
          .rounded-lg.border.p-2 > div:last-child { white-space: nowrap; }

          /* Keep compact stat pills (Sea/Air/Delayed/At risk) on one line in PDF */
          .rounded-lg.border.px-2.py-1.bg-white { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
          /* If grid layout utilities are missing, still keep pills aligned */
          .grid.grid-cols-2.sm\:grid-cols-4.gap-2.text-xs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
          /* Footer */
          .pageFooter { position: absolute; right: 0; bottom: 0; font-size: 10px; color: rgba(17,24,39,0.70); }
          @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        </style>
      `;

      const html = `<!doctype html><html><head><meta charset="utf-8"><title>VelOzity Pinpoint — ${escape(weekLabel)}</title>${style}</head>
        <body>
          ${pagesWithFooter.join('\n')}
        </body></html>`;

      const w = window.open('', '_blank');
      if (!w) { showAfterCapture(); return; }
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => { try { w.print(); } catch {} }, 300);
    } catch (e) {
      console.warn('[flow] pdf export failed', e);
    } finally {
      try {
        if (prevSel) UI.selection = { node: prevSel.node, sub: prevSel.sub || null };
        // Re-render once to restore the UI (best-effort; no backend writes)
        try {
          const receiving = cap.receiving, vas = cap.vas, intl = cap.intl, manual = cap.manual;
          renderDetail(ws, tz, receiving, vas, intl, manual);
          renderRightTile(ws, tz, receiving, vas, intl, manual);
          highlightSelection();
        } catch {}
      } catch {}
      try { showAfterCapture(); } catch {}
    }
  }
async function refresh() {
    const page = ensureFlowPageExists();
    injectSkeleton(page);

    let ws = window.state?.weekStart || $('#week-start')?.value;
    if (!ws) {
      // Cold-load resilience: pick the current Monday as weekStart (YYYY-MM-DD)
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dow = d.getDay(); // 0=Sun
      const delta = (dow + 6) % 7; // days since Monday
      d.setDate(d.getDate() - delta);
      ws = isoDateUTC(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
    }
    // Enforce Monday week-starts. This prevents silent drift that can make
    // the week appear to "lose" data when users navigate.
    ws = normalizeWeekStartToMonday(ws);
    if (!window.state) window.state = {};
    window.state.weekStart = ws;
    // Prime week-scoped local stores from backend so data is shared across browsers.
    await primeFlowWeekFromBackend(ws);
    // Backend sync pulse (cross-browser): periodically re-prime this week if backend changed.
    if (!window.__FLOW_BACKEND_POLL__) {
      window.__FLOW_BACKEND_POLL__ = setInterval(async () => {
        try {
          const flowSection = document.getElementById('page-flow');
          const isFlowVisible = flowSection && !flowSection.classList.contains('hidden');
          if (!isFlowVisible) return;
          const wsNow = normalizeWeekStartToMonday(UI.currentWs || window.state?.weekStart || '');
          if (!wsNow) return;
          const before = String(window.__FLOW_PRIMED__?.[`${wsNow}::${getFacility()}`] || '');
          await primeFlowWeekFromBackend(wsNow);
          const after = String(window.__FLOW_PRIMED__?.[`${wsNow}::${getFacility()}`] || '');
          if (after && after !== before) {
            // Re-render to reflect changes pulled from backend.
            refresh();
          }
        } catch {}
      }, 5000);
    }

    const wkInp = document.getElementById('week-start');
    if (wkInp) wkInp.value = ws;

    UI.currentWs = ws;
    const tz = getBizTZ();

    try {
      setSubheader(ws);
    setDayProgress(ws, tz);

    const resetBtn = document.getElementById('flow-reset');
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = '1';
      resetBtn.onclick = () => {
        // Flow-only reset (do not broadcast global events that can break other pages)
        UI.selection = { node: 'receiving', sub: null };
        try {
          // clear lightweight per-week manual inputs
          localStorage.removeItem(`flow:intl:${UI.currentWs}`);
          localStorage.removeItem(`flow:lastmile:${UI.currentWs}`);
        } catch {}
        // Re-render just this page
        refresh();
      };
    }

    // PDF report download (Flow-local). Opens print dialog for Save-as-PDF.
    const pdfBtn = document.getElementById('flow-download-pdf');
    if (pdfBtn && !pdfBtn.dataset.bound) {
      pdfBtn.dataset.bound = '1';
      pdfBtn.onclick = () => {
        try { downloadFlowReportPdf(UI.reportCache || { ws: UI.currentWs || ws, tz }); }
        catch (e) { console.warn('[flow] pdf failed', e); }
      };
    }




    // Week navigation (Flow-local). Never breaks if state/input missing.
    const prevBtn = document.getElementById('flow-prev-week');
    const nextBtn = document.getElementById('flow-next-week');
    const bindWeekBtn = (btn, delta) => {
      if (!btn || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.onclick = () => {
        try {
          // Shift and re-normalize to Monday (defensive even if stored ws drifts)
          const nextWs = normalizeWeekStartToMonday(shiftWeekStart(UI.currentWs || ws, delta));
          // Update both global state and any week input, but do not broadcast.
          if (!window.state) window.state = {};
          window.state.weekStart = nextWs;
          const inp = document.getElementById('week-start');
          if (inp) inp.value = nextWs;
          UI.currentWs = nextWs;
          // Keep selection stable but safe
          if (!UI.selection?.node) UI.selection = { node: 'receiving', sub: null };
          refresh();
        } catch (e) {
          console.warn('[flow] week nav failed', e);
        }
      };
    };
    bindWeekBtn(prevBtn, -1);
    bindWeekBtn(nextBtn, +1);

    // Load datasets
    let planRows = [];
    let receivingRows = [];
    let records = [];
    try {
      [planRows, receivingRows, records] = await Promise.all([
        loadPlan(ws),
        loadReceiving(ws),
        loadRecords(ws, tz),
      ]);
      planRows = asArray(planRows);
      receivingRows = asArray(receivingRows);
      records = asArray(records);

    // Receiving full-screen (units-based table) uses existing data only (no new endpoints).
    // Store a lightweight context snapshot for the modal to render instantly.
    try {
      window.__FLOW_RECEIVING_FS_CTX__ = { ws, tz, planRows, receivingRows, records };
    } catch {}

    } catch (e) {
      console.warn('[flow] load error', e);
    }

    const receiving = computeReceivingStatus(ws, tz, planRows, receivingRows, records);
    const vas = computeVASStatus(ws, tz, planRows, records);
    const intl = computeInternationalTransit(ws, tz, planRows, records, vas.due);
    const manual = computeManualNodeStatuses(ws, tz);


// Week sign-off (master ticks) — affects Receiving/VAS status only when checked.
const signoff = loadWeekSignoff(ws);

// Attach sign-off flags and "plan met" helpers for UI.
receiving.signoff = signoff;
vas.signoff = signoff;

receiving.planMet = (receiving.plannedPOs || 0) > 0 ? (receiving.receivedPOs || 0) >= (receiving.plannedPOs || 0) : true;
// Treat >=98% as effectively complete to avoid rounding/noise.
vas.planMet = (vas.plannedUnits || 0) > 0 ? (vas.appliedUnits || 0) >= ((vas.plannedUnits || 0) * 0.98) : true;

// If signed off, nudge the level to reflect completeness without faking actuals.
// - If plan met: green
// - If plan not met: at least yellow (unless already red)
if (signoff.receivingComplete) {
  receiving.level = receiving.planMet ? 'green' : (receiving.level === 'red' ? 'red' : 'yellow');
}
if (signoff.vasComplete) {
  vas.level = vas.planMet ? 'green' : (vas.level === 'red' ? 'red' : 'yellow');
}


    // Cache for PDF reporting (best-effort; never required for UI rendering)
    try {
      UI.reportCache = { ws, tz, receiving, vas, intl, manual, records: Array.isArray(records) ? records : (records?.records || records?.rows || records?.data || []) };
    } catch (e) {
      UI.reportCache = { ws, tz, receiving, vas, intl, manual, records: [] };
    }

    renderJourneyTop(ws, tz, receiving, vas, intl, manual);
    // default selection if invalid
    if (!UI.selection?.node || UI.selection.node === 'milk') UI.selection = { node: 'receiving', sub: null };
    renderDetail(ws, tz, receiving, vas, intl, manual);
    renderRightTile(ws, tz, receiving, vas, intl, manual);
    highlightSelection();
    } catch (e) {
      console.warn('[flow] refresh failed', e);
      const detail = document.getElementById('flow-detail');
      if (detail) detail.innerHTML = `<div class="p-6 text-sm text-red-700">Flow failed to render. Please reload. <span class="text-gray-500">(${String(e && e.message || e)})</span></div>`;
    }
  }

  function showHideByHash() {
    const hash = (location.hash || '').toLowerCase();
    const show = hash === '#flow' || hash.startsWith('#flow');
    const page = document.getElementById('page-flow');
    if (!page) return;
    if (show) page.classList.remove('hidden');
    else page.classList.add('hidden');

    // Also update nav active state (best-effort)
    const dash = document.getElementById('nav-dash');
    const intake = document.getElementById('nav-intake');
    const exec = document.getElementById('nav-exec');
    const flow = document.getElementById('nav-flow');
    if (dash && intake && exec && flow) {
      [dash, intake, exec, flow].forEach(el => { el.classList.remove('active'); el.removeAttribute('aria-current'); });
      if (show) { flow.classList.add('active'); flow.setAttribute('aria-current', 'page'); }
    }
  }

  // ------------------------- Boot -------------------------
  // Cold-load: if user lands directly on #flow, render once DOM is ready.
  document.addEventListener('DOMContentLoaded', () => {
    ensureFlowPageExists();
    showHideByHash();
    const hash = (location.hash || '').toLowerCase();
    const show = hash === '#flow' || hash.startsWith('#flow');
    if (show) {
      // Some pages set window.state asynchronously; run a quick retry.
      refresh();
      setTimeout(() => {
        const stillFlow = ((location.hash || '').toLowerCase() || '').startsWith('#flow');
        if (stillFlow) refresh();
      }, 400);
    }
  });


  window.addEventListener('state:ready', () => {
    ensureFlowPageExists();
    showHideByHash();
    // Only render when visible to avoid extra network chatter.
    const hash = (location.hash || '').toLowerCase();
    const show = hash === '#flow' || hash.startsWith('#flow');
    if (show) refresh();
  });

  window.addEventListener('hashchange', () => {
    ensureFlowPageExists();
    showHideByHash();
    const hash = (location.hash || '').toLowerCase();
    const show = hash === '#flow' || hash.startsWith('#flow');
    if (show) refresh();
  });

  // Make sure the section/nav exist even before first state:ready.
  ensureFlowPageExists();
  showHideByHash();
})();



(function(){
  try{
    if (document.getElementById('flow-ui-polish-style')) return;
    var style=document.createElement('style');
    style.id='flow-ui-polish-style';
    style.type='text/css';
    style.appendChild(document.createTextNode(`
/* ===== UI POLISH (SAFE, ADDITIVE) ===== */
/* Top tile subtle contrast */
#flow-top-tile.flow-tile--nodes{
  background:#F9FAFB;
  border-color:#EEF0F3;
}
/* ===== END UI POLISH ===== */
`));
    document.head.appendChild(style);
  }catch(e){}
})();

// PATCH: swallow setFooterHealth errors (null DOM) so setWeek() continues.
;(function(){var _sfh=window.setFooterHealth;if(typeof _sfh!=='function')return;window.setFooterHealth=function(){try{return _sfh.apply(this,arguments);}catch(e){console.warn('setFooterHealth suppressed',e);}};})();
