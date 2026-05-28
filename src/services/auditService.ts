import axios from 'axios';

const backendUrl = () => {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
};

export interface VisualAuditResult {
  success: boolean;
  name: string;
  url: string;
  baselineExisted: boolean;
  captured: boolean;
  diffPixels?: number;
  totalPixels?: number;
  diffPercent?: number;
  baselineUrl?: string;
  currentUrl?: string;
  diffUrl?: string;
  error?: string;
}

export interface A11yViolation {
  id: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodeCount: number;
  sampleSelectors: string[];
}

export interface A11yAuditResult {
  success: boolean;
  url: string;
  violationCount: number;
  counts: { critical: number; serious: number; moderate: number; minor: number };
  violations: A11yViolation[];
  passes: number;
  inapplicable: number;
  error?: string;
}

export const runVisualAudit = async (
  url: string,
  opts: { name?: string; fullPage?: boolean; setBaseline?: boolean } = {}
): Promise<VisualAuditResult> => {
  const res = await axios.post(`${backendUrl()}/api/audit/visual`, { url, ...opts }, { timeout: 90000 });
  return res.data;
};

export const runA11yAudit = async (
  url: string,
  opts: { standards?: string[] } = {}
): Promise<A11yAuditResult> => {
  const res = await axios.post(`${backendUrl()}/api/audit/a11y`, { url, ...opts }, { timeout: 90000 });
  return res.data;
};
