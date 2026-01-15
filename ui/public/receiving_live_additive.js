/* receiving_live_additive.js (v1) - Read-only receiving view
   - Uses the same API base meta as index.html
   - Loads plan + receiving rows for selected week
   - Shows Supplier picker -> list of POs + receiving/carton fields
   - Shows a placeholder ticker (we’ll make it “meaningful” next)
*/

(function () {
  const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || '').replace(/\/$/, '');
  const BUSINESS_TZ = document.querySelector('meta[name="business-tz"]')?.content || 'Asia/Shanghai';

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

  // Read the week currently selected by the app
  function getWeekStart() {
    // index.html maintains state.weekStart; fall back to the date input
    const wsFromState = (window.state && window.state.weekStart) ? window.state.weekStart : '';
    const wsFromInput = $('#week-start') ? $('#week-start').value : '';
    return wsFromState || wsFromInput || '';
  }

  function ensureReceivingPage() {
    // Create a page container only when needed.
    let page = document.getElementById('page-receiving');
    if (!page) {
      page = document.createElement('section');
      page.id = 'page-receiving';
      page.className = 'hidden';

      page.innerHTML = `
        <div class="vo-wrap">
          <div class="flex items-center justify-between mb-3">
            <div>
              <div class="text-xl font-semibold">Receiving</div>
              <div class="text-sm text-gray-500">Week: <span id="recv-week-label">—</span></div>
            </div>
            <div class="text-xs text-gray-500">TZ: viewer local (business: ${esc(BUSINESS_TZ)})</div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-12 gap-3">
            <!-- Main -->
            <div class="lg:col-span-9 bg-white rounded-2xl border shadow p-4 min-w-0">
              <div class="flex items-center gap-3 flex-wrap mb-3">
                <div class="text-base font-semibold">Supplier</div>
                <select id="recv-supplier" class="border rounded-md px-2 py-1 text-sm min-w-[280px]">
                  <option value="">Loading…</option>
                </select>
                <div class="text-sm text-gray-500">
                  POs: <span class="font-semibold tabular-nums" id="recv-po-count">0</span>
                  • Received: <span class="font-semibold tabular-nums" id="recv-po-received">0</span>
                </div>
              </div>

              <div class="overflow-auto border rounded-xl">
                <table class="w-full text-sm">
                  <thead class="bg-gray-50">
                    <tr class="text-gray-500">
                      <th class="text-left py-2 px-2">PO</th>
                      <th class="text-left py-2 px-2">Plan Facility</th>
                      <th class="text-left py-2 px-2">Received At</th>
                      <th class="text-right py-2 px-2">Cartons In</th>
                      <th class="text-right py-2 px-2">Damaged</th>
                      <th class="text-right py-2 px-2">Non-compliant</th>
                      <th class="text-right py-2 px-2">Replaced</th>
                    </tr>
                  </thead>
                  <tbody id="recv-body">
                    <tr><td colspan="7" class="text-center text-xs text-gray-400 py-6">Loading…</td></tr>
                  </tbody>
                </table>
              </div>

              <div class="mt-3 text-xs text-gray-500">
                v1 is read-only. Next step we’ll add “Receive” + editable fields + autosave to backend.
              </div>
            </div>

            <!-- Ticker -->
            <div class="lg:col-span-3 bg-white rounded-2xl border shadow p-4 min-w-0">
              <div class="text-base font-semibold mb-2">Live Ticker</div>
              <div id="recv-ticker" class="space-y-2 text-sm">
                <div class="text-xs text-gray-400">Ticker will populate once we start saving receiving events.</div>
              </div>
            </div>
          </div>
        </div>
      `;

      // Insert after dashboard so it behaves like a “page”
      const dashboard = document.getElementById('page-dashboard');
      if (dashboard && dashboard.parentNode) {
        dashboard.parentNode.insertBefore(page, dashboard.nextSibling);
      } else {
        document.body.appendChild(page);
      }
    }

    return page;
  }

  function showReceivingIfHash() {
    const pageReceiving = ensureReceivingPage();

    // Your app already uses hash for Exec (#exec). We'll mirror with #receiving.
    const show = (location.hash || '').toLowerCase().includes('receiving');

    const pageDashboard = document.getElementById('page-dashboard');
    if (show) {
      if (pageDashboard) pageDashboard.classList.add('hidden');
      pageReceiving.classList.remove('hidden');
    } else {
      pageReceiving.classList.add('hidden');
      if (pageDashboard) pageDashboard.classList.remove('hidden');
    }
  }

  function fmtLocalFromUtc(isoUtc) {
    if (!isoUtc) return '';
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return '';
    // viewer local time
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(d);
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  function buildViewModel(planRows, receivingRows) {
    // Map receiving by PO for this week
    const recvByPO = new Map();
    for (const r of receivingRows || []) {
      const po = String(r.po_number || '').trim();
      if (!po) continue;
      recvByPO.set(po, r);
    }

    // Supplier list from plan; include receiving rows that are unplanned
    const suppliersPlan = (planRows || []).map(p => String(p.supplier_name || '').trim()).filter(Boolean);
    const suppliersRecv = (receivingRows || []).map(r => String(r.supplier_name || '').trim()).filter(Boolean);
    const suppliers = uniq([...suppliersPlan, ...suppliersRecv]).sort((a,b)=>a.localeCompare(b));

    return { recvByPO, suppliers };
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

  function renderTableForSupplier(planRows, receivingRows, supplier) {
    const tbody = document.getElementById('recv-body');
    if (!tbody) return;

    const recvByPO = new Map();
    for (const r of receivingRows || []) {
      const po = String(r.po_number || '').trim();
      if (!po) continue;
      recvByPO.set(po, r);
    }

    // POs from plan for this supplier
    const planned = (planRows || [])
      .filter(p => String(p.supplier_name || '').trim() === supplier)
      .map(p => ({
        po: String(p.po_number || '').trim(),
        planFacility: String(p.facility_name || '').trim()
      }))
      .filter(x => x.po);

    // Also include unplanned receiving POs for this supplier (not in plan list)
    const plannedPOSet = new Set(planned.map(x => x.po));
    const unplanned = (receivingRows || [])
      .filter(r => String(r.supplier_name || '').trim() === supplier)
      .map(r => String(r.po_number || '').trim())
      .filter(po => po && !plannedPOSet.has(po))
      .map(po => ({ po, planFacility: '(Unplanned)' }));

    const rows = [...planned, ...unplanned].sort((a,b)=>a.po.localeCompare(b.po));

    const receivedCount = rows.reduce((acc, x) => acc + (recvByPO.get(x.po)?.received_at_utc ? 1 : 0), 0);
    const poCountEl = document.getElementById('recv-po-count');
    const poRecvEl = document.getElementById('recv-po-received');
    if (poCountEl) poCountEl.textContent = String(rows.length);
    if (poRecvEl) poRecvEl.textContent = String(receivedCount);

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-xs text-gray-400 py-6">No POs for this supplier in this week’s plan.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(x => {
      const r = recvByPO.get(x.po) || {};
      const receivedAt = fmtLocalFromUtc(r.received_at_utc);
      return `
        <tr class="border-t">
          <td class="py-2 px-2 font-semibold">${esc(x.po)}</td>
          <td class="py-2 px-2">${esc(x.planFacility || '')}</td>
          <td class="py-2 px-2">${esc(receivedAt || '')}</td>
          <td class="py-2 px-2 text-right tabular-nums">${Number(r.cartons_received || 0)}</td>
          <td class="py-2 px-2 text-right tabular-nums">${Number(r.cartons_damaged || 0)}</td>
          <td class="py-2 px-2 text-right tabular-nums">${Number(r.cartons_noncompliant || 0)}</td>
          <td class="py-2 px-2 text-right tabular-nums">${Number(r.cartons_replaced || 0)}</td>
        </tr>
      `;
    }).join('');
  }

  async function loadAndRender(ws) {
    if (!ws) return;

    ensureReceivingPage();
    const lbl = document.getElementById('recv-week-label');
    if (lbl) lbl.textContent = ws;

    // Fetch plan + receiving for the week
    const [plan, receiving] = await Promise.all([
      api(`/plan?weekStart=${encodeURIComponent(ws)}`),
      api(`/receiving?weekStart=${encodeURIComponent(ws)}`)
    ]);

    // Plan API returns {week_start,data?} in some implementations; index.html uses /plan/weeks/:ws.
    // Your server.js returns the parsed JSON data directly from /plan?weekStart=... (array).
    const planRows = Array.isArray(plan) ? plan : (plan?.data || []);

    const { suppliers } = buildViewModel(planRows, receiving);
    // Default: first supplier
    renderSuppliers(suppliers, '');
    const sel = document.getElementById('recv-supplier');
    const supplier = sel ? sel.value : (suppliers[0] || '');

    renderTableForSupplier(planRows, receiving, supplier);

    if (sel) {
      sel.onchange = () => renderTableForSupplier(planRows, receiving, sel.value);
    }
  }

  // Watch: week changes & hash changes
  let lastWS = '';
  async function tick() {
    try {
      showReceivingIfHash();
      const ws = getWeekStart();
      if (ws && ws !== lastWS) {
        lastWS = ws;
        // only load when receiving is visible OR keep ready in background (your call).
        // We'll load regardless so it’s instant when user switches hash.
        await loadAndRender(ws);
      }
    } catch (e) {
      // Don’t crash the app if receiving fails
      console.warn('[receiving] load error:', e);
    }
  }

  window.addEventListener('hashchange', () => {
    showReceivingIfHash();
  });

  // initial and interval
  tick();
  setInterval(tick, 800);
})();
