import axios from 'axios';
import { JiraIssue } from '../types';

/**
 * Unified input source service.
 *
 * All adapters return `JiraIssue[]` so the rest of the pipeline (Review,
 * llmNavigator prompts, TestPlanView) stays source-agnostic.
 *
 * For non-Jira sources we synthesize JiraIssue-shaped records:
 *  - `key` like "REQ-1", "FIG-3"
 *  - `status` like "Requirement" or "Design"
 *  - `description` carries the chunked content the LLM should reason over
 */

const backendUrl = () => {
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3001`;
};

const unwrapError = (e: any, source: string): never => {
  if (e.code === 'ECONNABORTED') throw new Error(`${source} request timed out.`);
  if (!e.response) throw new Error(`Cannot reach backend at ${backendUrl()}. Ensure the server is running.`);
  throw new Error(e.response?.data?.error || e.message);
};

export interface BrdResult {
  source: 'brd';
  label: string;
  items: JiraIssue[];
}

export const fetchFromBrd = async (file: File): Promise<BrdResult> => {
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await axios.post(`${backendUrl()}/api/input/brd`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    });
    return { source: 'brd', label: res.data.label, items: res.data.items || [] };
  } catch (e: any) {
    unwrapError(e, 'BRD');
    throw e;
  }
};

export interface HtmlResult {
  source: 'html';
  label: string;
  items: JiraIssue[];
  warnings?: string[];
}

export interface HtmlPageInput {
  url?: string;
  html?: string;
}

// Accepts either a single { url?, html? } (legacy) or { pages: [...] } (multi-page).
export const fetchFromHtml = async (
  input: HtmlPageInput | { pages: HtmlPageInput[] }
): Promise<HtmlResult> => {
  try {
    const res = await axios.post(`${backendUrl()}/api/input/html`, input, { timeout: 60000 });
    return {
      source: 'html',
      label: res.data.label,
      items: res.data.items || [],
      warnings: res.data.warnings,
    };
  } catch (e: any) {
    unwrapError(e, 'HTML');
    throw e;
  }
};

export interface FigmaResult {
  source: 'figma';
  label: string;
  items: JiraIssue[];
}

export const fetchFromFigma = async (figmaUrl: string, accessToken: string): Promise<FigmaResult> => {
  try {
    const res = await axios.post(
      `${backendUrl()}/api/input/figma`,
      { figmaUrl, accessToken },
      { timeout: 30000 }
    );
    return { source: 'figma', label: res.data.label, items: res.data.items || [] };
  } catch (e: any) {
    unwrapError(e, 'Figma');
    throw e;
  }
};
