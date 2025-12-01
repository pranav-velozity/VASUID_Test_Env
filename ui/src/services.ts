const API_BASE = (import.meta as any).env?.VITE_API_BASE || 'http://localhost:3000';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return undefined as T;
  return res.json() as Promise<T>;
}

// Records (Intake)
export type IntakeRow = {
  id: string;
  date_local: string;
  mobile_bin: string;
  sscc_label?: string;
  po_number: string;
  sku_code: string;
  uid: string;
  status: 'draft' | 'complete';
  sync_state: 'unknown' | 'pending' | 'synced';
};

export const Records = {
  list: async (params: { from?: string; to?: string; status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.status) q.set('status', params.status);
    if (params.limit) q.set('limit', String(params.limit));
    return req<{ records: IntakeRow[] }>(`/records${q.toString() ? `?${q}` : ''}`);
  },
  patchField: (id: string, field: string, value: string) =>
    req(`/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ field, value })
    })
};

// Plan
export type PlanDay = { date: string; planned: number };
export type WeekPlan = { weekStart: string; days: PlanDay[] };

export const Plan = {
  getWeek: (weekStartISO: string) => req<WeekPlan>(`/plan/weeks/${weekStartISO}`),
  putWeek: (weekStartISO: string, plan: WeekPlan) =>
    req(`/plan/weeks/${weekStartISO}`, { method: 'PUT', body: JSON.stringify(plan) })
};

// SSE
export function connectScanEvents(onMessage: (data: any) => void) {
  const url = `${API_BASE}/events/scan`;
  const es = new EventSource(url);
  es.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data)); } catch {}
  };
  return () => es.close();
}

// Utils
export function mondayOfWeekISO(d = new Date()) {
  const dd = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dd.getUTCDay() || 7;
  if (day > 1) dd.setUTCDate(dd.getUTCDate() - (day - 1));
  return dd.toISOString().slice(0, 10);
}
export function formatISO(d: Date) {
  const dd = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return dd.toISOString().slice(0, 10);
}
