import axios from 'axios';
import { backendUrl } from './backendUrl';

export interface JiraConfig {
  url: string;
  email: string;
  apiToken: string;
}

export const verifyJiraConnection = async (config: JiraConfig) => {
  // 1. Pre-flight: check if backend is reachable first
  try {
    await axios.get(`${backendUrl()}/api/health`, { timeout: 3000 });
  } catch (e) {
    console.error('Backend health check failed.', e);
    return {
      status: 'error',
      message: `❌ Cannot reach backend server at ${backendUrl()}. If running locally, ensure the backend is running ("npm run dev" in the /backend folder). If deployed, check that VITE_BACKEND_URL is correctly set at build time.`,
    };
  }

  // 2. Now try the actual Jira verify
  try {
    console.log(`🔗 Attempting Jira verification via ${backendUrl()}...`);
    const response = await axios.post(`${backendUrl()}/api/jira/verify`, config, { timeout: 12000 });
    const displayName = response.data?.data?.displayName || response.data?.data?.emailAddress || '';
    return {
      status: 'success',
      message: `✅ Connected successfully${displayName ? ` as ${displayName}` : ''}!`,
      data: response.data.data,
    };
  } catch (error: any) {
    const serverMsg = error.response?.data?.error;
    if (error.response?.status === 401 || error.response?.status === 403) {
      return { status: 'error', message: '🔐 Authentication failed. Check your email and API token.' };
    }
    if (error.response?.status === 404) {
      return { status: 'error', message: '🌐 Jira URL not found. Verify the instance URL (e.g. https://your-domain.atlassian.net).' };
    }
    return {
      status: 'error',
      message: serverMsg || `Connection failed: ${error.message}`,
    };
  }
};
