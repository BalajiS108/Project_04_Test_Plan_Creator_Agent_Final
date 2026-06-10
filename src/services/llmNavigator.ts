import axios from 'axios';
import { LLMConfig, JiraIssue } from '../types';
import { TEST_PLAN_GENERATOR_PROMPT, TEST_CASE_GENERATOR_PROMPT } from '../constants/prompts';

export const generateTestPlanResult = async (
  config: LLMConfig,
  productName: string,
  jiraIssues: JiraIssue[],
  additionalContext: string,
  outputType: 'plan' | 'cases' = 'plan',
  sourceUrl: string = ''
): Promise<string> => {
  const { provider, apiKey, baseUrl, model } = config;

  // Prepare Jira context
  const jiraContext = jiraIssues.map(issue =>
    `Issue: ${issue.key}\nSummary: ${issue.summary}\nDescription: ${issue.description}\nStatus: ${issue.status}`
  ).join('\n---\n');

  const basePrompt = outputType === 'cases' ? TEST_CASE_GENERATOR_PROMPT : TEST_PLAN_GENERATOR_PROMPT;

  // Source URL priority: explicit Application URL (Step 3) wins; otherwise try
  // to detect one from the story text itself. Jira authors usually paste the
  // app-under-test URL into the description — once jiraDescriptionToText surfaces
  // it (incl. hyperlink/smart-link hrefs), this picks it up so test cases get a
  // real target instead of "[URL not provided]" (which made execution navigate
  // nowhere and every case fail).
  const detectUrl = (text: string): string => {
    const m = text.match(/https?:\/\/[^\s)"'<>\]]+/);
    return m ? m[0].replace(/[.,;:]+$/, '') : '';
  };
  const resolvedSourceUrl = sourceUrl.trim() || detectUrl(jiraContext) || '[URL not provided]';

  const fullPrompt = basePrompt
    .replaceAll('{productName}', productName)
    .replaceAll('{jiraContext}', jiraContext)
    .replaceAll('{additionalContext}', additionalContext)
    .replaceAll('{sourceUrl}', resolvedSourceUrl);

  console.log(`🤖 Generating ${outputType} using ${provider} (${model || 'default'})`);
  console.log(`🔗 Endpoint Base: ${baseUrl || 'default'}`);
  console.log(`🔑 API Key detected: ${apiKey ? 'Yes' : 'No'}`);


  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let result: string | undefined;
    if (provider === 'Ollama') {
      const base = baseUrl.replace(/\/$/, '');
      const endpoint = base.includes('/api') || base.includes('/v1') 
        ? `${base}/generate` 
        : `${base}/api/generate`;
      const response = await axios.post(endpoint, {
        model,
        prompt: fullPrompt,
        stream: false
      }, { headers, timeout: 60000 });
      result = response.data.response;
    } else if (provider === 'Groq') {
      const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
      const groqModel = model === 'llama3' || model === '' ? 'llama3-70b-8192' : model;

      const response = await axios.post(endpoint, {
        model: groqModel,
        messages: [{ role: 'user', content: fullPrompt }],
        max_tokens: 3000,
        temperature: 0.2
      }, {
        headers,
        timeout: 60000
      });
      result = response.data?.choices?.[0]?.message?.content;

    } else if (provider === 'OpenAI') {
      const endpoint = 'https://api.openai.com/v1/chat/completions';
      const openaiModel = model === '' ? 'gpt-4o' : model;

      const response = await axios.post(endpoint, {
        model: openaiModel,
        messages: [{ role: 'user', content: fullPrompt }],
        max_tokens: 4096,
        temperature: 0.2
      }, {
        headers,
        timeout: 60000
      });
      result = response.data?.choices?.[0]?.message?.content;

    } else if (provider === 'Gemini') {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;
      const geminiModel = model === '' ? 'gemini-1.5-pro' : model;

      const response = await axios.post(endpoint, {
        model: geminiModel,
        messages: [{ role: 'user', content: fullPrompt }],
        max_tokens: 4096,
        temperature: 0.2
      }, {
        headers,
        timeout: 60000
      });
      result = response.data?.choices?.[0]?.message?.content;

    } else {
      throw new Error(`Provider ${provider} not supported for generation yet.`);
    }

    // Guard against a silent empty completion. Without this the caller sets an
    // empty plan and the UI spins on "Generating Plan…" forever. Surfacing a
    // clear error instead sends the user back to the previous step with a reason.
    if (typeof result !== 'string' || !result.trim()) {
      throw new Error(`The ${provider} model returned an empty response. Likely an invalid/expired API key, an unknown model name ("${model || 'default'}"), or a quota/safety block. Check Settings → LLM and try again.`);
    }
    return result;
  } catch (error: any) {
    const errorDetails = error.response?.data?.error?.message || error.response?.data?.error || error.response?.data || error.message;
    throw new Error(`LLM Error: ${typeof errorDetails === 'object' ? JSON.stringify(errorDetails) : errorDetails}`);
  }
};
