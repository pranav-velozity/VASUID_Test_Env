/* flow_live_additive.js (v52)
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
  window.__FLOW_BUILD__ = 'v51.1-flow-patch-' + new Date().toISOString();

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
    try { const r = await api(`/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=complete&limit=50000`); return asArray(r); } catch {}
    try { const r = await api(`/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50000`); return asArray(r); } catch {}
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
  const appliedBySup = new Map();
  const appliedByPO = new Map();

  for (const r of recs) {
    const qty = num(r.qty ?? r.quantity ?? r.units ?? r.target_qty ?? r.applied_qty ?? 1);
    const q = qty > 0 ? qty : 1;
    appliedUnits += q;

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
    return state;
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
    selection: { node: 'receiving', sub: null },
  };

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
          <!-- Insights tile moved to right 1/3 -->
          <div class="rounded-2xl border bg-white shadow-sm p-3 min-h-[320px] lg:col-span-1">
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
          #flow-journey svg { width: 100%; height: 240px; display: block; }
          @media (min-width: 1024px) { #flow-journey svg { height: 260px; } }
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
      C: { x: 920, y: 185 },  // mid-right corner
      D: { x: 120, y: 185 },  // mid-left corner
      E: { x: 120, y: 315 },  // bottom-left corner
      F: { x: 920, y: 315 },  // end
    };
    const rad = 40;

    // Node placement on the road (per your reference layout)
    const pts = {
      milk:      { x: road.A.x,                         y: road.A.y },        // start of the journey
      receiving: { x: Math.round((road.A.x + road.B.x) / 2), y: road.A.y },    // middle of first straight
      vas:       { x: Math.round((road.C.x + road.D.x) / 2), y: road.C.y },    // middle of second straight
      intl:      { x: Math.round((road.D.x + rad + road.F.x) / 2), y: road.E.y }, // middle of third straight
      lastmile:  { x: road.F.x,                         y: road.F.y },        // end point
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
      segs += `<path d="${d}" fill="none" stroke="${segStroke(nb.level, nb.upcoming)}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" />`;
    }

    // Ghost/base road behind colored segments (thicker, subtle)
    const baseRoad = `<path d="${roadPath}" fill="none" stroke="rgba(148,163,184,0.45)" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" />`;

    // Center dashed line
    const dashed = `<path d="${roadPath}" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="2.5" stroke-dasharray="7 7" stroke-linecap="round" stroke-linejoin="round" />`;

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
      const nameY = p.y - 34;

      const st = statusText(n);
      const stLevel = statusLevel(n);
      const stBg = matte(levelColor(stLevel), 0.14);
      const stFg = matte(levelColor(stLevel), 0.92);

      // Status pill below icon
      const pillW = Math.max(58, 14 + (String(st).length * 7));
      const pillH = 18;
      const pillY = p.y + 22;
      const pillX = p.x - (pillW / 2);
      const pillTextX = p.x;


      milestones += `
        <g class="flow-journey-hit" data-node="${id}" data-journey-node="${id}">
          <circle cx="${p.x}" cy="${p.y}" r="24" fill="white" stroke="${ring}" stroke-width="${isOngoing ? 2 : 1.2}"></circle>
          ${icon ? `<g transform="translate(${p.x - 13},${p.y - 13})">${icon}</g>` :
                   `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="rgba(55,65,81,0.75)">${n.short}</text>`}
          <text x="${labelX}" y="${nameY}" text-anchor="${labelAnchor}" font-size="12" font-weight="700" fill="rgba(17,24,39,0.70)">${n.label}</text>
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
        <svg viewBox="0 0 1000 380" preserveAspectRatio="xMidYMid meet" aria-label="Journey map" style="height:320px; width:100%;">

          <!-- road shadow (subtle) -->
          <path d="${roadPath}" fill="none" stroke="rgba(148,163,184,0.25)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" transform="translate(2,3)"></path>
          <!-- road base -->
          <path d="${roadPath}" fill="none" stroke="rgba(148,163,184,0.45)" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" />
          <path d="${roadPath}" fill="none" stroke="rgba(107,114,128,0.20)" stroke-width="36" stroke-linecap="round" stroke-linejoin="round" />
          ${baseRoad}
          ${segs}
          ${dashed}
          ${milestones}
          ${ongoing}
        </svg>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
        ${stat('Receiving', recA, recB, nodes[1])}
        ${stat('VAS applied', vasA, vasB, nodes[2])}
        ${stat('Transit & Clearing', intlA, intlB, nodes[3])}
        ${stat('Last Mile', lmA, lmB, nodes[4])}
      </div>
    `;

    // Click handlers (use existing selection + detail render; never assume)
    try {
      root.querySelectorAll('[data-journey-node]').forEach(el => {
        el.addEventListener('click', () => {
          const node = el.getAttribute('data-node');
          UI.selection = { node, sub: null };
          renderDetail(ws, tz, receiving, vas, intl, manual);
          highlightSelection();
        });
      });
    } catch {}
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
    ];
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
  const title = sel.sub === 'late' ? 'Receiving • Late POs' : sel.sub === 'missing' ? 'Receiving • Missing POs' : 'Receiving';
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
    .map(s => [
      s.supplier,
      `${s.receivedPOs}/${s.poCount}`,
      `${Math.round(s.units)}`,
      `${s.cartonsIn || 0}`,
      `${s.cartonsOut || 0}`,
    ]);

  detail.innerHTML = [
    header(title, receiving.level, subtitle),
    bullets(insights),
    kpis,
    table(['Supplier', 'POs received', 'Planned units', 'Cartons In', 'Cartons Out'], supRows),
  ].join('');
  return;
}

if (sel.node === 'vas') {
      const subtitle = `Due ${fmtInTZ(vas.due, tz)} • Planned ${vas.plannedUnits} units • Applied ${vas.appliedUnits} units`;
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
const supRows = (vas.supplierRows || []).slice(0, 12).map(x => [x.supplier, fmtN(x.planned), fmtN(x.applied), `${x.pct}%`]);


      detail.innerHTML = [
        header('VAS Processing', vas.level, subtitle),
        bullets(insights),
        `<div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div class="rounded-xl border p-3">
            <div class="text-sm font-semibold text-gray-700">Suppliers (planned vs applied)</div>
            ${table(['Supplier', 'Planned', 'Applied', '%'], supRows)}
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
      const subtitle = `Origin ready window ${fmtInTZ(intl.originMin, tz)} – ${fmtInTZ(intl.originMax, tz)}`;
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
          `<button class="text-left hover:underline" data-lane="${escapeAttr(l.key)}">${escapeHtml(l.supplier)}</button>`,
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

      detail.innerHTML = [
        header('Transit & Clearing', intl.level, subtitle),
        bullets(insights),
        kpis,
        `<div class="mt-3 rounded-xl border p-3">
          <div class="text-sm font-semibold text-gray-700">Lanes</div>
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
            <div class="text-sm font-semibold">${contRows.filter(r => !r.delivery_local).length}</div>
          </div>
        </div>
      `;

      const rows = contRows.map(r => {
        const st = r.delivery_local ? `<span class="text-xs px-2 py-0.5 rounded-full border ${pill('green')} whitespace-nowrap">Scheduled</span>`
                                 : `<span class="text-xs px-2 py-0.5 rounded-full border ${pill('yellow')} whitespace-nowrap">Open</span>`;
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
            : `<button data-lm-deliver="1" data-ws="${escapeAttr(ws)}" data-cont="${escapeAttr(r.key)}" data-uid="${escapeAttr(r.uid)}" class="px-2 py-1 rounded-lg text-xs border bg-emerald-50 hover:bg-emerald-100">Receive</button>`,
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
            <span class="dot ${dot(lane.level)}"></span>
            <span class="text-xs px-2 py-0.5 rounded-full border ${pill(lane.level)} whitespace-nowrap">${statusLabel(lane.level)}</span>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
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
                <div class="text-xs text-gray-500 mb-1">Origin customs cleared</div>
                <input id="flow-intl-originclr" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${originClr}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${baseOriginClr}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-originclr" data-val="${baseOriginClr}">Copy</button>
                </div>
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
                <div class="text-xs text-gray-500 mb-1">Arrived destination</div>
                <input id="flow-intl-arrived" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${arrived}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${baseArrived}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-arrived" data-val="${baseArrived}">Copy</button>
                </div>
              </label>
              <label class="text-sm">
                <div class="text-xs text-gray-500 mb-1">Destination customs cleared</div>
                <input id="flow-intl-destclr" type="datetime-local" class="w-full px-2 py-1.5 border rounded-lg" value="${destClr}"/>
                <div class="mt-1 text-[11px] text-gray-500 flex items-center justify-between gap-2">
                  <span>Baseline: <span class="font-mono">${baseDestClr}</span></span>
                  <button type="button" class="flow-intl-copy text-[11px] underline hover:text-gray-700" data-target="flow-intl-destclr" data-val="${baseDestClr}">Copy</button>
                </div>
              </label>
            </div>

            <div class="flex items-center gap-3 mt-3">
              <label class="text-sm flex items-center gap-2">
                <input id="flow-intl-hold" type="checkbox" class="h-4 w-4" ${hold ? 'checked' : ''}/>
                <span>Customs hold</span>
              </label>
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
    `;
  }

  function wireIntlDetail(ws, selectedKey) {
    // lane row clicks
    const detail = document.getElementById('flow-detail');
    if (!detail) return;

    detail.querySelectorAll('[data-lane]').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        const k = btn.getAttribute('data-lane');
        UI.selection = { node: 'intl', sub: k };
        refresh();
      });
    });



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

        const hold = !!detail.querySelector('#flow-intl-hold')?.checked;
        const note = detail.querySelector('#flow-intl-note')?.value || '';
        const obj = {
          packing_list_ready_at: safeISO(pack),
          origin_customs_cleared_at: safeISO(originClr),
          departed_at: safeISO(departed),
          arrived_at: safeISO(arrived),
          dest_customs_cleared_at: safeISO(destClr),
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
    const deliveredAt = r.delivery_local ? String(r.delivery_local).replace('T',' ') : '';
    const note = String(r.note || '');
    const canReceive = !r.delivery_local;

    return `
      <div class="mt-3 rounded-xl border p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold text-gray-700">Selected container</div>
            <div class="text-xs text-gray-500 mt-0.5">${escapeHtml(r.container_id || '—')} • ${escapeHtml(r.vessel || '—')}</div>
          </div>
          <div class="text-xs ${canReceive ? 'text-amber-700' : 'text-emerald-700'}">${canReceive ? 'Open' : 'Complete'}</div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-sm">
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">Delivered at</div>
            <div class="font-medium">${deliveredAt ? escapeHtml(deliveredAt) : '<span class="text-gray-400">—</span>'}</div>
          </div>
          <div class="rounded-lg border p-2">
            <div class="text-[11px] text-gray-500">POD</div>
            <div class="font-medium">${r.pod_received ? 'Yes' : (canReceive ? '<span class="text-gray-400">—</span>' : 'No')}</div>
          </div>
        </div>

        <label class="text-sm mt-3 block">
          <div class="text-xs text-gray-500 mb-1">Note (optional)</div>
          <textarea id="flow-lm-note" rows="2" class="w-full px-2 py-1.5 border rounded-lg" placeholder="Quick update for the team...">${escapeHtml(note)}</textarea>
        </label>

        <div class="flex items-center justify-between mt-3">
          <div id="flow-lm-save-msg" class="text-xs text-gray-500"></div>
          <div class="flex items-center gap-2">
            ${canReceive ? `
              <button data-lm-deliver="1"
                data-ws="${escapeAttr(ws)}"
                data-cont="${escapeAttr(r.key)}"
                data-uid="${escapeAttr(r.uid)}"
                class="px-3 py-1.5 rounded-lg text-sm border bg-emerald-50 hover:bg-emerald-100">Receive (now)</button>
            ` : `
              <button disabled class="px-3 py-1.5 rounded-lg text-sm border bg-gray-50 text-gray-400 cursor-not-allowed">Received</button>
            `}
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

    // container row clicks (selection)
    detail.querySelectorAll('[data-cont]').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const k = btn.getAttribute('data-cont');
        UI.selection = { node: 'lastmile', sub: k };
        refresh();
      });
    });

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
          delivery_local: now,
          pod_received: true,
          last_mile_note: note,
          _updatedAt: new Date().toISOString(),
        };
        saveLastMileReceipts(wsNow, receipts);

        if (msg) { msg.textContent = 'Received ✓'; msg.className = 'text-xs text-emerald-700'; }

        // Keep selection on the same container and do a full deterministic re-render.
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
          if (msg) { msg.textContent = 'Save failed: missing container uid'; msg.className = 'text-xs text-red-600'; }
          return;
        }

        const receipts = loadLastMileReceipts(wsNow);
        receipts[uid] = {
          ...(receipts[uid] || {}),
          last_mile_note: note,
          _updatedAt: new Date().toISOString(),
        };
        saveLastMileReceipts(wsNow, receipts);

        if (msg) { msg.textContent = 'Note saved ✓'; msg.className = 'text-xs text-emerald-700'; }

        UI.selection = { node: 'lastmile', sub: contKey };
        refresh();
      });
    };

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
    // Some builds call renderFooterTrends(weekKey, tz, records, receiving, vas, intl, lm).
    if (typeof el === 'string') {
      const wk = el;
      const receiving = arguments[3] || null;
      const vas = arguments[4] || null;
      const intl = arguments[5] || null;
      const lm = arguments[6] || null;

      const footerEl = document.getElementById('vo-footer');
      const n = [
        { id: 'receiving', label: 'Receiving', color: (receiving && receiving.color) || '#10b981' },
        { id: 'vas', label: 'VAS', color: (vas && vas.color) || '#10b981' },
        { id: 'intl', label: 'Transit', color: (intl && intl.color) || '#10b981' },
        { id: 'lm', label: 'Last Mile', color: (lm && lm.color) || '#10b981' },
      ];
      return renderFooterTrends(footerEl, n, wk);
    }

    // Normal signature: (el: HTMLElement, nodes: [{label,color}], weekKey: string)
    if (!el || typeof el !== 'object' || typeof el.innerHTML === 'undefined') return;

    const applied = (typeof getAppliedThisWeek === 'function') ? getAppliedThisWeek(weekKey) : 0;
    const worst = (Array.isArray(nodes) && nodes.length)
      ? nodes.reduce((acc, n) => severityRank(n.color) > severityRank(acc.color) ? n : acc, nodes[0])
      : { label: 'Health', color: '#10b981' };

    const pill = (colorToStatus(worst.color) || 'On Track');
    el.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
              style="background:${statusBg(worst.color)}; border-color:${statusStroke(worst.color)};">
          <span class="inline-block h-2 w-2 rounded-full" style="background:${worst.color};"></span>
          <span class="font-semibold">Health:</span>
          <span>${pill}</span>
        </span>
        <span class="text-xs text-gray-700">Applied this week: <span class="font-semibold">${fmtInt(applied)}</span></span>
      </div>
    `;
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
    const ws = cache?.ws || '';
    const tz = cache?.tz || getBizTZ();
    const receiving = cache?.receiving || {};
    const vas = cache?.vas || {};
    const intl = cache?.intl || {};
    const manual = cache?.manual || {};

    const suppliers = Array.isArray(receiving.suppliers) ? receiving.suppliers : [];

    const execRows = [
      ['Week', escHtml(String(ws))],
      ['Receiving', `${escHtml(pct(receiving.receivedPOs, receiving.plannedPOs))} (${escHtml(receiving.receivedPOs)}/${escHtml(receiving.plannedPOs)} POs)`],
      ['Cartons out', escHtml(receiving.cartonsOutTotal ?? 0)],
      ['VAS applied', `${escHtml(pct(vas.appliedUnits, vas.plannedUnits))} (${escHtml(vas.appliedUnits ?? 0)}/${escHtml(vas.plannedUnits ?? 0)} units)`],
      ['Transit lanes', escHtml(intl.lanesTotal ?? (manual?.intl?.lanes ?? 0) ?? 0)],
      ['Docs missing', escHtml(intl.docsMissing ?? (manual?.intl?.docsMissing ?? 0) ?? 0)],
      ['Last Mile open', `${escHtml(manual?.lastmile?.open ?? manual?.lastMile?.open ?? 0)}/${escHtml(manual?.lastmile?.total ?? manual?.lastMile?.total ?? 0)}`],
    ];

    const supplierTable = suppliers.length ? `
      <table>
        <thead>
          <tr><th>Supplier</th><th>POs received</th><th>Planned units</th><th>Cartons in</th><th>Cartons out</th></tr>
        </thead>
        <tbody>
          ${suppliers.map(s => `
            <tr>
              <td>${escHtml(s.supplier)}</td>
              <td>${escHtml(s.receivedPOs)}/${escHtml(s.poCount)}</td>
              <td>${escHtml(s.units)}</td>
              <td>${escHtml(s.cartonsIn)}</td>
              <td>${escHtml(s.cartonsOut)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : `<div class="muted">No supplier breakdown available for this week.</div>`;

    const nodePage = (title, bodyHtml) => `
      <section class="page">
        <div class="hdr">
          <div class="h1">${escHtml(title)}</div>
          <div class="muted">Week start: ${escHtml(ws)} • Generated: ${escHtml(new Date().toLocaleString())}</div>
        </div>
        ${bodyHtml}
      </section>
    `;

    const execPage = `
      <section class="page">
        <div class="hdr">
          <div class="h1">Flow — Executive summary</div>
          <div class="muted">${escHtml(weekRangeText(ws, tz))} • Week start: ${escHtml(ws)}</div>
        </div>

        <div class="grid2">
          ${execRows.map(([k,v]) => `<div class="kv"><div class="k">${escHtml(k)}</div><div class="v">${v}</div></div>`).join('')}
        </div>

        <div class="spacer"></div>
        <div class="h2">Notes</div>
        <div class="muted">Ongoing state is based on the current process node (not date math).</div>
      </section>
    `;

    const receivingPage = nodePage('Receiving', `
      <div class="grid2">
        <div class="kv"><div class="k">Due</div><div class="v">${escHtml(fmtDateLocal(receiving.due, tz))}</div></div>
        <div class="kv"><div class="k">Last received</div><div class="v">${escHtml(fmtDateLocal(receiving.lastReceived, tz))}</div></div>
        <div class="kv"><div class="k">POs received</div><div class="v">${escHtml(receiving.receivedPOs)}/${escHtml(receiving.plannedPOs)}</div></div>
        <div class="kv"><div class="k">Late POs</div><div class="v">${escHtml(receiving.latePOs ?? 0)}</div></div>
        <div class="kv"><div class="k">Cartons in</div><div class="v">${escHtml(receiving.cartonsInTotal ?? 0)}</div></div>
        <div class="kv"><div class="k">Cartons out</div><div class="v">${escHtml(receiving.cartonsOutTotal ?? 0)}</div></div>
      </div>
      <div class="spacer"></div>
      <div class="h2">Supplier breakdown</div>
      ${supplierTable}
    `);

    const vasPage = nodePage('VAS Processing', `
      <div class="grid2">
        <div class="kv"><div class="k">Due</div><div class="v">${escHtml(fmtDateLocal(vas.due, tz))}</div></div>
        <div class="kv"><div class="k">Applied</div><div class="v">${escHtml(vas.appliedUnits ?? 0)} / ${escHtml(vas.plannedUnits ?? 0)} units (${escHtml(pct(vas.appliedUnits, vas.plannedUnits))})</div></div>
        <div class="kv"><div class="k">Completion</div><div class="v">${escHtml(pct(vas.completedPOs, vas.plannedPOs))} (${escHtml(vas.completedPOs ?? 0)}/${escHtml(vas.plannedPOs ?? 0)} POs)</div></div>
      </div>
      <div class="spacer"></div>
      <div class="muted">Source: completed production records aggregated for the selected week.</div>
    `);

    const intlPage = nodePage('Transit & Clearing', `
      <div class="grid2">
        <div class="kv"><div class="k">Origin window</div><div class="v">${escHtml(intl.windowText ?? '—')}</div></div>
        <div class="kv"><div class="k">Lanes</div><div class="v">${escHtml(intl.lanesTotal ?? 0)}</div></div>
        <div class="kv"><div class="k">Mode split</div><div class="v">${escHtml(intl.modeText ?? '—')}</div></div>
        <div class="kv"><div class="k">Docs missing</div><div class="v">${escHtml(intl.docsMissing ?? 0)}</div></div>
        <div class="kv"><div class="k">Holds</div><div class="v">${escHtml(intl.holds ?? 0)}</div></div>
      </div>
      <div class="spacer"></div>
      <div class="muted">International Transit is lightweight manual data stored locally per week (unless data-driven fields are present).</div>
    `);

    const lm = manual?.lastmile || manual?.lastMile || {};
    const lastMilePage = nodePage('Last Mile', `
      <div class="grid2">
        <div class="kv"><div class="k">Delivery window</div><div class="v">${escHtml((intl && intl.lastMileWindowText) || lm.windowText || '—')}</div></div>
        <div class="kv"><div class="k">Open</div><div class="v">${escHtml(lm.open ?? 0)}</div></div>
        <div class="kv"><div class="k">Total</div><div class="v">${escHtml(lm.total ?? 0)}</div></div>
        <div class="kv"><div class="k">Status</div><div class="v">${escHtml(lm.statusText || '—')}</div></div>
      </div>
      <div class="spacer"></div>
      <div class="muted">Last Mile is lightweight manual data stored locally per week.</div>
    `);

    const style = `
      <style>
        :root { color-scheme: light; }
        body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; padding: 0; color: #111827; }
        .page { padding: 24px 28px; page-break-after: always; }
        .page:last-child { page-break-after: auto; }
        .hdr { margin-bottom: 14px; }
        .h1 { font-size: 18px; font-weight: 700; }
        .h2 { font-size: 13px; font-weight: 700; margin: 10px 0 8px; }
        .muted { color: rgba(17,24,39,0.65); font-size: 11px; }
        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .kv { border: 1px solid rgba(17,24,39,0.10); border-radius: 10px; padding: 10px; }
        .k { font-size: 10px; color: rgba(17,24,39,0.60); margin-bottom: 4px; }
        .v { font-size: 12px; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(17,24,39,0.10); }
        th { font-size: 10px; color: rgba(17,24,39,0.60); font-weight: 700; }
        .spacer { height: 10px; }
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      </style>
    `;

    return `<!doctype html><html><head><meta charset="utf-8">${style}<title>Flow report</title></head><body>
      ${execPage}
      ${receivingPage}
      ${vasPage}
      ${intlPage}
      ${lastMilePage}
    </body></html>`;
  }

  function downloadFlowReportPdf(cache) {
    try {
      const html = buildReportHTML(cache || {});
      const w = window.open('', '_blank');
      if (!w) return;
      w.document.open();
      w.document.write(html);
      w.document.close();
      // Give the browser a moment to render before printing.
      w.focus();
      setTimeout(() => {
        try { w.print(); } catch(e) {}
      }, 250);
    } catch (e) {
      console.warn('[flow] report build failed', e);
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
    } catch (e) {
      console.warn('[flow] load error', e);
    }

    const receiving = computeReceivingStatus(ws, tz, planRows, receivingRows, records);
    const vas = computeVASStatus(ws, tz, planRows, records);
    const intl = computeInternationalTransit(ws, tz, planRows, records, vas.due);
    const manual = computeManualNodeStatuses(ws, tz);

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
    // Footer trend uses the same completed records dataset.
    renderFooterTrends(ws, tz, Array.isArray(records) ? records : (records?.records || records?.rows || records?.data || []), receiving, vas, intl, manual);
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
