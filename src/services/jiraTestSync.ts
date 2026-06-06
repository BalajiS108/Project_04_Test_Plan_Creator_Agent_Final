import axios from 'axios';
import { Connection } from '../types';
import { ParsedTestCase } from '../utils/testPlanParser';
import { backendUrl } from './backendUrl';

export type TestManagementProvider = 'jira-native' | 'xray';

export interface PushResult {
  success: boolean;
  mapping: Record<string, string>;       // tcId -> jiraKey
  errors: { tcId: string; error: string }[];
  baseUrl: string;
  count: number;
  total: number;
}

export const pushTestCases = async (
  connection: Connection,
  projectKey: string,
  parentIssueKey: string | undefined,
  testCases: ParsedTestCase[],
  provider: TestManagementProvider = 'jira-native'
): Promise<PushResult> => {
  const res = await axios.post(`${backendUrl()}/api/jira/push-test-cases`, {
    connection,
    projectKey,
    parentIssueKey,
    testCases,
    provider,
  }, { timeout: 120000 });
  return res.data;
};

export interface SyncResultPayload {
  tcId: string;
  jiraKey: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR';
  duration?: number;
  actualResult?: string;
  error?: string;
}

export interface SyncResult {
  success: boolean;
  updated: { jiraKey: string; status: string }[];
  errors: { jiraKey: string; error: string }[];
  baseUrl: string;
  count: number;
  total: number;
  testExecutionKey?: string;
  testExecutionUrl?: string;
}

export const syncExecutionResults = async (
  connection: Connection,
  results: SyncResultPayload[],
  provider: TestManagementProvider = 'jira-native',
  projectKey?: string,
  transitionOnSuccess: boolean = false,
): Promise<SyncResult> => {
  const res = await axios.post(`${backendUrl()}/api/jira/update-execution-status`, {
    connection,
    results,
    provider,
    projectKey,
    transitionOnSuccess,
  }, { timeout: 120000 });
  return res.data;
};
