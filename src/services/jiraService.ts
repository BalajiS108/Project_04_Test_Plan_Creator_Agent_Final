import axios from 'axios';

export interface JiraConfig {
  url: string;
  email: string;
  apiToken: string;
}

export const verifyJiraConnection = async (config: JiraConfig) => {
  // 1. Pre-flight: check if backend is reachable first
  try {
    // Try both localhost and the current host if it's different
    const host = window.location.hostname || 'localhost';
    await axios.get(`http://${host}:3001/api/health`, { timeout: 3000 });
  } catch (e) {
    console.warn('Backend health check failed on primary host, trying localhost...', e);
    try {
      await axios.get(`http://localhost:3001/api/health`, { timeout: 3000 });
    } catch (e2) {
      console.error('All backend health checks failed.', e2);
      return {
        status: 'error',
        message: '❌ Cannot reach backend server on port 3001. Please ensure the backend is running: open a terminal in the /backend folder and run "npm start".',
      };
    }
  }

  const host = window.location.hostname || 'localhost';
  const backendUrl = `http://${host}:3001`;

  // 2. Now try the actual Jira verify
  try {
    console.log(`🔗 Attempting Jira verification via ${backendUrl}...`);
    const response = await axios.post(`${backendUrl}/api/jira/verify`, config, { timeout: 12000 });
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
