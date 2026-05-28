import { ALMProvider, LLMProvider } from '../types';

export const ALM_PROVIDERS: { id: ALMProvider; name: string }[] = [
  { id: 'Jira', name: 'Jira Cloud' },
  { id: 'ADO', name: 'Azure DevOps (ADO)' },
  { id: 'X-Ray', name: 'X-Ray' }
];

export const LLM_PROVIDERS: { id: LLMProvider; name: string }[] = [
  { id: 'Ollama', name: 'Ollama (Local)' },
  { id: 'Groq', name: 'Groq Cloud' },
  { id: 'OpenAI', name: 'OpenAI' }
];

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
