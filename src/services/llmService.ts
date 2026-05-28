import axios from 'axios';

export const verifyOllama = async (baseUrl: string, model: string, apiKey?: string) => {
  try {
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Try /api/tags first (Ollama native)
    const tagsEndpoint = `${cleanBaseUrl}/api/tags`;
    try {
      const response = await axios.get(tagsEndpoint, { headers, timeout: 5000 });
      const models = response.data.models || [];
      const exists = models.some((m: any) => m.name.includes(model) || model.includes(m.name));
      
      if (exists) {
        return { status: 'success', message: `Ollama connected. Model '${model}' found.` };
      } else if (apiKey) {
        // If we have an API key, the tags might be limited. Return success if we at least reached the server.
        return { status: 'success', message: `Ollama connected via API Key. Model '${model}' availability assumed via provider.` };
      } else {
        return { status: 'warning', message: `Ollama connected, but model '${model}' was not found in local library. Please run 'ollama pull ${model}'.` };
      }
    } catch (tagError) {
      // If /api/tags fails, try /v1/models (OpenAI compatibility)
      const modelsEndpoint = `${cleanBaseUrl}/v1/models`;
      const response = await axios.get(modelsEndpoint, { headers, timeout: 5000 });
      if (response.status === 200) {
        return { status: 'success', message: `Ollama connected (v1 API). Handshake successful.` };
      }
      throw tagError; // Re-throw if v1 also fails
    }
  } catch (error: any) {
    throw new Error(`Ollama connection failed: ${error.message}. Check URL and API Key.`);
  }
};

export const verifyGroq = async (apiKey: string) => {
  if (!apiKey) throw new Error("Groq API Key is required.");
  try {
    const response = await axios.get('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (response.status === 200) {
      return { status: 'success', message: 'Groq API Handshake successful.' };
    }
  } catch (error: any) {
    throw new Error(`Groq connection failed: ${error.response?.data?.error?.message || error.message}`);
  }
};

export const verifyOpenAI = async (apiKey: string) => {
  if (!apiKey) throw new Error("OpenAI API Key is required.");
  try {
    const response = await axios.get('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (response.status === 200) {
      return { status: 'success', message: 'OpenAI API Handshake successful.' };
    }
  } catch (error: any) {
    throw new Error(`OpenAI connection failed: ${error.response?.data?.error?.message || error.message}`);
  }
};

export const verifyGemini = async (apiKey: string) => {
  if (!apiKey) throw new Error("Gemini API Key is required.");
  try {
    const response = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
      params: { key: apiKey }
    });
    if (response.status === 200) {
      return { status: 'success', message: 'Google Gemini API connected successfully.' };
    }
  } catch (error: any) {
    throw new Error(`Gemini connection failed: ${error.response?.data?.error?.message || error.message}`);
  }
};
