# Publish Summary

- Time: 2026-04-25 18:28:09
- Subject: ship workflow executor platform and panel recovery
- Summary source: manual

## Preview

- Added the first workflow / executor platform layer with run status, executor registry, session defaults, and panel visibility.
- Upgraded the control panel for executor management, workflow history, session detail media preview, extension import/install, MCP status, and Codex CLI update.
- Hardened fast-path routing so Unity/Blender/MCP work requires real tool execution instead of tutorial-style fallback replies.
- Published refreshed portable, installer, live skill, and control panel artifacts from the suite workspace.

## Commit Body

Workflow and executor:
- Add executor manifests, routing status files, workflow run history, and tests for registry/status behavior.
- Keep Codex as the default brain while allowing explicit @codex / @claude / @local and panel session defaults.

Control panel:
- Add executor and workflow views, session detail media previews, workflow timelines, extension import/install actions, MCP status fixes, and Codex CLI update.
- Fix executor page layout so recent workflow history scrolls without covering the underlying UI.

Runtime safety:
- Tighten local assistant and MCP fast-path preflight.
- Block tutorial-style fallback for Unity/Blender/MCP tasks that require real tool output.
- Isolate Codex model config and document the current Codex CLI update path.

Release:
- Build packages, WebView panel, portable zip, installer payload, and live skill from the suite workspace.
