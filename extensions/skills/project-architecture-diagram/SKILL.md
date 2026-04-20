---
name: project-architecture-diagram
description: Generate, update, and maintain clear project architecture documentation with Mermaid diagrams. Use when creating a new project, analyzing an existing codebase, adding architecture docs, updating architecture after refactors or feature changes, documenting module boundaries, explaining data flow, or helping AI understand and maintain a project's structure across frontend, backend, database, Unity, game, tool, or service projects.
---

# Project Architecture Diagram

## Core Workflow

Use this skill to create or maintain architecture documentation for a project.

1. Inspect the project before writing:
   - Read entry points, package or build config, route or scene setup, dependency manifests, major modules, storage code, API boundaries, and existing docs.
   - Prefer `rg --files`, targeted `rg`, and config manifests over broad manual browsing.
   - If architecture docs already exist, maintain the existing location and style unless it is clearly broken or incomplete.

2. Decide the architecture doc target:
   - For this suite, use `docs/PROJECT-ARCHITECTURE.md`.
   - Do not create parallel architecture docs unless the user explicitly asks for a focused design note.
   - If another project has a clear docs convention, follow that convention.

3. Generate or update the document:
   - Include project goal, system context, module relationships, core data flow, key runtime flow, directory structure, external dependencies, and maintenance rules.
   - Use Mermaid diagrams by default.
   - Keep explanations concise and tied to actual code evidence.
   - Use business-semantic node names instead of generic labels like `Manager`, `Service`, or `Controller`.

4. Maintain diagrams during code work:
   - If a change affects module boundaries, public APIs, data flow, persistence, external services, runtime flow, deployment, or project structure, update the architecture doc.
   - If the change does not affect architecture, mention that no architecture update was needed in the final response.

## Suite-Specific Rules

- `docs/PROJECT-ARCHITECTURE.md` is the single architecture source of truth.
- `docs/DEVELOPMENT-LOG.md` records dated changes and risks; do not duplicate architecture explanations there.
- `AGENTS.md` records maintenance rules for future agents.
- Mermaid diagrams should stay small and split by concern: suite context, Feishu flow, provider routing, MCP discovery, packaging.
- Architecture updates must not include secrets, raw chat logs, tool traces, or local token values.

## References

Load only the reference needed for the current task:

- `references/architecture-template.md`: Use when creating or substantially rewriting architecture docs.
- `references/mermaid-patterns.md`: Use when choosing Mermaid diagram types or writing diagram syntax.
- `references/maintenance-checklist.md`: Use when updating an existing project or deciding whether a code change requires architecture doc updates.

## Output Rules

- Default to Markdown plus Mermaid, not image files, PlantUML, or Figma.
- Keep diagrams readable: split large graphs into smaller diagrams instead of making one dense graph.
- Label edges with verbs or data names when that makes the flow clearer.
- Do not invent services, databases, queues, or deployment layers that are not supported by the code or user request.
- For Chinese architecture docs, read and write UTF-8 explicitly and run a mojibake scan before the final response.
