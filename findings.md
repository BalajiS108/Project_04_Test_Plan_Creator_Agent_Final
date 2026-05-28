# 🔍 Findings & Research

## Discoveries
- **UI Flow**: 4-step wizard (Setup -> Fetch Issues -> Review -> Test Plan).
- **Setup**: Requires Jira/ADO connection configuration.
- **Fetch**: Inputs for Project Key, Product Name, Sprint Version, and Additional Context.
- **Review**: Displays a list of fetched issues for final selection/notes before generation.
- **Template Structure**: Detailed 12-section document including Objective, Scope (Functional, Data, Error, Perf, Security, etc.), Inclusions (CRUD, Boundary, Concurrency), Environments, Strategy, Schedule, and Deliverables.
- **LLM Support**: Must support Ollama, GROQ, and Grok with a "Test Connection" feature.

## Constraints
- Must handle multiple platforms (Jira, ADO, X-Ray).
- Must generate plans based on a fixed PDF/DOCX template structure.
- Local-first execution required.
- Standardized section mapping from Jira Story fields (Summary, Description, Acceptance Criteria) to Test Plan sections.
