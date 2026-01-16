/* receiving_live_additive.js (v8) - Receiving page (additive)
   - Loaded via <script src="/receiving_live_additive.js" defer></script> from index.html
   - Hash route: only controls UI when #receiving is active
   - Week binding: #week-start / window.state.weekStart
   - Loads plan + receiving rows for selected week
   - Batch receive: header "Received At" + "Receive Selected" applies timestamp to checked POs
   - Autosaves cartons/QC + facility per PO
   - Displays viewer-local time; SLA cutoff uses Asia/Shanghai Monday 12:00 (UTC+8)
*/

(function () {
  const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || '').replace(/\/$/, '');
  const BUSINESS_TZ = document.querySelector('meta[name="business-tz"]')?.content || 'Asia/Shanghai';
  const BUSINESS_UTC_OFFSET_HOURS = 8; // Asia/Shanghai is UTC+8, no DST

  function $(sel) { return document.querySelector(sel); }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function api(path, opts) {
    const url = API_BASE + path;
    const r = await fetch(url, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts || {}));
    if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
    return r.json();
  }

  function nowISO() { return new Date().toISOString(); }

  function fmtLocalFromUtc(isoUtc) {
    if (!isoUtc) return '';
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(d);
  }

  // Read the week currently selected by the app
  function getWeekStart() {
    const wsFromState = (window.state && window.state.weekStart) ? window.state.weekStart : '';
    const wsFromInput = $('#week-start') ? $('#week-start').value : '';
    return wsFromState || wsFromInput || '';
  }

  function addDaysISO(isoDate, days) {
    const d = new Date(isoDate + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return isoDate;
    d.setDate(d.getDate() + days);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function dtLocalNow() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function toDateTimeLocalValue(isoUtc) {
    // For <input type="datetime-local"> in viewer local time
    if (!isoUtc) return '';
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  function businessCutoffUtcISO(weekStartISO) {
    // Monday 12:00 in Asia/Shanghai => 04:00 UTC (same date) because UTC+8
    const hourUtc = 12 - BUSINESS_UTC_OFFSET_HOURS; // 4
    const hh = String(hourUtc).padStart(2, '0');
    return `${weekStartISO}T${hh}:00:00.000Z`;
  }

  // --- State cache for module ---
  const M = {
    ws: '',
    planRows: [],
    receivingRows: [],
    suppliers: [],
    selectedSupplier: '',
    // per-PO save debounce timers
    saveTimers: new Map()
  };

  // -------------------- Ticker (deduped, meaningful) --------------------
  let _tickerSeen = new Set();

  function resetTicker() {
    _tickerSeen = new Set();
    const el = document.getElementById('recv-ticker');
    if (el) el.innerHTML = '<div class="text-xs text-gray-400">No updates yet for this week.</div>';
  }

  function addTicker(msg, opts = {}) {
    const el = document.getElementById('recv-ticker');
    if (!el) return;

    const key = (opts.key || msg || '').trim();
    if (!key) return;
    if (_tickerSeen.has(key)) return;
    _tickerSeen.add(key);

    const ts = opts.ts ? new Date(opts.ts) : new Date();
    const when = new Intl.DateTimeFormat(undefined, {
      month: '2-digit', day: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    }).format(ts);

    const card = document.createElement('div');
    card.className = 'border rounded-xl p-3 bg-white';
    card.innerHTML = `<div class="text-xs text-gray-400 mb-1">${when}</div><div class="text-sm">${esc(msg)}</div>`;

    // If the placeholder exists, remove it before adding cards
    if (el.children.length === 1 && el.firstElementChild?.classList?.contains('text-gray-400')) {
      el.innerHTML = '';
    }

    el.prepend(card);

    while (el.children.length > 25) el.removeChild(el.lastChild);
  }

  function ensureReceivingPage() {
    let page = document.getElementById('page-receiving');
    if (page) return page;

    page = document.createElement('section');
    page.id = 'page-receiving';
    page.className = 'hidden';

    page.innerHTML = `
      <div class="vo-wrap">
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="text-xl font-semibold">Receiving</div>
            <div class="text-sm text-gray-500 flex items-center gap-2 flex-wrap">
              <span>Week:</span>
              <span id="recv-week-label">—</span>
              <button id="recv-prev-week" class="cmd cmd--ghost" title="Previous week">← Prev</button>
              <button id="recv-next-week" class="cmd cmd--ghost" title="Next week">Next →</button>
            </div>
          </div>
          <div class="text-xs text-gray-500">TZ: viewer local (business: ${esc(BUSINESS_TZ)})</div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <!-- Main -->
          <div class="lg:col-span-8 bg-white rounded-2xl border shadow p-4 min-w-0 flex flex-col" style="height: calc(100vh - 360px);">
            <div class="flex items-center gap-3 flex-wrap mb-3">
              <div class="text-base font-semibold">Supplier</div>
              <select id="recv-supplier" class="border rounded-md px-2 py-1 text-sm min-w-[280px]">
                <option value="">Loading…</option>
              </select>

              <div class="flex items-center gap-2 flex-wrap">
                <label class="text-sm text-gray-600">Received At</label>
                <input id="recv-batch-dt" type="datetime-local" class="border rounded-md px-2 py-1 text-sm" aria-label="Batch received at" />
                <button id="recv-batch-now" class="cmd cmd--ghost" title="Set to now">Now</button>
                <button id="recv-batch-receive" class="cmd cmd--ghost" style="border:1px solid #990033;color:#990033" title="Apply received time to selected POs">
                  Receive Selected
                </button>
              </div>

              <div class="text-sm text-gray-500">
                POs: <span class="font-semibold tabular-nums" id="recv-po-count">0</span>
                • Received: <span class="font-semibold tabular-nums" id="recv-po-received">0</span>
              </div>
            </div>

            <div class="overflow-auto border rounded-xl flex-1">
              <table class="w-full text-sm">
                <thead class="bg-gray-50">
                  <tr class="text-gray-500">
                    <th class="text-left py-2 px-2 w-[40px]"><input id="recv-check-all" type="checkbox" /></th>
                    <th class="text-left py-2 px-2">PO</th>
                    <th class="text-left py-2 px-2">Facility</th>
                    <th class="text-right py-2 px-2">Cartons In</th>
                    <th class="text-right py-2 px-2">Damaged</th>
                    <th class="text-right py-2 px-2">Non-compliant</th>
                    <th class="text-right py-2 px-2">Replaced</th>
                    <th class="text-left py-2 px-2">Last Received</th>
                  </tr>
                </thead>
                <tbody id="recv-body">
                  <tr><td colspan="8" class="text-center text-xs text-gray-400 py-6">Loading…</td></tr>
                </tbody>
              </table>
            </div>

            <div class="mt-3 text-xs text-gray-500">
              Tip: Enter carton/QC counts, select one or more POs, set <span class="font-semibold">Received At</span>, then click <span class="font-semibold">Receive Selected</span>. Carton/QC edits auto-save.
            </div>
          </div>

          <!-- Ticker -->
          <div class="lg:col-span-4 bg-white rounded-2xl border shadow p-4 min-w-0 flex flex-col" style="height: calc(100vh - 360px); border-color:#990033;">
            <div class="text-base font-semibold mb-2">Live Ticker</div>
            <div id="recv-ticker" class="space-y-2 text-sm overflow-auto flex-1 pr-1">
              <div class="text-xs text-gray-400">No updates yet for this week.</div>
            </div>
          </div>
        </div>

        <!-- Bottom summary bar -->
        <div class="bg-white rounded-2xl border shadow p-4" style="position: sticky; bottom: 16px; z-index: 20; border-color:#990033; margin-top: 14px; padding: 18px;">
          <div class="flex items-center justify-between flex-wrap gap-3">
            <div class="text-sm">
              <span class="text-gray-500">Expected POs:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-expected">0</span>
              <span class="text-gray-300 px-2">|</span>
              <span class="text-gray-500">Received:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-received">0</span>
              <span class="text-gray-300 px-2">|</span>
              <span class="text-gray-500">Cartons In:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-cartons">0</span>
              <span class="text-gray-300 px-2">|</span>
              <span class="text-gray-500">On-time by cutoff:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-ontime">0</span>
              <span class="text-gray-300 px-2">|</span>
              <span class="text-gray-500">Delayed:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-delayed">0</span>
            </div>
            <div class="text-sm">
              <span class="text-gray-500">Health:</span>
              <span class="font-semibold" id="recv-sum-health">—</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // Insert after dashboard so it behaves like a "page"
    const dashboard = document.getElementById('page-dashboard');
    if (dashboard && dashboard.parentNode) {
      dashboard.parentNode.insertBefore(page, dashboard.nextSibling);
    } else {
      document.body.appendChild(page);
    }

    // Week nav buttons
    const prevBtn = document.getElementById('recv-prev-week');
    const nextBtn = document.getElementById('recv-next-week');
    const weekInput = document.getElementById('week-start');

    if (prevBtn) prevBtn.onclick = () => {
      const ws = getWeekStart();
      const newWs = addDaysISO(ws, -7);
      if (weekInput) weekInput.value = newWs;
      if (window.state) window.state.weekStart = newWs;
    };

    if (nextBtn) nextBtn.onclick = () => {
      const ws = getWeekStart();
      const newWs = addDaysISO(ws, 7);
      if (weekInput) weekInput.value = newWs;
      if (window.state) window.state.weekStart = newWs;
    };

    // Wire header controls once
    wireHeaderControls();

    return page;
  }

  function showReceivingIfHash() {
    const pageReceiving = ensureReceivingPage();
    const show = (location.hash || '').toLowerCase().includes('receiving');

    if (show) {
      const pageDashboard = document.getElementById('page-dashboard');
      const pageExec = document.getElementById('page-exec');
      const pageIntake = document.getElementById('page-intake');

      if (pageDashboard) pageDashboard.classList.add('hidden');
      if (pageExec) pageExec.classList.add('hidden');
      if (pageIntake) pageIntake.classList.add('hidden');

      pageReceiving.classList.remove('hidden');
    } else {
      pageReceiving.classList.add('hidden');
    }
  }

  function buildSuppliers(planRows, receivingRows) {
    const suppliersPlan = (planRows || []).map(p => String(p.supplier_name || '').trim()).filter(Boolean);
    const suppliersRecv = (receivingRows || []).map(r => String(r.supplier_name || '').trim()).filter(Boolean);
    return uniq([...suppliersPlan, ...suppliersRecv]).sort((a, b) => a.localeCompare(b));
  }

  function renderSuppliers(suppliers, selected) {
    const sel = document.getElementById('recv-supplier');
    if (!sel) return;

    sel.innerHTML = '';
    if (!suppliers.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No suppliers';
      sel.appendChild(opt);
      return;
    }

    for (const s of suppliers) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      sel.appendChild(opt);
    }

    sel.value = selected && suppliers.includes(selected) ? selected : suppliers[0];
  }

  function buildPOListForSupplier(planRows, receivingRows, supplier) {
    // Deduplicate planned POs (plan can have multiple SKU rows per PO)
    const plannedMap = new Map();
    for (const p of planRows || []) {
      if (String(p.supplier_name || '').trim() !== supplier) continue;
      const po = String(p.po_number || '').trim();
      if (!po) continue;
      if (!plannedMap.has(po)) {
        plannedMap.set(po, { po, planFacility: String(p.facility_name || '').trim() });
      }
    }
    const planned = Array.from(plannedMap.values());

    const plannedPOSet = new Set(planned.map(x => x.po));
    const unplanned = (receivingRows || [])
      .filter(r => String(r.supplier_name || '').trim() === supplier)
      .map(r => String(r.po_number || '').trim())
      .filter(po => po && !plannedPOSet.has(po))
      .map(po => ({ po, planFacility: '(Unplanned)' }));

    return [...planned, ...unplanned].sort((a, b) => a.po.localeCompare(b.po));
  }

  function getReceivingByPO(receivingRows) {
    const m = new Map();
    for (const r of receivingRows || []) {
      const po = String(r.po_number || '').trim();
      if (!po) continue;
      m.set(po, r);
    }
    return m;
  }

  function computeSummaryAll(planRows, receivingRows, ws) {
    const cutoffUtc = businessCutoffUtcISO(ws);
    const cutoff = new Date(cutoffUtc);

    // expected: ALL planned POs for the week (deduped)
    const plannedMap = new Map();
    for (const p of planRows || []) {
      const po = String(p.po_number || '').trim();
      if (!po) continue;
      plannedMap.set(po, true);
    }
    const expected = plannedMap.size;

    const receivingByPO = getReceivingByPO(receivingRows);

    let received = 0;
    let cartons = 0;
    let ontime = 0;

    for (const po of plannedMap.keys()) {
      const r = receivingByPO.get(po);
      if (r && r.received_at_utc) {
        received += 1;
        cartons += Number(r.cartons_received || 0) || 0;

        const d = new Date(r.received_at_utc);
        if (!Number.isNaN(d.getTime()) && d.getTime() <= cutoff.getTime()) ontime += 1;
      }
    }

    const delayed = Math.max(0, received - ontime);
    return { expected, received, cartons, ontime, delayed, cutoffUtc };
  }

  function renderSummary(sum) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };

    set('recv-sum-expected', sum.expected);
    set('recv-sum-received', sum.received);
    set('recv-sum-cartons', sum.cartons);
    set('recv-sum-ontime', sum.ontime);
    set('recv-sum-delayed', sum.delayed);

    const healthEl = document.getElementById('recv-sum-health');
    if (healthEl) {
      if (sum.expected === 0) healthEl.textContent = '—';
      else if (sum.ontime >= sum.expected) healthEl.textContent = 'On-track';
      else healthEl.textContent = 'Delayed';
    }
  }

  function readRowPayload(ws, supplier, po, planFacility) {
    const row = document.querySelector(`tr[data-po="${CSS.escape(po)}"]`);

    const getVal = (selector) => {
      const el = row ? row.querySelector(selector) : null;
      return el ? String(el.value || '').trim() : '';
    };

    const getNum = (selector) => {
      const el = row ? row.querySelector(selector) : null;
      return el ? (Number(el.value || 0) || 0) : 0;
    };

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'viewer-local';

    return {
      po_number: po,
      supplier_name: supplier,
      facility_name: getVal('input[data-f="facility"]') || planFacility || '',
      received_at_local: '',
      received_at_utc: '',
      received_tz: tz,
      cartons_received: getNum('input[data-f="cartons_received"]'),
      cartons_damaged: getNum('input[data-f="cartons_damaged"]'),
      cartons_noncompliant: getNum('input[data-f="cartons_noncompliant"]'),
      cartons_replaced: getNum('input[data-f="cartons_replaced"]')
    };
  }

  function upsertReceivingRow(ws, payload) {
    const po = String(payload.po_number || '').trim();
    if (!po) return;

    const idx = M.receivingRows.findIndex(r => String(r.po_number || '').trim() === po);
    const merged = Object.assign({}, (idx >= 0 ? M.receivingRows[idx] : {}), payload, {
      week_start: ws,
      updated_at: nowISO()
    });

    if (idx >= 0) M.receivingRows[idx] = merged;
    else M.receivingRows.push(merged);
  }

  function debounceSave(ws, supplier, po, planFacility) {
    const key = `${ws}|||${po}`;
    if (M.saveTimers.has(key)) clearTimeout(M.saveTimers.get(key));

    M.saveTimers.set(key, setTimeout(async () => {
      try {
        const payload = readRowPayload(ws, supplier, po, planFacility);
        await api(`/receiving/weeks/${encodeURIComponent(ws)}`, {
          method: 'PUT',
          body: JSON.stringify([payload])
        });
        upsertReceivingRow(ws, payload);
        addTicker(`Saved ${po} cartons/QC`, { key: `save:${ws}:${po}:${payload.cartons_received}:${payload.cartons_damaged}:${payload.cartons_noncompliant}:${payload.cartons_replaced}` });
        renderCurrentSupplierView();
      } catch (e) {
        console.warn('[receiving] save error', e);
        addTicker(`⚠️ Save failed for ${po}`, { key: `savefail:${ws}:${po}` });
      }
    }, 500));
  }

  function wireRowInputs(ws, supplier, po, planFacility) {
    const row = document.querySelector(`tr[data-po="${CSS.escape(po)}"]`);
    if (!row) return;

    const inputs = row.querySelectorAll('input[data-f]');
    inputs.forEach(inp => {
      inp.onchange = () => debounceSave(ws, supplier, po, planFacility);
      inp.onblur = () => debounceSave(ws, supplier, po, planFacility);
      inp.oninput = () => debounceSave(ws, supplier, po, planFacility);
    });
  }

  function renderTableForSupplier(planRows, receivingRows, supplier) {
    const tbody = document.getElementById('recv-body');
    if (!tbody) return;

    const receivingByPO = getReceivingByPO(receivingRows);
    const rows = buildPOListForSupplier(planRows, receivingRows, supplier);

    const receivedCount = rows.reduce((acc, x) => acc + (receivingByPO.get(x.po)?.received_at_utc ? 1 : 0), 0);
    const poCountEl = document.getElementById('recv-po-count');
    const poRecvEl = document.getElementById('recv-po-received');
    if (poCountEl) poCountEl.textContent = String(rows.length);
    if (poRecvEl) poRecvEl.textContent = String(receivedCount);

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-xs text-gray-400 py-6">No POs for this supplier in this week\'s plan.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(x => {
      const r = receivingByPO.get(x.po) || {};
      return `
        <tr class="border-t" data-po="${esc(x.po)}">
          <td class="py-2 px-2">
            <input class="recv-row-check" type="checkbox" data-po="${esc(x.po)}" />
          </td>
          <td class="py-2 px-2 font-semibold">${esc(x.po)}</td>
          <td class="py-2 px-2">
            <input class="border rounded px-2 py-1 text-sm w-[160px]"
                   data-po="${esc(x.po)}" data-f="facility"
                   value="${esc(r.facility_name || x.planFacility || '')}" />
          </td>
          <td class="py-2 px-2 text-right">
            <input class="border rounded px-2 py-1 text-sm w-[90px] text-right"
                   data-po="${esc(x.po)}" data-f="cartons_received"
                   value="${Number(r.cartons_received || 0)}" />
          </td>
          <td class="py-2 px-2 text-right">
            <input class="border rounded px-2 py-1 text-sm w-[90px] text-right"
                   data-po="${esc(x.po)}" data-f="cartons_damaged"
                   value="${Number(r.cartons_damaged || 0)}" />
          </td>
          <td class="py-2 px-2 text-right">
            <input class="border rounded px-2 py-1 text-sm w-[110px] text-right"
                   data-po="${esc(x.po)}" data-f="cartons_noncompliant"
                   value="${Number(r.cartons_noncompliant || 0)}" />
          </td>
          <td class="py-2 px-2 text-right">
            <input class="border rounded px-2 py-1 text-sm w-[90px] text-right"
                   data-po="${esc(x.po)}" data-f="cartons_replaced"
                   value="${Number(r.cartons_replaced || 0)}" />
          </td>
          <td class="py-2 px-2 text-sm text-gray-600">
            ${esc(fmtLocalFromUtc(r.received_at_utc) || '')}
          </td>
        </tr>
      `;
    }).join('');

    // Wire row autosaves
    for (const x of rows) {
      wireRowInputs(M.ws, supplier, x.po, x.planFacility);
    }
  }

  function renderCurrentSupplierView() {
    const ws = M.ws;
    if (!ws) return;

    const sel = document.getElementById('recv-supplier');
    const supplier = sel ? sel.value : M.selectedSupplier;
    if (!supplier) return;

    M.selectedSupplier = supplier;
    renderTableForSupplier(M.planRows, M.receivingRows, supplier);

    const sum = computeSummaryAll(M.planRows, M.receivingRows, ws);
    renderSummary(sum);
  }

  function wireHeaderControls() {
    const page = document.getElementById('page-receiving');
    if (!page || page.dataset.wired === '1') return;
    page.dataset.wired = '1';

    const btnNow = document.getElementById('recv-batch-now');
    const batchDt = document.getElementById('recv-batch-dt');
    const btnReceive = document.getElementById('recv-batch-receive');
    const checkAll = document.getElementById('recv-check-all');

    if (btnNow && batchDt) btnNow.onclick = () => { batchDt.value = dtLocalNow(); };

    if (checkAll) {
      checkAll.onchange = () => {
        document.querySelectorAll('.recv-row-check').forEach(cb => { cb.checked = checkAll.checked; });
      };
    }

    if (btnReceive) {
      btnReceive.onclick = async () => {
        const ws = getWeekStart();
        const sel = document.getElementById('recv-supplier');
        const supplier = (sel && sel.value) ? sel.value : '';

        const dtVal = batchDt ? String(batchDt.value || '').trim() : '';
        if (!dtVal) { alert('Please select Received At date/time.'); return; }

        const checked = Array.from(document.querySelectorAll('.recv-row-check'))
          .filter(cb => cb.checked)
          .map(cb => cb.getAttribute('data-po'))
          .filter(Boolean);

        if (!checked.length) { alert('Select at least one PO.'); return; }

        // Optimistic update: update local cache first so UI/summary/ticker update immediately
        const payload = checked.map(po => {
          const row = document.querySelector(`tr[data-po="${CSS.escape(po)}"]`);
          const get = (f) => row ? row.querySelector(`input[data-f="${f}"]`) : null;

          const facility = (get('facility')?.value || '').trim();
          const cartons_received = Number(get('cartons_received')?.value || 0) || 0;
          const cartons_damaged = Number(get('cartons_damaged')?.value || 0) || 0;
          const cartons_noncompliant = Number(get('cartons_noncompliant')?.value || 0) || 0;
          const cartons_replaced = Number(get('cartons_replaced')?.value || 0) || 0;

          const utcISO = new Date(dtVal).toISOString();

          return {
            po_number: po,
            supplier_name: supplier,
            facility_name: facility,
            received_at_utc: utcISO,
            received_at_local: dtVal,
            received_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'viewer-local',
            cartons_received,
            cartons_damaged,
            cartons_noncompliant,
            cartons_replaced
          };
        });

        payload.forEach(p => upsertReceivingRow(ws, p));
        addTicker(`Received ${payload.length} PO(s) for ${supplier} at ${fmtLocalFromUtc(payload[0].received_at_utc)}`, { key: `batch:${ws}:${supplier}:${payload.length}:${payload[0].received_at_utc}` });
        renderCurrentSupplierView();

        try {
          await api(`/receiving/weeks/${encodeURIComponent(ws)}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
          });
          addTicker(`Saved batch receive (${payload.length})`, { key: `batchsave:${ws}:${supplier}:${payload.length}:${payload[0].received_at_utc}` });
        } catch (e) {
          console.warn(e);
          addTicker(`⚠️ Failed to save batch receive: ${e.message || e}`, { key: `batchfail:${ws}:${supplier}:${payload.length}` });
          alert('Save failed. Check connection / server logs.');
        }
      };
    }
  }

  async function loadWeek(ws) {
    if (!ws) return;

    M.ws = ws;
    const lbl = document.getElementById('recv-week-label');
    if (lbl) lbl.textContent = ws;

    resetTicker();
    addTicker(`Loaded week ${ws}`, { key: `loaded:${ws}` });

    const [plan, receiving] = await Promise.all([
      api(`/plan?weekStart=${encodeURIComponent(ws)}`),
      api(`/receiving?weekStart=${encodeURIComponent(ws)}`)
    ]);

    const planRows = Array.isArray(plan) ? plan : (plan?.data || []);
    const receivingRows = Array.isArray(receiving) ? receiving : [];

    M.planRows = planRows;
    M.receivingRows = receivingRows;
    M.suppliers = buildSuppliers(planRows, receivingRows);

    renderSuppliers(M.suppliers, M.selectedSupplier);

    const sel = document.getElementById('recv-supplier');
    if (sel) {
      sel.onchange = () => {
        M.selectedSupplier = sel.value;
        addTicker(`Viewing supplier ${sel.value}`, { key: `view:${ws}:${sel.value}` });
        renderCurrentSupplierView();
      };
    }

    renderCurrentSupplierView();
  }

  // Watch: week changes & hash changes
  let lastWS = '';

  async function tick() {
    try {
      showReceivingIfHash();
      const isReceiving = (location.hash || '').toLowerCase().includes('receiving');
      if (!isReceiving) return;

      const ws = getWeekStart();
      if (ws && ws !== lastWS) {
        lastWS = ws;
        ensureReceivingPage();
        await loadWeek(ws);
      }
    } catch (e) {
      console.warn('[receiving] load error:', e);
    }
  }

  window.addEventListener('hashchange', () => {
    showReceivingIfHash();
  });

  tick();
  setInterval(tick, 800);
})();
