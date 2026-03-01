/* intake.js — VelOzity Pinpoint Intake (standalone)
   Assumptions:
   - index.html contains the Intake DOM (section#page-intake and its child elements/IDs).
   - XLSX (SheetJS) is loaded globally (window.XLSX) if you want XLSX parsing.
   - index.html defines (optional) window.apiBase OR window.API_BASE (no trailing slash). If not, we derive from location.
   - index.html routing calls window.IntakePage.show() when hash route is "#intake".
*/
(function () {
  'use strict';

  // ---------- Config ----------
  function deriveApiBase() {
    // Prefer explicitly set base
    const explicit = (window.apiBase || window.API_BASE || '').toString().trim();
    if (explicit) return explicit.replace(/\/+$/, '');

    // Common pattern: backend on same origin but different port during local dev.
    // In production you'll almost always set API_BASE explicitly.
    const loc = window.location;
    // If frontend is served from same server, this works.
    return (loc.origin || '').replace(/\/+$/, '');
  }
  const apiBase = deriveApiBase();

  // ---------- Tiny DOM helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function showToast(msg) {
    // Non-intrusive fallback; replace with your app toast if you have one.
    // eslint-disable-next-line no-alert
    console.log('[Intake]', msg);
  }

  // ---------- Date helpers ----------
  function isoYMD(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  }

  function mondayOf(ymd) {
    const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    const day = d.getUTCDay(); // 0..6 (Sun..Sat)
    const diff = (day === 0 ? -6 : (1 - day));
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  function weekEndOf(ws) {
    const d = new Date(ws + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  }

  // ---------- CSV/XLSX parsing ----------
  function parseCSV(text) {
    // Minimal CSV parser with quoted fields.
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

    // Convert to objects using header row
    if (!rows.length) return [];
    const header = rows[0].map(h => String(h || '').trim());
    return rows.slice(1).filter(r => r.some(x => String(x || '').trim() !== '')).map(r => {
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
    // normalize keys for flexible headers
    const out = {};
    for (const [k, v] of Object.entries(row || {})) {
      out[String(k).toLowerCase().trim()] = v;
    }
    return out;
  }

  // ---------- API ----------
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

  // ---------- Intake state ----------
  const IntakeState = {
    rows: [], // draft rows for current week, plus one empty row
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

  function toUI(v) { return String(v || '').slice(0, 10); }

  function requiredFilled(r) {
    return Boolean(
      String(r.date_local || '').trim() &&
      String(r.mobile_bin || '').trim() &&
      String(r.po_number || '').trim() &&
      String(r.sku_code || '').trim() &&
      String(r.uid || '').trim()
    );
  }

  function syncClass(r) {
    if (r.status === 'complete') return 'bg-emerald-50';
    if (requiredFilled(r)) return 'bg-amber-50';
    return '';
  }

  // ---------- Render ----------
  function renderIntake() {
    const tb = $('#intake-body');
    if (!tb) return;

    tb.innerHTML = '';
    if (!IntakeState.rows.length) IntakeState.rows.push(newLocalRow());

    let drafts = 0;
    let synced = 0;

    for (let i = 0; i < IntakeState.rows.length; i++) {
      const r = IntakeState.rows[i];
      if (r.status !== 'complete') drafts++; else synced++;

      const tr = document.createElement('tr');
      tr.className = (i % 2 ? 'bg-gray-50' : 'bg-white') + ' ' + syncClass(r);

      tr.innerHTML = `
        <td class="border px-2 py-2"><input type="checkbox" ${r.selected ? 'checked' : ''} data-id="${r.id}" data-role="sel"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${toUI(r.date_local)}" data-id="${r.id}" data-f="date_local"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.mobile_bin)}" data-id="${r.id}" data-f="mobile_bin"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.sscc_label || '')}" data-id="${r.id}" data-f="sscc_label"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.po_number)}" data-id="${r.id}" data-f="po_number"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.sku_code)}" data-id="${r.id}" data-f="sku_code"/></td>
        <td class="border px-2 py-2"><input class="cell w-full" value="${escapeHtml(r.uid)}" data-id="${r.id}" data-f="uid"/></td>
        <td class="border px-2 py-2 text-xs text-gray-600">${escapeHtml(r.status || 'draft')}</td>
      `;
      tb.appendChild(tr);
    }

    const elDrafts = $('#ops-drafts');
    if (elDrafts) elDrafts.textContent = String(drafts);

    const allChk = $('#chk-all');
    if (allChk) allChk.checked = IntakeState.rows.length > 0 && IntakeState.rows.every(x => x.selected);

    // bind events for rendered inputs
    $$('.cell', tb).forEach(inp => {
      inp.addEventListener('change', async (e) => {
        const t = e.currentTarget;
        const id = t.getAttribute('data-id');
        const field = t.getAttribute('data-f');
        const val = t.value;

        // update local row immediately
        const row = IntakeState.rows.find(x => x.id === id);
        if (row) row[field] = val;

        try {
          const resp = await patchRecord(id, field, val);
          if (resp && resp.record) {
            const updated = resp.record;
            if (row) {
              row.status = updated.status || row.status;
              row.sync_state = updated.sync_state || row.sync_state;
              row.completed_at = updated.completed_at || row.completed_at;
            }
          }
        } catch (err) {
          console.error(err);
          showToast('Patch failed: ' + (err.message || err));
        } finally {
          // keep one empty row at bottom
          ensureTrailingBlankRow();
          renderIntake();
          // if app has setWeek(), refresh derived dashboards
          if (typeof window.setWeek === 'function' && window.state?.weekStart) {
            try { await window.setWeek(window.state.weekStart); } catch {}
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

    if (synced && $('#ops-sync-badges')) {
      $('#ops-sync-badges').textContent = `${synced} complete`;
    }
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  // ---------- Ops ribbon (optional) ----------
  async function loadOpsMetrics() {
    try {
      const m = await apiJSON('/summary/ops', { method: 'GET', headers: {} });
      if ($('#ops-today')) $('#ops-today').textContent = String(m.scans_today ?? 0);
      if ($('#ops-hour')) $('#ops-hour').textContent = String(m.last_hour ?? 0);
      if ($('#ops-rate')) $('#ops-rate').textContent = String(m.last_30m ?? 0);
      if ($('#ops-dupes')) $('#ops-dupes').textContent = String(m.dupes ?? 0);
      if ($('#ops-last-updated')) $('#ops-last-updated').textContent = isoYMD(new Date());
    } catch (e) {
      // Non-blocking
      console.warn('Ops metrics failed:', e);
    }
  }

  function startSSE() {
    // Server: GET /events/scan (SSE). Each event = { ts }
    try {
      const es = new EventSource(apiBase + '/events/scan');
      const beats = [];
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data || '{}');
          const ts = new Date(msg.ts || Date.now()).getTime();
          beats.push(ts);
          // keep last 60s
          const cutoff = Date.now() - 60000;
          while (beats.length && beats[0] < cutoff) beats.shift();
          const bpm = Math.round(beats.length * 60); // events in last minute -> bpm
          if ($('#intake-bpm')) $('#intake-bpm').textContent = String(bpm);
        } catch {}
      };
      es.onerror = () => { /* ignore */ };
    } catch (e) {
      console.warn('SSE not available:', e);
    }
  }

  // ---------- Upload UIDs ----------
  function pickRowValue(norm, ...keys) {
    for (const k of keys) {
      const v = norm[String(k).toLowerCase().trim()];
      if (v != null && String(v).trim() !== '') return v;
    }
    return '';
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
        if (file.name.toLowerCase().endsWith('.csv')) {
          rows = parseCSV(await file.text());
        } else {
          rows = await readXlsx(file);
        }

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

        if (!payload.length) {
          alert('No rows found.');
          return;
        }

        const resp = await apiJSON('/records/import', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        alert(`Upload complete. Inserted: ${resp.inserted ?? 0} / ${resp.total ?? payload.length}. Rejected: ${resp.rejected ?? 0}.`);

        // refresh drafts for current week
        await IntakePage.reload();
        if (typeof window.setWeek === 'function' && window.state?.weekStart) {
          try { await window.setWeek(window.state.weekStart); } catch {}
        }
      } catch (err) {
        console.error(err);
        alert('Upload failed: ' + (err.message || err));
      }
    });
  }

  // ---------- Upload Bin Manifest ----------
  function toNumberOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

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

        const ws = (window.state && window.state.weekStart) ? window.state.weekStart : IntakeState.weekStart;

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

        // Refresh week so insights update
        if (typeof window.setWeek === 'function') {
          try { await window.setWeek(ws); } catch {}
        }
      } catch (err) {
        console.error(err);
        alert('Upload failed: ' + (err.message || err));
      }
    });
  }

  // ---------- Delete ----------
  async function deleteUIDs(list) {
    const items = (list || []).map(x => {
      if (typeof x === 'string') return { uid: x.trim(), sku_code: '' };
      return { uid: String(x.uid || '').trim(), sku_code: String(x.sku_code || '').trim() };
    }).filter(x => x.uid);

    if (!items.length) return;

    const resp = await apiJSON('/records/delete', {
      method: 'POST',
      body: JSON.stringify(items)
    });
    return resp;
  }

  function wireDeletes() {
    const btnSel = $('#btn-delete-selected');
    if (btnSel) {
      btnSel.addEventListener('click', async () => {
        const selected = IntakeState.rows.filter(r => r.selected && String(r.uid || '').trim());
        if (!selected.length) { alert('No rows selected.'); return; }

        if (!confirm(`Delete ${selected.length} selected UID(s)? This deletes by UID (and SKU if present).`)) return;

        try {
          await deleteUIDs(selected.map(r => ({ uid: r.uid, sku_code: r.sku_code })));
          alert('Deleted.');
          await IntakePage.reload();
          if (typeof window.setWeek === 'function' && window.state?.weekStart) {
            try { await window.setWeek(window.state.weekStart); } catch {}
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
        const lines = String(txt.value || '')
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean);
        if (!lines.length) { alert('Paste UIDs first.'); return; }

        if (!confirm(`Delete ${lines.length} UID(s)?`)) return;
        try {
          const resp = await deleteUIDs(lines);
          if (status) status.textContent = `Deleted: ${resp.total_deleted ?? 0}`;
          await IntakePage.reload();
          if (typeof window.setWeek === 'function' && window.state?.weekStart) {
            try { await window.setWeek(window.state.weekStart); } catch {}
          }
        } catch (e) {
          console.error(e);
          alert('Delete failed: ' + (e.message || e));
        }
      });
    }
  }

  // ---------- Export ----------
  function wireExport() {
    const btn = $('#btn-export-day');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const date = isoYMD(new Date());
      window.open(`${apiBase}/export/xlsx?date=${encodeURIComponent(date)}`, '_blank', 'noopener');
    });
  }

  // ---------- Load drafts for week ----------
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

  // ---------- Public API ----------
  const IntakePage = {
    async init() {
      // one-time wiring
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

      // start SSE pulse if intake exists
      if ($('#page-intake')) startSSE();

      // initial load uses current global weekStart if present
      await this.reload();
      renderIntake();
      await loadOpsMetrics();
    },

    async reload() {
      const ws = (window.state && window.state.weekStart) ? window.state.weekStart : IntakeState.weekStart;
      IntakeState.weekStart = ws || IntakeState.weekStart;
      await loadWeekDrafts(IntakeState.weekStart);
      renderIntake();
      await loadOpsMetrics();
    },

    async show() {
      const sec = $('#page-intake');
      if (sec) sec.classList.remove('hidden');
      await this.reload();
    },

    hide() {
      const sec = $('#page-intake');
      if (sec) sec.classList.add('hidden');
    }
  };

  window.IntakePage = IntakePage;

  // Auto-init on DOM ready (safe even if routing doesn't show intake yet)
  document.addEventListener('DOMContentLoaded', () => {
    // Only init if the intake section exists in DOM
    if (!$('#page-intake')) return;
    IntakePage.init().catch(err => console.error('Intake init failed:', err));
  });
})();
