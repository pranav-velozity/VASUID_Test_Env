// =============================================================================
// intake_live_additive.js  —  VelOzity Pinpoint UID Intake (standalone)
//
// Drop-in replacement for all inline intake code previously in index.html.
// Load with:  <script src="/intake_live_additive.js?v=1" defer></script>
//
// EXPECTS these globals from the main <script> block:
//   BRAND, apiBase, $, iso, fmtInt, toNum, toUI,
//   BUSINESS_TZ, ymdInTZ, todayInTZ, dayOfWeekInTZ, mondayOfInTZ,
//   createHeart, state
//
// EXPECTS these DOM elements already present (the intake HTML scaffold):
//   #page-intake, #intake-body, #intake-bpm, #chk-all,
//   #btn-add-row, #btn-delete-selected, #btn-export-day,
//   #btn-upload-applied, #file-upload-applied,
//   #btn-upload-bins, #file-bins,
//   #btn-delete-uids, #uids-to-delete, #delete-uids-status,
//   #ops-today, #ops-hour, #ops-rate, #ops-drafts, #ops-dupes,
//   #ops-sync-badges, #ops-alerts, #ops-last-updated, #ops-dot,
//   #ops-heart-small
//
// DISPATCHES:
//   window 'intake:synced'  — after any record create/delete/import so the
//                              main script can call refreshDashboardTotals /
//                              setWeek if it wants to stay in sync.
// =============================================================================
(function intakeModule() {
  'use strict';

  // ---- Guard: wait for globals ----
  if (typeof apiBase === 'undefined' || typeof $ === 'undefined') {
    console.warn('[intake] Globals not ready, retrying in 200ms…');
    return setTimeout(intakeModule, 200);
  }

  // ====================================================================
  // Private helpers (copies of closure-local functions from the monolith)
  // ====================================================================

  function toISODate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return iso(d);
    }
    if (v instanceof Date) return iso(v);
    const str = String(v).trim();
    const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      const [_, d, mth, y] = m;
      const yyyy = y.length === 2 ? '20' + y : y;
      return `${yyyy}-${mth.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const d2 = new Date(str);
    return isNaN(d2) ? '' : iso(d2);
  }

  function todayISO() { return todayInTZ(); }

  // ---- Lightweight fetch cache (shared across intake calls) ----
  const __fetchCache = new Map();
  async function fetchJSONCached(url, ttlMs = 15000) {
    const now = Date.now();
    const hit = __fetchCache.get(url);
    if (hit) {
      if (hit.data && (now - hit.ts) < ttlMs) return hit.data;
      if (hit.promise) return hit.promise;
    }
    const prom = fetch(url, { cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then((data) => { __fetchCache.set(url, { ts: Date.now(), data, promise: null }); return data; })
      .catch((err) => { __fetchCache.delete(url); throw err; });
    __fetchCache.set(url, { ts: now, data: hit ? hit.data : null, promise: prom });
    return prom;
  }

  async function getRecordsSnapshot(ttlMs = 15000) {
    if (!apiBase) return [];
    try {
      const d = await fetchJSONCached(`${apiBase}/records?limit=65000`, ttlMs);
      return (d && d.records) || [];
    } catch { return []; }
  }

  // Notify the main script that intake changed data (create / delete / import)
  function emitIntakeSynced() {
    try { window.dispatchEvent(new Event('intake:synced')); } catch {}
  }

  // ====================================================================
  // Intake row model
  // ====================================================================
  const intakeRows = [];

  function newRow() {
    return {
      id: crypto.randomUUID(),
      selected: false,
      date_local: iso(new Date()),
      mobile_bin: '',
      sscc_label: '',
      po_number: '',
      sku_code: '',
      uid: '',
      status: 'draft',
      sync: 'pending',
      _pending: {}
    };
  }

  function requiredFilled(r) {
    return r.date_local && r.mobile_bin && r.po_number && r.sku_code && r.uid;
  }

  function syncClass(s) {
    return s === 'synced' ? 'bg-green-500' : (s === 'pending' ? 'bg-amber-500' : 'bg-gray-400');
  }

  // (kept for potential use by SSE-pushed record hydration)
  function toIntakeRow(r) {
    return {
      id: r.id,
      selected: false,
      date_local: r.date_local || iso(new Date()),
      mobile_bin: r.mobile_bin || '',
      sscc_label: r.sscc_label || '',
      po_number: r.po_number || '',
      sku_code: r.sku_code || '',
      uid: r.uid ?? '',
      status: r.status || 'complete',
      sync: 'synced',
      _pending: {}
    };
  }

  // ====================================================================
  // Render the intake table
  // ====================================================================
  function renderIntake() {
    const tb = $('#intake-body'); if (!tb) return;
    tb.innerHTML = '';
    if (!intakeRows.length) intakeRows.push(newRow());
    let drafts = 0, synced = 0;

    intakeRows.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.className = i % 2 ? 'bg-gray-50' : 'bg-white';
      if (r.status !== 'complete') drafts++; else synced++;
      tr.innerHTML = `
        <td class="border px-2 py-2"><input type="checkbox" ${r.selected ? 'checked' : ''} data-id="${r.id}" data-role="sel"/></td>
        <td class="border px-2 py-2"><input class="cell" value="${toUI(r.date_local)}" data-id="${r.id}" data-f="date_local"/></td>
        <td class="border px-2 py-2"><input class="cell" value="${r.mobile_bin}" data-id="${r.id}" data-f="mobile_bin"/></td>
        <td class="border px-2 py-2"><input class="cell" value="${r.sscc_label}" data-id="${r.id}" data-f="sscc_label" placeholder="(optional)"/></td>
        <td class="border px-2 py-2"><input class="cell" value="${r.po_number}" data-id="${r.id}" data-f="po_number"/></td>
        <td class="border px-2 py-2"><input class="cell" value="${r.sku_code}" data-id="${r.id}" data-f="sku_code"/></td>
        <td class="border px-2 py-2"><input class="cell" value="${r.uid}" data-id="${r.id}" data-f="uid" data-last="1"/></td>
        <td class="border px-2 py-2 text-center"><span class="dot ${syncClass(r.sync)}"></span></td>`;
      tb.appendChild(tr);
    });

    // Wire checkbox handlers
    tb.querySelectorAll('input[data-role="sel"]').forEach(chk => {
      chk.addEventListener('change', e => {
        const id = e.target.dataset.id;
        const row = intakeRows.find(x => x.id === id);
        if (row) row.selected = e.target.checked;
        const chkAll = document.getElementById('chk-all');
        if (chkAll) chkAll.checked = intakeRows.length && intakeRows.every(r => r.selected);
      });
    });

    // Wire field input / change handlers
    tb.querySelectorAll('input[data-f]').forEach(inp => {
      const id = inp.dataset.id, f = inp.dataset.f;

      // Tab on last UID field → auto-add row
      if (f === 'uid') {
        inp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Tab' && !ev.shiftKey) {
            const idx = intakeRows.findIndex(x => x.id === id);
            if (idx === intakeRows.length - 1) {
              setTimeout(() => { intakeRows.push(newRow()); renderIntake(); }, 0);
            }
          }
        });
      }

      inp.addEventListener('input', e => {
        const row = intakeRows.find(x => x.id === id); if (!row) return;
        if (f === 'uid') {
          row[f] = String(e.target.value ?? '');         // UID verbatim
        } else if (f === 'date_local') {
          row[f] = toISODate(String(e.target.value || '').trim());
        } else {
          row[f] = String(e.target.value || '').trim();
        }
        row.status = requiredFilled(row) ? 'complete' : 'draft';
        row.sync = 'pending';
      });

      inp.addEventListener('change', async e => {
        const row = intakeRows.find(x => x.id === id); if (!row) return;
        if (!apiBase || !requiredFilled(row)) { renderIntake(); return; }
        try {
          const res = await fetch(`${apiBase}/records`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: row.id, date_local: row.date_local, mobile_bin: row.mobile_bin,
              sscc_label: row.sscc_label, po_number: row.po_number,
              sku_code: row.sku_code, uid: row.uid
            })
          });
          const j = await res.json().catch(() => ({}));
          if (res.ok && j.ok) { row.status = 'complete'; row.sync = 'synced'; }
          else { row.sync = 'pending'; }
        } catch { row.sync = 'pending'; }
        renderIntake();
        await loadOpsMetrics();
        emitIntakeSynced();
      });
    });

    // Ribbon quick badges
    const draftsEl = document.getElementById('ops-drafts');
    if (draftsEl) draftsEl.textContent = drafts;
    const badgeWrap = document.getElementById('ops-sync-badges');
    if (badgeWrap) {
      badgeWrap.innerHTML =
        `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] border-green-200 bg-green-50 text-green-700">synced: ${synced}</span>
         <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] border-amber-200 bg-amber-50 text-amber-700">pending: ${drafts}</span>`;
    }
  }

  // ====================================================================
  // Button handlers
  // ====================================================================

  // Add Row
  const btnAdd = document.getElementById('btn-add-row');
  if (btnAdd) btnAdd.onclick = () => { intakeRows.push(newRow()); renderIntake(); };

  // Delete Selected
  const btnDelSel = document.getElementById('btn-delete-selected');
  if (btnDelSel) btnDelSel.onclick = async () => {
    const selected = intakeRows.filter(r => r.selected);
    if (!selected.length) return alert('Select at least one row.');
    if (!confirm(`Delete ${selected.length} row(s)?`)) return;

    if (apiBase) {
      const pairs = selected.filter(r => r.uid && r.sku_code).map(r => ({ uid: r.uid, sku_code: r.sku_code }));
      if (pairs.length) {
        try {
          await fetch(`${apiBase}/records/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pairs)
          });
        } catch (e) { console.warn('Server delete error', e); }
      }
    }
    for (let i = intakeRows.length - 1; i >= 0; i--) {
      if (intakeRows[i].selected) intakeRows.splice(i, 1);
    }
    if (!intakeRows.length) intakeRows.push(newRow());
    renderIntake();
    await loadOpsMetrics();
    emitIntakeSynced();
  };

  // Export XLSX
  const btnExport = document.getElementById('btn-export-day');
  if (btnExport) btnExport.onclick = () => {
    if (!apiBase) return;
    const d = iso(new Date());
    window.location = `${apiBase}/export/xlsx?date=${d}`;
  };

  // Select-all checkbox
  const chkAll = document.getElementById('chk-all');
  if (chkAll) chkAll.addEventListener('change', (e) => {
    const on = e.target.checked;
    intakeRows.forEach(r => r.selected = on);
    renderIntake();
    document.getElementById('chk-all').checked = on;
  });

  // ====================================================================
  // Upload UIDs (XLSX / CSV → intake table → POST /records/import)
  // ====================================================================
  (function wireUploadUIDs() {
    const btn = document.getElementById('btn-upload-applied');
    const file = document.getElementById('file-upload-applied');
    if (!btn || !file) return;

    btn.onclick = () => file.click();

    file.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
      try {
        let rows = [];
        if (/\.xlsx?$/i.test(f.name)) {
          const buf = await f.arrayBuffer();
          const wb = XLSX.read(buf, { type: 'array' });
          rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        } else {
          const text = await f.text();
          const lines = text.split(/\r?\n/).filter(Boolean);
          const hdr = lines.shift().split(',').map(s => s.trim());
          rows = lines.map(l => l.split(',')).map(c => {
            const o = {}; hdr.forEach((h, i) => o[h] = c[i] ?? ''); return o;
          });
        }

        const normRow = (r) => {
          const n = {};
          for (const k in r) { n[k.trim().toLowerCase().replace(/\s+/g, '_')] = r[k]; }
          const pick = (...a) => {
            for (const x of a) { const v = n[x]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
            return '';
          };
          const pickRaw = (...a) => {
            for (const x of a) { if (x in n) return String(n[x] ?? ''); }
            return '';
          };
          return {
            date_local: toISODate(pick('date_local', 'date')),
            mobile_bin: pick('mobile_bin', 'mobile_bin_(box)', 'mobile_bin (box)'),
            sscc_label: pick('sscc_label', 'sscc', 'sscc_label (box)'),
            po_number:  pick('po_number', 'po', 'po#'),
            sku_code:   pick('sku_code', 'sku'),
            uid:        pickRaw('uid', 'u_id', 'u id')
          };
        };

        const items = rows.map(normRow).filter(r => r.po_number && r.sku_code && (r.uid !== ''));
        if (!items.length) return alert('No valid rows found (need PO_Number, SKU_Code, UID).');

        // Build UI rows & a bulk payload for the backend
        const payload = [];
        for (const r of items) {
          const ui = newRow();
          ui.date_local  = r.date_local || iso(new Date());
          ui.mobile_bin  = r.mobile_bin || '';
          ui.sscc_label  = r.sscc_label || '';
          ui.po_number   = r.po_number;
          ui.sku_code    = r.sku_code;
          ui.uid         = r.uid;          // verbatim
          ui.status      = requiredFilled(ui) ? 'complete' : 'draft';
          ui.sync        = 'pending';
          intakeRows.push(ui);

          payload.push({
            date_local: ui.date_local,
            mobile_bin: ui.mobile_bin,
            sscc_label: ui.sscc_label,
            po_number:  ui.po_number,
            sku_code:   ui.sku_code,
            uid:        ui.uid
          });
        }

        if (apiBase && payload.length) {
          try {
            const res = await fetch(`${apiBase}/records/import`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const j = await res.json().catch(() => ({}));

            if (res.ok && j.ok) {
              const insertedCount = j.inserted ?? payload.length;
              const rejectedCount = j.rejected ?? 0;
              const newlyAdded = intakeRows.slice(-items.length);

              for (const ui of newlyAdded) {
                if (requiredFilled(ui)) {
                  ui.sync   = 'synced';
                  ui.status = 'complete';
                }
              }

              if (rejectedCount) {
                console.warn('Some rows were rejected by the server', j.errors || []);
                alert(`Upload finished.\nInserted: ${insertedCount}\nRejected: ${rejectedCount}`);
              }
            } else {
              alert('Upload failed on server.');
            }
          } catch (err) {
            console.error(err);
            alert('Upload failed: ' + (err?.message || err));
          }
        }

        renderIntake();
        await loadOpsMetrics();
        emitIntakeSynced();
      } catch (err) {
        console.error(err);
        alert('Upload failed: ' + (err?.message || err));
      }
    });
  })();

  // ====================================================================
  // Upload Bin Manifest (XLSX / CSV → PUT /bins/weeks/:ws)
  // ====================================================================
  (function wireUploadBins() {
    const btn  = document.getElementById('btn-upload-bins');
    const file = document.getElementById('file-bins');
    if (!btn || !file) return;

    btn.onclick = () => file.click();

    function toNumberOrNull(v) {
      const n = Number(String(v ?? '').toString().replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : null;
    }

    function normalizeRow(r) {
      const n = {};
      for (const k in r) n[k.toLowerCase().replace(/\s+/g, '_')] = r[k];
      const pick = (...keys) => {
        for (const k of keys) {
          const v = n[k];
          if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return '';
      };
      const id       = pick('mobile_bin', 'bin_id', 'bin', 'bin_no', 'bin_number');
      const unitsRaw = pick('total_units', 'units', 'qty', 'quantity');
      const weightRaw= pick('weight_kg', 'weight', 'kg');
      const dateRaw  = pick('date', 'date_local', 'created_at');

      return {
        mobile_bin:  id,
        total_units: toNumberOrNull(unitsRaw),
        weight_kg:   toNumberOrNull(weightRaw),
        date_local:  toISODate(dateRaw) || todayInTZ()
      };
    }

    function validateBin(b) {
      const errs = [];
      if (!b.mobile_bin) errs.push('Missing mobile_bin');
      if (b.total_units != null && b.total_units < 0) errs.push('total_units < 0');
      if (b.weight_kg  != null && b.weight_kg  < 0) errs.push('weight_kg < 0');
      if (b.total_units != null && b.weight_kg != null) {
        const perUnit = b.weight_kg / Math.max(1, b.total_units);
        if (perUnit < 0.001 || perUnit > 10) b._suspicious = true;
      }
      return errs;
    }

    file.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; e.target.value = ''; if (!f || !apiBase) return;

      try {
        let rows = [];
        if (/\.xlsx?$/i.test(f.name)) {
          const buf = await f.arrayBuffer();
          const wb  = XLSX.read(buf, { type: 'array' });
          rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        } else {
          const buf = await f.arrayBuffer();
          const wb  = XLSX.read(new Uint8Array(buf), { type: 'array' });
          rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        }

        if (!rows.length) { alert('No rows found in manifest.'); return; }

        // Use the currently selected week if available, else compute from today
        const ws = (typeof state !== 'undefined' && state.weekStart)
          ? state.weekStart
          : mondayOfInTZ(todayInTZ());

        const items = rows.map(normalizeRow).filter(r => r.mobile_bin);

        const rejected = [];
        for (const it of items) {
          const errs = validateBin(it);
          if (errs.length) rejected.push({ it, errs });
        }
        const valid = items.filter(it => !rejected.find(x => x.it === it));

        if (!valid.length) { alert('No valid bin rows to upload.'); return; }

        const resp = await fetch(`${apiBase}/bins/weeks/${ws}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(valid)
        });
        if (!resp.ok) {
          const msg = await resp.text().catch(() => 'Upload failed');
          alert(msg);
          return;
        }

        const summary = await resp.json().catch(() => ({}));
        alert(summary?.ok
          ? `Bin manifest uploaded: ${valid.length} row(s).${rejected.length ? `  Rejected: ${rejected.length}` : ''}`
          : `Upload finished with warnings. Accepted: ${valid.length}${rejected.length ? `, Rejected: ${rejected.length}` : ''}`
        );

        // Let the main script refresh week / bin QA
        emitIntakeSynced();
      } catch (err) {
        console.error(err);
        alert('Upload failed: ' + (err?.message || err));
      }
    });
  })();

  // ====================================================================
  // Delete Applied UIDs (quick utility)
  // ====================================================================
  async function deleteUIDs() {
    const ta     = document.getElementById('uids-to-delete');
    const status = document.getElementById('delete-uids-status');
    if (!ta) return;
    const raw = ta.value.trim();
    if (!raw) { alert('Please enter at least one UID.'); return; }

    const list = raw.split(/[\s,]+/).filter(Boolean);
    if (!list.length) return alert('No valid UIDs found.');
    if (!confirm(`Delete ${list.length} UID record(s)?`)) return;

    status.textContent = 'Deleting...';

    try {
      const res = await fetch(`${apiBase}/records/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(list.map(uid => ({ uid })))
      });

      if (!res.ok) throw new Error(await res.text());
      const body = await res.json().catch(() => ({}));
      const n = typeof body.total_deleted === 'number' ? body.total_deleted : list.length;
      status.textContent = `Deleted ${n} UID(s) successfully.`;
      if (Array.isArray(body.results) && body.results.length) {
        const lines = body.results.map(r =>
          `${r.uid}${r.sku_code ? ` (${r.sku_code})` : ''}: ${r.deleted}`
        );
        status.textContent += `  [ ${lines.join(' · ')} ]`;
      }
      ta.value = '';
      await loadOpsMetrics();
      emitIntakeSynced();
    } catch (e) {
      console.error(e);
      status.textContent = 'Error deleting: ' + (e.message || e);
    }
  }

  const btnDelUIDs = document.getElementById('btn-delete-uids');
  if (btnDelUIDs) btnDelUIDs.addEventListener('click', deleteUIDs);

  // ====================================================================
  // Ops metrics & Ops Pulse (intake ribbon)
  // ====================================================================
  async function loadOpsMetrics() {
    if (!apiBase) return;
    try {
      const rows = await getRecordsSnapshot(15000);

      const now = Date.now();
      const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
      const hourAgo = now - 3600e3;
      const halfAgo = now - 1800e3;

      let scansToday = 0, lastHour = 0, rate = 0, drafts = 0, dupes = 0;
      const syncCounts = {}, seen = new Set();

      for (const r of rows) {
        const ct = r.completed_at ? new Date(r.completed_at).getTime() : null;
        const todayByCompletion = !!ct && ct >= startToday.getTime();

        if (r.status === 'complete') {
          if (todayByCompletion) scansToday++;
          if (ct && ct >= hourAgo) lastHour++;
          if (ct && ct >= halfAgo) rate++;
          if (r.sku_code && r.uid) {
            const k = r.sku_code + '|' + r.uid;
            if (seen.has(k)) dupes++; else seen.add(k);
          }
        } else drafts++;

        const s = r.sync_state || 'unknown';
        syncCounts[s] = (syncCounts[s] || 0) + 1;
      }

      const el = (id) => document.getElementById(id);

      const opsToday = el('ops-today');
      if (opsToday) opsToday.textContent = scansToday.toLocaleString();
      const opsHour = el('ops-hour');
      if (opsHour) opsHour.textContent = lastHour.toLocaleString();
      const opsRate = el('ops-rate');
      if (opsRate) opsRate.textContent = (rate * 2).toLocaleString();
      const opsDrafts = el('ops-drafts');
      if (opsDrafts) opsDrafts.textContent = drafts.toLocaleString();
      const opsDupes = el('ops-dupes');
      if (opsDupes) opsDupes.textContent = dupes.toLocaleString();
      const opsUpdated = el('ops-last-updated');
      if (opsUpdated) opsUpdated.textContent = new Date().toLocaleTimeString();

      // Pulse animation + hearts
      const bpm = Math.max(40, Math.min(200, rate * 2));
      const bpmEl = el('intake-bpm');
      if (bpmEl) bpmEl.textContent = bpm;

      const small = el('ops-heart-small');
      if (small) { small.innerHTML = ''; small.appendChild(createHeart(18, BRAND, bpm)); }

      // Also update the dashboard heart if it exists (shared element)
      const big = el('ops-heart');
      if (big) {
        big.innerHTML = '';
        big.appendChild(createHeart(24, BRAND, bpm));
        const bpmBig = el('ops-bpm');
        if (bpmBig) bpmBig.textContent = bpm;
        const extra = el('ops-extra');
        if (extra) {
          const delta = bpm - 40;
          extra.textContent = `${delta >= 0 ? '+' : ''}${delta} over 40`;
        }
      }

      const wrap = el('ops-sync-badges');
      if (wrap) {
        wrap.innerHTML = '';
        Object.entries(syncCounts)
          .sort((a, b) => b[1] - a[1])
          .forEach(([name, count]) => {
            const span = document.createElement('span');
            span.className =
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ' +
              (name === 'synced'  ? 'border-green-200 bg-green-50 text-green-700'
              : name === 'pending' ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-gray-200 bg-gray-50 text-gray-700');
            span.textContent = `${name}: ${count}`;
            wrap.appendChild(span);
          });
      }

      const alerts = [];
      if (drafts > 0)
        alerts.push(`There ${drafts === 1 ? 'is' : 'are'} ${drafts} draft${drafts === 1 ? '' : 's'} to complete.`);
      if (dupes > 0)
        alerts.push(`${dupes} duplicate UID${dupes === 1 ? '' : 's'} detected today.`);

      const alertsEl = el('ops-alerts');
      if (alertsEl) {
        alertsEl.innerHTML = alerts.length
          ? alerts.map(t => `<li>${t}</li>`).join('')
          : '<li class="text-gray-400">No alerts.</li>';
      }
    } catch (e) {
      console.warn('[intake] Ops ribbon metrics load failed:', e);
    }
  }

  // ====================================================================
  // SSE (real-time scan events) — coalesced to avoid UI hangs
  // ====================================================================
  let __opsRefreshTimer   = null;
  let __opsRefreshRunning = false;
  let __opsRefreshPending = false;
  let __opsRefreshLast    = 0;

  function scheduleOpsRefresh() {
    if (!apiBase) return;
    if (document.hidden) return;
    __opsRefreshPending = true;
    if (__opsRefreshTimer) return;
    const minGapMs = 1500;
    const wait = Math.max(0, minGapMs - (Date.now() - __opsRefreshLast));
    __opsRefreshTimer = setTimeout(runOpsRefresh, wait);
  }

  async function runOpsRefresh() {
    __opsRefreshTimer = null;
    if (__opsRefreshRunning) { __opsRefreshPending = true; return; }
    if (!__opsRefreshPending) return;
    __opsRefreshPending = false;
    __opsRefreshRunning = true;
    __opsRefreshLast = Date.now();

    try {
      await new Promise(r => setTimeout(r, 0));
      await loadOpsMetrics();
    } catch (e) {
      console.warn('[intake] Ops refresh failed:', e);
    } finally {
      __opsRefreshRunning = false;
      if (__opsRefreshPending) scheduleOpsRefresh();
    }
  }

  function startSSE() {
    if (!apiBase) return;
    try {
      const ev = new EventSource(`${apiBase}/events/scan`);
      const dot = document.getElementById('ops-dot');
      if (dot) dot.classList.replace('bg-gray-300', 'bg-green-500');

      ev.onmessage = () => { scheduleOpsRefresh(); };
      ev.onerror = () => {
        try { ev.close(); } catch {}
        if (dot) dot.classList.replace('bg-green-500', 'bg-amber-500');
        setTimeout(startSSE, 3000);
      };

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) scheduleOpsRefresh();
      });
    } catch {}
  }

  // ====================================================================
  // Expose key functions on window so the main script can call them
  // (mirrors the original monolith where they shared one closure)
  // ====================================================================
  window.renderIntake    = renderIntake;
  window.loadOpsMetrics  = loadOpsMetrics;
  window.startSSE        = startSSE;
  window.intakeRows      = intakeRows;

  // ====================================================================
  // INIT
  // ====================================================================
  renderIntake();

  const heartSmall = document.getElementById('ops-heart-small');
  if (heartSmall) heartSmall.appendChild(createHeart(18, BRAND, 40));

  loadOpsMetrics();
  startSSE();

  console.log('[intake] intake_live_additive.js loaded ✓');
})();
