# 📜 Project Constitution: Smart Test Plan Creator

## 🎯 North Star
Create an intelligent agent that fetches user stories from Jira/ADO and transforms them into comprehensive Test Plans using a standardized template.

## 🏛️ Architectural Invariants
- **Local-First**: Sensitive API keys and logic reside locally.
- **Deterministic Logic**: LLMs are used for content generation, but the "Skeleton" and "Integrations" follow strict SOPs.
- **Modular Connections**: Support multiple input sources (Jira, ADO, X-Ray) and multiple LLM providers (Ollama, Groq, Grok).

## 🛠️ Data Schemas

### Connection Schema
```json
{
  "id": "uuid",
  "type": "Jira | ADO | X-Ray",
  "name": "Connection Label",
  "url": "https://...",
  "apiKey": "encrypted_string",
  "username": "string"
}
```

### LLM Config Schema
```json
{
  "provider": "Ollama | GROQ | Grok",
  "apiKey": "string",
  "baseUrl": "string",
  "model": "string"
}
```

### Test Plan Schema (Output)
```json
{
  "meta": {
    "productName": "string",
    "projectKey": "string",
    "version": "string",
    "date": "iso_string"
  },
  "sections": {
    "objective": "string",
    "scope": ["Functional", "Data Validation", "Error Handling", "Performance", "Security", "Integration", "Compatibility"],
    "inclusions": {
      "create": "string",
      "read": "string",
      "update": "string",
      "delete": "string",
      "boundary": "string",
      "concurrency": "string"
    },
    "environments": [{ "name": "string", "url": "string" }],
    "strategy": ["string"],
    "deliverables": ["string"],
    "risks": [{ "risk": "string", "mitigation": "string" }]
  }
}
```

## ⚖️ Behavioral Rules
- Always test connections (LLM/Jira) before attempting data fetch.
- Never store API keys in plaintext (use `.env`).
- Follow the B.L.A.S.T. protocol for all tool development.
