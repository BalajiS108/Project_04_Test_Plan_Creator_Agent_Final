import axios from 'axios';
import { Connection, JiraIssue } from '../types';
import { backendUrl } from './backendUrl';

export const fetchJiraIssues = async (connection: Connection, projectKey: string, sprintVersion?: string): Promise<JiraIssue[]> => {
  try {
    const response = await axios.post(`${backendUrl()}/api/jira/search`, {
      connection,
      projectKey,
      sprintVersion
    }, { timeout: 30000 });
    return response.data.issues || [];
  } catch (error: any) {
    if (error.code === 'ECONNABORTED') throw new Error('Jira search timed out. The query might be too complex or the network is slow.');
    if (!error.response) throw new Error(`Cannot reach backend at ${backendUrl()}. Ensure the server is running.`);
    throw new Error(error.response?.data?.error || error.message);
  }
};
