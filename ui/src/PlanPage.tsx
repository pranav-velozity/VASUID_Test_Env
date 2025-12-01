import { useEffect, useMemo, useState } from 'react';
import { Plan, WeekPlan, mondayOfWeekISO, formatISO } from './services';

function weekDays(weekStartISO: string) {
  const start = new Date(weekStartISO + 'T00:00:00Z');
  return Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
    return formatISO(d);
  });
}

export default function PlanPage() {
  const [weekStart, setWeekStart] = useState(mondayOfWeekISO(new Date()));
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [status, setStatus] = useState<'idle'|'loading'|'saving'|'error'>('idle');
  const [error, setError] = useState<string>();

  async function load() {
    setStatus('loading'); setError(undefined);
    try {
      const p = await Plan.getWeek(weekStart);
      const days = weekDays(weekStart).map(date => p?.days?.find(d=>d.date===date) || { date, planned: 0 });
      setPlan({ weekStart, days });
      setStatus('idle');
    } catch (e: any) {
      setError(e.message || 'Failed to load week plan'); setStatus('error');
    }
  }

  useEffect(() => { load(); }, [weekStart]);

  const total = useMemo(()=> (plan?.days || []).reduce((s,d)=>s + (Number(d.planned)||0), 0), [plan]);

  async function save() {
    if (!plan) return;
    setStatus('saving'); setError(undefined);
    try { await Plan.putWeek(weekStart, plan); setStatus('idle'); }
    catch (e: any) { setError(e.message || 'Failed to save plan'); setStatus('error'); }
  }

  return (
    <section>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Weekly Plan</h2>
        <span className="badge">Week of {weekStart}</span>
        <span className="right" />
        <label className="muted">Week start (Mon)</label>
        <input type="date" value={weekStart} onChange={(e)=>setWeekStart(e.target.value)} />
        <button className="primary" onClick={save} disabled={status==='saving' || !plan}>
          {status==='saving' ? 'Saving…' : 'Save'}
        </button>
      </div>

      {status==='loading' && <div className="muted">Loading…</div>}
      {error && <div className="card" style={{ borderColor: '#f5c2c7', background:'#fff5f5' }}>
        <strong>Error:</strong> {error}
      </div>}

      {plan && (
        <div className="card">
          <table>
            <thead>
              <tr><th style={{width:180}}>Date</th><th>Planned</th></tr>
            </thead>
            <tbody>
              {plan.days.map((d, idx) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>
                    <input
                      type="number"
                      value={String(d.planned)}
                      onChange={(e) => setPlan(p => {
                        if (!p) return p;
                        const days = [...p.days];
                        days[idx] = { ...days[idx], planned: Number(e.target.value || 0) };
                        return { ...p, days };
                      })}
                      style={{ width: 120 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td><strong>Total</strong></td><td><strong>{total}</strong></td></tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
