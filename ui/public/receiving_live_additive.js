/* receiving_live_additive.js (v11) - Receiving page (additive)
   - Loaded via <script src="/receiving_live_additive.js" defer></script>
   - Hash route: only controls UI when #receiving is active
   - Week binding: #week-start / window.state.weekStart
   - Loads plan + receiving rows for selected week
   - Batch receive: header "Received At" + "Receive Selected" applies timestamp to checked POs
   - Autosave: facility + cartons/QC per PO. (v9 change: autosave never re-renders the table)
   - Exceptions panel: supplier-level outliers (view-only)
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
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
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

  function fmtLocalFromUtc(isoUtc) {
    if (!isoUtc) return '';
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(d);
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

  function businessCutoffUtcISO(weekStartISO) {
    // Monday 12:00 in Asia/Shanghai => 04:00 UTC (same date) because UTC+8
    const hourUtc = 12 - BUSINESS_UTC_OFFSET_HOURS; // 4
    const hh = String(hourUtc).padStart(2, '0');
    return `${weekStartISO}T${hh}:00:00.000Z`;
  }

  function buildWeekPOIndex(planRows) {
    // Deduplicate planned POs (plan can have multiple SKU rows per PO)
    const poIndex = new Map();
    for (const p of planRows || []) {
      const po = String(p.po_number || '').trim();
      if (!po) continue;
      if (!poIndex.has(po)) {
        poIndex.set(po, {
          po,
          supplier: String(p.supplier_name || '').trim(),
          planFacility: String(p.facility_name || '').trim()
        });
      }
    }
    return poIndex;
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

  function computePOStatus(receivedAtUtc, cutoffUtc) {
    if (!receivedAtUtc) return '';
    const d = new Date(receivedAtUtc);
    const c = new Date(cutoffUtc);
    if (Number.isNaN(d.getTime()) || Number.isNaN(c.getTime())) return '';
    return (d.getTime() <= c.getTime()) ? 'On-time' : 'Delayed';
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadTextFile(filename, content, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  function buildWeekExportRows(planRows, receivingRows, weekStartISO) {
    const cutoffUtc = businessCutoffUtcISO(weekStartISO);
    const cutoff = new Date(cutoffUtc);
    const now = new Date();

    const poIndex = buildWeekPOIndex(planRows);
    const recvByPO = getReceivingByPO(receivingRows);

    const rows = [];
    for (const { po, supplier, planFacility } of poIndex.values()) {
      const r = recvByPO.get(po) || {};
      const receivedAtUtc = String(r.received_at_utc || '').trim();

      let status = '';
      if (receivedAtUtc) status = computePOStatus(receivedAtUtc, cutoffUtc);
      else status = (now.getTime() > cutoff.getTime()) ? 'Not received (Delayed)' : 'Not received';

      rows.push({
        week_start: weekStartISO,
        supplier_name: supplier,
        facility_name: String(r.facility_name || planFacility || '').trim(),
        po_number: po,
        cartons_in: Number(r.cartons_received || 0) || 0,
        damaged: Number(r.cartons_damaged || 0) || 0,
        non_compliant: Number(r.cartons_noncompliant || 0) || 0,
        replaced: Number(r.cartons_replaced || 0) || 0,
        received_at_utc: receivedAtUtc,
        last_received_local: fmtLocalFromUtc(receivedAtUtc),
        cutoff_utc: cutoffUtc,
        status
      });
    }

    // stable sort: supplier then PO
    rows.sort((a, b) =>
      String(a.supplier_name).localeCompare(String(b.supplier_name)) ||
      String(a.po_number).localeCompare(String(b.po_number))
    );

    return rows;
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  // -------------------- Exceptions panel (view-only) --------------------
  // Goal: show actionable weekly outliers by supplier (no ticker/log spam)
  function computeSupplierStats(planRows, receivingRows) {
    const cutoffUtc = businessCutoffUtcISO(M.ws);
    const cutoff = new Date(cutoffUtc);
    const now = new Date();

    // planned POs (deduped) by supplier
    const plannedBySupplier = new Map(); // supplier -> Set(po)
    for (const p of planRows || []) {
      const supplier = String(p.supplier_name || '').trim();
      const po = String(p.po_number || '').trim();
      if (!supplier || !po) continue;
      if (!plannedBySupplier.has(supplier)) plannedBySupplier.set(supplier, new Set());
      plannedBySupplier.get(supplier).add(po);
    }

    const receivingByPO = getReceivingByPO(receivingRows);

    const stats = [];
    for (const [supplier, poSet] of plannedBySupplier.entries()) {
      let expectedPOs = poSet.size;
      let receivedPOs = 0;
      let delayedPOs = 0;
      let cartonsIn = 0;
      let damaged = 0;
      let noncompliant = 0;
      let replaced = 0;

      for (const po of poSet) {
        const r = receivingByPO.get(po);
        const hasReceived = !!(r && r.received_at_utc);
        if (hasReceived) {
          receivedPOs += 1;
          cartonsIn += Number(r.cartons_received || 0) || 0;
          damaged += Number(r.cartons_damaged || 0) || 0;
          noncompliant += Number(r.cartons_noncompliant || 0) || 0;
          replaced += Number(r.cartons_replaced || 0) || 0;

          const d = new Date(r.received_at_utc);
          if (!Number.isNaN(d.getTime()) && d.getTime() > cutoff.getTime()) delayedPOs += 1;
        } else {
          // If we are past cutoff and it still isn't received, it's delayed.
          if (now.getTime() > cutoff.getTime()) delayedPOs += 1;
        }
      }

      stats.push({
        supplier,
        expectedPOs,
        receivedPOs,
        delayedPOs,
        cartonsIn,
        damaged,
        noncompliant,
        replaced,
        cutoffUtc
      });
    }

    return stats;
  }

  function topN(arr, n, keyFn) {
    return (arr || [])
      .slice()
      .sort((a, b) => (keyFn(b) - keyFn(a)) || String(a.supplier).localeCompare(String(b.supplier)))
      .slice(0, n);
  }

  function renderExceptionsPanel() {
    const el = document.getElementById('recv-exceptions');
    if (!el) return;
    const stats = computeSupplierStats(M.planRows, M.receivingRows);
    if (!stats.length) {
      el.innerHTML = `<div class="text-xs text-gray-400">No planned suppliers for this week.</div>`;
      return;
    }

    const topDelayed = topN(stats, 5, s => s.delayedPOs);
    const topNonc = topN(stats, 5, s => s.noncompliant);
    const topDam = topN(stats, 5, s => s.damaged);
    const topRepl = topN(stats, 5, s => s.replaced);

    const row = (label, items, fmt) => {
      const rows = items
        .filter(x => fmt(x).value > 0)
        .map(x => {
          const v = fmt(x);
          return `<div class="flex items-center justify-between gap-3 py-1">
            <div class="truncate" title="${esc(x.supplier)}">${esc(x.supplier)}</div>
            <div class="tabular-nums font-semibold whitespace-nowrap">${esc(v.text)}</div>
          </div>`;
        })
        .join('');
      return `
        <div class="border rounded-xl p-3">
          <div class="text-sm font-semibold mb-2">${esc(label)}</div>
          ${rows || `<div class="text-xs text-gray-400">No items.</div>`}
        </div>
      `;
    };

    el.innerHTML = `
      <div class="text-xs text-gray-500 mb-2">Week cutoff (business): <span class="font-semibold">${esc(fmtLocalFromUtc(businessCutoffUtcISO(M.ws)))}</span></div>
      <div class="space-y-2">
        ${row('Most delayed POs', topDelayed, (x) => ({ value: x.delayedPOs, text: `${x.delayedPOs} / ${x.expectedPOs}` }))}
        ${row('Most non-compliant cartons', topNonc, (x) => ({ value: x.noncompliant, text: `${x.noncompliant}` }))}
        ${row('Most damaged cartons', topDam, (x) => ({ value: x.damaged, text: `${x.damaged}` }))}
        ${row('Most replaced cartons', topRepl, (x) => ({ value: x.replaced, text: `${x.replaced}` }))}
      </div>
    `;
  }

  // -------------------- Save status (quiet autosave feedback) --------------------
  let _saveStatusTimer = null;
  function setSaveStatus(text, tone) {
    const el = document.getElementById('recv-save-status');
    if (!el) return;

    el.textContent = text || '';
    el.style.opacity = text ? '1' : '0';
    el.style.display = 'inline-block';
    el.className = 'text-xs';

    // Tone via inline styles to avoid tailwind compile issues
    if (tone === 'saving') {
      el.style.color = '#6b7280'; // gray-500
    } else if (tone === 'saved') {
      el.style.color = '#16a34a'; // green-600
    } else if (tone === 'error') {
      el.style.color = '#dc2626'; // red-600
    } else {
      el.style.color = '#6b7280';
    }

    if (_saveStatusTimer) clearTimeout(_saveStatusTimer);
    if (text) {
      _saveStatusTimer = setTimeout(() => {
        const el2 = document.getElementById('recv-save-status');
        if (el2) el2.textContent = '';
      }, tone === 'error' ? 4000 : 1500);
    }
  }

  // -------------------- State cache --------------------
  const M = {
    ws: '',
    planRows: [],
    receivingRows: [],
    suppliers: [],
    selectedSupplier: '',
    saveTimers: new Map()
  };

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
                <button id="recv-batch-receive" class="cmd cmd--ghost" style="border:1px solid #990033;color:#990033" title="Apply received time to selected POs">Receive Selected</button>
              </div>

<button id="recv-dl-week-csv" class="cmd cmd--ghost"
        title="Download week receiving as CSV (Excel)">
  Download Week (CSV)
</button>

<button id="recv-dl-supplier-pdf" class="cmd cmd--ghost"
        title="Open supplier summary for printing to PDF">
  Supplier Summary (PDF)
</button>


<div class="text-sm text-gray-500 flex items-center gap-2">
  <div>
    POs: <span class="font-semibold tabular-nums" id="recv-po-count">0</span>
    • Received: <span class="font-semibold tabular-nums" id="recv-po-received">0</span>
  </div>

  <!-- Permanent reserved slot (prevents layout jump) -->
  <span id="recv-save-status"
        class="inline-block text-xs text-gray-400"
        style="min-width: 90px; opacity: 0;">
    Saved
  </span>
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
              Tip: Enter carton/QC counts, select one or more POs, set <span class="font-semibold">Received At</span>, then click <span class="font-semibold">Receive Selected</span>. Facility/carton/QC edits auto-save.
            </div>
          </div>

          <!-- Exceptions (view-only) -->
          <div class="lg:col-span-4 bg-white rounded-2xl border shadow p-4 min-w-0 flex flex-col" style="height: calc(100vh - 360px); border-color:#990033;">
            <div class="text-base font-semibold mb-2">Exceptions</div>
            <div class="text-xs text-gray-500 mb-2">Supplier-level outliers for this week (view-only).</div>
            <div id="recv-exceptions" class="space-y-2 text-sm overflow-auto flex-1 pr-1">
              <div class="text-xs text-gray-400">Loading…</div>
            </div>
          </div>
        </div>

        <!-- Bottom summary bar -->
        <div class="bg-white rounded-2xl border shadow p-4" style="position: sticky; bottom: 16px; z-index: 20; border-color:#990033; margin-top: 14px; padding: 18px;">
          <div class="flex items-center justify-between flex-wrap gap-3">
            <div class="text-sm">
<!-- PO metrics -->
<span class="text-gray-500">Expected POs:</span>
<span class="font-semibold tabular-nums" id="recv-sum-expected">0</span>
<span class="text-gray-300 px-2">|</span>
<span class="text-gray-500">Received:</span>
<span class="font-semibold tabular-nums" id="recv-sum-received">0</span>
<span class="text-gray-300 px-2">|</span>
<span class="text-gray-500">On-time by cutoff:</span>
<span class="font-semibold tabular-nums" id="recv-sum-ontime">0</span>
<span class="text-gray-300 px-2">|</span>
<span class="text-gray-500">Delayed:</span>
<span class="font-semibold tabular-nums" id="recv-sum-delayed">0</span>

<span class="text-gray-300 px-2">|</span>

<!-- Carton metrics -->
<span class="text-gray-500">Cartons In:</span>
<span class="font-semibold tabular-nums" id="recv-sum-cartons">0</span>
<span class="text-gray-300 px-2">|</span>
<span class="text-gray-500">Damaged:</span>
<span class="font-semibold tabular-nums" id="recv-sum-damaged">0</span>
<span class="text-gray-300 px-2">|</span>
<span class="text-gray-500">Non-compliant:</span>
<span class="font-semibold tabular-nums" id="recv-sum-nonc">0</span>
<span class="text-gray-300 px-2">|</span>
<span class="text-gray-500">Replaced:</span>
<span class="font-semibold tabular-nums" id="recv-sum-replaced">0</span>

            </div>
            <div class="text-sm">
              <span class="text-gray-500">Health:</span>
<span id="recv-sum-health"
      class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border"> — </span>
            </div>
          </div>
        </div>
      </div>
    `;

    const dashboard = document.getElementById('page-dashboard');
    if (dashboard && dashboard.parentNode) {
      dashboard.parentNode.insertBefore(page, dashboard.nextSibling);
    } else {
      document.body.appendChild(page);
    }

    // Prev/Next week
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

    // Header controls
    const btnNow = document.getElementById('recv-batch-now');
    const batchDt = document.getElementById('recv-batch-dt');
    if (btnNow && batchDt) btnNow.onclick = () => { batchDt.value = dtLocalNow(); };

    const checkAll = document.getElementById('recv-check-all');
    if (checkAll) {
      checkAll.onchange = () => {
        document.querySelectorAll('.recv-row-check').forEach(cb => { cb.checked = checkAll.checked; });
      };
    }

    // Downloads (week-level, all suppliers)
    const btnCsv = document.getElementById('recv-dl-week-csv');
    const btnPdf = document.getElementById('recv-dl-supplier-pdf');

    if (btnCsv) {
      btnCsv.onclick = () => {
        const ws = getWeekStart();
        if (!ws) return;

        const rows = buildWeekExportRows(M.planRows, M.receivingRows, ws);
        const header = [
          'week_start','supplier_name','facility_name','po_number',
          'cartons_in','damaged','non_compliant','replaced',
          'last_received_local','received_at_utc','cutoff_utc','status'
        ];

        const lines = [
          header.join(','),
          ...rows.map(r => header.map(h => csvEscape(r[h])).join(','))
        ];

        downloadTextFile(`receiving_week_${ws}.csv`, lines.join('\n'), 'text/csv');
      };
    }

    if (btnPdf) {
      btnPdf.onclick = () => {
        const ws = getWeekStart();
        if (!ws) return;

        const rows = buildWeekExportRows(M.planRows, M.receivingRows, ws);
        const bySupplier = new Map();
        for (const r of rows) {
          if (!bySupplier.has(r.supplier_name)) bySupplier.set(r.supplier_name, []);
          bySupplier.get(r.supplier_name).push(r);
        }

        const cutoffLocal = fmtLocalFromUtc(businessCutoffUtcISO(ws));
        const suppliers = Array.from(bySupplier.keys()).sort((a,b)=>a.localeCompare(b));

        const pageCss = `
          <style>
            body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; margin:24px;}
            h1{font-size:18px;margin:0 0 4px;}
            .meta{color:#666;font-size:12px;margin-bottom:14px;}
            .supplier{page-break-after:always; margin-bottom:18px;}
            .supplier:last-child{page-break-after:auto;}
            h2{font-size:14px;margin:12px 0 6px;}
            .kpis{display:flex;gap:16px;flex-wrap:wrap;color:#333;font-size:12px;margin:6px 0 10px;}
            .kpis b{font-variant-numeric:tabular-nums;}
            table{width:100%;border-collapse:collapse;font-size:12px;}
            th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top;}
            th{background:#f9fafb;color:#374151;}
            .right{text-align:right;font-variant-numeric:tabular-nums;}
            .delayed{color:#b91c1c;font-weight:600;}
          </style>
        `;

        const supplierPages = suppliers.map(supplier => {
          const rs = bySupplier.get(supplier) || [];
          const expected = rs.length;
          const received = rs.filter(x => x.received_at_utc).length;
          const delayed = rs.filter(x => x.status === 'Delayed' || x.status === 'Not received (Delayed)').length;
          const cartons = rs.reduce((a,x)=>a + (x.cartons_in||0),0);
          const damaged = rs.reduce((a,x)=>a + (x.damaged||0),0);
          const nonc = rs.reduce((a,x)=>a + (x.non_compliant||0),0);
          const repl = rs.reduce((a,x)=>a + (x.replaced||0),0);

          const rowsHtml = rs.map(x => `
            <tr>
              <td>${esc(x.po_number)}</td>
              <td>${esc(x.facility_name)}</td>
              <td class="right">${x.cartons_in}</td>
              <td class="right">${x.damaged}</td>
              <td class="right">${x.non_compliant}</td>
              <td class="right">${x.replaced}</td>
              <td>${esc(x.last_received_local || '')}</td>
              <td class="${(x.status || '').includes('Delayed') ? 'delayed' : ''}">${esc(x.status)}</td>
            </tr>
          `).join('');

          return `
            <div class="supplier">
              <h2>${esc(supplier)}</h2>
              <div class="kpis">
                <div>Expected POs: <b>${expected}</b></div>
                <div>Received: <b>${received}</b></div>
                <div>Delayed: <b class="delayed">${delayed}</b></div>
                <div>Cartons In: <b>${cartons}</b></div>
                <div>Damaged: <b>${damaged}</b></div>
                <div>Non-compliant: <b>${nonc}</b></div>
                <div>Replaced: <b>${repl}</b></div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>PO</th>
                    <th>Facility</th>
                    <th class="right">Cartons</th>
                    <th class="right">Damaged</th>
                    <th class="right">Non-comp</th>
                    <th class="right">Replaced</th>
                    <th>Last Received</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
          `;
        }).join('');

        const html = `
          <!doctype html>
          <html><head><meta charset="utf-8" />
            <title>Receiving Supplier Summary — ${esc(ws)}</title>
            ${pageCss}
          </head>
          <body>
            <h1>Receiving — Supplier Summary</h1>
            <div class="meta">Week: ${esc(ws)} • Business cutoff (local): ${esc(cutoffLocal || '')}</div>
            ${supplierPages}
            <script>window.print();</script>
          </body></html>
        `;

        const w = window.open('', '_blank');
        if (!w) return;
        w.document.open();
        w.document.write(html);
        w.document.close();
      };
    }

    // Delegated autosave for facility + cartons/QC
    const tbody = document.getElementById('recv-body');
    if (tbody) {
      tbody.addEventListener('input', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.classList.contains('recv-num') && !t.classList.contains('recv-facility')) return;
        const po = t.getAttribute('data-po') || '';
        if (!po) return;
        queueAutosave(po);
      });

      tbody.addEventListener('change', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.classList.contains('recv-num') && !t.classList.contains('recv-facility')) return;
        const po = t.getAttribute('data-po') || '';
        if (!po) return;
        queueAutosave(po);
      });
    }

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

  function getReceivingByPO(receivingRows) {
    const m = new Map();
    for (const r of receivingRows || []) {
      const po = String(r.po_number || '').trim();
      if (!po) continue;
      m.set(po, r);
    }
    return m;
  }

  function buildPOListForSupplier(planRows, receivingRows, supplier) {
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

  function computeSummaryAll(planRows, receivingRows) {
    const cutoffUtc = businessCutoffUtcISO(M.ws);
    const cutoff = new Date(cutoffUtc);

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
    let damaged = 0;
    let noncompliant = 0;
    let replaced = 0;

    for (const po of plannedMap.keys()) {
      const r = receivingByPO.get(po);
      if (r && r.received_at_utc) {
        received += 1;
        cartons += Number(r.cartons_received || 0) || 0;
        damaged += Number(r.cartons_damaged || 0) || 0;
        noncompliant += Number(r.cartons_noncompliant || 0) || 0;
        replaced += Number(r.cartons_replaced || 0) || 0;

        const d = new Date(r.received_at_utc);
        if (!Number.isNaN(d.getTime()) && d.getTime() <= cutoff.getTime()) ontime += 1;
      }
    }

    const delayed = Math.max(0, received - ontime);
    return { expected, received, cartons, damaged, noncompliant, replaced, ontime, delayed, cutoffUtc };
  }

  function renderSummary(sum) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };
    set('recv-sum-expected', sum.expected);
    set('recv-sum-received', sum.received);
    set('recv-sum-cartons', sum.cartons);
    set('recv-sum-damaged', sum.damaged ?? 0);
    set('recv-sum-nonc', sum.noncompliant ?? 0);
    set('recv-sum-replaced', sum.replaced ?? 0);
    set('recv-sum-ontime', sum.ontime);
    set('recv-sum-delayed', sum.delayed);

    const healthEl = document.getElementById('recv-sum-health');
    if (healthEl) {
      if (sum.expected === 0) healthEl.textContent = '—';
      else if (sum.ontime >= sum.expected) healthEl.textContent = 'On-track';
      else healthEl.textContent = 'Delayed';

    // minimalist emphasis (no motion)
    const cls = (id, on, onCls, offCls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = on ? onCls : offCls;
    };

    // Health pill
    const healthEl = document.getElementById('recv-sum-health');
    const health = (sum.expected === 0) ? '—' : ((sum.delayed > 0) ? 'Delayed' : 'On-track');
    if (healthEl) {
      healthEl.textContent = health;
      healthEl.className =
        (health === 'Delayed')
          ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-red-300 text-red-700 bg-red-50'
          : (health === 'On-track')
            ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-green-300 text-green-700 bg-green-50'
            : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-gray-200 text-gray-500 bg-gray-50';
    }

    // Emphasize problem metrics
    cls('recv-sum-delayed', (Number(sum.delayed) || 0) > 0, 'font-semibold tabular-nums text-red-700', 'font-semibold tabular-nums text-gray-800');
    cls('recv-sum-nonc', (Number(sum.noncompliant) || 0) > 0, 'font-semibold tabular-nums text-red-700', 'font-semibold tabular-nums text-gray-800');
    cls('recv-sum-damaged', (Number(sum.damaged) || 0) > 0, 'font-semibold tabular-nums text-amber-700', 'font-semibold tabular-nums text-gray-800');
    cls('recv-sum-replaced', (Number(sum.replaced) || 0) > 0, 'font-semibold tabular-nums text-red-700', 'font-semibold tabular-nums text-gray-800');


    }
  }

  function renderCountsForSupplier(planRows, receivingRows, supplier) {
    const receivingByPO = getReceivingByPO(receivingRows);
    const rows = buildPOListForSupplier(planRows, receivingRows, supplier);
    const receivedCount = rows.reduce((acc, x) => acc + (receivingByPO.get(x.po)?.received_at_utc ? 1 : 0), 0);

    const poCountEl = document.getElementById('recv-po-count');
    const poRecvEl = document.getElementById('recv-po-received');
    if (poCountEl) poCountEl.textContent = String(rows.length);
    if (poRecvEl) poRecvEl.textContent = String(receivedCount);
  }

  function renderTableForSupplier(planRows, receivingRows, supplier) {
    const tbody = document.getElementById('recv-body');
    if (!tbody) return;

    const receivingByPO = getReceivingByPO(receivingRows);
    const rows = buildPOListForSupplier(planRows, receivingRows, supplier);

    renderCountsForSupplier(planRows, receivingRows, supplier);

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-xs text-gray-400 py-6">No POs for this supplier in this week’s plan.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(x => {
      const r = receivingByPO.get(x.po) || {};
      return `
<tr class="border-t" data-po="${esc(x.po)}">
  <td class="py-2 px-2"><input class="recv-row-check" type="checkbox" data-po="${esc(x.po)}" /></td>
  <td class="py-2 px-2 font-semibold">${esc(x.po)}</td>
  <td class="py-2 px-2">
    <input class="recv-facility border rounded px-2 py-1 text-sm w-[160px]" data-po="${esc(x.po)}" value="${esc(r.facility_name || x.planFacility || '')}" />
  </td>
  <td class="py-2 px-2 text-right"><input class="recv-num border rounded px-2 py-1 text-sm w-[90px] text-right" data-field="cartons_received" data-po="${esc(x.po)}" value="${Number(r.cartons_received || 0)}" /></td>
  <td class="py-2 px-2 text-right"><input class="recv-num border rounded px-2 py-1 text-sm w-[90px] text-right" data-field="cartons_damaged" data-po="${esc(x.po)}" value="${Number(r.cartons_damaged || 0)}" /></td>
  <td class="py-2 px-2 text-right"><input class="recv-num border rounded px-2 py-1 text-sm w-[110px] text-right" data-field="cartons_noncompliant" data-po="${esc(x.po)}" value="${Number(r.cartons_noncompliant || 0)}" /></td>
  <td class="py-2 px-2 text-right"><input class="recv-num border rounded px-2 py-1 text-sm w-[90px] text-right" data-field="cartons_replaced" data-po="${esc(x.po)}" value="${Number(r.cartons_replaced || 0)}" /></td>
  <td class="py-2 px-2 text-sm text-gray-600" data-cell="last-received">${esc(fmtLocalFromUtc(r.received_at_utc) || '')}</td>
</tr>`;
    }).join('');
  }

  function renderCurrentSupplierView() {
    const ws = M.ws;
    if (!ws) return;
    const sel = document.getElementById('recv-supplier');
    const supplier = sel ? sel.value : M.selectedSupplier;
    if (!supplier) return;

    M.selectedSupplier = supplier;
    renderTableForSupplier(M.planRows, M.receivingRows, supplier);
    renderSummary(computeSummaryAll(M.planRows, M.receivingRows));
  }

  function mergeReceivingRow(po, patch) {
    const idx = M.receivingRows.findIndex(r => String(r.po_number || '').trim() === po);
    const merged = Object.assign({}, (idx >= 0 ? M.receivingRows[idx] : {}), patch, { po_number: po, week_start: M.ws, updated_at: new Date().toISOString() });
    if (idx >= 0) M.receivingRows[idx] = merged;
    else M.receivingRows.push(merged);
    return merged;
  }

  function getUIValuesForPO(po) {
    const supplier = (document.getElementById('recv-supplier') || {}).value || '';
    const facEl = document.querySelector(`.recv-facility[data-po="${CSS.escape(po)}"]`);
    const facility = facEl ? facEl.value.trim() : '';

    const getNum = (field) => {
      const el = document.querySelector(`.recv-num[data-po="${CSS.escape(po)}"][data-field="${field}"]`);
      return el ? (Number(el.value || 0) || 0) : 0;
    };

    return {
      supplier_name: supplier,
      facility_name: facility,
      cartons_received: getNum('cartons_received'),
      cartons_damaged: getNum('cartons_damaged'),
      cartons_noncompliant: getNum('cartons_noncompliant'),
      cartons_replaced: getNum('cartons_replaced')
    };
  }

  function queueAutosave(po) {
    const key = `${M.ws}|||${po}`;
    if (M.saveTimers.has(key)) clearTimeout(M.saveTimers.get(key));

    setSaveStatus('Saving…', 'saving');

    M.saveTimers.set(key, setTimeout(async () => {
      try {
        const base = getUIValuesForPO(po);
        const existing = M.receivingRows.find(r => String(r.po_number || '').trim() === po) || {};

        // build payload: preserve received_* fields if they exist
        const payload = Object.assign({}, {
          po_number: po,
          supplier_name: base.supplier_name,
          facility_name: base.facility_name,
          received_at_utc: existing.received_at_utc || '',
          received_at_local: existing.received_at_local || '',
          received_tz: existing.received_tz || '',
          cartons_received: base.cartons_received,
          cartons_damaged: base.cartons_damaged,
          cartons_noncompliant: base.cartons_noncompliant,
          cartons_replaced: base.cartons_replaced
        });

        // optimistic state update (no table re-render)
        mergeReceivingRow(po, payload);
        renderSummary(computeSummaryAll(M.planRows, M.receivingRows));
        renderCountsForSupplier(M.planRows, M.receivingRows, (document.getElementById('recv-supplier') || {}).value || M.selectedSupplier);
        renderExceptionsPanel();

        await api(`/receiving/weeks/${encodeURIComponent(M.ws)}`, {
          method: 'PUT',
          body: JSON.stringify([payload])
        });

        setSaveStatus('Saved', 'saved');
      } catch (e) {
        console.warn('[receiving] autosave error', e);
        setSaveStatus('Save failed', 'error');
      }
    }, 450));
  }

  async function handleBatchReceive() {
    const ws = getWeekStart();
    const supplier = (document.getElementById('recv-supplier') || {}).value || '';
    const batchDt = document.getElementById('recv-batch-dt');
    const dtVal = batchDt ? batchDt.value : '';

    if (!dtVal) { alert('Please select Received At date/time.'); return; }

    const checked = Array.from(document.querySelectorAll('.recv-row-check'))
      .filter(cb => cb.checked)
      .map(cb => cb.getAttribute('data-po'))
      .filter(Boolean);

    if (!checked.length) { alert('Select at least one PO.'); return; }

    const utcISO = new Date(dtVal).toISOString();

    // optimistic UI + state update (no full re-render)
    const payload = checked.map(po => {
      const base = getUIValuesForPO(po);
      const prev = M.receivingRows.find(r => String(r.po_number || '').trim() === po) || {};
      const merged = mergeReceivingRow(po, {
        po_number: po,
        supplier_name: supplier,
        facility_name: base.facility_name,
        received_at_utc: utcISO,
        received_at_local: dtVal,
        received_tz: prev.received_tz || 'viewer-local',
        cartons_received: base.cartons_received,
        cartons_damaged: base.cartons_damaged,
        cartons_noncompliant: base.cartons_noncompliant,
        cartons_replaced: base.cartons_replaced
      });

      // update "Last Received" cell in-place
      const row = document.querySelector(`tr[data-po="${CSS.escape(po)}"]`);
      const cell = row ? row.querySelector('[data-cell="last-received"]') : null;
      if (cell) cell.textContent = fmtLocalFromUtc(merged.received_at_utc);

      return merged;
    });

    renderSummary(computeSummaryAll(M.planRows, M.receivingRows));
    renderCountsForSupplier(M.planRows, M.receivingRows, supplier);
    renderExceptionsPanel();

    // persist
    try {
      setSaveStatus('Saving…', 'saving');
      await api(`/receiving/weeks/${encodeURIComponent(ws)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      setSaveStatus('Saved', 'saved');
    } catch (e) {
      console.warn(e);
      setSaveStatus('Save failed', 'error');
      alert('Save failed. Check connection / server logs.');
    }
  }

  async function loadWeek(ws) {
    if (!ws) return;
    M.ws = ws;
    const lbl = document.getElementById('recv-week-label');
    if (lbl) lbl.textContent = ws;

    const [plan, receiving] = await Promise.all([
      api(`/plan?weekStart=${encodeURIComponent(ws)}`),
      api(`/receiving?weekStart=${encodeURIComponent(ws)}`)
    ]);

    const planRows = Array.isArray(plan) ? plan : (plan?.data || []);
    M.planRows = planRows;
    M.receivingRows = Array.isArray(receiving) ? receiving : [];
    M.suppliers = buildSuppliers(planRows, M.receivingRows);

    renderSuppliers(M.suppliers, M.selectedSupplier);

    const sel = document.getElementById('recv-supplier');
    if (sel) {
      sel.onchange = () => {
        M.selectedSupplier = sel.value;
        renderCurrentSupplierView();
        renderExceptionsPanel();
      };
    }

    const btnReceive = document.getElementById('recv-batch-receive');
    if (btnReceive) btnReceive.onclick = handleBatchReceive;

    renderCurrentSupplierView();
    renderExceptionsPanel();
  }

  // Watch: week changes & hash changes
  let lastWS = '';
  async function tick() {
    try {
      showReceivingIfHash();
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
