import { useEffect, useMemo, useState } from 'react';
import { Records, IntakeRow, connectScanEvents, formatISO } from './services';

type Filter = { from?: string; to?: string; status?: string; limit?: number };

export default function IntakePage() {
  const today = formatISO(new Date());
  const [filter, setFilter] = useState<Filter>({ from: today, to: today, limit: 200 });
  const [rows, setRows] = useState<IntakeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const { records } = await Records.list(filter);
      setRows(records);
    } catch (e: any) {
      setError(e.message || 'Failed to load records');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // initial
  useEffect(() => {
    const off = connectScanEvents(() => { load(); });
    return off;
  }, []); // SSE

  const completeCount = useMemo(() => rows.filter(r => r.status === 'complete').length, [rows]);

  async function updateCell(id: string, field: keyof IntakeRow, value: string) {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } as IntakeRow : r));
    try { await Records.patchField(id, field, value); }
    catch (e: any) { setError(e.message || 'Update failed'); await load(); }
  }

  return (
    <section>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Intake</h2>
        <span className="badge">{rows.length} rows</span>
        <span className="badge">{completeCount} complete</span>
        <span className="right" />
        <label className="muted">From</label>
        <input type="date" value={filter.from || ''} onChange={(e) => setFilter({ ...filter, from: e.target.value })}/>
        <label className="muted">To</label>
        <input type="date" value={filter.to || ''} onChange={(e) => setFilter({ ...filter, to: e.target.value })}/>
        <select value={filter.status || ''} onChange={(e) => setFilter({ ...filter, status: e.target.value || undefined })}>
          <option value="">Any status</option>
          <option value="draft">Draft</option>
          <option value="complete">Complete</option>
        </select>
        <button className="primary" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {error && <div className="card" style={{ borderColor: '#f5c2c7', background:'#fff5f5' }}>
        <strong>Error:</strong> {error}
      </div>}

      <div className="card">
        <div style={{ overflowX:'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Bin</th><th>SSCC</th><th>PO</th><th>SKU</th><th>UID</th><th>Status</th><th>Sync</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.date_local}</td>
                  <td><InlineEdit value={r.mobile_bin} onSave={(v)=>updateCell(r.id,'mobile_bin',v)}/></td>
                  <td><InlineEdit value={r.sscc_label || ''} onSave={(v)=>updateCell(r.id,'sscc_label',v)}/></td>
                  <td><InlineEdit value={r.po_number} onSave={(v)=>updateCell(r.id,'po_number',v)}/></td>
                  <td><InlineEdit value={r.sku_code} onSave={(v)=>updateCell(r.id,'sku_code',v)}/></td>
                  <td>{r.uid}</td>
                  <td><span className="badge">{r.status}</span></td>
                  <td><span className="badge">{r.sync_state}</span></td>
                </tr>
              ))}
              {!rows.length && !loading && <tr><td colSpan={8} className="muted">No records</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function InlineEdit({ value, onSave }: { value: string; onSave: (v: string)=>void }) {
  const [v, setV] = useState(value);
  useEffect(()=>setV(value), [value]);
  return (
    <span className="row" style={{ gap:6 }}>
      <input value={v} onChange={(e)=>setV(e.target.value)} style={{ minWidth: 140 }}/>
      <button onClick={()=>onSave(v)}>Save</button>
    </span>
  );
}
