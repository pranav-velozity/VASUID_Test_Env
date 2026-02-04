/* receiving_live_additive.js (v23) - Receiving page (editable, week nav, summary, ticker scaffold)
   - Loaded via <script src="/receiving_live_additive.js" defer></script> from index.html
   - Binds to global week selector (#week-start / window.state.weekStart)
   - Loads plan + receiving rows for selected week
   - Allows per-PO edits and saves to backend (/receiving/weeks/:ws)
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

  function fmtLocalFromUtc(isoUtc) {
    if (!isoUtc) return '';
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(d);
  }


  function weekEndISO(ws) {
    const d = new Date(ws);
    if (Number.isNaN(d.getTime())) return ws;
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  }

async function fetchCompletedRecordsForWeek(ws) {
  // Match index.html contract: /records?from=<ws>&to=<we>&status=complete&limit=50000
  // Response can be an array OR { records: [...] } depending on backend version.
  try {
    const we = weekEndISO(ws);
    const d = await api(`/records?from=${encodeURIComponent(ws)}&to=${encodeURIComponent(we)}&status=complete&limit=50000`);
    return Array.isArray(d) ? d : (d?.records || []);
  } catch (e) {
    console.warn('[receiving] failed to load records for carton out', e);
    return [];
  }
}


// Ticker removed (replaced by Exceptions panel). Keep no-op for legacy calls.
function addTicker() {}
  // Build a per-PO "Carton Out" map from Ops records (mobile bins used in the week).
  // Definition: number of UNIQUE mobile bins (cartons) for each PO in the selected week.
function computeCartonsOutByPOFromRecords(records) {
  // Definition: number of UNIQUE mobile bins for each PO in the selected week.
  const sets = new Map(); // po -> Set(mobile_bin)
  for (const r of records || []) {
    if (!r) continue;
    // Records are usually already status=complete, but be safe.
    if (r.status && String(r.status).toLowerCase() !== 'complete') continue;
    const po = String(r.po_number || r.po || r.PO || '').trim();
    if (!po) continue;
    const mb = String(r.mobile_bin || r.bin || r.mobileBin || '').trim();
    if (!mb) continue;
    if (!sets.has(po)) sets.set(po, new Set());
    sets.get(po).add(mb);
  }
  const byPO = new Map();
  for (const [po, set] of sets.entries()) byPO.set(po, set.size);
  return byPO;
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

  // Format a UTC ISO timestamp into a simple, Excel-friendly local datetime string.
  // Output: YYYY-MM-DD HH:MM (viewer local)
  function fmtLocalYMDHMFromUtc(isoUtc) {
    if (!isoUtc) return '';
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  // -------------------- CSV parsing & date normalization (upload) --------------------
  function stripBOM(s) {
    return (s && s.charCodeAt(0) === 0xFEFF) ? s.slice(1) : s;
  }

  // Minimal RFC4180-ish CSV parser (handles quotes, commas, newlines)
  function parseCSV(text) {
    const out = [];
    const rows = [];
    let i = 0;
    let field = '';
    let row = [];
    let inQuotes = false;

    const pushField = () => {
      row.push(field);
      field = '';
    };
    const pushRow = () => {
      // trim trailing empty line
      if (row.length === 1 && row[0] === '' && rows.length === 0) return;
      rows.push(row);
      row = [];
    };

    while (i < text.length) {
      const c = text[i];

      if (inQuotes) {
        if (c === '"') {
          const next = text[i + 1];
          if (next === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += c;
        i += 1;
        continue;
      }

      if (c === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (c === ',') {
        pushField();
        i += 1;
        continue;
      }
      if (c === '\n') {
        pushField();
        pushRow();
        i += 1;
        continue;
      }
      if (c === '\r') {
        // ignore CR (handle CRLF)
        i += 1;
        continue;
      }
      field += c;
      i += 1;
    }
    pushField();
    pushRow();

    if (!rows.length) return [];
    const header = rows[0].map(h => stripBOM(String(h || '').trim()).toLowerCase());
    for (let r = 1; r < rows.length; r += 1) {
      const obj = {};
      for (let c = 0; c < header.length; c += 1) {
        const key = header[c] || '';
        if (!key) continue;
        obj[key] = (rows[r][c] ?? '').toString().trim();
      }
      // skip completely empty rows
      if (Object.values(obj).every(v => String(v || '').trim() === '')) continue;
      out.push(obj);
    }
    return out;
  }

  function normalizeISODateYMD(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Accept week_start formats like:
  //  - YYYY-MM-DD
  //  - M/D/YYYY or MM/DD/YYYY
  //  - YYYY/M/D
  function parseWeekStartToISO(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    const m1 = v.match(/^\d{4}-\d{2}-\d{2}$/);
    if (m1) return v;

    const m2 = v.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
    if (m2) {
      const mm = m2[1].padStart(2, '0');
      const dd = m2[2].padStart(2, '0');
      return `${m2[3]}-${mm}-${dd}`;
    }

    const m3 = v.match(/^\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*$/);
    if (m3) {
      const mm = m3[2].padStart(2, '0');
      const dd = m3[3].padStart(2, '0');
      return `${m3[1]}-${mm}-${dd}`;
    }

    // last resort Date parse
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return normalizeISODateYMD(d);
    return '';
  }

  // Parse received_at_local values that users will type in Excel.
  // Accepted:
  //  - YYYY-MM-DD HH:MM
  //  - YYYY-MM-DDTHH:MM
  //  - MM/DD/YYYY HH:MM AM/PM
  function parseLocalDateTimeToDate(s) {
    const v = String(s || '').trim();
    if (!v) return null;

    // YYYY-MM-DD HH:MM
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (m) {
      const [_, Y, M, D, hh, mi] = m;
      return new Date(Number(Y), Number(M) - 1, Number(D), Number(hh), Number(mi), 0, 0);
    }

    // YYYY-MM-DDTHH:MM (datetime-local)
    m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (m) {
      const [_, Y, M, D, hh, mi] = m;
      return new Date(Number(Y), Number(M) - 1, Number(D), Number(hh), Number(mi), 0, 0);
    }

    // MM/DD/YYYY HH:MM AM/PM
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (m) {
      let hh = Number(m[4]);
      const mi = Number(m[5]);
      const ampm = String(m[6] || '').toUpperCase();
      if (ampm === 'PM' && hh < 12) hh += 12;
      if (ampm === 'AM' && hh === 12) hh = 0;
      return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hh, mi, 0, 0);
    }

    // Fall back to Date parsing (may vary by browser/locale)
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
    return null;
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  // -------------------- Exports (week-level, all suppliers) --------------------
  // We generate CSV (Excel-friendly) and a print-to-PDF supplier summary.
  function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

  function computePOStatus(receivedAtUtc, cutoffUtc) {
    if (!receivedAtUtc) return '';
    const d = new Date(receivedAtUtc);
    const c = new Date(cutoffUtc);
    if (Number.isNaN(d.getTime()) || Number.isNaN(c.getTime())) return '';
    return (d.getTime() <= c.getTime()) ? 'On-time' : 'Delayed';
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
        cartons_out: Number(M.cartonsOutByPO?.get(po) ?? 0) || 0,
        damaged: Number(r.cartons_damaged || 0) || 0,
        non_compliant: Number(r.cartons_noncompliant || 0) || 0,
        replaced: Number(r.cartons_replaced || 0) || 0,
        // Editable, Excel-friendly local datetime (viewer local)
        received_at_local: fmtLocalYMDHMFromUtc(receivedAtUtc),
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

  function businessCutoffUtcISO(weekStartISO) {
    // Monday 12:00 in Asia/Shanghai => 04:00 UTC (same date) because UTC+8
    // weekStartISO is expected to be Monday date string YYYY-MM-DD
    const hourUtc = 12 - BUSINESS_UTC_OFFSET_HOURS; // 4
    const hh = String(hourUtc).padStart(2, '0');
    return `${weekStartISO}T${hh}:00:00.000Z`;
  }

  // --- State cache for module ---
  const M = {
    ws: '',
    planRows: [],
    receivingRows: [],
    cartonsOutByPO: new Map(),
    suppliers: [],
    selectedSupplier: '',
    // per-PO save debounce timers
    saveTimers: new Map(),
    // ticker items (latest first)
    ticker: []
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
<div class="flex items-center gap-2 flex-wrap flex-1 min-w-0">
  <label class="text-sm text-gray-600">Received At</label>
  <input id="recv-batch-dt" type="datetime-local"
         class="border rounded-md px-2 py-1 text-sm"
         aria-label="Batch received at" />
  <button id="recv-batch-now" class="cmd cmd--ghost" title="Set to now">Now</button>
  <button id="recv-batch-receive" class="cmd cmd--ghost"
          style="border:1px solid #990033;color:#990033"
          title="Apply received time to selected POs">
    Receive Selected
  </button>

  <input id="recv-ul-week-csv-input" type="file" accept=".csv,text/csv" style="display:none" />
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
  <th class="text-left py-2 px-2 w-[40px]">
    <input id="recv-check-all" type="checkbox" />
  </th>
  <th class="text-left py-2 px-2">PO</th>
  <th class="text-left py-2 px-2">Facility</th>
  <th class="text-right py-2 px-2">Cartons In</th>
  <th class="text-right py-2 px-2" style="color:#990033">Carton Out</th>
  <th class="text-right py-2 px-2">Damaged</th>
  <th class="text-right py-2 px-2">Non-compliant</th>
  <th class="text-right py-2 px-2">Replaced</th>
  <th class="text-left py-2 px-2">Last Received</th>
</tr>

                </thead>
                <tbody id="recv-body">
                  <tr><td colspan="9" class="text-center text-xs text-gray-400 py-6">Loading…</td></tr>
                </tbody>
              </table>
            </div>

            <div class="mt-3 text-xs text-gray-500">
              Enter carton/QC counts, then click <span class="font-semibold">Receive</span> to confirm (it will stamp "Received At" with now if empty). Changes auto-save.
            </div>
          </div>


<!-- Right column: actions ABOVE Exceptions (outside the tile) -->
<div class="lg:col-span-4 min-w-0 flex flex-col">
  <div class="flex justify-end mb-3">
    <div class="inline-flex items-center gap-1 bg-white border rounded-xl shadow-sm px-1 py-1">
      <button id="recv-dl-week-csv"
              class="px-3 py-2 rounded-lg text-sm font-medium hover:bg-[#990033]/5"
              style="color:#990033"
              title="Download week receiving as CSV (Excel)">
        ⤓ Download Week
      </button>

      <button id="recv-ul-week-csv"
              class="px-3 py-2 rounded-lg text-sm font-medium hover:bg-[#990033]/5"
              style="color:#990033"
              title="Upload week receiving from CSV">
        ⤒ Upload Week
      </button>

      <button id="recv-dl-supplier-pdf"
              class="px-3 py-2 rounded-lg text-sm font-medium hover:bg-[#990033]/5"
              style="color:#990033"
              title="Open supplier summary for printing to PDF">
        📄 Supplier PDF
      </button>
    </div>
  </div>

  <!-- Exceptions (view-only) -->
  <div class="bg-white rounded-2xl border shadow p-4 min-w-0 flex flex-col" style="height: calc(100vh - 420px); border-color:#990033;">
            <div class="text-lg font-semibold mb-1">Exceptions</div>


            <div class="text-xs text-gray-500 mb-2">Supplier-level outliers for this week (view-only).</div>
            <div class="text-xs text-gray-500 mb-3">Week cutoff (business): <span class="font-semibold" id="recv-cutoff-local">—</span></div>
            <div id="recv-exceptions" class="space-y-3 text-sm overflow-auto flex-1 pr-1">
              <div class="text-xs text-gray-400">Loading…</div>
            </div>
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
              <span class="text-gray-500">On-time by cutoff:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-ontime">0</span>
              <span class="text-gray-300 px-2">|</span>
              <span class="text-gray-500">Delayed:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-delayed">0</span>

              <span class="text-gray-300 px-2">|</span>

              <span class="text-gray-500">Cartons In:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-cartons">0</span>
              <span class="text-gray-300 px-2">|</span>
              <span class="text-gray-500">Cartons Out:</span>
              <span class="font-semibold tabular-nums" id="recv-sum-cartonsout" style="color:#990033">0</span>
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
              <span id="recv-sum-health" class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border">—</span>
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

    // Wire Prev / Next week buttons (simple, no guessing)
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

    return page;
  }

  function showReceivingIfHash() {
    const pageReceiving = ensureReceivingPage();
    const show = (location.hash || '').toLowerCase().includes('receiving');

    // IMPORTANT: Only take control when we're on #receiving.
    // When the hash is something else (e.g., #exec, #intake), we must NOT
    // force the dashboard visible, otherwise we break other modules' routing.
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

  // (ticker removed)

function computeSummaryAll(planRows, receivingRows) {
  const cutoffUtc = businessCutoffUtcISO(M.ws);
  const cutoff = new Date(cutoffUtc);
  const now = new Date();

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
  let cartonsOut = 0;
  let damaged = 0;
  let noncompliant = 0;
  let replaced = 0;
  let ontime = 0;

  for (const po of plannedMap.keys()) {
    const r = receivingByPO.get(po);
    cartonsOut += Number(M.cartonsOutByPO?.get(po) ?? 0) || 0;
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

  // If we're past cutoff, anything not on-time is effectively delayed.
  // Before cutoff, only received-after-cutoff entries can be delayed.
  const delayed = (now.getTime() > cutoff.getTime())
    ? Math.max(0, expected - ontime)
    : Math.max(0, received - ontime);

  return { expected, received, cartons, cartonsOut, damaged, noncompliant, replaced, ontime, delayed, cutoffUtc };
}


  function renderSummary(sum) {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };
    set('recv-sum-expected', sum.expected);
    set('recv-sum-received', sum.received);
    set('recv-sum-cartons', sum.cartons);
    set('recv-sum-cartonsout', sum.cartonsOut ?? 0);
    set('recv-sum-damaged', sum.damaged ?? 0);
    set('recv-sum-nonc', sum.noncompliant ?? 0);
    set('recv-sum-replaced', sum.replaced ?? 0);
    set('recv-sum-ontime', sum.ontime);
    set('recv-sum-delayed', sum.delayed);

    // Minimalist emphasis (no motion)
    const healthEl = document.getElementById('recv-sum-health');
    const health = (sum.expected === 0) ? '—' : ((Number(sum.delayed) || 0) > 0 ? 'Delayed' : 'On-track');
    if (healthEl) {
      healthEl.textContent = health;
      healthEl.className = (health === 'Delayed')
        ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-red-300 text-red-700 bg-red-50'
        : (health === 'On-track')
          ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-green-300 text-green-700 bg-green-50'
          : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-gray-200 text-gray-500 bg-gray-50';
    }

    const setCls = (id, on, onCls, offCls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = on ? onCls : offCls;
    };

    setCls('recv-sum-delayed', (Number(sum.delayed) || 0) > 0,
      'font-semibold tabular-nums text-red-700',
      'font-semibold tabular-nums text-gray-800');

    setCls('recv-sum-nonc', (Number(sum.noncompliant) || 0) > 0,
      'font-semibold tabular-nums text-red-700',
      'font-semibold tabular-nums text-gray-800');

    setCls('recv-sum-replaced', (Number(sum.replaced) || 0) > 0,
      'font-semibold tabular-nums text-red-700',
      'font-semibold tabular-nums text-gray-800');

    setCls('recv-sum-damaged', (Number(sum.damaged) || 0) > 0,
      'font-semibold tabular-nums text-amber-700',
      'font-semibold tabular-nums text-gray-800');
  }

  function wireRowInputs(ws, supplier, po, planFacility, existing) {
    const row = document.querySelector(`tr[data-po="${CSS.escape(po)}"]`);
    if (!row) return;

    const facilityInput = row.querySelector('input[data-f="facility"]');
    const receivedInput = row.querySelector('input[data-f="received_at"]');
    const cartonsInput = row.querySelector('input[data-f="cartons_received"]');
    const damagedInput = row.querySelector('input[data-f="cartons_damaged"]');
    const noncInput = row.querySelector('input[data-f="cartons_noncompliant"]');
    const replInput = row.querySelector('input[data-f="cartons_replaced"]');
    const receiveBtn = row.querySelector('button[data-act="receive"]');

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';

    function currentPayload() {
      const facility_name = (facilityInput?.value || planFacility || '').trim();
      const receivedLocal = (receivedInput?.value || '').trim(); // datetime-local value
      const received_at_local = receivedLocal;
      const received_at_utc = receivedLocal ? new Date(receivedLocal).toISOString() : '';
      return {
        po_number: po,
        supplier_name: supplier,
        facility_name,
        received_at_local,
        received_at_utc,
        received_tz: tz,
        cartons_received: Number(cartonsInput?.value || 0) || 0,
        cartons_damaged: Number(damagedInput?.value || 0) || 0,
        cartons_noncompliant: Number(noncInput?.value || 0) || 0,
        cartons_replaced: Number(replInput?.value || 0) || 0
      };
    }

    async function saveNow() {
      const payload = currentPayload();
      // minimal: allow saving cartons/QC even if received_at empty
      await api(`/receiving/weeks/${encodeURIComponent(ws)}`, {
        method: 'PUT',
        body: JSON.stringify([payload])
      });
      // Update cache
      const idx = M.receivingRows.findIndex(r => String(r.po_number || '').trim() === po);
      const merged = Object.assign({}, existing || {}, payload, { week_start: ws, updated_at: nowISO() });
      if (idx >= 0) M.receivingRows[idx] = merged;
      else M.receivingRows.push(merged);

      addTicker(`Updated PO ${po} for ${supplier} @ ${payload.facility_name || planFacility || ''}`);
      // Refresh counts/summary for current supplier without full reload
      renderCurrentSupplierView();
    }

    function debounceSave() {
      const key = `${ws}|||${po}`;
      if (M.saveTimers.has(key)) clearTimeout(M.saveTimers.get(key));
      M.saveTimers.set(key, setTimeout(() => {
        saveNow().catch(e => console.warn('[receiving] save error', e));
      }, 500));
    }

    if (receiveBtn) {
      receiveBtn.onclick = async () => {
        if (!receivedInput) return;

        // Receive = confirm receipt. If "Received At" is empty, default to NOW (viewer local).
        if (!String(receivedInput.value || '').trim()) {
          receivedInput.value = nowDateTimeLocalValue();
          receivedInput.style.borderColor = '#990033';
        }

        // Optimistic UI update (so the user sees the confirmation immediately)
        const payload = currentPayload();
        const idx = M.receivingRows.findIndex(r => String(r.po_number || '').trim() === po);
        const merged = Object.assign({}, existing || {}, payload, { week_start: ws, updated_at: nowISO() });
        if (idx >= 0) M.receivingRows[idx] = merged;
        else M.receivingRows.push(merged);

        addTicker(`Received PO ${po} for ${supplier} at ${payload.facility_name || planFacility || ''}`);
        renderCurrentSupplierView();

        // Persist immediately (no debounce)
        try {
          await api(`/receiving/weeks/${encodeURIComponent(ws)}`, {
            method: 'PUT',
            body: JSON.stringify([payload])
          });
        } catch (e) {
          console.warn('[receiving] save error', e);
          addTicker(`⚠️ Save failed for PO ${po} (check network)`);
        }

      };
    }

    for (const inp of [facilityInput, receivedInput, cartonsInput, damagedInput, noncInput, replInput]) {
      if (!inp) continue;
      inp.onchange = debounceSave;
      inp.onblur = debounceSave;
      // allow quick typing without excessive saves
      inp.oninput = () => {
        // only debounce numeric/text fields, not for performance
        debounceSave();
      };
    }
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
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-xs text-gray-400 py-6">No POs for this supplier in this week’s plan.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(x => {
      const r = receivingByPO.get(x.po) || {};
      const facility = String(r.facility_name || x.planFacility || '').trim();
      const receivedAtLocalInput = toDateTimeLocalValue(r.received_at_utc);
      const cartonsOut = (M.cartonsOutByPO && M.cartonsOutByPO.has(x.po)) ? (Number(M.cartonsOutByPO.get(x.po)) || 0)
        : (Number(r.cartons_out || r.mobile_bin_count || r.mobile_bin_counts || r.mobile_bins || r.mobile_bins_count || r.mobile_bin_total || r.mobile_bin_total_count || 0) || 0);

      return `
<tr class="border-t">
  <td class="py-2 px-2">
    <input class="recv-row-check" type="checkbox" data-po="${esc(x.po)}" />
  </td>
  <td class="py-2 px-2 font-semibold">${esc(x.po)}</td>
  <td class="py-2 px-2">
    <input class="recv-facility border rounded px-2 py-1 text-sm w-[120px]"
           data-po="${esc(x.po)}"
           value="${esc(r.facility_name || x.planFacility || '')}" />
  </td>

  <td class="py-2 px-2 text-right">
    <input class="recv-num border rounded px-2 py-1 text-sm w-[70px] text-right"
           data-field="cartons_received" data-po="${esc(x.po)}"
           value="${Number(r.cartons_received || 0)}" />
  </td>
  <td class="py-2 px-2 text-right">
    <div class="px-2 py-1 text-sm w-[70px] text-right rounded border tabular-nums"
         style="background:#fff5f7;border-color:#e8b3c6;color:#990033"
         title="Carton Out (Mobile Bin count, read-only)">
      ${cartonsOut}
    </div>
  </td>
  <td class="py-2 px-2 text-right">
    <input class="recv-num border rounded px-2 py-1 text-sm w-[70px] text-right"
           data-field="cartons_damaged" data-po="${esc(x.po)}"
           value="${Number(r.cartons_damaged || 0)}" />
  </td>
  <td class="py-2 px-2 text-right">
    <input class="recv-num border rounded px-2 py-1 text-sm w-[85px] text-right"
           data-field="cartons_noncompliant" data-po="${esc(x.po)}"
           value="${Number(r.cartons_noncompliant || 0)}" />
  </td>
  <td class="py-2 px-2 text-right">
    <input class="recv-num border rounded px-2 py-1 text-sm w-[70px] text-right"
           data-field="cartons_replaced" data-po="${esc(x.po)}"
           value="${Number(r.cartons_replaced || 0)}" />
  </td>

  <td class="py-2 px-2 text-sm text-gray-600">
    ${esc(fmtLocalFromUtc(r.received_at_utc) || '')}
  </td>
</tr>
`;
    }).join('');

    // wire inputs to autosave
    for (const x of rows) {
      const existing = receivingByPO.get(x.po) || null;
      wireRowInputs(M.ws, supplier, x.po, x.planFacility, existing);
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
    const sum = computeSummaryAll(M.planRows, M.receivingRows);
    renderSummary(sum);
    renderExceptionsPanel(M.planRows, M.receivingRows, ws);
  }

  function computeSupplierStats(planRows, receivingRows, weekStartISO) {
    const cutoffUtc = businessCutoffUtcISO(weekStartISO);
    const cutoff = new Date(cutoffUtc);
    const now = new Date();

    const recvByPO = getReceivingByPO(receivingRows);
    const seenPO = new Set();
    const stats = new Map();

    for (const p of planRows || []) {
      const po = String(p.po_number || '').trim();
      const supplier = String(p.supplier_name || '').trim() || '—';
      if (!po) continue;
      if (seenPO.has(po)) continue; // plan may have multiple rows per PO
      seenPO.add(po);

      if (!stats.has(supplier)) {
        stats.set(supplier, {
          supplier,
          expected: 0,
          received: 0,
          ontime: 0,
          delayed: 0,
          cartons: 0,
          damaged: 0,
          noncompliant: 0,
          replaced: 0
        });
      }
      const s = stats.get(supplier);
      s.expected += 1;

      const r = recvByPO.get(po);
      if (r && r.received_at_utc) {
        s.received += 1;
        s.cartons += Number(r.cartons_received || 0) || 0;
        s.damaged += Number(r.cartons_damaged || 0) || 0;
        s.noncompliant += Number(r.cartons_noncompliant || 0) || 0;
        s.replaced += Number(r.cartons_replaced || 0) || 0;

        const d = new Date(r.received_at_utc);
        if (!Number.isNaN(d.getTime()) && d.getTime() <= cutoff.getTime()) s.ontime += 1;
        else s.delayed += 1;
      } else {
        // Not received: becomes delayed only after cutoff
        if (now.getTime() > cutoff.getTime()) s.delayed += 1;
      }
    }

    return {
      cutoffUtc,
      items: Array.from(stats.values())
    };
  }

  function renderExceptionsPanel(planRows, receivingRows, weekStartISO) {
    const wrap = document.getElementById('recv-exceptions');
    const cutoffEl = document.getElementById('recv-cutoff-local');
    if (cutoffEl) cutoffEl.textContent = fmtLocalFromUtc(businessCutoffUtcISO(weekStartISO));
    if (!wrap) return;

    const { items } = computeSupplierStats(planRows, receivingRows, weekStartISO);

    const top = (arr, keyFn, n = 5) => arr
      .slice()
      .sort((a, b) => (keyFn(b) - keyFn(a)) || String(a.supplier).localeCompare(String(b.supplier)))
      .filter(x => keyFn(x) > 0)
      .slice(0, n);

    const card = (title, rows, rightFmt) => {
      const body = rows.length
        ? rows.map(r => `
          <div class="flex items-center justify-between py-1">
            <div class="text-sm text-gray-800 truncate pr-3" title="${esc(r.supplier)}">${esc(r.supplier)}</div>
            <div class="text-sm font-semibold tabular-nums">${rightFmt(r)}</div>
          </div>
        `).join('')
        : `<div class="text-xs text-gray-400">None</div>`;

      return `
        <div class="border rounded-2xl p-3 bg-white">
          <div class="text-sm font-semibold mb-2">${esc(title)}</div>
          ${body}
        </div>
      `;
    };

    const mostDelayed = top(items, x => Number(x.delayed) || 0);
    const mostNonc = top(items, x => Number(x.noncompliant) || 0);
    const mostDamaged = top(items, x => Number(x.damaged) || 0);
    const mostReplaced = top(items, x => Number(x.replaced) || 0);

    wrap.innerHTML = [
      card('Most delayed POs', mostDelayed, r => `${r.delayed} / ${r.expected}`),
      card('Most non-compliant cartons', mostNonc, r => String(r.noncompliant)),
      card('Most damaged cartons', mostDamaged, r => String(r.damaged)),
      card('Most replaced cartons', mostReplaced, r => String(r.replaced))
    ].join('');
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

    // Load completed records for Carton Out (self-contained)
    M.completedRecords = await fetchCompletedRecordsForWeek(ws);
    M.cartonsOutByPO = computeCartonsOutByPOFromRecords(M.completedRecords);

    renderSuppliers(M.suppliers, M.selectedSupplier);
    const sel = document.getElementById('recv-supplier');
    if (sel) {
      sel.onchange = () => {
        M.selectedSupplier = sel.value;
        renderCurrentSupplierView();
      };
    }

    // initial render
    renderCurrentSupplierView();

// Header controls wiring
const btnNow = document.getElementById('recv-batch-now');
const batchDt = document.getElementById('recv-batch-dt');
const btnReceive = document.getElementById('recv-batch-receive');
const checkAll = document.getElementById('recv-check-all');
	const btnCsv = document.getElementById('recv-dl-week-csv');
	const btnUp = document.getElementById('recv-ul-week-csv');
	const upInput = document.getElementById('recv-ul-week-csv-input');
	const btnPdf = document.getElementById('recv-dl-supplier-pdf');

if (btnNow && batchDt) btnNow.onclick = () => { batchDt.value = dtLocalNow(); };

if (checkAll) {
  checkAll.onchange = () => {
    document.querySelectorAll('.recv-row-check').forEach(cb => { cb.checked = checkAll.checked; });
  };
}

	// Downloads (week-level, all suppliers)
	if (btnCsv) {
	  btnCsv.onclick = () => {
	    const ws = getWeekStart();
	    if (!ws) return;
	    const rows = buildWeekExportRows(M.planRows, M.receivingRows, ws);
	    const header = ['week_start','supplier_name','facility_name','po_number','cartons_in','cartons_out','damaged','non_compliant','replaced','received_at_local','last_received_local','received_at_utc','cutoff_utc','status'];
	    const lines = [
	      header.join(','),
	      ...rows.map(r => header.map(h => csvEscape(r[h])).join(','))
	    ];
	    downloadTextFile(`receiving_week_${ws}.csv`, lines.join('\n'), 'text/csv');
	  };
	}

	// Upload (week-level, all suppliers)
	if (btnUp && upInput) {
	  btnUp.onclick = () => {
	    upInput.value = '';
	    upInput.click();
	  };

	  upInput.onchange = async () => {
	    const file = upInput.files && upInput.files[0];
	    if (!file) return;

	    const wsSelected = getWeekStart();
	    if (!wsSelected) {
	      alert('No week selected.');
	      return;
	    }

	    let text = '';
	    try {
	      text = await file.text();
	    } catch (e) {
	      console.warn(e);
	      alert('Could not read CSV file.');
	      return;
	    }

	    const rows = parseCSV(text);
	    if (!rows.length) {
	      alert('CSV appears empty.');
	      return;
	    }

	    // Build lookup sources
	    const poIndex = buildWeekPOIndex(M.planRows);
	    const recvByPO = getReceivingByPO(M.receivingRows);
	
	    const errors = [];
	    let weekMismatchCount = 0;
	    const payload = [];
	
	    const pick = (obj, keys) => {
	      for (const k of keys) {
	        const v = obj[k];
	        if (v !== undefined && String(v).trim() !== '') return String(v).trim();
	      }
	      return '';
	    };
	
	    const pickNum = (obj, keys, fallback) => {
	      const raw = pick(obj, keys);
	      if (raw === '') return fallback;
	      const n = Number(raw);
	      return Number.isFinite(n) ? n : fallback;
	    };

	    for (let i = 0; i < rows.length; i += 1) {
	      const r = rows[i] || {};
	      const rowNum = i + 2; // header is row 1
	
	      const po = pick(r, ['po_number', 'po']);
	      if (!po) {
	        errors.push(`Row ${rowNum}: missing po_number`);
	        continue;
	      }
	
	      const wsRaw = pick(r, ['week_start', 'week']);
	      const wsCSV = wsRaw ? parseWeekStartToISO(wsRaw) : '';
	      if (wsCSV && wsCSV !== wsSelected) weekMismatchCount += 1;

	      const plan = poIndex.get(po) || {};
	      const existing = recvByPO.get(po) || {};

	      const supplier = pick(r, ['supplier_name', 'supplier']) || String(existing.supplier_name || plan.supplier || '').trim();
	      const facility = pick(r, ['facility_name', 'facility']) || String(existing.facility_name || plan.planFacility || '').trim();

	      const cartons_received = pickNum(r, ['cartons_in', 'cartons_received', 'cartons'], Number(existing.cartons_received || 0) || 0);
	      const cartons_damaged = pickNum(r, ['damaged', 'cartons_damaged'], Number(existing.cartons_damaged || 0) || 0);
	      const cartons_noncompliant = pickNum(r, ['non_compliant', 'non-compliant', 'cartons_noncompliant', 'noncompliant'], Number(existing.cartons_noncompliant || 0) || 0);
	      const cartons_replaced = pickNum(r, ['replaced', 'cartons_replaced'], Number(existing.cartons_replaced || 0) || 0);

	      const receivedLocal = pick(r, ['received_at_local', 'received_at', 'last_received_local']);
	      let received_at_local = String(existing.received_at_local || '').trim();
	      let received_at_utc = String(existing.received_at_utc || '').trim();

	      if (receivedLocal) {
	        const d = parseLocalDateTimeToDate(receivedLocal);
	        if (!d) {
	          errors.push(`Row ${rowNum}: invalid received_at_local "${receivedLocal}"`);
	        } else {
	          // store local string as provided, but normalize output in payload
	          received_at_local = fmtLocalYMDHMFromUtc(d.toISOString());
	          received_at_utc = d.toISOString();
	        }
	      }

	      payload.push({
	        po_number: po,
	        supplier_name: supplier,
	        facility_name: facility,
	        received_at_local: received_at_local,
	        received_at_utc: received_at_utc,
	        received_tz: 'viewer-local',
	        cartons_received,
	        cartons_damaged,
	        cartons_noncompliant,
	        cartons_replaced
	      });
	    }

	    if (errors.length) {
	      alert(`Upload blocked (fix CSV):\n\n${errors.slice(0, 8).join('\n')}${errors.length > 8 ? `\n… (+${errors.length - 8} more)` : ''}`);
	      return;
	    }

	    // Confirm before applying
	    const msg = [
	      `Apply CSV upload?`,
	      `\nFile: ${file.name}`,
	      `Week selected: ${wsSelected}`,
	      `Rows: ${payload.length}`,
	      weekMismatchCount ? `\nNote: ${weekMismatchCount} row(s) had week_start not matching the selected week. They will still be applied to the selected week.` : ''
	    ].join('\n');
	
	    if (!window.confirm(msg)) return;

	    try {
	      await api(`/receiving/weeks/${encodeURIComponent(wsSelected)}`, {
	        method: 'PUT',
	        body: JSON.stringify(payload)
	      });

	      alert(`Upload applied: ${payload.length} row(s) updated.`);
	      // Refresh immediately so UI reflects updates (no manual refresh)
	      await loadWeek(wsSelected);
	    } catch (e) {
	      console.warn(e);
	      alert('Upload failed. Check connection / server logs.');
	    }
	  };
	}

	if (btnPdf) {
	  btnPdf.onclick = () => {
	    const ws = getWeekStart();
	    if (!ws) return;
	    const rows = buildWeekExportRows(M.planRows, M.receivingRows, ws);
	    const bySupplier = new Map();
	    for (const r of rows) {
	      const k = r.supplier_name || '—';
	      if (!bySupplier.has(k)) bySupplier.set(k, []);
	      bySupplier.get(k).push(r);
	    }
	    const suppliers = Array.from(bySupplier.keys()).sort((a,b)=>String(a).localeCompare(String(b)));
	    const cutoffLocal = fmtLocalFromUtc(businessCutoffUtcISO(ws));
	    const generatedAtLocal = new Date().toLocaleString();

	    // Exception summary (first page)
	    const { items } = computeSupplierStats(M.planRows, M.receivingRows, ws);

	    const top = (arr, keyFn, n = 8) => arr
	      .slice()
	      .sort((a, b) => (keyFn(b) - keyFn(a)) || String(a.supplier).localeCompare(String(b.supplier)))
	      .filter(x => keyFn(x) > 0)
	      .slice(0, n);

	    const mostDelayed = top(items, x => Number(x.delayed) || 0);
	    const mostNonc = top(items, x => Number(x.noncompliant) || 0);
	    const mostDamaged = top(items, x => Number(x.damaged) || 0);
	    const mostReplaced = top(items, x => Number(x.replaced) || 0);

	    const excList = (rows, fmtRight) => rows.length
	      ? rows.map(r => `
	          <tr>
	            <td>${esc(r.supplier)}</td>
	            <td class="right">${fmtRight(r)}</td>
	          </tr>
	        `).join('')
	      : `<tr><td colspan="2" class="muted">None</td></tr>`;

	    const exceptionPage = `
	      <div class="page">
	        <h2>Exceptions Snapshot</h2>
	        <div class="meta">
	          Generated: ${esc(generatedAtLocal)}<br/>
	          Week: ${esc(ws)} • Business cutoff (local): ${esc(cutoffLocal || '')}
	        </div>

	        <div class="grid">
	          <div class="card">
	            <div class="cardTitle">Most delayed POs</div>
	            <table class="mini">
	              <thead><tr><th>Supplier</th><th class="right">Delayed / Expected</th></tr></thead>
	              <tbody>${excList(mostDelayed, r => `${r.delayed} / ${r.expected}`)}</tbody>
	            </table>
	          </div>

	          <div class="card">
	            <div class="cardTitle">Most non-compliant cartons</div>
	            <table class="mini">
	              <thead><tr><th>Supplier</th><th class="right">Non-comp</th></tr></thead>
	              <tbody>${excList(mostNonc, r => String(r.noncompliant))}</tbody>
	            </table>
	          </div>

	          <div class="card">
	            <div class="cardTitle">Most damaged cartons</div>
	            <table class="mini">
	              <thead><tr><th>Supplier</th><th class="right">Damaged</th></tr></thead>
	              <tbody>${excList(mostDamaged, r => String(r.damaged))}</tbody>
	            </table>
	          </div>

	          <div class="card">
	            <div class="cardTitle">Most replaced cartons</div>
	            <table class="mini">
	              <thead><tr><th>Supplier</th><th class="right">Replaced</th></tr></thead>
	              <tbody>${excList(mostReplaced, r => String(r.replaced))}</tbody>
	            </table>
	          </div>
	        </div>
	      </div>
	    `;


	    const css = `
	      <style>
	        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:24px;}
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
	      
        h2{font-size:16px;margin:0 0 8px;}
        .page{page-break-after:always;}
        .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
        .card{border:1px solid #e5e7eb;border-radius:16px;padding:10px;background:#fff;}
        .cardTitle{font-size:12px;font-weight:700;margin-bottom:6px;color:#111827;}
        table.mini{width:100%;border-collapse:collapse;font-size:12px;}
        table.mini th, table.mini td{border:1px solid #e5e7eb;padding:6px 8px;}
        table.mini th{background:#f9fafb;color:#374151;}
        .muted{color:#9ca3af;font-size:12px;}
</style>
	    `;

	    const pages = suppliers.map(supplier => {
	      const rs = bySupplier.get(supplier) || [];
	      const expected = rs.length;
	      const received = rs.filter(x => x.received_at_utc).length;
	      const delayed = rs.filter(x => String(x.status||'').includes('Delayed')).length;
	      const cartons = rs.reduce((a,x)=>a + (x.cartons_in||0),0);
	      const cartonsOut = rs.reduce((a,x)=>a + (x.cartons_out||0),0);
	      const damaged = rs.reduce((a,x)=>a + (x.damaged||0),0);
	      const nonc = rs.reduce((a,x)=>a + (x.non_compliant||0),0);
	      const repl = rs.reduce((a,x)=>a + (x.replaced||0),0);
	      const rowsHtml = rs.map(x => `
	        <tr>
	          <td>${esc(x.po_number)}</td>
	          <td>${esc(x.facility_name)}</td>
	          <td class="right">${x.cartons_in}</td>
	          <td class="right">${x.cartons_out}</td>
	          <td class="right">${x.damaged}</td>
	          <td class="right">${x.non_compliant}</td>
	          <td class="right">${x.replaced}</td>
	          <td>${esc(x.last_received_local || '')}</td>
	          <td class="${String(x.status||'').includes('Delayed') ? 'delayed' : ''}">${esc(x.status||'')}</td>
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
	            <div>Cartons Out: <b>${cartonsOut}</b></div>
	            <div>Damaged: <b>${damaged}</b></div>
	            <div>Non-compliant: <b>${nonc}</b></div>
	            <div>Replaced: <b>${repl}</b></div>
	          </div>
	          <table>
	            <thead>
	              <tr>
	                <th>PO</th>
	                <th>Facility</th>
	                <th class="right">Cartons In</th>
	                <th class="right">Cartons Out</th>
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
	        ${css}
	      </head>
	      <body>
	        <h1>Receiving — Supplier Summary</h1>
	        <div class="meta">Week: ${esc(ws)} • Business cutoff (local): ${esc(cutoffLocal || '')}</div>
	        ${exceptionPage}${pages}
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

if (btnReceive) {
  btnReceive.onclick = async () => {
    const ws = getWeekStart();
    const supplier = (document.getElementById('recv-supplier') || {}).value || '';
    const dtVal = batchDt ? batchDt.value : '';
    if (!dtVal) { alert('Please select Received At date/time.'); return; }

    // which POs are checked
    const checked = Array.from(document.querySelectorAll('.recv-row-check'))
      .filter(cb => cb.checked)
      .map(cb => cb.getAttribute('data-po'))
      .filter(Boolean);

    if (!checked.length) { alert('Select at least one PO.'); return; }

    // Build upsert payload from current UI values
    const payload = checked.map(po => {
      const facEl = document.querySelector(`.recv-facility[data-po="${CSS.escape(po)}"]`);
      const facility = facEl ? facEl.value.trim() : '';

      const getNum = (field) => {
        const el = document.querySelector(`.recv-num[data-po="${CSS.escape(po)}"][data-field="${field}"]`);
        return el ? (Number(el.value || 0) || 0) : 0;
      };

      // Treat dtVal as local time entered by user; store utc ISO
      const utcISO = new Date(dtVal).toISOString();

      return {
        po_number: po,
        supplier_name: supplier,
        facility_name: facility,
        received_at_utc: utcISO,
        received_at_local: dtVal,
        received_tz: 'viewer-local',
        cartons_received: getNum('cartons_received'),
        cartons_damaged: getNum('cartons_damaged'),
        cartons_noncompliant: getNum('cartons_noncompliant'),
        cartons_replaced: getNum('cartons_replaced')
      };
    });

    try {
      await api(`/receiving/weeks/${encodeURIComponent(ws)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      // force reload of receiving rows to reflect last-received column + footer
      lastWS = '';
      await tick();
    } catch (e) {
      console.warn(e);
      alert('Save failed. Check connection / server logs.');
    }
  };
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
        ensureReceivingPage();
        await loadWeek(ws);
      }
    } catch (e) {
      console.warn('[receiving] load error:', e);
    }
  }

function dtLocalNow() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mi = String(d.getMinutes()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

  // When Ops refreshes window.state (week switch), recompute Carton Out and re-render if needed.
  window.addEventListener('state:ready', () => {
    const ws = getWeekStart();
    if (!ws) return;
    if (ws !== M.ws) return;
    M.cartonsOutByPO = computeCartonsOutByPOFromState(ws);
    // lightweight refresh (no API calls)
    try { renderCurrentSupplierView(); } catch {}
  });

  window.addEventListener('hashchange', () => {
    showReceivingIfHash();
  });

  tick();
  setInterval(tick, 800);
})();
