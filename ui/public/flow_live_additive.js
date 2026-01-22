/* flow_live_additive.js (v1)
   - Additive "Flow" page module for VelOzity Pinpoint
   - Receiving + VAS are data-driven from existing endpoints
   - International Transit + Last Mile are lightweight manual (localStorage)
   - Milk Run is future (greyed)
*/

(function () {
  'use strict';

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

  // Format in business TZ with Intl (avoid heavy libs)
  function fmtInTZ(date, tz) {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(date);
    } catch {
      return date.toISOString();
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

  function pill(level) {
    if (level === 'green') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    if (level === 'yellow') return 'bg-amber-100 text-amber-800 border-amber-200';
    if (level === 'red') return 'bg-rose-100 text-rose-800 border-rose-200';
    return 'bg-gray-100 text-gray-700 border-gray-200';
  }

  function dot(level) {
    if (level === 'green') return 'bg-emerald-500';
    if (level === 'yellow') return 'bg-amber-500';
    if (level === 'red') return 'bg-rose-500';
    return 'bg-gray-400';
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

  // ------------------------- Data fetch (reusing existing endpoints) -------------------------
  async function loadPlan(ws) {
    // Prefer window.state.plan if it matches current ws
    const s = window.state || {};
    if (s.weekStart === ws && Array.isArray(s.plan) && s.plan.length) return s.plan;
    // Fallback to backend endpoints used elsewhere
    try { return await api(`/plan?weekStart=${encodeURIComponent(ws)}`); } catch {}
    try { return await api(`/plan/weeks/${encodeURIComponent(ws)}`); } catch {}
    return [];
  }

  async function loadReceiving(ws) {
    // Receiving module uses /receiving?weekStart=... and /receiving/weeks/:ws for saves.
    try { return await api(`/receiving?weekStart=${encodeURIComponent(ws)}`); } catch {}
    try { return await api(`/receiving/weeks/${encodeURIComponent(ws)}`); } catch {}
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
    try { return await api(`/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=complete`); } catch {}
    try { return await api(`/records?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); } catch {}
    return [];
  }

  // ------------------------- Computations -------------------------
  function normalizeSupplier(x) {
    return String(x || '').trim() || 'Unknown';
  }

  function getPlanUnits(planRows) {
    // common fields seen in codebase: planned_qty, qty, units
    return (planRows || []).reduce((acc, r) => {
      const n = Number(r.planned_qty ?? r.qty ?? r.units ?? r.quantity ?? 0);
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  function groupPlanBySupplier(planRows) {
    const m = new Map();
    for (const r of planRows || []) {
      const sup = normalizeSupplier(r.supplier_name || r.supplier || r.vendor);
      const po = String(r.po_number || r.po || '').trim();
      const units = Number(r.planned_qty ?? r.qty ?? r.units ?? r.quantity ?? 0) || 0;
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

  function computeReceivingStatus(ws, tz, planRows, receivingRows) {
    const now = new Date();
    const due = makeBizLocalDate(ws, BASELINE.receiving_due.time, tz); // Monday noon
    const byPO = receivingByPO(receivingRows);

    const plannedPOs = uniq((planRows || []).map(r => String(r.po_number || r.po || '').trim()));
    const receivedPOs = plannedPOs.filter(po => {
      const rec = byPO.get(po);
      return !!(rec && (rec.received_at_utc || rec.received_at || rec.received_at_local));
    });

    // Determine "last received" timestamp among planned POs
    let lastReceived = null;
    for (const po of receivedPOs) {
      const rec = byPO.get(po);
      const ts = rec?.received_at_utc || rec?.received_at;
      const d = ts ? new Date(ts) : null;
      if (d && !isNaN(d) && (!lastReceived || d > lastReceived)) lastReceived = d;
    }

    const st = statusFromDue(due, lastReceived, now);

    // Supplier breakdown (planned vs received)
    const planBySup = groupPlanBySupplier(planRows);
    const recSupSet = new Set((receivingRows || []).map(r => normalizeSupplier(r.supplier_name || r.supplier || r.vendor)));
    const suppliers = planBySup.map(x => {
      // count received POs per supplier
      const pos = uniq((planRows || []).filter(r => normalizeSupplier(r.supplier_name || r.supplier || r.vendor) === x.supplier)
        .map(r => String(r.po_number || r.po || '').trim()));
      const received = pos.filter(po => {
        const rec = byPO.get(po);
        return !!(rec && (rec.received_at_utc || rec.received_at));
      }).length;
      return {
        supplier: x.supplier,
        poCount: x.poCount,
        receivedPOs: received,
        units: x.units,
      };
    });

    const latePOs = plannedPOs.filter(po => {
      const rec = byPO.get(po);
      const ts = rec?.received_at_utc || rec?.received_at;
      if (!ts) return false;
      const d = new Date(ts);
      return !isNaN(d) && d.getTime() > due.getTime();
    });

    const missingPOs = plannedPOs.filter(po => !receivedPOs.includes(po));

    return {
      due,
      lastReceived,
      level: st.level,
      plannedPOs: plannedPOs.length,
      receivedPOs: receivedPOs.length,
      latePOs: latePOs.length,
      missingPOs: missingPOs.length,
      suppliers,
      latePOList: latePOs,
      missingPOList: missingPOs,
    };
  }

  function computeVASStatus(ws, tz, planRows, records) {
    const now = new Date();
    const due = makeBizLocalDate(isoDate(addDays(new Date(`${ws}T00:00:00Z`), BASELINE.vas_complete_due.dayOffset)), BASELINE.vas_complete_due.time, tz);

    const plannedUnits = getPlanUnits(planRows);
    const plannedPOs = uniq((planRows || []).map(r => String(r.po_number || r.po || '').trim())).length;

    // Build PO -> supplier + planned units index from plan.
    const poToSup = new Map();
    const plannedBySup = new Map();
    const plannedByPO = new Map();
    for (const r of planRows || []) {
      const po = String(r.po_number || r.po || '').trim();
      if (!po) continue;
      const sup = normalizeSupplier(r.supplier_name || r.supplier || r.vendor);
      poToSup.set(po, sup);
      const u = Number(r.target_qty ?? r.planned_qty ?? r.qty ?? r.units ?? r.quantity ?? 0) || 0;
      plannedBySup.set(sup, (plannedBySup.get(sup) || 0) + u);
      plannedByPO.set(po, (plannedByPO.get(po) || 0) + u);
    }

    // Records: count applied units and attribute to supplier via plan (fallback to record fields).
    let appliedUnits = 0;
    const appliedBySup = new Map();
    const appliedByPO = new Map();

    for (const r of records || []) {
      const qty = Number(r.qty ?? r.quantity ?? r.units ?? 1);
      const n = Number.isFinite(qty) && qty > 0 ? qty : 1;
      appliedUnits += n;

      const po = String(r.po_number || r.po || '').trim() || 'Unknown';
      const sup = poToSup.get(po) || normalizeSupplier(r.supplier_name || r.supplier || r.vendor);
      appliedBySup.set(sup, (appliedBySup.get(sup) || 0) + n);
      if (po && po !== 'Unknown') appliedByPO.set(po, (appliedByPO.get(po) || 0) + n);
    }

    const completion = plannedUnits > 0 ? appliedUnits / plannedUnits : 0;
    // Soft status: compare "completion" vs time elapsed; if past due, red; if close, yellow.
    const st = statusFromDue(due, completion >= 0.98 ? due : null, now); // if near complete, treat as on-time
    // If we're before due but completion is very low, show yellow.
    let level = st.level;
    const untilDueDays = daysBetween(now, due);
    if (untilDueDays > 0 && completion < 0.5 && untilDueDays < 2) level = 'yellow';
    if (untilDueDays <= 0 && completion < 0.9) level = 'red';

    // Supplier rollup should include suppliers with planned units even if applied is 0.
    const suppliers = Array.from(new Set([
      ...plannedBySup.keys(),
      ...appliedBySup.keys(),
    ])).map((supplier) => {
      const planned = plannedBySup.get(supplier) || 0;
      const applied = appliedBySup.get(supplier) || 0;
      const pct = planned > 0 ? applied / planned : 0;
      return {
        supplier,
        planned,
        applied,
        pct,
        remaining: Math.max(0, planned - applied),
      };
    });

    // Top suppliers (for quick view): sort by remaining work, then planned.
    const topSup = suppliers
      .slice()
      .sort((a, b) => (b.remaining - a.remaining) || (b.planned - a.planned))
      .slice(0, 12);

    const topPO = Array.from(new Set([
      ...plannedByPO.keys(),
      ...appliedByPO.keys(),
    ])).map((po) => {
      const planned = plannedByPO.get(po) || 0;
      const applied = appliedByPO.get(po) || 0;
      const pct = planned > 0 ? applied / planned : 0;
      return { po, planned, applied, pct, remaining: Math.max(0, planned - applied) };
    })
      .filter(x => x.po)
      .sort((a, b) => (b.remaining - a.remaining) || (b.planned - a.planned))
      .slice(0, 12);

    return {
      due,
      level,
      plannedUnits,
      appliedUnits,
      plannedPOs,
      completion,
      suppliers,
      topSup,
      topPO,
    };
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
          <button id="flow-reset" class="px-3 py-1.5 rounded-lg text-sm border bg-white hover:bg-gray-50">Reset view</button>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <!-- Top tile -->
        <div class="rounded-2xl border bg-white shadow-sm p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-semibold text-gray-700">End-to-end nodes</div>
            <div id="flow-day" class="text-xs text-gray-500"></div>
          </div>
          <div id="flow-nodes" class="grid grid-cols-1 md:grid-cols-5 gap-2"></div>
        </div>

        <!-- Bottom tile -->
        <div class="rounded-2xl border bg-white shadow-sm p-3 min-h-[320px]">
          <div id="flow-detail" class="h-full"></div>
        </div>
      </div>

      <div class="mt-3 text-xs text-gray-500">
        Baseline is editable in <code>flow_live_additive.js</code>. Receiving + VAS are data-driven; International Transit + Last Mile are lightweight manual (stored locally per week).
      </div>
    `;
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

  function nodeCard({ id, title, subtitle, level, badges = [], disabled = false }) {
    const dis = disabled ? 'opacity-50 pointer-events-none' : '';
    const badgeHtml = badges.map(b => {
      const cls = b.level ? pill(b.level) : 'bg-gray-100 text-gray-700 border-gray-200';
      return `<button data-sub="${b.sub || ''}" class="text-xs px-2 py-0.5 rounded-full border ${cls} hover:opacity-95">${b.label}</button>`;
    }).join(' ');
    return `
      <div data-node="${id}" class="rounded-xl border p-3 hover:bg-gray-50 cursor-pointer ${dis}">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="text-sm font-semibold">${title}</div>
            <div class="text-xs text-gray-500 mt-0.5">${subtitle || ''}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="dot ${dot(level)}"></span>
            <span class="text-xs px-2 py-0.5 rounded-full border ${pill(level)} whitespace-nowrap">${statusLabel(level)}</span>
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

  function renderTopNodes(ws, tz, receiving, vas, manual) {
    const nodes = document.getElementById('flow-nodes');
    if (!nodes) return;

    const milk = nodeCard({
      id: 'milk',
      title: 'Milk Run',
      subtitle: 'Future expansion',
      level: 'gray',
      badges: [],
      disabled: true,
    });

    const recBadges = [
      { label: `${receiving.receivedPOs}/${receiving.plannedPOs} received`, sub: 'summary' },
      receiving.latePOs ? { label: `${receiving.latePOs} late`, level: 'yellow', sub: 'late' } : null,
      receiving.missingPOs ? { label: `${receiving.missingPOs} missing`, level: 'red', sub: 'missing' } : null,
    ].filter(Boolean);

    const rec = nodeCard({
      id: 'receiving',
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
      title: 'VAS Processing',
      subtitle: `Due ${fmtInTZ(vas.due, tz)}`,
      level: vas.level,
      badges: vasBadges,
    });

    const intlBadges = [
      { label: `${manual.intlMode}`, sub: 'mode' },
      manual.manual?.customs_hold ? { label: 'Customs hold', level: 'red', sub: 'hold' } : null,
      manual.manual?.origin_ready_at ? { label: 'Origin ready set', sub: 'origin' } : { label: 'Origin ready (set)', sub: 'origin' },
    ].filter(Boolean);
    const intlCard = nodeCard({
      id: 'intl',
      title: 'International Transit',
      subtitle: `Origin window ${fmtInTZ(manual.baselines.originMin, tz)} – ${fmtInTZ(manual.baselines.originMax, tz)}`,
      level: manual.levels.intl,
      badges: intlBadges,
    });

    const lmBadges = [
      manual.manual?.last_mile_issue ? { label: 'Issue', level: 'red', sub: 'issue' } : null,
      manual.manual?.delivered_at ? { label: 'Delivered set', sub: 'delivered' } : { label: 'Delivered (set)', sub: 'delivered' },
    ].filter(Boolean);
    const lmCard = nodeCard({
      id: 'lastmile',
      title: 'Last Mile',
      subtitle: `Window ${fmtInTZ(manual.baselines.lastMileMin, tz)} – ${fmtInTZ(manual.baselines.lastMileMax, tz)}`,
      level: manual.levels.lastMile,
      badges: lmBadges,
    });

    nodes.innerHTML = [milk, rec, vasCard, intlCard, lmCard].join('');

    // Click handlers
    $$('#flow-nodes [data-node]').forEach(card => {
      card.addEventListener('click', (e) => {
        const node = card.getAttribute('data-node');
        const btn = e.target.closest('button[data-sub]');
        const sub = btn ? (btn.getAttribute('data-sub') || null) : null;
        UI.selection = { node, sub };
        renderDetail(ws, tz, receiving, vas, manual);
        highlightSelection();
      });
    });
  }

  function highlightSelection() {
    const { node } = UI.selection;
    $$('#flow-nodes [data-node]').forEach(el => {
      if (el.getAttribute('data-node') === node) el.classList.add('ring-2', 'ring-[#990033]');
      else el.classList.remove('ring-2', 'ring-[#990033]');
    });
  }

  function renderDetail(ws, tz, receiving, vas, manual) {
    const detail = document.getElementById('flow-detail');
    if (!detail) return;

    const now = new Date();
    const sel = UI.selection;

    function header(title, level, subtitle) {
      return `
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-semibold">${title}</div>
            <div class="text-sm text-gray-500 mt-0.5">${subtitle || ''}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="dot ${dot(level)}"></span>
            <span class="text-xs px-2 py-0.5 rounded-full border ${pill(level)} whitespace-nowrap">${statusLabel(level)}</span>
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

      const rows = (sel.sub === 'late' ? receiving.latePOList : sel.sub === 'missing' ? receiving.missingPOList : [])
        .slice(0, 50)
        .map(po => {
          const rec = receivingByPO(awaitingReceivingRowsCache)?.get(po); // placeholder
          return [po];
        });

      // Build supplier summary table
      const supRows = receiving.suppliers
        .sort((a, b) => (b.receivedPOs / (b.poCount || 1)) - (a.receivedPOs / (a.poCount || 1)))
        .slice(0, 30)
        .map(s => [
          s.supplier,
          `${s.receivedPOs}/${s.poCount}`,
          `${Math.round(s.units)}`,
        ]);

      detail.innerHTML = [
        header(title, receiving.level, subtitle),
        bullets(insights),
        table(['Supplier', 'POs received', 'Planned units'], supRows),
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

      // Suppliers: show planned + applied so you can see who is still outstanding (even with 0 applied)
      const supRows = (vas.topSup || []).map(x => {
        const pct = x.planned > 0 ? Math.round((x.applied / x.planned) * 100) : 0;
        return [
          x.supplier,
          `${Math.round(x.planned)}`,
          `${Math.round(x.applied)}`,
          `${pct}%`,
        ];
      });

      // POs: show planned + applied (top remaining)
      const poRows = (vas.topPO || []).map(x => {
        const pct = x.planned > 0 ? Math.round((x.applied / x.planned) * 100) : 0;
        return [x.po, `${Math.round(x.planned)}`, `${Math.round(x.applied)}`, `${pct}%`];
      });

      detail.innerHTML = [
        header('VAS Processing', vas.level, subtitle),
        bullets(insights),
        `<div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div class="rounded-xl border p-3">
            <div class="text-sm font-semibold text-gray-700">Top suppliers by remaining work</div>
            ${table(['Supplier', 'Planned', 'Applied', '%'], supRows)}
          </div>
          <div class="rounded-xl border p-3">
            <div class="text-sm font-semibold text-gray-700">Top POs by remaining work</div>
            ${table(['PO', 'Planned', 'Applied', '%'], poRows)}
          </div>
        </div>`,
      ].join('');
      return;
    }

    if (sel.node === 'intl') {
      const { baselines } = manual;
      const m = manual.manual || {};
      const subtitle = `Mode ${manual.intlMode} • Origin ready window ${fmtInTZ(baselines.originMin, tz)} – ${fmtInTZ(baselines.originMax, tz)}`;
      const insights = [
        m.customs_hold ? '<b>Customs hold</b> flagged (red).' : 'Soft cutoffs: use this as guidance, not enforcement.',
        m.origin_ready_at ? `Origin ready set: <b>${fmtInTZ(new Date(m.origin_ready_at), tz)}</b>` : 'Set an Origin Ready date to start the transit clock.',
        m.departed_at ? `Departed origin: <b>${fmtInTZ(new Date(m.departed_at), tz)}</b>` : `Baseline depart target: <b>${fmtInTZ(addDays(baselines.originMax, 1), tz)}</b>`,
      ];

      detail.innerHTML = [
        header('International Transit', manual.levels.intl, subtitle),
        bullets(insights),
        manualFormIntl(ws, tz, manual),
      ].join('');
      wireManualIntl(ws);
      return;
    }

    if (sel.node === 'lastmile') {
      const { baselines } = manual;
      const m = manual.manual || {};
      const subtitle = `Delivery window ${fmtInTZ(baselines.lastMileMin, tz)} – ${fmtInTZ(baselines.lastMileMax, tz)}`;
      const insights = [
        m.last_mile_issue ? '<b>Issue</b> flagged (red).' : 'Soft cutoffs: use this as guidance, not enforcement.',
        m.delivered_at ? `Delivered set: <b>${fmtInTZ(new Date(m.delivered_at), tz)}</b>` : 'Set Delivered date when WH confirms receipt.',
      ];

      detail.innerHTML = [
        header('Last Mile', manual.levels.lastMile, subtitle),
        bullets(insights),
        manualFormLastMile(ws, tz, manual),
      ].join('');
      wireManualLastMile(ws);
      return;
    }

    // default
    detail.innerHTML = header('Flow', 'gray', 'Click a node above to see details.');
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
  async function refresh() {
    const page = ensureFlowPageExists();
    injectSkeleton(page);

    // Cold-load safety: weekStart may not be initialized until other pages run.
    // Derive a sensible default (Monday) and, if possible, hydrate global state via setWeek().
    const tz = getBizTZ();
    const ws = (function getOrInitWeekStart() {
      const fromState = window.state?.weekStart;
      const fromInput = $('#week-start')?.value;
      if (fromState) return fromState;
      if (fromInput) return fromInput;
      // Default to the most recent Monday (UTC-based) in ISO.
      const now = new Date();
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const day = d.getUTCDay(); // 0=Sun .. 1=Mon
      const offset = (day === 0) ? 6 : (day - 1);
      d.setUTCDate(d.getUTCDate() - offset);
      const iso = isoDate(d);
      // Try to set the global week selector/state if available.
      try {
        const inp = $('#week-start');
        if (inp) inp.value = iso;
        if (typeof window.setWeek === 'function') window.setWeek(iso);
        if (window.state) window.state.weekStart = iso;
      } catch {}
      return iso;
    })();
    if (!ws) return;
    UI.currentWs = ws;

    setSubheader(ws);
    setDayProgress(ws, tz);

    const resetBtn = document.getElementById('flow-reset');
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = '1';
      resetBtn.onclick = () => {
        UI.selection = { node: 'receiving', sub: null };
        window.dispatchEvent(new Event('state:ready'));
      };
    }

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
    } catch (e) {
      console.warn('[flow] load error', e);
    }

    const receiving = computeReceivingStatus(ws, tz, planRows, receivingRows);
    const vas = computeVASStatus(ws, tz, planRows, records);
    const manual = computeManualNodeStatuses(ws, tz);

    renderTopNodes(ws, tz, receiving, vas, manual);
    // default selection if invalid
    if (!UI.selection?.node || UI.selection.node === 'milk') UI.selection = { node: 'receiving', sub: null };
    renderDetail(ws, tz, receiving, vas, manual);
    highlightSelection();
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

  // Cold-load: if user lands directly on #flow, render immediately.
  const initialHash = (location.hash || '').toLowerCase();
  if (initialHash === '#flow' || initialHash.startsWith('#flow')) {
    // Defer one tick so other scripts can attach week selector/state.
    setTimeout(() => refresh(), 0);
  }
})();
