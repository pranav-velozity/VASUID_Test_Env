// server.js — VelOzity UID Ops Backend (Express + SQLite + SSE)

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

// ---- Config ----
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // set to your frontend origin(s) in prod
const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DB_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DB_DIR, 'uid_ops.sqlite');

// ---- App ----
const app = express();

// --- Global CORS (single source of truth) ---
const allowList = (ALLOWED_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin/curl
    if (allowList.includes('*') || allowList.includes(origin)) return cb(null, true);
    // allow Netlify preview subdomains if a wildcard *.netlify.app was provided
    if (allowList.some(a => a.endsWith('.netlify.app') && origin.endsWith('.netlify.app'))) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '100mb' }));

/* ===== BEGIN: /api alias -> root endpoints =====
   This lets /api/plan, /api/records, /api/bins hit the same handlers as
   /plan, /records, /bins without duplicating code.
   Place ABOVE all your app.get('/...') routes.
*/
app.use('/api', (req, res, next) => {
  // keep querystring; only drop the /api prefix
  // e.g. /api/plan?weekStart=2025-11-03 -> /plan?weekStart=2025-11-03
  req.url = req.url.replace(/^\/api\/?/, '/');
  next();
});
/* ===== END: /api alias ===== */

// --- Time helpers (America/Chicago) ---
function chicagoISOFromDate(d = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = fmt.formatToParts(d);
    const y = parts.find(p => p.type === 'year')?.value;
    const m = parts.find(p => p.type === 'month')?.value;
    const dd = parts.find(p => p.type === 'day')?.value;
    if (y && m && dd) return `${y}-${m}-${dd}`;
  } catch {}
  return d.toISOString().slice(0, 10);
}
const todayChicagoISO = () => chicagoISOFromDate(new Date());

function toISODate(v) {
  if (v == null) return '';
  if (typeof v === 'number' && isFinite(v)) { // Excel serial
    const base = new Date(Date.UTC(1899, 11, 30));
    const ms = Math.round(v * 86400000);
    const d = new Date(base.getTime() + ms);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d1 = new Date(s);
  if (!isNaN(d1)) return d1.toISOString().slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = (m[3].length === 2 ? '20' + m[3] : m[3]);
    const d2 = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (!isNaN(d2)) return d2.toISOString().slice(0, 10);
  }
  return '';
}

// --- DB setup ---
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  date_local TEXT,
  mobile_bin TEXT,
  sscc_label TEXT,
  po_number TEXT,
  sku_code TEXT,
  uid TEXT,
  status TEXT DEFAULT 'draft',
  completed_at TEXT,
  sync_state TEXT DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(date_local);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE INDEX IF NOT EXISTS idx_records_po ON records(po_number);
CREATE INDEX IF NOT EXISTS idx_records_sku ON records(sku_code);
CREATE INDEX IF NOT EXISTS idx_records_uid ON records(uid);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_po_sku_uid ON records(po_number, sku_code, uid);

CREATE TABLE IF NOT EXISTS plans (
  week_start TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const selectRecordById = db.prepare('SELECT * FROM records WHERE id = ?');
const selectByComposite = db.prepare('SELECT id FROM records WHERE po_number = ? AND sku_code = ? AND uid = ?');
const deleteById = db.prepare('DELETE FROM records WHERE id = ?');
const deleteBySkuUid = db.prepare('DELETE FROM records WHERE uid = ? AND sku_code = ?');
const deleteByUid = db.prepare('DELETE FROM records WHERE uid = ?');

const upsertByComposite = db.prepare(`
INSERT INTO records (id, date_local, mobile_bin, sscc_label, po_number, sku_code, uid, status, completed_at, sync_state)
VALUES (@id, @date_local, @mobile_bin, @sscc_label, @po_number, @sku_code, @uid, @status, @completed_at, @sync_state)
ON CONFLICT(po_number, sku_code, uid) DO UPDATE SET
  date_local   = COALESCE(excluded.date_local, records.date_local),
  mobile_bin   = COALESCE(excluded.mobile_bin, records.mobile_bin),
  sscc_label   = COALESCE(excluded.sscc_label, records.sscc_label),
  status       = CASE WHEN excluded.status='complete' THEN 'complete' ELSE records.status END,
  completed_at = COALESCE(records.completed_at, excluded.completed_at),
  sync_state   = 'synced'
`);

// --- Completion rule (SSCC optional) ---
function isComplete(row) {
  return Boolean(
    (row?.date_local || '').trim() &&
    (row?.mobile_bin || '').trim() &&
    (row?.po_number || '').trim() &&
    (row?.sku_code  || '').trim() &&
    (row?.uid       || '').trim()
  );
}

// --- SSE hub for ops pulse ---
const clients = new Set();
function emitScan(ts = new Date()) {
  const payload = JSON.stringify({ ts: ts.toISOString() });
  for (const res of clients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
}

app.get('/events/scan', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': allowList.includes('*') ? '*' : (req.headers.origin || allowList[0] || '*')
  });
  res.write('\n');
  clients.add(res);
  req.on('close', () => { clients.delete(res); });
});

// --- Health ---
app.get('/health', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// --- Inline cell patch from Intake table ---
app.patch('/records/:id', (req, res) => {
  const id = String(req.params.id);
  const { field, value } = req.body || {};
  if (!id || !field) return res.status(400).json({ error: 'id and field required' });

  const allowed = new Set(['date_local','mobile_bin','sscc_label','po_number','sku_code','uid']);
  if (!allowed.has(field)) return res.status(400).json({ error: `Invalid field: ${field}` });

  let row = selectRecordById.get(id);
  let createdNow = false;
  if (!row) {
    db.prepare(`INSERT INTO records(id, date_local, status, sync_state) VALUES(?, ?, 'draft', 'pending')`)
      .run(id, todayChicagoISO());
    row = selectRecordById.get(id);
    createdNow = true;
  }

  const next = { ...row, [field]: String(value ?? '') };
  const completed = isComplete(next);

  db.prepare(`
    UPDATE records SET
      date_local=?, mobile_bin=?, sscc_label=?, po_number=?, sku_code=?, uid=?,
      status=?, completed_at=?, sync_state=? WHERE id=?
  `).run(
    next.date_local || row.date_local || todayChicagoISO(),
    next.mobile_bin ?? row.mobile_bin ?? '',
    next.sscc_label ?? row.sscc_label ?? '',
    next.po_number  ?? row.po_number  ?? '',
    next.sku_code   ?? row.sku_code   ?? '',
    next.uid        ?? row.uid        ?? '',
    completed ? 'complete' : 'draft',
    completed ? new Date().toISOString() : row.completed_at,
    completed ? 'synced' : 'pending',
    id
  );

  const after = selectRecordById.get(id);

  // if just completed, pulse
  if (completed && row.status !== 'complete') emitScan(new Date(after.completed_at));

  // if we created a new shell but it duplicates an existing composite, drop the shell
  if (createdNow && after.po_number && after.sku_code && after.uid) {
    const ex = selectByComposite.get(after.po_number, after.sku_code, after.uid);
    if (ex && ex.id && ex.id !== id) { try { deleteById.run(id); } catch {} }
  }

  return res.json({ ok: true, record: after });
});

// --- Create record (used by UI once a row is complete) ---
app.post('/records', (req, res) => {
  const b = req.body || {};
  const rec = {
    id: b.id || randomUUID(),
    date_local: toISODate(b.date_local) || todayChicagoISO(),
    mobile_bin: String(b.mobile_bin ?? ''),
    sscc_label: String(b.sscc_label ?? ''), // optional
    po_number:  String(b.po_number  ?? ''),
    sku_code:   String(b.sku_code   ?? ''),
    uid:        String(b.uid        ?? ''),
    status:     'complete',
    completed_at: new Date().toISOString(),
    sync_state: 'synced'
  };

  if (!rec.date_local || !rec.mobile_bin || !rec.po_number || !rec.sku_code || !rec.uid) {
    return res.status(400).json({ error: 'date_local, mobile_bin, po_number, sku_code, uid are required' });
  }

  try {
    upsertByComposite.run(rec);
    emitScan(new Date(rec.completed_at));
    const row = selectByComposite.get(rec.po_number, rec.sku_code, rec.uid);
    const saved = row ? selectRecordById.get(row.id) : selectRecordById.get(rec.id);
    return res.json({ ok: true, record: saved });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- Import (kept for compatibility; UI can still call it if desired) ---
function normalizeUploadRow(row) {
  const norm = {};
  for (const k in row) norm[String(k).toLowerCase().trim()] = row[k];
  const pick = (...names) => {
    for (const n of names) {
      const v = norm[n.toLowerCase().trim()];
      if (v != null && String(v).trim() !== '') return String(v);
    }
    return '';
  };
  return {
    id: randomUUID(),
    date_local: toISODate(pick('date_local', 'date')) || todayChicagoISO(),
    mobile_bin: String(pick('mobile_bin', 'mobile bin (box)') || ''),
    sscc_label: String(pick('sscc_label', 'sscc label (box)', 'sscc') || ''),
    po_number:  String(pick('po_number', 'po_number', 'po', 'po#', 'po number') || ''),
    sku_code:   String(pick('sku_code', 'sku_code', 'sku', 'sku code') || ''),
    uid:        String(pick('uid', 'uid', 'u_id', 'u id') || ''), // verbatim
    status: 'complete',
    completed_at: new Date().toISOString(),
    sync_state: 'synced'
  };
}

app.post('/records/import', (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : [];
  if (!arr.length) return res.status(400).json({ error: 'array of rows required' });

  try {
    const normalized = arr.map(normalizeUploadRow);

    const payload = [];
    const rejected = [];

    normalized.forEach((r, index) => {
      const missing = [];
      if (!r.date_local) missing.push('date_local');
      if (!r.po_number) missing.push('po_number');
      if (!r.sku_code)  missing.push('sku_code');
      if (!r.uid)       missing.push('uid');

      if (missing.length) {
        rejected.push({
          index,
          po_number: r.po_number,
          sku_code:  r.sku_code,
          uid:       r.uid,
          reason:    'Missing ' + missing.join(', ')
        });
      } else {
        // NOTE: mobile_bin is allowed to be empty on import; can be fixed later in intake UI
        payload.push(r);
      }
    });

    if (!payload.length) {
      return res.json({
        ok:       true,
        inserted: 0,
        total:    arr.length,
        rejected: rejected.length,
        errors:   rejected
      });
    }

    const trx = db.transaction(rows => {
      for (const r of rows) upsertByComposite.run(r);
    });
    trx(payload);

    if (payload.length) {
      emitScan(new Date(payload[payload.length - 1].completed_at));
    }

    return res.json({
      ok:       true,
      inserted: payload.length,
      total:    arr.length,
      rejected: rejected.length,
      errors:   rejected
    });
  } catch (e) {
    console.error('Import failed:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});


// --- Fetch records ---
app.get('/records', (req, res) => {
  // Accept either from/to OR weekStart/weekEnd (we translate weekStart/weekEnd to from/to)
  const weekStart = req.query.weekStart ? String(req.query.weekStart) : '';
  const weekEnd   = req.query.weekEnd   ? String(req.query.weekEnd)   : '';
  const fromQ     = req.query.from      ? String(req.query.from)      : '';
  const toQ       = req.query.to        ? String(req.query.to)        : '';

  const from = fromQ || weekStart || '';
  const to   = toQ   || weekEnd   || '';
  const status = req.query.status ? String(req.query.status) : '';
  const limit  = req.query.limit  ? Number(req.query.limit)  : undefined;

  const params = [];
  let sql = 'SELECT * FROM records WHERE 1=1';
  if (from)   { sql += ' AND date_local >= ?'; params.push(from); }
  if (to)     { sql += ' AND date_local <= ?'; params.push(to); }
  if (status) { sql += ' AND status = ?';      params.push(status); }
  sql += ' ORDER BY completed_at DESC';
  if (limit)  { sql += ' LIMIT ?';             params.push(limit); }

  const rows = db.prepare(sql).all(...params);
  res.json({ records: rows });
});

// --- Export XLSX ---
app.get('/export/xlsx', async (req, res) => {
  const date = String(req.query.date || todayChicagoISO());
  const rows = db.prepare('SELECT * FROM records WHERE date_local = ? ORDER BY completed_at DESC').all(date);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('UIDs');
  ws.columns = [
    { header: 'Date', key: 'date_local', width: 12 },
    { header: 'Mobile Bin (BOX)', key: 'mobile_bin', width: 16 },
    { header: 'SSCC Label (BOX)', key: 'sscc_label', width: 18 },
    { header: 'PO_Number', key: 'po_number', width: 14 },
    { header: 'SKU_Code', key: 'sku_code', width: 14 },
    { header: 'UID', key: 'uid', width: 22 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Completed At', key: 'completed_at', width: 22 },
  ];
  rows.forEach(r => ws.addRow(r));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="uids_${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// --- Deletions ---
app.delete('/records', (req, res) => {
  const uid = String(req.query.uid || '').trim();
  const sku = String(req.query.sku_code || '').trim();

  if (!uid) return res.status(400).json({ error: 'uid required' });

  const info = sku
    ? deleteBySkuUid.run(uid, sku)  // original behavior
    : deleteByUid.run(uid);         // NEW: delete all rows with this UID

  return res.json({ ok: true, deleted: info.changes });
});

app.post('/records/delete', (req, res) => {
  const input = req.body;

  // Normalize input to a list of objects with { uid, sku_code? }
  let items = [];
  if (Array.isArray(input)) {
    items = input.map(x => {
      if (typeof x === 'string') return { uid: String(x).trim(), sku_code: '' };
      return { uid: String(x?.uid || '').trim(), sku_code: String(x?.sku_code || '').trim() };
    });
  } else if (input && typeof input === 'object') {
    items = [{ uid: String(input.uid || '').trim(), sku_code: String(input.sku_code || '').trim() }];
  }

  if (!items.length) {
    return res.status(400).json({ error: 'Body must be array or object containing uid (and optional sku_code)' });
  }

  const results = [];
  const trx = db.transaction(list => {
    for (const it of list) {
      const uid = it.uid;
      const sku = it.sku_code;

      if (!uid) {
        results.push({ uid, sku_code: sku, deleted: 0, error: 'missing uid' });
        continue;
      }

      const info = sku
        ? deleteBySkuUid.run(uid, sku) // original precise delete
        : deleteByUid.run(uid);        // NEW: delete all rows with this UID

      results.push({ uid, sku_code: sku, deleted: info.changes });
    }
  });

  try { trx(items); }
  catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }

  const total = results.reduce((s, r) => s + (r.deleted || 0), 0);
  return res.json({ ok: true, total_deleted: total, results });
});

// Simple helper to compute Monday for a given date (kept consistent with your existing mondayOf)
function mondayOfLoose(ymd) {
  if (!ymd) return '';
  try {
    const d = new Date(String(ymd).trim() + 'T00:00:00Z');
    const day = d.getUTCDay();               // 0..6, Sunday=0
    const diff = (day === 0 ? -6 : (1 - day));
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0,10);
  } catch { return ''; }
}

/* ===== BEGIN: /plan?weekStart=YYYY-MM-DD alias =====
   Returns the same payload as GET /plan/weeks/:mondayISO
   (works for /api/plan too thanks to the /api alias above)
*/
app.get('/plan', (req, res) => {
  const ws = String(req.query.weekStart || req.query.ws || '').trim();
  if (!ws) return res.status(400).json({ error: 'weekStart required' });
  const monday = mondayOfLoose(ws);
  if (!monday) return res.status(400).json({ error: 'invalid weekStart' });

  const row = db.prepare('SELECT data FROM plans WHERE week_start = ?').get(monday);
  if (!row) return res.json([]);
  try { return res.json(JSON.parse(row.data) || []); }
  catch { return res.json([]); }
});
/* ===== END: /plan alias ===== */


// ---------- Weekly Plan API (kept) ----------
function normalizePlanArray(body, fallbackStart) {
  if (!Array.isArray(body)) return [];
  const norm = body.map(r => ({
    po_number: String(r?.po_number ?? '').trim(),
    sku_code:  String(r?.sku_code  ?? '').trim(),
    start_date: (String(r?.start_date ?? '').trim()) || fallbackStart || '',
    due_date:   String(r?.due_date   ?? '').trim(),
    target_qty: Number(r?.target_qty ?? 0) || 0,
    priority:   r?.priority ? String(r.priority).trim() : undefined,
    notes:      r?.notes ? String(r.notes).trim() : undefined,
  })).filter(r => r.po_number && r.sku_code && r.due_date);
  return norm;
}

app.get('/plan/weeks/:mondayISO', (req, res) => {
  const monday = String(req.params.mondayISO);
  const row = db.prepare('SELECT data FROM plans WHERE week_start = ?').get(monday);
  if (!row) return res.json([]);
  try {
    return res.json(JSON.parse(row.data) || []);
  } catch {
    return res.json([]);
  }
});

app.put('/plan/weeks/:mondayISO', (req, res) => {
  const monday = String(req.params.mondayISO);
  const arr = normalizePlanArray(req.body, monday);
  db.prepare(`
    INSERT INTO plans(week_start, data, updated_at)
    VALUES(?, ?, datetime('now'))
    ON CONFLICT(week_start) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
  `).run(monday, JSON.stringify(arr));
  return res.json(arr);
});

app.post('/plan/weeks/:mondayISO/zero', (req, res) => {
  const monday = String(req.params.mondayISO);
  db.prepare(`
    INSERT INTO plans(week_start, data, updated_at)
    VALUES(?, '[]', datetime('now'))
    ON CONFLICT(week_start) DO UPDATE SET data='[]', updated_at=datetime('now')
  `).run(monday);
  return res.json({ ok: true, week_start: monday, rows: 0 });
});

app.get('/plan/weeks', (req, res) => {
  const rows = db.prepare(`SELECT week_start, updated_at FROM plans ORDER BY week_start DESC LIMIT 52`).all();
  res.json(rows);
});

// --- bins.routes.js ---
const binsRouter = express.Router();

// Store: use your DB (SQL/NoSQL). Here we assume a generic DAL with upsertMany/getByWeek.
// --- Bins DAL (SQLite, inline) ---
db.exec(`
CREATE TABLE IF NOT EXISTS bins (
  week_start  TEXT NOT NULL,
  mobile_bin  TEXT NOT NULL,
  total_units INTEGER,
  weight_kg   REAL,
  date_local  TEXT,
  PRIMARY KEY (week_start, mobile_bin)
);
CREATE INDEX IF NOT EXISTS idx_bins_week ON bins(week_start);
`);

const Bins = {
  upsertMany: db.transaction((rows) => {
    const stmt = db.prepare(`
      INSERT INTO bins (week_start, mobile_bin, total_units, weight_kg, date_local)
      VALUES (@week_start, @mobile_bin, @total_units, @weight_kg, @date_local)
      ON CONFLICT(week_start, mobile_bin) DO UPDATE SET
        total_units = excluded.total_units,
        weight_kg   = excluded.weight_kg,
        date_local  = excluded.date_local
    `);
    let n = 0;
    for (const r of rows) { stmt.run(r); n++; }
    return n;
  }),
  getByWeek: (ws) => {
    return db.prepare(`
      SELECT week_start, mobile_bin, total_units, weight_kg, date_local
      FROM bins
      WHERE week_start = ?
      ORDER BY mobile_bin
    `).all(ws);
  }
};

// Helper: Monday anchor computed in business TZ on the server if you store server-side
function mondayOf(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : (1 - day));
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0,10);
}

// PUT /bins/weeks/:ws    body: [{mobile_bin, total_units?, weight_kg?, date_local?}, ...]
binsRouter.put('/weeks/:ws', async (req, res) => {
  try {
    const ws = req.params.ws; // YYYY-MM-DD (business Monday from client)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return res.status(400).send('Invalid week start');

    const rows = Array.isArray(req.body) ? req.body : [];
    if (!rows.length) return res.json({ ok: true, upserted: 0 });

    const clean = [];
    const seen = new Set();
    const errors = [];

    for (const r of rows) {
      const bin = String(r.mobile_bin || '').trim();
      const units = (r.total_units == null || r.total_units === '') ? null : Number(r.total_units);
      const weight = (r.weight_kg == null || r.weight_kg === '') ? null : Number(r.weight_kg);
      const dateLocal = String(r.date_local || ws);

      if (!bin) { errors.push({row:r, reason:'missing mobile_bin'}); continue; }
      if (units != null && (!Number.isFinite(units) || units < 0)) { errors.push({row:r, reason:'invalid total_units'}); continue; }
      if (weight != null && (!Number.isFinite(weight) || weight < 0)) { errors.push({row:r, reason:'invalid weight_kg'}); continue; }

      // de-dupe per (ws,bin). If multiple entries present, keep last one.
      const key = ws + '|' + bin;
      if (seen.has(key)) clean.pop();
      seen.add(key);

      clean.push({
        week_start: ws,
        mobile_bin: bin,
        total_units: units,
        weight_kg: weight,
        date_local: dateLocal
      });
    }

    if (!clean.length) return res.status(400).json({ ok:false, errors });

    const upserted = await Bins.upsertMany(clean); // implement in DAL
    return res.json({ ok:true, upserted, rejected: errors.length, errors });
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to upsert bins');
  }
});

// GET /bins/weeks/:ws
binsRouter.get('/weeks/:ws', async (req, res) => {
  try {
    const ws = req.params.ws;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return res.status(400).send('Invalid week start');
    const rows = await Bins.getByWeek(ws); // returns [{mobile_bin, total_units, weight_kg, date_local, week_start}, ...]
    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to fetch bins');
  }
});

app.use('/bins', binsRouter);

/* ===== BEGIN: /bins?weekStart=YYYY-MM-DD alias =====
   Returns the same as GET /bins/weeks/:ws
   (works for /api/bins too thanks to the /api alias above)
*/
app.get('/bins', (req, res) => {
  const ws = String(req.query.weekStart || req.query.ws || '').trim();
  if (!ws) return res.status(400).json({ error: 'weekStart required' });
  const monday = mondayOfLoose(ws);
  if (!monday) return res.status(400).json({ error: 'invalid weekStart' });

  try {
    const rows = Bins.getByWeek(monday);
    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Failed to fetch bins');
  }
});
/* ===== END: /bins alias ===== */



// ---- Start ----
app.listen(PORT, () => {
  console.log(`UID Ops backend listening on http://localhost:${PORT}`);
  console.log(`DB file: ${DB_FILE}`);
  console.log(`CORS origin(s): ${allowList.join(', ')}`);
});

