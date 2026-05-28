import axios from 'axios';

const backendUrl = () => {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
};

export interface CICDConfigView {
  owner: string;
  repo: string;
  workflowFile: string;
  defaultBranch: string;
  tokenSet: boolean;
}

export interface RunSummary {
  id: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  event: string;
  branch: string;
  headSha: string;
  actor: string;
  actorAvatar: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string;
  durationMs: number | null;
}

export interface WorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
  badgeUrl?: string;
  htmlUrl?: string;
}

export const fetchCicdConfig = async (): Promise<CICDConfigView> => {
  const r = await axios.get(`${backendUrl()}/api/cicd/config`, { timeout: 10000 });
  return r.data;
};

export const saveCicdConfig = async (config: { owner: string; repo: string; token?: string; workflowFile: string; defaultBranch: string }): Promise<CICDConfigView> => {
  const r = await axios.post(`${backendUrl()}/api/cicd/config`, config, { timeout: 15000 });
  return r.data;
};

export const testCicdConnection = async (): Promise<{ ok: boolean; login?: string; error?: string }> => {
  const r = await axios.post(`${backendUrl()}/api/cicd/test`, {}, { timeout: 15000 });
  return r.data;
};

export const fetchCicdWorkflow = async (): Promise<WorkflowInfo> => {
  const r = await axios.get(`${backendUrl()}/api/cicd/workflow`, { timeout: 15000 });
  return r.data;
};

export const listCicdWorkflows = async (): Promise<{ name: string; path: string; state: string }[]> => {
  const r = await axios.get(`${backendUrl()}/api/cicd/workflows`, { timeout: 15000 });
  return r.data.workflows || [];
};

export const fetchRecentRuns = async (limit = 20): Promise<RunSummary[]> => {
  const r = await axios.get(`${backendUrl()}/api/cicd/runs?limit=${limit}`, { timeout: 20000 });
  return r.data.runs || [];
};

export const triggerWorkflow = async (ref?: string, reason?: string): Promise<{ triggeredAt: string; branch: string }> => {
  const r = await axios.post(`${backendUrl()}/api/cicd/trigger`, { ref, reason }, { timeout: 15000 });
  return r.data;
};
