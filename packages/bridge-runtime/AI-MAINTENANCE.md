# claude-to-im Runtime Maintenance Notes

This is the live Feishu bridge runtime. Prefer these paths over the source copies under `C:\Users\admin\Documents\New project`:

- Skill/runtime wrapper: `C:\Users\admin\.codex\skills\claude-to-im`
- Core bridge package: `C:\Users\admin\.codex\skills\claude-to-im-core`

## Unity MCP Startup Contract

Unity MCP tasks must not stop after a failed endpoint probe. The bridge precheck should:

1. Probe `http://127.0.0.1:8081/mcp`, then `http://127.0.0.1:8080/mcp`, then `http://127.0.0.1:8080`.
2. If the target Unity project is already open, do not launch a second Unity instance.
3. Write `Library\MCPForUnity\http-autostart.request` in the Unity project and touch the MCPForUnity autostart script so Unity can consume the request on reload.
4. If Unity does not consume the request quickly, directly start the external HTTP server with:

```powershell
uvx --from mcpforunityserver==<MCPForUnity package.json version> mcp-for-unity --transport http --http-url http://127.0.0.1:8081 --project-scoped-tools
```

5. Treat HTTP 406/404/405 from `/mcp` as a reachable MCP HTTP service. The endpoint exists even if a plain browser GET is not a valid MCP request.
6. Continue the Codex turn even if the precheck is not fully healthy. Inject the diagnostics into the prompt and make one more concrete repair/diagnostic attempt before reporting failure.
7. If MCP cannot perform the requested Unity operation, use Codex CLI or local desktop automation to simulate the existing Unity UI click/keyboard path when safe and unambiguous. Do not refuse until this fallback has been considered or attempted.
8. For screenshot tasks, the requested source is binding. If the user asks for `PreviewCamera`, Game view, or a specific camera, do not substitute a Scene View crop as success. Keep repairing the exact capture path or report the exact blocker.
9. After screenshot capture, verify the image content. Blank/black/transparent/mostly one-color captures, wrong viewport captures, or Scene View crops for a named camera are failures, not deliverables.

The previous working behavior left this status file:

```text
C:\unity\ST3\Game\Library\CodexUnityMcpBootstrap.status.txt
```

It showed `server_started=True`, `bridge_started=True`, and a verified websocket connection to `ws://127.0.0.1:8081/hub/plugin`. If this regresses, check whether `Assets\Editor\CodexUnityMcpBootstrap.cs` still exists in the Unity project and whether `mcp-for-unity` processes are running.

## User-Facing Behavior

- Default bridge work must stay in `C:\unity\ST3`; the Unity project path is `C:\unity\ST3\Game`. Other workspaces are only valid when the configured Feishu owner explicitly requests a path in the current message.
- For ST3 screenshots, ordinary screenshot requests should prefer portrait Game view or the requested camera. Only explicit overview/landscape requests should produce a 16:9 landscape overview with an adjusted view.
- Feishu owner-only operations include deleting documents, clearing conversations or memory, changing code, git write operations, writing outside ST3, and approving tool permissions. Use `/whoami` to diagnose the sender ID and configure `CTI_FEISHU_OWNER_USERS`.
- After a bot-created Feishu document succeeds, write a compact memory/index entry under `E:\cli-md\data\documents\index.json` and regenerate `E:\cli-md\data\documents\DOCUMENT_GUIDE.md`. Document list queries should read this index, not full chat history.

- Send short progress updates during long operations.
- Progress updates must contain completed checkpoints. Do not send repeated empty "still working" heartbeat messages.
- Append the configured reply end marker to final bridge replies so the user can tell the turn has ended.
- Avoid conservative "I cannot" replies when a safe local repair path exists.
- Feishu document creation should write a polished document body, not a raw chat transcript. Direct Feishu-doc requests must first rewrite the source into title, summary, facts, execution result, risks, and follow-up tasks.
- Feishu document writes must preserve UTF-8. Do not pass Chinese JSON or Markdown through PowerShell command strings, PowerShell stdin pipes, or console-codepage dependent paths. Use a UTF-8 file, Node Buffer/string loaded from disk, or direct in-process API calls. If generated text contains long `????` runs or mojibake such as `鈥`, `涓`, `鎬`, fail fast and regenerate from the original UTF-8 source before writing to Feishu.
- Feishu document generation rules now live in `C:\Users\admin\.codex\skills\feishu-document-generation\SKILL.md`. Any bridge feature that creates or rewrites Feishu Docx content should follow that skill: content-derived title, structured sections, no raw chat transcript, no generic timestamp title, no screenshot-path appendix unless explicitly requested, and scene-location appendix for Unity scene documents.
- Timeline scene screenshots require a stricter capture path: load the target scene, activate the intended Timeline object, set the PlayableDirector to the requested frame (usually `time=0` for first frame), call `Evaluate()`, then render from the bound camera at the requested aspect ratio. A blank Timeline camera frame is a failed capture, not a deliverable.
