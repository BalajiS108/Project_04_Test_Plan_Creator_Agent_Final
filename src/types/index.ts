export type ALMProvider = 'Jira' | 'ADO' | 'X-Ray';
export type LLMProvider = 'Ollama' | 'Groq' | 'OpenAI' | 'Gemini';

/**
 * Where the requirements come from. The pipeline downstream of fetching
 * is source-agnostic — every adapter must return a list of JiraIssue-shaped
 * items so existing LLM prompts and the review UI continue to work.
 */
export type InputSourceType = 'jira' | 'brd' | 'html' | 'figma';

export interface InputSourceMeta {
  source: InputSourceType;
  label: string;          // Display name of the document/URL/figma file
  retrievedAt: string;    // ISO timestamp
}

export interface Connection {
  id: string;
  type: ALMProvider;
  name: string;
  url: string;
  email?: string;
  apiToken: string;
}

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string;
  status: string;
}

export interface TestPlan {
  meta: {
    productName: string;
    projectKey: string;
    version: string;
    date: string;
  };
  sections: {
    objective: string;
    scope: string[];
    inclusions: {
      create: string;
      read: string;
      update: string;
      delete: string;
      boundary: string;
      concurrency: string;
    };
    environments: { name: string; url: string }[];
    strategy: string[];
    deliverables: string[];
    risks: { risk: string; mitigation: string }[];
  };
}
