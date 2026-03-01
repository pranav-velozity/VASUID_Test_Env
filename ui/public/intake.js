/* intake.js — VelOzity Pinpoint Intake (standalone)

   What this file does
   - Owns ONLY the Intake page behavior (render, edit cells, upload applied UIDs, upload bin manifest, delete).
   - It does NOT touch Operations/Dashboard logic except an optional callback hook.

   Requirements in index.html
   - Include the Intake DOM with these IDs:
       #page-intake
       #intake-body
       #btn-add-row
       #chk-all
       #btn-delete-selected
       #btn-export-day
       #btn-upload-applied
       #file-upload-applied (type=file)
       #btn-upload-bins
       #file-bins (type=file)
       #btn-delete-uids
       #uids-to-delete
       #delete-uids-status
       #intake-bpm
       (Optional ribbon IDs if you keep them: #ops-today #ops-hour #ops-rate #ops-drafts #ops-dupes #ops-sync-badges #ops-alerts #ops-last-updated #ops-dot)

   - SheetJS must be loaded globally (window.XLSX) if you want XLSX uploads.

   API wiring expectations (matches your server.js)
   - PATCH  /records/:id   {field,value}
   - POST   /records/import   [rows]
   - POST   /records/delete   [{uid, sku_code?}]   (deletes by UID; server supports sku_code optional)
   - GET    /records?from=YYYY-MM-DD&to=YYYY-MM-DD&status=draft
   - PUT    /bins/weeks/:weekStart   [ {mobile_bin,total_units?,weight_kg?,date_local?} ]
   - GET    /events/scan  (SSE)  -> {ts}

   API base resolution
   - Prefers <meta name="api-base" content="..."> if present
   - Else window.apiBase / window.API_BASE
   - Else falls back to location.origin
*/

(function () {
  'use strict';

  // ------------------------
  // API base
  // ------------------------
  function resolveApiBase() {
    const meta = document.querySelector('meta[name="api-base"]')?.content || '';
    const explicit = meta || (window.apiBase || window.API_BASE || '');
    const base = String(explicit).trim() || String(window.location.origin || '').trim();
    return base.replace(/\/+$/, '');
  }
  const apiBase = resolveApiBase();

  // ------------------------
  // DOM helpers
  // ------------------------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ------------------------
  // Date helpers
  // ------------------------
  function isoYMD(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  }

  function mondayOf(ymd) {
    const s = String(ymd || '').slice(0, 10);
    const d = new Date(s + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : (1 - day));
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  function weekEndOf(ws) {
    const d = new Date(String(ws || '').slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  }

  function toISODateLoose(v) {
    if (v == null) return '';
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Excel serial date
      const base = new Date(Date.UTC(1899, 11, 30));
      const ms = Math.round(v * 86400000);
      return new Date(base.getTime() + ms).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return '';
  }

  // ------------------------
  // Minimal CSV parser (quoted fields)
  // ------------------------
  function parseCSV(text) {
    const rows = [];
    let i = 0, field = '', row = [], inQuotes = false;
    function pushField() { row.push(field); field = ''; }
    function pushRow() { rows.push(row); row = []; }

    while (i < text.length) {
      const c = text[i++];
      if (inQuotes) {
        if (c === '"') {
          if (text[i] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') pushField();
        else if (c === '\r') { /* ignore */ }
        else if (c === '\n') { pushField(); pushRow(); }
        else field += c;
      }
    }
    pushField();
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();

    if (!rows.length) return [];
    const header = rows[0].map(h => String(h || '').trim());
    return rows.slice(1)
      .filter(r => r.some(x => String(x || '').trim() !== ''))
      .map(r => {
        const o = {};
        header.forEach((h, idx) => { if (h) o[h] = r[idx]; });
        return o;
      });
  }

  function readXlsx(file) {
    return new Promise((resolve, reject) => {
      if (!window.XLSX) return reject(new Error('XLSX library not loaded (window.XLSX missing).'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.onload = () => {
        try {
          const data = new Uint8Array(reader.result);
          const wb = window.XLSX.read(data, { type: 'array' });
          const wsName = wb.SheetNames[0];
          const sheet = wb.Sheets[wsName];
          const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: '' });
          resolve(rows);
        } catch (e) { reject(e); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function normalizeKeyedRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) {
      out[String(k).toLowerCase().trim()] = v;
    }
    return out;
  }

  function pickRowValue(norm, ...keys) {
    for (const k of keys) {
      const v = norm[String(k).toLowerCase().trim()];
      if (v != null && String(v).trim() !== '') return v;
    }
    return '';
  }

  function toNumberOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ------------------------
  // API
  // ------------------------
  async function apiJSON(path, opts) {
    const res = await fetch(apiBase + path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts || {}));
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${t}`.trim());
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  async function fetchRecords({ from, to, status, limit }) {
    const u = new URL(apiBase + '/records');
    if (from) u.searchParams.set('from', from);
    if (to) u.searchParams.set('to', to);
    if (status) u.searchParams.set('status', status);
    if (limit) u.searchParams.set('limit', String(limit));
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error(`Failed /records: ${res.status}`);
    const j = await res.json();
    return Array.isArray(j.records) ? j.records : [];
  }

  async function patchRecord(id, field, value) {
    return apiJSON(`/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ field, value })
    });
  }

  async function deleteUIDs(list) {
    const items = (list || []).map(x => {
      if (typeof x === 'string') return { uid: x.trim(), sku_code: '' };
      return { uid: String(x.uid || '').trim(), sku_code: String(x.sku_code || '').trim() };
    }).filter(x => x.uid);

    if (!items.length) return null;

    return apiJSON('/records/delete', {
      method: 'POST',
      body: JSON.stringify(items)
    });
  }

  // ------------------------
  // Intake state + business rules
  // ------------------------
  const IntakeState = {
    rows: [],
    weekStart: mondayOf(isoYMD(new Date()))
  };

  function newLocalRow() {
    return {
      id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2),
      selected: false,
      date_local: isoYMD(new Date()),
      mobile_bin: '',
      sscc_label: '',
      po_number: '',
      sku_code: '',
      uid: '',
      status: 'draft',
      sync_state: 'pending'
    };
  }

  function requiredFilled(r) {
    return Boolean(
      String(r.date_local || '').trim() &&
      String(r.mobile_bin || '').trim() &&
      String(r.po_number || '').trim() &&
      String(r.sku_code || '').trim() &&
      String(r.uid || '').trim()
    );
  }

  function ensureTrailingBlankRow() {
    if (!IntakeState.rows.length) { IntakeState.rows.push(newLocalRow()); return; }
    const last = IntakeState.rows[IntakeState.rows.length - 1];
    const isLastBlank = !String(last.mobile_bin || '').trim()
      && !String(last.po_number || '').trim()
      && !String(last.sku_code || '').trim()
      && !String(last.uid || '').trim()
      && last.status !== 'complete';
    if (!isLastBlank) IntakeState.rows.push(newLocalRow());
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ------------------------
  // Render
  // ------------------------
  function renderIntake() {
    const tb = $('#intake-body');
    if (!tb) return;

    tb.innerHTML = '';
    ensureTrailingBlankRow();

    let drafts = 0;
    let complete = 0;

    for (let i = 0; i < IntakeState.rows.length; i++) {
      const r = IntakeState.rows[i];
      if (r.status === 'complete') complete++; else drafts++;

      const tr = document.createElement('tr');
      tr.className = (i % 2 ? 'bg-gray-50' : 'bg-white');

      tr.innerHTML = `
        <td class="border px-2 py-2"><input type="checkbox" ${r.selected ? 'checked' : ''} data-id="${r.id}" data-role="sel"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(String(r.date_local || '').slice(0,10))}" data-id="${r.id}" data-f="date_local"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.mobile_bin)}" data-id="${r.id}" data-f="mobile_bin"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.sscc_label || '')}" data-id="${r.id}" data-f="sscc_label"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.po_number)}" data-id="${r.id}" data-f="po_number"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.sku_code)}" data-id="${r.id}" data-f="sku_code"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.uid)}" data-id="${r.id}" data-f="uid"/></td>
        <td class="border px-2 py-2 text-xs text-gray-600">${escapeHtml(r.status || 'draft')}</td>
        <td class="border px-2 py-2 text-xs text-gray-600">${escapeHtml(r.sync_state || '')}</td>
        <td class="border px-2 py-2 text-xs text-gray-600">${requiredFilled(r) ? '' : '<span class="text-gray-400">—</span>'}</td>
      `;
      tb.appendChild(tr);
    }

    // Optional ribbon badges
    if ($('#ops-drafts')) $('#ops-drafts').textContent = String(drafts);
    if ($('#ops-sync-badges')) $('#ops-sync-badges').textContent = `${complete} complete`;

    const allChk = $('#chk-all');
    if (allChk) allChk.checked = IntakeState.rows.length > 0 && IntakeState.rows.every(x => x.selected);

    // Bind events
    $$('.cell', tb).forEach(inp => {
      inp.addEventListener('change', async (e) => {
        const t = e.currentTarget;
        const id = t.getAttribute('data-id');
        const field = t.getAttribute('data-f');
        const val = t.value;

        const row = IntakeState.rows.find(x => x.id === id);
        if (row) row[field] = val;

        try {
          const resp = await patchRecord(id, field, val);
          if (resp && resp.record && row) {
            row.status = resp.record.status || row.status;
            row.sync_state = resp.record.sync_state || row.sync_state;
            row.completed_at = resp.record.completed_at || row.completed_at;
          }
        } catch (err) {
          console.error(err);
          alert('Save failed: ' + (err.message || err));
        } finally {
          ensureTrailingBlankRow();
          renderIntake();
          // Optional hook: let the rest of the app refresh if it wants
          if (typeof window.onIntakeChanged === 'function') {
            try { window.onIntakeChanged(); } catch {}
          }
        }
      });
    });

    $$('input[data-role="sel"]', tb).forEach(cb => {
      cb.addEventListener('change', (e) => {
        const t = e.currentTarget;
        const id = t.getAttribute('data-id');
        const row = IntakeState.rows.find(x => x.id === id);
        if (row) row.selected = t.checked;
        const all = $('#chk-all');
        if (all) all.checked = IntakeState.rows.every(x => x.selected);
      });
    });
  }

  // ------------------------
  // Load drafts for week
  // ------------------------
  async function loadWeekDrafts(ws) {
    const we = weekEndOf(ws);
    const drafts = await fetchRecords({ from: ws, to: we, status: 'draft', limit: 20000 });
    IntakeState.rows = drafts.map(r => ({
      id: r.id,
      selected: false,
      date_local: r.date_local,
      mobile_bin: r.mobile_bin || '',
      sscc_label: r.sscc_label || '',
      po_number: r.po_number || '',
      sku_code: r.sku_code || '',
      uid: r.uid || '',
      status: r.status || 'draft',
      sync_state: r.sync_state || 'unknown'
    }));
    ensureTrailingBlankRow();
  }

  // ------------------------
  // Upload Applied UIDs
  // ------------------------
  function wireUploadUIDs() {
    const btn = $('#btn-upload-applied');
    const inp = $('#file-upload-applied');
    if (!btn || !inp) return;

    btn.addEventListener('click', () => inp.click());
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      inp.value = '';
      if (!file) return;

      try {
        let rows;
        if (file.name.toLowerCase().endsWith('.csv')) rows = parseCSV(await file.text());
        else rows = await readXlsx(file);

        const payload = rows.map(r => {
          const n = normalizeKeyedRow(r);
          return {
            date_local: toISODateLoose(pickRowValue(n, 'date_local', 'date')),
            mobile_bin: String(pickRowValue(n, 'mobile_bin', 'mobile bin (box)', 'mobile bin', 'bin') || ''),
            sscc_label: String(pickRowValue(n, 'sscc_label', 'sscc label (box)', 'sscc', 'sscc label') || ''),
            po_number:  String(pickRowValue(n, 'po_number', 'po', 'po#', 'po number') || ''),
            sku_code:   String(pickRowValue(n, 'sku_code', 'sku', 'sku code') || ''),
            uid:        String(pickRowValue(n, 'uid', 'u_id', 'u id') || '')
          };
        }).filter(x => (x.po_number || x.sku_code || x.uid || x.mobile_bin));

        if (!payload.length) { alert('No rows found.'); return; }

        const resp = await apiJSON('/records/import', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        alert(`Upload complete. Inserted: ${resp.inserted ?? 0} / ${resp.total ?? payload.length}. Rejected: ${resp.rejected ?? 0}.`);

        await IntakePage.reload();
        if (typeof window.onIntakeChanged === 'function') {
          try { window.onIntakeChanged(); } catch {}
        }
      } catch (err) {
        console.error(err);
        alert('Upload failed: ' + (err.message || err));
      }
    });
  }

  // ------------------------
  // Upload Bin Manifest
  // ------------------------
  function validateBin(row) {
    const mb = String(row.mobile_bin || '').trim();
    if (!mb) return { ok: false, reason: 'missing mobile_bin' };
    const u = row.total_units;
    if (u != null && (!Number.isFinite(u) || u < 0)) return { ok: false, reason: 'invalid total_units' };
    const w = row.weight_kg;
    if (w != null && (!Number.isFinite(w) || w < 0)) return { ok: false, reason: 'invalid weight_kg' };
    return { ok: true };
  }

  function wireUploadBins() {
    const btn = $('#btn-upload-bins');
    const inp = $('#file-bins');
    if (!btn || !inp) return;

    btn.addEventListener('click', () => inp.click());
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      inp.value = '';
      if (!file) return;

      try {
        let rows;
        if (file.name.toLowerCase().endsWith('.csv')) rows = parseCSV(await file.text());
        else rows = await readXlsx(file);

        const ws = (window.state && window.state.weekStart)
          ? window.state.weekStart
          : IntakeState.weekStart;

        const items = rows.map(r => {
          const n = normalizeKeyedRow(r);
          return {
            mobile_bin: String(pickRowValue(n, 'mobile_bin', 'mobile bin', 'bin') || '').trim(),
            total_units: toNumberOrNull(pickRowValue(n, 'total_units', 'total units', 'units')),
            weight_kg: toNumberOrNull(pickRowValue(n, 'weight_kg', 'weight', 'weight (kg)', 'gross weight')),
            date_local: toISODateLoose(pickRowValue(n, 'date_local', 'date')) || ws
          };
        }).filter(x => x.mobile_bin);

        if (!items.length) { alert('No rows found in manifest.'); return; }

        const rejected = [];
        const clean = [];
        for (const it of items) {
          const v = validateBin(it);
          if (!v.ok) rejected.push({ row: it, reason: v.reason });
          else clean.push(it);
        }
        if (!clean.length) { alert('All rows invalid.'); return; }

        const resp = await apiJSON(`/bins/weeks/${encodeURIComponent(ws)}`, {
          method: 'PUT',
          body: JSON.stringify(clean)
        });

        alert(`Bin manifest uploaded. Upserted: ${resp.upserted ?? 0}. Rejected: ${resp.rejected ?? rejected.length}.`);

        if (typeof window.onIntakeChanged === 'function') {
          try { window.onIntakeChanged(); } catch {}
        }
      } catch (err) {
        console.error(err);
        alert('Upload failed: ' + (err.message || err));
      }
    });
  }

  // ------------------------
  // Deletes + export
  // ------------------------
  function wireDeletes() {
    const btnSel = $('#btn-delete-selected');
    if (btnSel) {
      btnSel.addEventListener('click', async () => {
        const selected = IntakeState.rows.filter(r => r.selected && String(r.uid || '').trim());
        if (!selected.length) { alert('No rows selected.'); return; }
        if (!confirm(`Delete ${selected.length} selected UID(s)?`)) return;

        try {
          await deleteUIDs(selected.map(r => ({ uid: r.uid, sku_code: r.sku_code })));
          alert('Deleted.');
          await IntakePage.reload();
          if (typeof window.onIntakeChanged === 'function') {
            try { window.onIntakeChanged(); } catch {}
          }
        } catch (e) {
          console.error(e);
          alert('Delete failed: ' + (e.message || e));
        }
      });
    }

    const btnBulk = $('#btn-delete-uids');
    const txt = $('#uids-to-delete');
    const status = $('#delete-uids-status');
    if (btnBulk && txt) {
      btnBulk.addEventListener('click', async () => {
        const items = String(txt.value || '')
          .split(/[^A-Za-z0-9\-_;:]+/g)
          .map(s => s.trim())
          .filter(Boolean);

        if (!items.length) { alert('Paste UIDs first.'); return; }
        if (!confirm(`Delete ${items.length} UID(s)?`)) return;

        try {
          const resp = await deleteUIDs(items);
          if (status) status.textContent = `Deleted: ${resp?.total_deleted ?? 0}`;
          await IntakePage.reload();
          if (typeof window.onIntakeChanged === 'function') {
            try { window.onIntakeChanged(); } catch {}
          }
        } catch (e) {
          console.error(e);
          alert('Delete failed: ' + (e.message || e));
        }
      });
    }
  }

  function wireExport() {
    const btn = $('#btn-export-day');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const date = isoYMD(new Date());
      window.open(`${apiBase}/export/xlsx?date=${encodeURIComponent(date)}`, '_blank', 'noopener');
    });
  }

  // ------------------------
  // SSE -> BPM
  // ------------------------
  function startSSE() {
    try {
      const es = new EventSource(apiBase + '/events/scan');
      const beats = [];
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data || '{}');
          const ts = new Date(msg.ts || Date.now()).getTime();
          beats.push(ts);
          const cutoff = Date.now() - 60000;
          while (beats.length && beats[0] < cutoff) beats.shift();
          const bpm = Math.round(beats.length * 60);
          if ($('#intake-bpm')) $('#intake-bpm').textContent = String(bpm);
          if ($('#ops-dot')) $('#ops-dot').className = 'w-2 h-2 rounded-full bg-emerald-500';
          if ($('#ops-last-updated')) $('#ops-last-updated').textContent = isoYMD(new Date());
        } catch {}
      };
      es.onerror = () => {
        if ($('#ops-dot')) $('#ops-dot').className = 'w-2 h-2 rounded-full bg-gray-300';
      };
    } catch (e) {
      // Ignore
    }
  }

  // ------------------------
  // Public page API
  // ------------------------
  const IntakePage = {
    _wired: false,

    async init() {
      if (this._wired) return;
      this._wired = true;

      wireUploadUIDs();
      wireUploadBins();
      wireDeletes();
      wireExport();

      const all = $('#chk-all');
      if (all) {
        all.addEventListener('change', () => {
          const v = all.checked;
          IntakeState.rows.forEach(r => { r.selected = v; });
          renderIntake();
        });
      }

      const add = $('#btn-add-row');
      if (add) add.addEventListener('click', () => { IntakeState.rows.push(newLocalRow()); renderIntake(); });

      if ($('#page-intake')) startSSE();

      await this.reload();
    },

    async reload() {
      const ws = (window.state && window.state.weekStart) ? window.state.weekStart : IntakeState.weekStart;
      IntakeState.weekStart = ws || IntakeState.weekStart;
      await loadWeekDrafts(IntakeState.weekStart);
      renderIntake();
    },

    async show() {
      const sec = $('#page-intake');
      if (sec) sec.classList.remove('hidden');
      await this.init();
      await this.reload();
    },

    hide() {
      const sec = $('#page-intake');
      if (sec) sec.classList.add('hidden');
    }
  };

  window.IntakePage = IntakePage;
})();
