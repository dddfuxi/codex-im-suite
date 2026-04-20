# Architecture Maintenance Checklist

Use this checklist before finishing any task in a project that uses architecture documentation.

## Inspect Existing Docs

- Look for `docs/PROJECT-ARCHITECTURE.md`, `docs/architecture.md`, `README.md`, ADR files, design docs, or project-specific documentation paths.
- If a doc already describes architecture, update it instead of creating a parallel document.
- Preserve the project's language, heading style, and diagram conventions unless they are unclear.

## Update Required

Update architecture docs when the change affects any of these:

- Project entry points, command handlers, background workers, daemon startup, panel startup, or Unity scene routing.
- Module boundaries, major dependencies, public interfaces, package layout, ownership, or responsibilities.
- Request flow, event flow, provider routing, MCP routing, permission flow, state flow, or data transformation.
- Storage location, cache strategy, file formats, memory index, Feishu history index, or persistence lifecycle.
- External APIs, SDKs, auth, messaging, model inference, local LLM, Codex, MCP servers, or Unity/Blender integration.
- Build, packaging, installer, release, live-skill sync, or runtime environment.

## Usually No Update Needed

Usually do not update architecture docs for:

- Pure UI spacing or styling tweaks.
- Copy-only changes.
- Small bug fixes that do not change data flow or module boundaries.
- Test-only changes that do not document new behavior.
- Internal refactors that preserve public boundaries and runtime flow.

## Existing Project Procedure

1. Read `AGENTS.md`.
2. Read `docs/PROJECT-ARCHITECTURE.md`.
3. Compare the doc against the actual code paths touched by the task.
4. Remove stale nodes and explanations.
5. Add only architecture-relevant new nodes.
6. Keep Mermaid diagrams small enough to read in Markdown preview.
7. In the final response, state whether architecture docs were updated or not.

## Chinese Encoding

For Chinese Markdown or source files:

- Read with UTF-8 explicitly in PowerShell:
  `Get-Content -Raw -Encoding UTF8 <path>`
- After modifying Chinese files, run a mojibake scan.
- If suspected mojibake appears, stop and recover from original files, Git history, or user context before continuing.
