import axios from 'axios';

const backendUrl = () => {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
};

export interface RunMeta {
  id: string;
  executedAt: string;
  productName: string;
  mode: 'AI Agent' | 'Playwright Script';
  source?: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  duration: number;
  passRate: number;
}

export interface StoredRun extends RunMeta {
  results: any[];
}

export interface HistoryStats {
  totalRuns: number;
  averagePassRate: number;
  runs7d: number;
  runs30d: number;
  trend: { date: string; passRate: number; total: number }[];
  flakiest: { name: string; runs: number; passes: number; fails: number; flakiness: number }[];
  slowest: { name: string; avgDuration: number; runs: number }[];
}

export const listRuns = async (limit = 100): Promise<RunMeta[]> => {
  const res = await axios.get(`${backendUrl()}/api/history/runs?limit=${limit}`, { timeout: 10000 });
  return res.data.runs || [];
};

export const getRun = async (id: string): Promise<StoredRun> => {
  const res = await axios.get(`${backendUrl()}/api/history/runs/${encodeURIComponent(id)}`, { timeout: 10000 });
  return res.data;
};

export const deleteRun = async (id: string): Promise<void> => {
  await axios.delete(`${backendUrl()}/api/history/runs/${encodeURIComponent(id)}`, { timeout: 10000 });
};

export const fetchStats = async (): Promise<HistoryStats> => {
  const res = await axios.get(`${backendUrl()}/api/history/stats`, { timeout: 20000 });
  return res.data;
};
