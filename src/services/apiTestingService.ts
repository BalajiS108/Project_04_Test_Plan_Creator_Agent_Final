import axios from 'axios';

const backendUrl = () => {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
};

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type AssertionType =
  | 'status'
  | 'statusRange'
  | 'header'
  | 'jsonPath'
  | 'jsonPathExists'
  | 'bodyContains'
  | 'responseTimeBelow';

export interface ApiAssertion {
  type: AssertionType;
  name?: string;
  expected?: any;
  path?: string;
  range?: '2xx' | '3xx' | '4xx' | '5xx';
  expectedMs?: number;
}

export interface ApiExtraction {
  name: string;
  source: 'jsonPath' | 'header' | 'status';
  path?: string;
  headerName?: string;
}

export interface ApiDatasetRow {
  [key: string]: string | number | boolean;
}

export interface ApiTest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: any;
  assertions: ApiAssertion[];
  extractions?: ApiExtraction[];
  dataset?: ApiDatasetRow[];
  timeoutMs?: number;
}

export interface ApiTestStep {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ApiTestResult {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  httpStatus?: number;
  durationMs: number;
  requestPreview: { method: string; url: string; headers?: Record<string, string>; body?: any };
  responsePreview?: { status?: number; headers?: Record<string, string>; bodyExcerpt?: string };
  steps: ApiTestStep[];
  extracted?: Record<string, string>;
  error?: string;
}

export interface ApiSuite {
  name: string;
  description?: string;
  tests: ApiTest[];
  environments: Record<string, Record<string, string>>;
  activeEnvironment?: string;
  updatedAt: string;
}

export interface SuiteListEntry {
  name: string;
  description?: string;
  testCount: number;
  updatedAt: string;
}

export interface ParseResult {
  success: boolean;
  detectedBaseUrl?: string;
  info?: { title?: string; version?: string };
  tests: ApiTest[];
  error?: string;
}

export const parseOpenApi = async (spec: string, baseUrl?: string, maxTests = 100): Promise<ParseResult> => {
  const res = await axios.post(`${backendUrl()}/api/apitest/parse-spec`, { spec, baseUrl, maxTests }, { timeout: 30000 });
  return res.data;
};

export const runApiTests = async (
  tests: ApiTest[],
  envVars?: Record<string, string>
): Promise<{ success: boolean; results: ApiTestResult[]; summary: { total: number; passed: number; failed: number; errors: number; totalDurationMs: number }; finalVars?: Record<string, string> }> => {
  const res = await axios.post(`${backendUrl()}/api/apitest/run`, { tests, envVars }, { timeout: 120000 });
  return res.data;
};

/* ─── Suite persistence ─────────────────────────────────────────────── */

export const listSuites = async (): Promise<SuiteListEntry[]> => {
  const res = await axios.get(`${backendUrl()}/api/apitest/suites`, { timeout: 10000 });
  return res.data.suites || [];
};

export const getSuite = async (name: string): Promise<ApiSuite> => {
  const res = await axios.get(`${backendUrl()}/api/apitest/suites/${encodeURIComponent(name)}`, { timeout: 10000 });
  return res.data;
};

export const saveSuite = async (suite: ApiSuite): Promise<ApiSuite> => {
  const res = await axios.post(`${backendUrl()}/api/apitest/suites`, suite, { timeout: 15000 });
  return res.data.suite;
};

export const deleteSuite = async (name: string): Promise<void> => {
  await axios.delete(`${backendUrl()}/api/apitest/suites/${encodeURIComponent(name)}`, { timeout: 10000 });
};
