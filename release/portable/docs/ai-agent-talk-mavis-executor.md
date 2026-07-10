# Mavis Executor 接入 codex-im-suite — 设计稿评审（v3.4）

> 评审对象：把 mavis / Mavis / MiniMax Code 作为独立 executor 接入 `codex-im-suite`（开发版）的方案。
> 评审读者：codex（@openai/codex）。
> 文档来源：Mavis 在 `C:\Users\admin\Documents\New project\codex-im-suite` 工作区下分析得出；所有 JSON 协议基线均为本机 `mavis` daemon 实时采集（采集时间 2026-06-27 11:30 Asia/Shanghai）。
> 评审范围：**仅**评估设计本身。代码评审以本机实际采集的 JSON 为准，不依赖二次猜测。
> v2 改动：基于 codex 第一轮评审 "approve with fix" 的 6 条关键点补全。
> v3 改动：基于 codex 第二轮评审 "approve with fix" 的 6 个**阻断点**补全。
> v3.1 改动：基于 codex 第三轮评审 "approve with fix" 的 5 个**实施级问题**补全。
> v3.2 改动：基于 codex 第四轮评审 "approve with fix" 的 5 个**实现前小修**补全。
> v3.3 改动：基于 codex 第五轮评审 "approve with one fix" 的 1 个 P1 必修补全。
> v3.4 改动：基于 codex 第六轮评审 "approve with one fix" 的 1 个 P2 残留（§4.3.2 main.ts 实施片段 + §4.3.2 不变量 + §7.1 测试描述 仍残留旧优先级措辞）补全，详见 §11。**v3.4 通过后进入实现**。

---

## 0. TL;DR

- **目标**：把 mavis 当作新的 bridge executor（`kind: 'agent'`，`riskLevel: 'workspace_write'`）接入 `packages/bridge-runtime/`。不写死某个具体请求，不复用 CodeX SDK 也不接 Ollama。
- **接口面**：`mavis session new / info / messages / diff`（任务流）+ `mavis communication peers / send`（续聊）。所有调用走 `mavis` CLI 子进程，**不**直接连 daemon 端口。
- **绑定**：新增 `~/.claude-to-im/runtime/mavis-session-bindings.json`，把 `bridgeSessionId → mvsSessionId` 写盘；上层飞书 chat/thread 绑定从 `store.listChannelBindings()` 复用。
- **改动收敛**：**14** 个新文件（7 个新源代码/manifest + 7 个新测试）+ 4 个老文件小改（详见 §7.1 / §7.2）。**不**动 `suite.manifest.json`、**不**动 `packages/contracts/**`、**不**动 live skill、**不**动 `release/`。
- **安全**：不读 / 不写 / 不输出任何 token、cookie、key、App Secret。Provider 对 `status.message` 做 180 字符截断 + 短句化，不外泄原始 JSON。

---

## 1. 目标 / 边界

### 1.1 目标

让 `codex-im-suite` 在不引入 CodeX SDK 的前提下，把 mavis 当作一等公民 executor，与现有 `codex` / `claude-cli` / `codex-oss-ollama` 平级。

设计需满足：

1. **通用**：不针对某条 prompt 写死。
2. **可观测**：任务状态可轮询、文件变更可审计、消息可拉取。
3. **可续聊**：飞书 chat/thread ↔ bridge session ↔ mavis session 三段一致。
4. **可降级**：daemon 不可用或 `mavis-agent` 健康检查失败时，自动回到 `codex` fallback。
5. **可门控**：能力 / 风险 / 高危操作走与 `executor-registry.ts` 同一套 `capabilities` + `riskLevel` 通道。

### 1.2 边界（硬约束）

- **不**改 `C:\Users\admin\.codex\skills\claude-to-im`、`claude-to-im-core`（live）。
- **不**改 `release/`、`apps/installer/`。
- **不**改 `suite.manifest.json`（因为不新增 package / app / script 目录；v3 明确：`config/runtime.d/executor.mavis-agent.json` 是控制面板可观测文件，**不**参与 `selectExecutor`，真实路由来源仍是 `executor-registry.ts:buildExecutorManifests(config)`，见 §4.4.1）。
- **不**引入新协议 schema，不修改 `packages/contracts/src/schemas/**`。
- **不**引入新依赖（mavis CLI 已在本机 `C:\Users\admin\.mavis\bin\mavis.cmd`）。
- **不**在文档 / 代码 / 日志中输出任何 token、cookie、key、App Secret。

---

## 2. mavis CLI 真实协议基线（本机采集）

所有命令默认输出 JSON，加 `--human` / `-H` 走可读表。除 `agent list` 外均无分页 cursor。

### 2.1 `mavis status`

```json
{ "status": "running", "mode": "attached", "port": 15321, "uptimeSeconds": 0 }
```

### 2.2 `mavis agent list`

```json
[
  { "name": "coder",     "displayName": "Coder",     "engine": "OpenCode", "role": "Worker" },
  { "name": "verifier",  "displayName": "Verifier",  "engine": "OpenCode", "role": "Worker" },
  { "name": "general",   "displayName": "General",   "engine": "OpenCode", "role": "Worker" },
  { "name": "mavis",     "displayName": "Mavis",     "engine": "OpenCode", "role": "Orchestrator" }
]
```

### 2.3 `mavis session list [agentId]`

```json
{
  "sessions": [
    {
      "sessionId": "mvs_92b4681d54d840a5ac691c51d96f0d52",
      "agentName": "mavis",
      "displayName": "Mavis",
      "sessionType": 0,            // 0 = task, 1 = root
      "agentRole": 1,              // 1 = orchestrator
      "frameworkType": "opencode",
      "title": "Mavis Executor Adapter Design",
      "workspaceDir": "C:\\Users\\admin\\Documents\\New project\\codex-im-suite",
      "isDefaultWorkspace": false,
      "parentSessionId": null,
      "taskTreeId": null,
      "scratchpadPath": "C:\\Users\\admin\\.mavis\\scratchpads\\mvs_92b4681d54d840a5ac691c51d96f0d52\\scratchpad.md",
      "compressed": false, "pinned": false, "pinnedAt": null,
      "status": { "type": "started" },   // started | finished | error | aborted
      "effectiveModel": "minimax/MiniMax-M3",
      "effectiveModelVariant": "thinking",
      "model": { "provider_id": "minimax", "model_id": "MiniMax-M3", "variant": "thinking" },
      "lastActiveAt": 1782530929157, "createdAt": 1782530600299, "updatedAt": 1782530929157
    }
  ]
}
```

### 2.4 `mavis session new <agent>`

```
mavis session new mavis \
  --from root|--from <parentSid> \
  --prompt "<text>" \
  --title "<title>" \
  --workspace "<cwd>" \
  --model "<providerId/modelId>"
```

返回体（与 `session info` 同构）：

```json
{
  "session": { /* 同 2.3 session 字段 */ },
  "agentModel": "minimax/MiniMax-M3",
  "currentTurnId": "4ebc2eac-0357-49b9-91e0-39355e187766"
}
```

**注意**：`session new` **不保证** prompt 已完成，必须轮询 `session info` 看 `status.type`。

### 2.5 `mavis session info <sid>`

```json
{
  "session": { /* 同 2.3 session 字段 */ },
  "agentModel": "minimax/MiniMax-M3",
  "currentTurnId": "4ebc2eac-…"
}
```

### 2.6 `mavis session messages <sid> --limit N --before <cursor>`

```json
{
  "messages": [
    { "msg_id": "umsg_…", "role": "user",      "msg_type": 1, "msg_content": "…", "timestamp": 1780716173807, "source": "api" },
    { "msg_id": "msg_…",  "role": "assistant", "msg_type": 2, "thinking_content": "…",
      "tool_calls": [ { "tool_name": "skill", "tool_call_id": "call_…", "tool_call_status": 2,
                        "tool_call_args": "{\"name\":\"minimax-api-config\"}",
                        "tool_call_result_data": "<skill_content>…</skill_content>" } ],
      "finish_reason": "tool-calls", "usage": { "total_tokens": 29755, "context_window": 200000 } },
    { "msg_id": "msg_…",  "role": "assistant", "msg_type": 1, "msg_content": "…", "finish_reason": "stop",
      "usage": { "total_tokens": 29755, "context_window": 200000 }, "source": "api" },
    { "msg_id": "evt-…",  "msg_type": 3, "msg_content": "{\"eventType\":\"communication.message\",…}", "timestamp": 1782470033551 }
  ],
  "nextCursor": "msg_…"
}
```

- `msg_type 1` = 文本（user 或已结束 assistant）
- `msg_type 2` = 工具调用中间态（assistant）
- `msg_type 3` = 通信 / 系统事件
- `finish_reason ∈ { stop, tool-calls, error, length }`

### 2.7 `mavis session diff <sid>`

```json
{ "diffs": [] }   // 无变更时空；非空形如 [{ path, kind: 'add'|'update'|'delete', before?, after? }]
```

实测本机会话 `mvs_d2b38907cd5f447d9784f148ad66f16c` 的 `diffs` 为 `[]`。非空 shape 未在本机拿到，但 opencode 框架下常见字段为 `path / kind / before / after`。

### 2.8 `mavis communication peers`

```json
{
  "sessions": [
    { "sessionId": "mvs_…", "agentName": "mavis", "agentRole": "orchestrator", "displayName": "Mavis", "title": "…" }
  ],
  "count": 13
}
```

### 2.9 `mavis communication send`

```
mavis communication send \
  --from <sessionId>  (默认 = $__MAVIS_PARENT_SESSION_ID) \
  --to   <sessionId>  \
  --command prompt|abort|kill|summarize|fork|spawn \
  --content "<text>"
```

`mavis communication messages --limit N` 看到的派发记录：

```json
{
  "messages": [
    { "id": 110, "from_session": "user", "to_session": "mvs_…",
      "command": "prompt", "content": "…", "status": "done",
      "result": "{\"targetSessionId\":\"mvs_…\"}",
      "error": null, "caller_chain": null,
      "time_created": 1782529818681, "time_processed": 1782529818681, "metadata": null }
  ],
  "count": 1
}
```

---

## 3. 桥接侧接入点

`codex-im-suite` 当前 executor 抽象已成形，关键文件如下：

- `packages/bridge-runtime/src/executor-types.ts:1-71`
  - 已有 `ExecutorKind = 'cli' | 'agent' | 'local_model' | 'mcp'` → mavis 用 `agent`。
  - 已有 `ExecutorRiskLevel = 'read_only' | 'workspace_write' | 'system'`。
  - 已有 `ExecutorCapability = 'chat' | 'code' | 'repo_query' | 'file_read' | 'file_write' | 'mcp_ops' | 'image_input' | 'artifact_delivery'`。
  - `ExecutorManifest` 已含 `id / displayName / kind / capabilities / riskLevel / enabled / priority / description / healthCheck / configSchema`。
- `packages/bridge-runtime/src/executor-registry.ts:52-120`
  - `buildExecutorManifests(config)` 集中构造所有 manifest。
  - `inferRequestedExecutorId` 用正则匹配 `@codex` / `@claude` / `@ollama` → 需追加 `@mavis` / `@minimax`。
  - `inferCapabilities` 用 prompt 关键词推断 → 复用即可。
  - `selectExecutor` 选 + 排序 → 复用。
  - `readSessionExecutorDefaults` / `writeSessionExecutorDefault` 已存在（仅存 executor id，不存远端 sessionId）→ 需新建 binding store。
- `packages/bridge-runtime/src/executor-status.ts:1-77`
  - 已写 `~/.claude-to-im/runtime/executor-status.json`（`tmp + rename`） → 同模式复用。
- `packages/bridge-runtime/src/main.ts:767-860`
  - `HubLlmProvider` 内部**不再**持有 `fallbackProvider` 字段（v3 删除）；改为构造时注入 `ExecutorProviderRegistry`，由 `resolveForRequest` 在每次 `streamChat` 内**真分派**到外部 executor。Codex / claude-cli / codex-oss-ollama 走 registry 的默认 fallback（即原 `codexFallback`）。
- `packages/bridge-runtime/src/llm-provider.ts`、`codex-provider.ts:604-794`
  - 现有 `CodexProvider.streamChat` 返回 `ReadableStream<string>`，写 SSE 事件（`status / text / tool_use / tool_result / result / error`）→ Mavis provider 走同协议。

---

## 4. 设计稿

### 4.1 客户端层（`mavis-cli-client.ts`，新文件）

```ts
export interface MavisClientOptions {
  cliPath: string;                    // 默认 'mavis'，从 config.mavisCliPath 读
  dataDir?: string;                   // 可选，显式优于 env
  port?: number;                      // 可选
  commandTimeoutMs: number;           // 单次 CLI 调用硬超时（默认 25_000）
  extraArgs?: string[];               // 透传如 --profile xxx
}

export interface MavisClient {
  status(): Promise<{ status: 'running' | string; mode?: string; port?: number; uptimeSeconds?: number }>;
  listAgents(): Promise<MavisAgentSummary[]>;
  listSessions(agentName?: string): Promise<{ sessions: MavisSessionSummary[] }>;
  createSession(input: { agent: string; from?: 'root' | string; prompt: string; title?: string; workspace?: string; model?: string }): Promise<MavisSessionInfo>;
  info(sessionId: string): Promise<MavisSessionInfo>;
  messages(sessionId: string, opts?: { limit?: number; before?: string }): Promise<{ messages: MavisMessage[]; nextCursor?: string }>;
  diff(sessionId: string): Promise<{ diffs: MavisDiff[] }>;
  communicationPeers(): Promise<{ sessions: Array<{ sessionId: string; agentName: string; agentRole: string; displayName: string; title: string; status?: string }>; count: number }>;
  /**
   * v3.2 修订：`from` **强烈建议省略**（让 mavis CLI 用默认 $__MAVIS_PARENT_SESSION_ID env）。
   * 不要传 bridge sessionId ——bridge sessionId 不是 Mavis sessionId，mavis daemon 会拒收或归类错误。
   * 真要传 `from`，必须是合法的 Mavis sessionId（`mvs_<uuid>` 格式）。
   */
  communicationSend(input: { from?: string; to: string; command: 'prompt' | 'abort' | 'kill' | 'summarize' | 'fork' | 'spawn'; content: string }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export class MavisClientError extends Error { command: string; exitCode: number | null; stderrHead: string; }
```

#### 4.1.1 鲁棒 JSON 提取（v2 关键修复 / v3 阻断点 ① — codex 第 1 点）

codex 实测：
- `mavis session new` 会先输出一行说明再输出 JSON
- `mavis agent list` 也可能在 JSON 后跟 `Note: ...`
- `[{...},{...}]\nNote` 这种结构**对 lastIndexOf 是陷阱** —— `lastIndexOf('{')` 会切到数组里最后一个对象上，越界丢根

**v3 修正**：**只**保留 `extractFirstCompleteJson` 一个提取器，**所有** subcommand 统一用它。删除 `extractLastCompleteJson`（v2 那版用 `Math.max(lastBrace, lastBracket)` 在数组尾部带注释时会切到内部对象，codex 明确指出）。

```ts
/** 从 stdout 中提取「第一个」完整 JSON object 或 array，**同时容忍**前缀说明与后缀 Note。 */
function extractFirstCompleteJson(stdout: string): unknown {
  const text = stdout;
  const start = text.search(/[{[]/);
  if (start < 0) throw new MavisClientError('no_json', 0, text.slice(0, 200));
  return sliceAndParse(text, start);
}

/**
 * 从 start 起配对 {/[ 与 }/]，跳过字符串内字符与转义。
 * depth=0 时停止 — 停在「第一个根值的闭合处」之后，**所有后缀（包括 Note / 提示文本）被自然忽略**。
 * 关键不变量：start 必须是根值的第一个字符（object 的 `{` 或 array 的 `[`），不应该是嵌套对象内部的 `{`。
 */
function sliceAndParse(text: string, start: number): unknown {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); }
        catch (err) {
          throw new MavisClientError('json_parse', 0, slice.slice(0, 200));
        }
      }
    }
  }
  throw new MavisClientError('json_incomplete', 0, text.slice(start, start + 200));
}
```

按 subcommand 路由（**v3 统一**为 `extractFirstCompleteJson`）：

| subcommand | 提取策略 | 备注 |
| --- | --- | --- |
| `status` | `extractFirstCompleteJson` | 单 object |
| `agent list` | `extractFirstCompleteJson` | array 根值闭合后，尾注 `Note: ...` 被 `sliceAndParse` 自然忽略 |
| `session list` | `extractFirstCompleteJson` | 单 object |
| `session new` | `extractFirstCompleteJson` | 前缀说明行在 `search(/[{[]/)` 之前被忽略 |
| `session info` | `extractFirstCompleteJson` | 单 object |
| `session messages` | `extractFirstCompleteJson` | 单 object |
| `session diff` | `extractFirstCompleteJson` | 单 object |
| `communication peers` | `extractFirstCompleteJson` | 单 object |
| `communication messages` | `extractFirstCompleteJson` | 单 object |
| `communication send` | `extractFirstCompleteJson` | 单 object |

**为什么单提取器够用**：
- `sliceAndParse` 的 `depth` 是从 start 那个根 `{`/`[` 开始计；遇到根值的 `}`/`]` 立刻 depth=0 停止
- 数组里的 `[{...},{...}]` 内部 `{` 只增 depth，不会归零；只有数组自己的 `]` 才会归零
- 根值闭合之后的内容（`\nNote: ...` / `\n[其他]`）在 `for` 循环里**根本不会被扫到**，因为函数已经 `return` 了
- 因此"前缀说明 + 后缀 Note + 嵌套对象"三种情况都是同一个提取器

**错误处理**：
- 解析失败 → 抛 `MavisClientError('json_parse' | 'no_json' | 'json_incomplete', exitCode, head200)`；客户端不重试。
- stdout 头 200 字符 + stderr 头 200 字符进 `error.stderrHead`，**不**外泄完整 stdout（可能含用户上下文）。

实现要点：
- 用 `child_process.spawn` 跑 `mavis <subcmd> [...]`，捕获 stdout 解析 JSON；stderr 走 logger，**仅**截前 200 字符进 `MavisClientError.stderrHead`。
- 单次调用走 `AbortController` + `Promise.race` 强杀，到点 SIGTERM → SIGKILL。
- 客户端**不**读 `MAVIS_AUTH_TOKEN` / `OPENAI_API_KEY` / `feishuAppSecret` / `tgBotToken` / `discordBotToken` / `qqAppSecret` 等任何环境变量或配置项。
- 返回结构白名单化；缺字段给空数组 / 空对象，**不**抛错（上层按 `result` 决定是否降级）。

### 4.2 会话绑定层（`mavis-session-store.ts`，新文件）

```ts
export interface MavisSessionBinding {
  bridgeSessionId: string;            // 桥接侧 session_id
  feishuChatId?: string;              // 来自 store.listChannelBindings()
  feishuThreadId?: string;
  channelType?: string;               // feishu | weixin | tg | discord | qq
  mvsSessionId: string;               // mavis sessionId
  agentName: string;                  // 远端 agent，默认 mavis
  createdAt: string;
  lastTurnAt: string;                 // 我们上一次派发的桥接侧时间
  // —— v2 新增：续聊游标（codex 第 3 点） ——
  lastDispatchAt?: string;            // 我们上一次 `communication send` 的 ISO 时间，用于审计
  lastSeenMessageId?: string;         // 上一次已经向用户展示过的 msg_id（用于 --before 翻页）
  lastUserMessageTimestamp?: number;  // 我们上一次发出去的用户消息在 mavis 端的 timestamp（ms），用于「只取本轮之后的新 assistant」
  lastFinalText?: string;             // 末次 assistant 终答短摘要（≤500 字符），仅给 memory / 压缩用
  model: { provider_id: string; model_id: string; variant?: string };
}

const FILE = path.join(CTI_HOME, 'runtime', 'mavis-session-bindings.json');
export function readBindings(config?: Config): Record<string, MavisSessionBinding>;
export function upsertBinding(binding: MavisSessionBinding, config?: Config): void;
export function removeBinding(bridgeSessionId: string, config?: Config): void;
export function findBindingByMvs(mvsSessionId: string, config?: Config): MavisSessionBinding | undefined;
```

- 写盘沿用 `executor-status.ts:70-76` 的 `tmp + rename` 模式。
- `bridgeSessionId` 做主键（一个飞书 chat/thread 对应一个 mavis session）；同 chat 续聊走 `communication send`，**不**新建。
- binding 中**绝不**记录任何 secret、token、cookie、原始 diff 全文。

### 4.3 Provider 层（`mavis-executor-provider.ts`，新文件）

```ts
export interface MavisExecutorOptions {
  client: MavisClient;
  config: Config;
  agentName: string;                  // 默认 'mavis'
  pollIntervalMs: number;             // 默认 1500
  hardTimeoutMs: number;              // 默认 480_000 (8 分钟)
  quietTimeoutMs: number;             // 默认 90_000
  maxDiffBytes: number;               // 默认 32_000
}

export class MavisExecutorProvider implements LLMProvider {
  constructor(private readonly opts: MavisExecutorOptions) {}
  async probe(): Promise<{ ok: boolean; reason?: string }>;
  streamChat(params: StreamChatParams): ReadableStream<string>;
}
```

`streamChat` 内部状态机：

```
1. 探 binding：
   - 命中：mavis communication send --to <mvsSessionId> --command prompt --content <turnPrompt>
   - 未命中：mavis session new <agent> --from root --prompt <turnPrompt>
            [--title] [--workspace] [--model]
            → upsertBinding
2. 轮询 session info：
   - status.type === 'finished'                  → 拉 messages + diff，emit final
   - status.type === 'error' | 'aborted'         → emit error + 终态
   - status.type === 'started' | 'idle'          → 继续轮询
   - quietTimeoutMs / hardTimeoutMs 触发         → 走 mavis communication send --command abort 后 emit error
3. 终态：
   - 末条 msg_type=1 且 role=assistant 的 msg_content → sseEvent('text', ...)
   - 中间 msg_type=2 的 tool_calls[]               → 一对 sseEvent('tool_use') + sseEvent('tool_result')
   - 末条 thinking_content                       → sseEvent('status', { reasoning: ... })
   - usage                                        → sseEvent('result', { usage, session_id: mvsSessionId })
   - diffs[]                                      → 一对 sseEvent('tool_use', { name: 'Edit', input: { files: [...] }})
                                                       + sseEvent('tool_result', { content: '<evidence>', is_error: false })
4. 错误：
   - summarizeMavisFailureMessage(status.message) → sseEvent('error', short)
```

`probe()` 跑一发 `mavis status` + `mavis agent list`；任一失败 → `{ ok: false, reason: ... }`，让 `buildExecutorManifests` 把 `enabled` 设为 `false`。

#### 4.3.2 真分派：ExecutorProviderRegistry（v2 关键修复 — codex 第 2 点）

codex 第一轮指出：v1 设计在 `HubLlmProvider` 构造期替换 `fallbackProvider` 不对 — `selectExecutor` 在 `main.ts:891` 跑、`streamChat` 在 `main.ts:1780` 跑，中间 `HubLlmProvider` 内部还有本地路由链，构造期替换会让"显示选了 mavis-agent，实际仍是 Codex"。

**v3 已彻底删除 v1 替换方案**：本节是 `ExecutorProviderRegistry` 真分派的唯一描述。`HubLlmProvider` 构造里**不再**写"只在选中 mavis-agent 时把 fallback 替换为 Mavis provider"——那行 v1 文本已从 §3 删除（见 line 218 修订）。

**新方案**：引入 `ExecutorProviderRegistry`，在 `selectExecutor` **之后立刻分派**，绕开 Hub 的本地路由。

新文件 `packages/bridge-runtime/src/executor-provider-registry.ts`（**v3.1 实施级问题 ① 修订 + v3.2 实施级问题 ② 修订** — 类型从 `executor-types.js` 导入，函数从 `executor-registry.js` 导入）：

```ts
import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import { selectExecutor } from './executor-registry.js';            // ← v3.2: 函数
import type { ExecutorRequest, ExecutorSelection } from './executor-types.js';  // ← v3.2: 类型
import type { Config } from './config.js';

export interface ResolvedDispatch {
  provider: LLMProvider;
  selection: ExecutorSelection;
  isExternal: boolean;
}

export class ExecutorProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  /** 由 main.ts 在 daemon 启动时一次性注册。 */
  register(executorId: string, provider: LLMProvider): void {
    if (!executorId || !provider) return;
    this.providers.set(executorId, provider);
  }

  has(executorId: string): boolean { return this.providers.has(executorId); }

  /**
   * 关键分派点（v3.1 + v3.2 修订）：
   * - registry **只接 ExecutorRequest**，**不**自己从 StreamChatParams 拼
   * - registry **不**接 `sessionDefaultId` 参数（v3.2 选项 A）——caller 必须把 session default 折进
   *   `ExecutorRequest.requestedExecutorId`（与 `@hint` 推断结果合并）
   * - 拼装 ExecutorRequest 是 caller（HubLlmProvider）的职责，这样 caller 才能：
   *   - 把 `sessionDefaultId`（从 `readSessionExecutorDefaults` 读）折进 `requestedExecutorId`
   *   - 保留 `preferredExecutorId`（HubLlmProvider 的 `primaryExecutorId`）
   *   - 保留 `taskKind`（`startObservedWorkflow` 已推断）
   *   - 显式传 `prompt`（避免 `selectExecutor` 内部 `params.prompt` 二次取）
   *
   * `defaultProvider` 是 registry 内的「**默认 Codex 主链**」——**仅在 isExternal=false 时使用**。
   * 选中 external executor 后这个参数**完全被忽略**，与 v1 "构造期替换 fallback" 无关。
   */
  resolveForRequest(
    config: Config,
    request: ExecutorRequest,         // ← v3.1：必须是完整 ExecutorRequest
    defaultProvider: LLMProvider,
  ): ResolvedDispatch {
    const selection = selectExecutor(config, request);   // ← 用 caller 已构造好的完整 request；sessionDefaultId 已在 caller 折进 requestedExecutorId
    const external = this.providers.get(selection.executor.id);
    if (
      external
      && selection.executor.id !== 'codex'
      && selection.executor.id !== 'claude-cli'
      && selection.executor.id !== 'codex-oss-ollama'
    ) {
      return { provider: external, selection, isExternal: true };
    }
    return { provider: defaultProvider, selection, isExternal: false };
  }
}
```

`HubLlmProvider.streamChat` 内 caller 侧的 `ExecutorRequest` 构造（**v3.1 新增 + v3.2 修订 + v3.3 必修 — `sessionDefaultId` 折进 `requestedExecutorId`，**`@hint` 优先于 `sessionDefault`**）：

```ts
// HubLlmProvider.streamChat 内部（v3.2：不再传 sessionDefaultId 给 registry；折进 requestedExecutorId）
const sessionDefaultId = readSessionExecutorDefaults(this.config)[params.sessionId];
const taskKind = this.inferTaskKindFromStreamParams(params);   // 沿用 v1 HubLlmProvider.startObservedWorkflow 推断逻辑
// v3.3 必修：@hint 优先于 sessionDefault
// 原因：会话默认 mavis-agent 后，用户 @codex 应该能切回 Codex；写反会让用户 @codex 切不回
const hintedExecutorId = inferRequestedExecutorId(params.prompt);
const requestedExecutorId =
  hintedExecutorId
  ?? sessionDefaultId
  ?? undefined;
const executorRequest: ExecutorRequest = {
  sessionId: params.sessionId,
  prompt: params.prompt,                              // ← 显式从 params 提一次，避免下游再取
  workingDirectory: params.workingDirectory,
  permissionMode: params.permissionMode,
  requestedExecutorId,                                // ← v3.2：已包含 sessionDefaultId + @hint 推断；v3.3：@hint 优先
  preferredExecutorId: this.primaryExecutorId,        // ← HubLlmProvider 已有的字段
  taskKind,
  params,                                             // ← 原 StreamChatParams 一并传，供下游按需取
};

const { provider, selection, isExternal } = this.executorRegistry.resolveForRequest(
  this.config,
  executorRequest,                  // ← v3.1：传完整 ExecutorRequest
  this.defaultCodexProvider,        // ← v3.1：默认 Codex 主链
);
// v3.2：不再有第 4 参 sessionDefaultId；registry 也不接
```

**v3.3 关键不变量**：
- `ExecutorProviderRegistry.resolveForRequest` **不**接 `sessionDefaultId` 参数
- `ExecutorRequest` **不**有 `sessionDefaultId` 字段（v3.2 选项 A，codex 第四轮 ② 二选一选这个）
- `selectExecutor` 现有的第 3 参 `sessionDefaultId?: string` **保留**作为兜底（caller 折进 `requestedExecutorId` 后此参通常 undefined，但兼容旧调用方不报错）
- **v3.3 P1 必修 — 优先级必须为 `@hint > sessionDefault`**：
  - 用户输入 `@codex` → `hintedExecutorId = 'codex'` → 命中 → 路由 Codex（**不**被 sessionDefault 拦截）
  - 用户输入 `@mavis` / `@minimax` → `hintedExecutorId = 'mavis-agent'` → 命中
  - 用户无 hint + sessionDefault = `'mavis-agent'` → `hintedExecutorId = undefined` → 回落到 sessionDefault = `'mavis-agent'`
  - 用户无 hint + 无 sessionDefault → 两者都 undefined → 走 capability 自动选择（`request.requestedExecutorId` / `inferRequestedExecutorId` / `sessionDefaultId` 全空 → `selectExecutor` 走非显式路径）
- `executor-provider-registry.test.ts` 测例覆盖：「sessionDefaultId 折进 requestedExecutorId 后 selectExecutor 命中 mavis-agent」「sessionDefaultId + @hint 同时存在时 **`@hint` 优先于 `sessionDefault`**」（**v3.3 必修** — v3.2 写反了）2 条 case
- HubLlmProvider caller 内部用 `hintedExecutorId ?? sessionDefaultId ?? undefined` 顺序（**v3.3 必修**：v3.2 写反了，v3.3 改为 `@hint` 优先）；与 `selectExecutor` 内部 `request.requestedExecutorId || inferRequestedExecutorId(request.prompt) || sessionDefaultId` 顺序一致——两边都是"`@hint` 优先于 sessionDefault"，避免概念漂移
- **v3.3 P1 必修 — `@hint` 优先于 `sessionDefault`**：见上面 caller 注释。如果写反，会让 session default = mavis-agent 的会话**永远**走 mavis-agent，用户 `@codex` 切不回 Codex

**不变量**：
- registry **不**接受 `StreamChatParams`，**不**内部拼 `ExecutorRequest`（避免隐式丢 `requestedExecutorId` / `preferredExecutorId` / `taskKind`）
- caller 永远是 `ExecutorRequest` 构造者，保留所有可选字段
- `main.ts:891`（`startObservedWorkflow`）和 `main.ts:1780`（实际 stream 调用点）**都**走同一个 `executorRequest` 构造路径，避免两处分叉
```

`main.ts` 改动（最小）：

```ts
// daemon 启动时一次性注册
const executorRegistry = new ExecutorProviderRegistry();
executorRegistry.register('mavis-agent', new MavisExecutorProvider({ client, config, ... }));

// 在 HubLlmProvider 构造里拿到 registry（注入而非全局变量）
class HubLlmProvider implements LLMProvider {
  constructor(
    ..., private readonly executorRegistry: ExecutorProviderRegistry, ...
  ) {}

  streamChat(params) {
    return new ReadableStream({
      start: async (controller) => {
        // 把 startObservedWorkflow 里的 selectExecutor 调用改成走 registry
        // 注意：第三个参数是**默认 provider**（即 Codex 主链），不是「v1 替换出来的 fallback」；
        // registry 在选到 external executor 时**完全忽略**这个参数。
        // v3.2：传 caller 构造的 `executorRequest`，**不**再传 `params`（line 528 旧调用已删）
        // v3.3 必修：`@hint` 优先于 `sessionDefault`，让 user `@codex` 能切回 Codex
        const sessionDefaultId = readSessionExecutorDefaults(this.config)[params.sessionId];
        const taskKind = this.inferTaskKindFromStreamParams(params);
        const hintedExecutorId = inferRequestedExecutorId(params.prompt);
        const requestedExecutorId =
          hintedExecutorId
          ?? sessionDefaultId
          ?? undefined;
        const executorRequest: ExecutorRequest = {
          sessionId: params.sessionId,
          prompt: params.prompt,
          workingDirectory: params.workingDirectory,
          permissionMode: params.permissionMode,
          requestedExecutorId,
          preferredExecutorId: this.primaryExecutorId,
          taskKind,
          params,
        };
        const { provider, selection, isExternal } = this.executorRegistry.resolveForRequest(this.config, executorRequest, this.defaultCodexProvider);
        writeExecutorStatus(this.config, { sessionId: params.sessionId, selection });
        setWorkflowExecutor(workflowRun.id, selection.executor.id, selection.reason);
        if (isExternal) {
          // 真分派：mavis-agent / 未来的其它 external executor 直接走自己
          // —————— 阶段 A：pre-dispatch（probe + createSession / communication send） ——————
          // 任何阶段 A 失败 → 允许回落 Codex，因为 Mavis 还没真正接单
          try {
            await this.runPreDispatch(provider, params);   // 抛错即回落到 §4.3.2.1
            // 阶段 A 成功：mvsSessionId 已在 binding 里，prompt 已 send
            // —————— 阶段 B：post-dispatch（poll + messages + diff） ——————
            // 任何阶段 B 失败 → 禁止回落；Mavis 已接单，重复执行会写两次仓库
            // 只允许 emit error / partial_result
            await this.runPostDispatch(provider, params, controller);
            controller.close();
            return;
          } catch (phaseAError) {
            // 仅阶段 A 错误能回落
            return this.pipeCodexPrimaryWithFallback(
              controller, params, conservative,
              `外部 executor pre-dispatch 失败，回落 Codex：${summarizeMavisFailureMessage(phaseAError.message)}`,
            );
          }
        }
        // 不是 external：走原有 HubLlmProvider 内部路由
        ...
      }
    });
  }
}
```

**关键不变量（v3 阻断点 ② 修订）**：
- `selectExecutor` 是唯一选择入口（`executor-registry.ts` 已有），`ExecutorProviderRegistry` 只做"id → provider 实例"映射。
- `isExternal === true` 时，**不**调用 `decideConservativeRoute` / `LocalLlmProvider` / `ManifestSlimCodexProvider` 等任何本地路由链（避免重复决策、避免泄漏 mavis 内部状态到本地日志）。
- `isExternal === false` 时，行为与 v1 完全一致（Codex / claude-cli / codex-oss-ollama）。
- **回落边界**（codex 第二轮阻断点 ②）：
  - **pre-dispatch 阶段**（`probe` / `createSession` / `communication send`）失败 → **可**回落到 Codex
  - **post-dispatch 阶段**（poll / messages / diff / 终态解析）失败 → **禁止**回落；只 emit `error: ...` 或 `partial_result: ...`，让用户决定是否手动重试
  - 判据：是否已存在非空 `binding.mvsSessionId` 且 `lastDispatchAt` 已写入
  - post-dispatch 失败时**不**改 binding 的 `mvsSessionId`（让用户能手动 `mavis session info` 续看），但 `lastFinalText` / `lastSeenMessageId` 保持上次成功值不变

##### 4.3.2.0 `buildMavisSessionTitle` 派生（v3.1 实施级问题 ④ — `StreamChatParams` 无 `title` 字段）

`StreamChatParams`（来自 `claude-to-im/src/lib/bridge/host.js`）**没有** `title` 字段。`createSession.title` **不能**用 `params.title`，必须从 `params.prompt` / `params.sourceMessageId` / `params.sessionId` 派生短标题。独立函数（`packages/bridge-runtime/src/mavis-session-title.ts`）：

```ts
import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

const MAX_TITLE_LEN = 64;          // mavis session.title 上限（经验值，未在协议里硬约束）
const FALLBACK_PREFIX = 'mavis:';

/**
 * 从 StreamChatParams 派生 mavis session.title。
 * 优先级：prompt 摘要 → sourceMessageId → sessionId 末段。
 * **不**接受任何外部 title 字符串（StreamChatParams 没有这字段），**不**接受 params.title。
 */
export function buildMavisSessionTitle(params: StreamChatParams): string {
  const base = summarizePrompt(params.prompt);
  if (base) return clamp(`${FALLBACK_PREFIX}${base}`, MAX_TITLE_LEN);
  if (params.sourceMessageId) return clamp(`${FALLBACK_PREFIX}msg-${params.sourceMessageId}`, MAX_TITLE_LEN);
  // sessionId 通常是 mvs_<random>，取末段 8 字符足够
  const tail = (params.sessionId || 'unknown').split(/[-_:]/).pop() || params.sessionId || 'unknown';
  return clamp(`${FALLBACK_PREFIX}${tail}`, MAX_TITLE_LEN);
}

function summarizePrompt(prompt: string | undefined): string {
  if (!prompt || typeof prompt !== 'string') return '';
  // 去掉前后空白、合并换行；保留前 30 字符作为摘要；中文 / 英文 / emoji 统一按字符数截
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= 30 ? flat : `${flat.slice(0, 29)}…`;
}

function clamp(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}
```

**使用规约**：
- **唯一**调用点：`MavisExecutorProvider.preDispatch` 的「新建路径」分支（第 4.3.2.1 节，`createSession.title` 字段）
- 续聊路径**不**调（mavis 端 session 已有 title）
- **不**对外暴露 `title` 入口；任何 `params.title` 用法都是 v3.1 修复目标，codex 明确这是错误用法
- 单测覆盖：纯 prompt / 短 prompt（≤30 字符）/ 长 prompt / 仅含空白 / 含 emoji / `params.prompt` 缺省（用 sourceMessageId）/ 全缺省（用 sessionId 末段）

##### 4.3.2.1 pre-dispatch 流程（唯一可回落的窗口）

```ts
private async runPreDispatch(provider: LLMProvider, params: StreamChatParams): Promise<void> {
  // MavisExecutorProvider 暴露一个预同步钩子；只做「可达性 + 派发」，不读结果
  const mavis = provider as MavisExecutorProvider;     // 内部类型断言
  if (typeof mavis.preDispatch === 'function') {
    await mavis.preDispatch(params);   // probe + createSession / communication send + 写入 binding
    return;
  }
  throw new MavisSafetyError('not_external', 'provider 不支持 preDispatch');
}
```

`MavisExecutorProvider.preDispatch(params)` 的实现（**纯同步派发，不读结果**；**v3.1 实施级问题 ② 修订** — 续聊路径必须发本轮 prompt，不能只 info 探活）：

```ts
async preDispatch(params: StreamChatParams): Promise<void> {
  // 1) 探活（probe 已经在 daemon 启动时跑过；这里仅做轻量二次确认）
  await this.assertWorkspaceAllowed(params.workingDirectory || this.config.defaultWorkDir, this.allowedRoots);
  // 2) 续聊 or 新建
  const binding = this.readBinding(params.sessionId);
  if (binding && (Date.now() - Date.parse(binding.createdAt)) < 24 * 60 * 60 * 1000) {
    // 续聊路径 — 三步：探活 + 派发本轮 prompt + 写 binding
    // （v3.1 关键修复：v3 漏了派发本轮 prompt，会让续聊完全空跑）
    // （v3.2 修订：from 必须**省略**，让 mavis CLI 用默认 $__MAVIS_PARENT_SESSION_ID；
    //   bridge sessionId 不是 Mavis sessionId，传 from 会被 mavis daemon 拒收或归类错误；
    //   bridge 端无法确定合法的 mavis-agent sender sessionId，让 CLI 默认最稳）
    const info = await this.client.info(binding.mvsSessionId);
    if (!info.session) throw new MavisSafetyError('remote_gc', 'mavis 端 session 已被 GC');
    // 派发本轮 prompt 到现有 mavis session
    const sendResult = await this.client.communicationSend({
      to: binding.mvsSessionId,
      command: 'prompt',
      content: this.buildTurnPrompt(params),
      // 显式不传 `from`：让 `mavis communication send` 用 CLI 默认值 `$__MAVIS_PARENT_SESSION_ID`
      // （参考 `mavis communication send --help`: --from 默认 = __MAVIS_PARENT_SESSION_ID env）
    });
    if (!sendResult.ok) {
      throw new MavisSafetyError('send_failed', `mavis 端续聊入队失败：${sendResult.error || 'unknown'}`);
    }
    // 续聊只更新 lastDispatchAt，**不**改 mvsSessionId / createdAt
    this.binding = upsertBinding({
      ...binding,
      lastDispatchAt: new Date().toISOString(),
      lastTurnAt: new Date().toISOString(),
    });
  } else {
    // 新建路径
    const created = await this.client.createSession({
      agent: this.opts.agentName,
      from: 'root',
      prompt: this.buildTurnPrompt(params),
      title: buildMavisSessionTitle(params),         // ← v3.1：派生标题（StreamChatParams 无 title 字段）
      workspace: params.workingDirectory,
    });
    this.binding = this.upsertBinding({
      bridgeSessionId: params.sessionId,
      mvsSessionId: created.session.sessionId,
      agentName: this.opts.agentName,
      createdAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
      model: { provider_id: created.session.model.provider_id, model_id: created.session.model.model_id, variant: created.session.model.variant },
    });
  }
  // pre-dispatch 完成后任何错误（poll / messages / diff 失败）都不再回落
}
```

##### 4.3.2.2 post-dispatch 流程（禁止回落）

```ts
private async runPostDispatch(
  provider: LLMProvider,
  params: StreamChatParams,
  controller: ReadableStreamDefaultController<string>,
): Promise<void> {
  const mavis = provider as MavisExecutorProvider;
  if (typeof mavis.streamUntilFinish === 'function') {
    await mavis.streamUntilFinish(params, this.binding!, controller);
    return;
  }
  throw new MavisSafetyError('not_external', 'provider 不支持 streamUntilFinish');
}
```

`MavisExecutorProvider.streamUntilFinish(params, binding, controller)`：**完全自管 SSE**，不调 `HubLlmProvider` 任何方法。失败语义：
- `status.type === 'finished'` → emit `result` + `close()`，binding 更新 `lastSeenMessageId` / `lastFinalText` / `lastUserMessageTimestamp`
- `status.type === 'error' | 'aborted'` → emit `error: 远端未完成...` + `close()`，**不**改 `lastFinalText` / `lastSeenMessageId`（保持上次成功值），让用户能重试看到完整上下文
- `quietTimeoutMs` / `hardTimeoutMs` → 先 `communication send --command abort`，再 emit `error: 远端调用超时` + `close()`，binding 标记 `lastDispatchAt` 但不更新游标
- `partial_result`（终态 finished 但 messages / diff 拉不到）→ emit `cti-final` 风格 "未完成/部分完成" 文本 + `close()`，**不**回落

#### 4.3.3 续聊过滤（v2 关键修复 / v3 阻断点 ④ — codex 第 3 点）

codex 指出：`mavis communication send` 之后拉 `session messages`，**不能**简单按时间戳过滤 — 续聊但本轮 mavis 还没产生新 user message 时，会漏掉上一轮最后一条 assistant。

**v3 主用 `lastSeenMessageId`，`timestamp` 仅作兜底**：
- **主用**：用 `lastSeenMessageId` 作为切点，拉最新一页 → 按 timestamp 升序排序 → 切到 `lastSeenMessageId` 之后
- **不用 `--before` 做 after cursor**：`--before <msg_id>` 的语义是"返回这条消息**之前**的更早消息"，是翻旧页用的；如果用 `--before lastSeenMessageId`，mavis 会返回**比它更早的旧消息**，方向反了
- **`timestamp` 兜底**：当某条消息缺 `msg_id`（理论上不会，但 mavis 协议未保证）时，退化为 `timestamp > lastUserMessageTimestamp`
- `lastUserMessageTimestamp` 在 binding 里**仍然保留**，但只作为 fallback path 的输入

```ts
// MavisExecutorProvider.streamUntilFinish 内部（终态后）
const { messages: page } = await client.messages(binding.mvsSessionId, { limit: 50 });
// 升序，最新在末尾
const sorted = [...page].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

let newMessages: typeof sorted;
if (binding.lastSeenMessageId) {
  // 主用：找到 lastSeenMessageId 的索引，**取它之后**的全部消息
  const idx = sorted.findIndex(m => m.msg_id === binding.lastSeenMessageId);
  if (idx >= 0) {
    newMessages = sorted.slice(idx + 1);
  } else {
    // 找不到（消息流被截断 / 翻页了），回退到 timestamp 兜底
    const cutoff = binding.lastUserMessageTimestamp ?? 0;
    newMessages = sorted.filter(m => (m.timestamp ?? 0) > cutoff);
  }
} else {
  // 首轮 / binding 没 lastSeenMessageId：不做过滤，全量作为本轮新消息
  // 但要排除 binding 之前已经存过的"上次终答"——以 binding.createdAt 之前为界
  const cutoff = binding.lastUserMessageTimestamp ?? 0;
  newMessages = sorted.filter(m => (m.timestamp ?? 0) > cutoff);
}

// 终答：newMessages 里最后一条 msg_type=1 且 role=assistant 的 msg_content
const finalAssistant = [...newMessages].reverse().find(m => m.role === 'assistant' && m.msg_type === 1 && m.msg_content);
const text = finalAssistant?.msg_content ?? '';

// 找本轮我们的 user message（用来更新 lastUserMessageTimestamp 兜底值）
const ourUserMsg = newMessages.find(m => m.role === 'user');

// 更新 binding：主用 lastSeenMessageId，timestamp 仅兜底
const nextLastSeen = finalAssistant?.msg_id ?? binding.lastSeenMessageId;
const nextTs = ourUserMsg?.timestamp ?? binding.lastUserMessageTimestamp;

upsertBinding({
  ...binding,
  lastDispatchAt: new Date().toISOString(),
  lastSeenMessageId: nextLastSeen,        // 主用游标
  lastUserMessageTimestamp: nextTs,       // 仅作 fallback
  lastFinalText: text.slice(0, 500),
  lastTurnAt: new Date().toISOString(),
});
```

**`--before` 的正确用法**（仅在历史回溯时使用，本 PR 不调用）：
```ts
// 仅当用户明确说"翻这一页之前的历史"才用
const older = await client.messages(sid, { before: anchorMsgId, limit: 20 });
```

边界：
- 首轮（无 binding / 无 `lastSeenMessageId`）→ 按 `lastUserMessageTimestamp` 兜底过滤，全量作为本轮新消息。
- 续聊但 mavis 端 session 已被 GC（`info` 探活 404 / `status.type === 'error'`）→ 删除 binding 后走 `session new`。
- 续聊但本轮 mavis 端没产生新 assistant（极少见）→ emit `error: 远端未产生新回复` + **不**更新 `lastSeenMessageId` 与 `lastUserMessageTimestamp`，下次还能重试。
- 续聊但消息流被服务端截断，`lastSeenMessageId` 在新拉的 50 条里找不到 → 自动回退 timestamp 兜底 + emit `status: { cursorFallback: true }` 提示，便于后续实现增量拉取。

### 4.4 Manifest 改动（v3 阻断点 ⑥ 修订）

#### 4.4.1 `config/runtime.d/` ≠ executor registry 来源（codex 阻断点 ⑥）

`config/runtime.d/*.json` 在 codex-im-suite 里的实际用途是**控制面板运行单元 / 更新协议可观测**（参考现有 4 个 `service.*.json` 的用法），**不是** `selectExecutor` 的真实路由来源。

**真实路由来源始终是 `executor-registry.ts:buildExecutorManifests(config)`** —— 它在每次 `selectExecutor()` 时基于 `Config` 实时构造 manifest，**不读** `config/runtime.d/*.json`。

因此本节拆成两份职责清晰的文件：

1. **`config/runtime.d/executor.mavis-agent.json`**（**仅控制面板可观测**）：
   - 写不写、字段如何，**都不影响**路由决策
   - 面板用它显示"运行时单元"卡片、健康检查入口
   - 文件可省略；省略时面板不显示 mavis-agent 卡片，但 bridge 仍可路由

2. **`executor-registry.ts:buildExecutorManifests()`**（**真实路由来源**）：
   - 唯一被 `selectExecutor` 调用的入口
   - `mavisEnabled=false` 时**不返回** mavis-agent manifest → `selectExecutor` 看不到
   - 面板展示的"当前生效 executor 列表"应来自 `executor-status.json`（由 `buildExecutorManifests` 持久化），不是 `config/runtime.d/`

`config/runtime.d/executor.mavis-agent.json`（新文件，**仅供控制面板可观测**，**默认 enabled=false**）：

```json
{
  "id": "mavis-agent",
  "displayName": "Mavis Agent (Mavis / MiniMax Code)",
  "kind": "agent",
  "category": "external-agent",
  "enabled": false,
  "installState": "external",
  "source": "${SUITE_ROOT}\\packages\\bridge-runtime\\src\\mavis-executor-provider.ts",
  "cwd": "${SUITE_ROOT}",
  "version": "",
  "description": "控制面板可观测条目；真实路由来源是 buildExecutorManifests(config)，本文件不参与 selectExecutor。",
  "executorProtocol": "mavis-cli/v1"
}
```

`executor-registry.ts:52-120` 末尾追加 manifest（**真实路由来源** — **v2 默认 opt-in**，codex 第一轮第 4 点）：

```ts
{
  id: 'mavis-agent',
  displayName: `Mavis Agent (${config.mavisAgentName || 'mavis'})`,
  kind: 'agent',
  capabilities: config.mavisReadOnly
    ? ['chat', 'repo_query', 'file_read', 'image_input']
    : ['chat', 'code', 'repo_query', 'file_read', 'file_write', 'mcp_ops', 'image_input', 'artifact_delivery'],
  riskLevel: config.mavisReadOnly ? 'read_only' : 'workspace_write',
  // 关键：mavisEnabled=false 时 manifest 完全不注册，selectExecutor 看不到
  enabled: !!config.mavisEnabled && !!config.mavisCliPath,
  // 关键：priority 低于 codex（80/100）和 claude-cli（70），只有显式 hint 或用户配置 mavisDefaultExecutor=true 时才会被自动选中
  priority: config.mavisEnabled ? 50 : 0,
  description: 'Mavis / MiniMax Code 独立 executor；通过 mavis CLI 派发任务、轮询结果。',
  healthCheck: { kind: 'command', target: `${config.mavisCliPath || 'mavis'} status` },
  configSchema: {
    protocol: 'mavis-cli/v1',
    agent: config.mavisAgentName || 'mavis',
    port: config.mavisPort,
    dataDir: config.mavisDataDir,
    pollIntervalMs: config.mavisPollIntervalMs ?? 1500,
    hardTimeoutMs: config.mavisHardTimeoutMs ?? 480000,
    quietTimeoutMs: config.mavisQuietTimeoutMs ?? 90000,
    maxDiffBytes: config.mavisMaxDiffBytes ?? 32000,
    readOnly: !!config.mavisReadOnly,
    optIn: true,                          // 标记：必须显式 opt-in
  },
}
```

`executor-registry.ts:18-23` 的 `EXECUTOR_HINTS` 追加（**显式 hint 优先**）：

```ts
{ pattern: /(?:^|\s)@?(?:mavis|minimax|minimax-code)(?:\s|$)/i, id: 'mavis-agent' },
```

`selectExecutor` 行为不变（v1 已有逻辑）：`inferRequestedExecutorId` 命中 → `requestedExecutorId='mavis-agent'` → 显式选择 mavis-agent；无 hint 时按 `priority` 排序，codex(80) > claude-cli(70) > mavis-agent(50)。

新增配置项 `mavisDefaultExecutor`（v2 新增，codex 第 4 点）：用户在控制面板 / `config.env` 设 `mavisDefaultExecutor=true` 后，`writeSessionExecutorDefault(bridgeSessionId, 'mavis-agent')` 在首次进入该 session 时落盘，**之后**该 session 续聊默认走 mavis-agent，直到用户显式 `@codex` 切回。

```ts
// executor-registry.ts:175-202 readSessionExecutorDefaults 现有函数无需改
// 面板/配置入口处（不在本 PR 范围）调用：
writeSessionExecutorDefault(bridgeSessionId, 'mavis-agent', config);
```

`Config` 在 `config.ts:6-116` 末尾追加 **11** 个可选字段（**v3.1 实施级问题 ③ 修订** — codex 第三轮数清楚 11 个，不是 10 个）：

```ts
mavisEnabled?: boolean;                 // 总开关；默认 false（opt-in）
mavisCliPath?: string;                  // 默认 'mavis'
mavisAgentName?: string;                // 默认 'mavis'
mavisDataDir?: string;                  // 可选，显式优于 env
mavisPort?: number;                     // 可选
mavisPollIntervalMs?: number;           // 默认 1500
mavisHardTimeoutMs?: number;            // 默认 480_000
mavisQuietTimeoutMs?: number;           // 默认 90_000
mavisMaxDiffBytes?: number;             // 默认 32_000
mavisReadOnly?: boolean;                // true → capabilities 去掉 file_write / mcp_ops
mavisDefaultExecutor?: boolean;         // ← v3 补：true → 写 sessionExecutorDefaults('mavis-agent')，session 续聊默认走 mavis
```

**v3.1 实施级问题 ③ 强调 — env 主命名必须按项目约定 `CTI_*`**：

仓库现有 `config.env` 的 env 名是 `CTI_DEFAULT_WORKDIR` / `CTI_CODEX_*` / `CTI_LOCAL_AI_*` 等，全部带 `CTI_` 前缀（参考 `config.ts:200+` 的 `parseEnvFile` 调用方）。新 mavis 字段必须遵守这条约定：

| Config 字段 | env **主命名**（v3.1 强制） | 裸 `MAVIS_*` **兼容 alias**（v3.1 允许，但不主推） |
| --- | --- | --- |
| `mavisEnabled` | `CTI_MAVIS_ENABLED` | `MAVIS_ENABLED`（alias） |
| `mavisCliPath` | `CTI_MAVIS_CLI_PATH` | `MAVIS_CLI_PATH`（alias） |
| `mavisAgentName` | `CTI_MAVIS_AGENT_NAME` | `MAVIS_AGENT_NAME`（alias） |
| `mavisDataDir` | `CTI_MAVIS_DATA_DIR` | `MAVIS_DATA_DIR`（alias） |
| `mavisPort` | `CTI_MAVIS_PORT` | `MAVIS_PORT`（alias） |
| `mavisPollIntervalMs` | `CTI_MAVIS_POLL_INTERVAL_MS` | `MAVIS_POLL_INTERVAL_MS`（alias） |
| `mavisHardTimeoutMs` | `CTI_MAVIS_HARD_TIMEOUT_MS` | `MAVIS_HARD_TIMEOUT_MS`（alias） |
| `mavisQuietTimeoutMs` | `CTI_MAVIS_QUIET_TIMEOUT_MS` | `MAVIS_QUIET_TIMEOUT_MS`（alias） |
| `mavisMaxDiffBytes` | `CTI_MAVIS_MAX_DIFF_BYTES` | `MAVIS_MAX_DIFF_BYTES`（alias） |
| `mavisReadOnly` | `CTI_MAVIS_READ_ONLY` | `MAVIS_READ_ONLY`（alias） |
| `mavisDefaultExecutor` | `CTI_MAVIS_DEFAULT_EXECUTOR` | `MAVIS_DEFAULT_EXECUTOR`（alias） |

**`loadConfig` / `saveConfig` 解析顺序**：
1. 优先读 `CTI_MAVIS_*`
2. 缺省时 fallback 到 `MAVIS_*`（**仅**作为 alias，log warn 一次提示"建议改用 `CTI_MAVIS_*`"）
3. 都没有 → 字段保持 `undefined`（manifest `enabled=false`）

**`saveConfig` 写出**：只写 `CTI_MAVIS_*`，**不**写裸 `MAVIS_*`（避免污染用户 `config.env`）。

**v3 阻断点 ⑤ 强调**：实现时**必须**同时改三处，否则 `config.env` 改了也不生效：

| 位置 | 改动 |
| --- | --- |
| `Config` interface（`config.ts:6-116`） | 加这 11 个字段 |
| `loadConfig()`（`config.ts:200+`） | 在 env → config 映射里加 11 条解析；主命名 `CTI_MAVIS_*` + 兼容 alias `MAVIS_*`；类型转换与现有字段一致（string / number / boolean） |
| `saveConfig()`（`config.ts:300+`，如有） | 反向写出 11 条（**只**用 `CTI_MAVIS_*`）；保证面板改值能落回 `config.env` |

任何一处漏改 → 用户改了 `config.env` 但 `Config` 仍是 undefined → manifest `enabled=false` → mavis-agent 永远不参与路由。**单元测试**必须包含「`loadConfig` 解析 `CTI_MAVIS_ENABLED=true` 后 `config.mavisEnabled === true`」「`loadConfig` 在 `CTI_MAVIS_ENABLED` 缺省时回退 `MAVIS_ENABLED`」「`saveConfig` 写出后 `CTI_MAVIS_DEFAULT_EXECUTOR` 落盘、**不**写 `MAVIS_DEFAULT_EXECUTOR`」3 条 case。

`main.ts:767-860` `HubLlmProvider` 构造里**不再**写"替换 fallbackProvider"。v3 改为注入 `ExecutorProviderRegistry`：

```ts
const executorRegistry = new ExecutorProviderRegistry();
executorRegistry.register('mavis-agent', new MavisExecutorProvider({
  client: createMavisClient({
    cliPath: config.mavisCliPath || 'mavis',
    dataDir: config.mavisDataDir,
    port: config.mavisPort,
    commandTimeoutMs: 25_000,
  }),
  config,
  agentName: config.mavisAgentName || 'mavis',
  pollIntervalMs: config.mavisPollIntervalMs ?? 1500,
  hardTimeoutMs: config.mavisHardTimeoutMs ?? 480_000,
  quietTimeoutMs: config.mavisQuietTimeoutMs ?? 90_000,
  maxDiffBytes: config.mavisMaxDiffBytes ?? 32_000,
}));

// HubLlmProvider 构造
new HubLlmProvider(
  config, store, local, localAgent,
  codexFallback,                                  // defaultCodexProvider
  executorRegistry,                               // ← v3 注入
  ...
);
```

`HubLlmProvider` **不再**有 `if (selection.executor.id === 'mavis-agent') { fallback = ... }` 这种构造期分支——分派由 `executorRegistry.resolveForRequest` 在 `streamChat` 内按 §4.3.2 真分派。
    client: createMavisClient({ cliPath: config.mavisCliPath || 'mavis', ... }),
    config, agentName: config.mavisAgentName || 'mavis',
    pollIntervalMs: config.mavisPollIntervalMs ?? 1500,
    hardTimeoutMs: config.mavisHardTimeoutMs ?? 480_000,
    quietTimeoutMs: config.mavisQuietTimeoutMs ?? 90_000,
    maxDiffBytes: config.mavisMaxDiffBytes ?? 32_000,
  });
}
```

---

## 5. Polling / Timeout / Error

### 5.1 轮询参数

| 字段 | 默认 | 触发 |
| --- | --- | --- |
| `pollIntervalMs` | 1500 | 首次 1s，连续 3 次 `status` / `updatedAt` 无变化退避到 3000 |
| `hardTimeoutMs` | 480000 | 任务总时长上限，触发后 `communication send --command abort` |
| `quietTimeoutMs` | 90000 | `session info` 的 `lastActiveAt` / `updatedAt` 静默 |
| `commandTimeoutMs` | 25000 | 单次 `mavis …` CLI 调用 |

### 5.2 错误分类

| 现象 | 分类 | 行为 |
| --- | --- | --- |
| `mavis status` 非 running | `not_ready` | emit `error: mavis daemon 未运行，请执行 mavis start`；不重试 |
| `session new` 退出码非 0 | `dispatch_failed` | 短句化 `stderr` 头 200 字 |
| `status.type === 'error'` | `remote_error` | `summarizeMavisFailureMessage(status.message)` → 180 字符截断 |
| `status.type === 'aborted'` | `aborted` | emit `error: 任务被中止` |
| quiet / hard timeout | `timeout` | 先 `--command abort`，再 emit error |
| `communication send` 入队失败 | `send_failed` | 退化为 `session new`（先 `session info` 探活） |
| `session diff` 解析失败 | `evidence_lost` | 降级为仅文本回包，log `文件变更证据读取失败` |
| `status.type === 'finished'` 但 messages 拉不到 | `partial_result` | 用 `session.title` + `effectiveModel` 拼兜底回复 |

### 5.3 续聊（解决 Q4）

每次 `streamChat` 第一步读 `mavis-session-bindings.json`：

```
binding = readBindings()[params.sessionId]
if binding and (Date.now() - new Date(binding.lastTurnAt)) < 24h:
    mavis communication send --to binding.mvsSessionId --command prompt --content <turnPrompt>
else if binding 但 mavis 端 session 已不存在（info 探活 404）:
    delete binding
    mavis session new <agent> --from root --prompt <turnPrompt> ...
    upsertBinding(new binding)
else (无 binding):
    mavis session new <agent> --from root --prompt <turnPrompt> ...
    upsertBinding(new binding)
```

`feishuChatId` / `feishuThreadId` / `channelType` 从 `store.listChannelBindings().find(b => b.codepilotSessionId === params.sessionId)` 复用现有 `BridgeStore`（参考 `main.ts:867-868`）。

### 5.4 能力 / 风险门控

- `permissionMode === 'acceptEdits'` 但 `mavisReadOnly === true` → 立即 emit `error: 只读 executor 拒绝写请求`。
- 命中 `local-llm-router.ts:64` 的 `HARD_EXCLUDE_PATTERNS`（`git push|publish|shutdown|删库|…`）且 `riskLevel === 'workspace_write'` → `highRiskRequiresPermission: true`，走 `PendingPermissions` 让用户确认（参考 `main.ts` 用法）。
- `workingDirectory` 必须在 `config.allowedWorkspaceRoots` 内（`buildToolSandboxPolicy` 已有逻辑）→ 校验后才传 `--workspace`。
- 文件变更证据**只能**从 `session diff` 取，**不**接受 assistant 文本里自由声明的"我已经改了 X"。

### 5.5 硬安全门控（v2 关键修复 — codex 第 5 点）

codex 强调"安全门控要比文档更硬"。本节把 §5.4 中提到的"校验后再传 --workspace"等条目落到**可执行**层。

#### 5.5.1 workingDirectory 强校验

`MavisExecutorProvider.run` 在调用 `client.createSession` **之前**强制走：

```ts
function assertWorkspaceAllowed(workingDirectory: string, allowedRoots: string[]): void {
  if (!workingDirectory) throw new MavisSafetyError('workspace_empty', '未提供 workingDirectory');
  const normalized = path.resolve(workingDirectory);
  const roots = allowedRoots.map(r => path.resolve(r));
  const ok = roots.some(root => {
    const a = normalized.toLowerCase();
    const b = root.toLowerCase();
    return a === b || a.startsWith(b + path.sep);
  });
  if (!ok) {
    throw new MavisSafetyError(
      'workspace_denied',
      `workingDirectory ${normalized} 不在 allowedWorkspaceRoots ${JSON.stringify(roots)} 内`,
    );
  }
}
```

调用链：
1. `MavisExecutorProvider` 构造时取 `buildToolSandboxPolicy(config).allowedWorkspaceRoots` 缓存。
2. `streamChat` 第一步 → `assertWorkspaceAllowed(params.workingDirectory, cached)`。
3. 失败 → emit `sseEvent('error', '工作目录不在允许范围内：' + relativePath)` + `close()`，**不**派发到 mavis。
4. 没有 `workingDirectory` 兜底用 `config.defaultWorkDir`；兜底也必须在校验通过后才用。

#### 5.5.2 diff 解析：只接受结构化 JSON

```ts
async function readDiffEvidence(client: MavisClient, sessionId: string, maxBytes: number): Promise<{ ok: boolean; diffs: MavisDiff[]; error?: string }> {
  const raw = await client.diff(sessionId);   // 内部已走 extractFirstCompleteJson
  if (!raw || !Array.isArray(raw.diffs)) {
    return { ok: false, diffs: [], error: 'diff_payload_not_array' };
  }
  const sanitized: MavisDiff[] = [];
  for (const d of raw.diffs.slice(0, 200)) {  // 限条数
    if (typeof d?.path !== 'string' || !d.path) continue;
    if (!['add', 'update', 'delete'].includes(d.kind)) continue;
    sanitized.push({
      path: d.path.slice(0, 1000),
      kind: d.kind,
      before: typeof d.before === 'string' ? d.before.slice(0, maxBytes) : undefined,
      after:  typeof d.after  === 'string' ? d.after.slice(0, maxBytes) : undefined,
    });
  }
  return { ok: true, diffs: sanitized };
}
```

**关键不变量**：
- **不**对 `diffs[]` 内容做正则 / `@@` / `+`/`-` 等 patch-text 回退解析 — codex 明确禁止。
- 解析失败 → `{ ok: false }` → Provider emit `sseEvent('status', { evidence: 'lost', reason: error })`，**不**当作 `tool_result` 发出。
- 单 diff 体积限 `maxBytes`（默认 32_000）；超长截断并在 SSE 末尾标 `truncated: true`。
- `path` 限 1000 字符；`kind` 白名单（`add|update|delete`）；其它字段不进入桥接事件。

#### 5.5.3 错误与 tool result 脱敏

新增 `summarizeMavisFailureMessage(message: string, maxLen = 180): string`（独立文件 `mavis-failure-summarizer.ts`）：

```ts
const FAILURE_PATTERNS: Array<{ pattern: RegExp; summary: string }> = [
  { pattern: /usage\s*limit|quota|429|rate\s*limit/i,         summary: '远端 API 额度或速率限制' },
  { pattern: /401|unauthorized|refresh\s*token|auth\s*token/i, summary: '远端登录已失效' },
  { pattern: /403|forbidden/i,                                summary: '远端拒绝访问（权限或资源不可用）' },
  { pattern: /econnrefused|connection\s*refused|fetch\s*failed/i, summary: '远端服务不可达' },
  { pattern: /timeout|etimedout|socket\s*hang\s*up/i,         summary: '远端调用超时' },
  { pattern: /404|not\s*found/i,                              summary: '远端资源不存在（session 可能已被 GC）' },
  { pattern: /500|502|503|504/i,                              summary: '远端服务内部错误' },
  { pattern: /invalid\s*request|bad\s*request/i,             summary: '请求参数不合法' },
  { pattern: /\bv1\/responses\b/i,                            summary: 'API 协议不兼容' },
];

export function summarizeMavisFailureMessage(raw: string | undefined, maxLen = 180): string {
  if (!raw || typeof raw !== 'string') return '远端返回未提供错误细节';
  for (const { pattern, summary } of FAILURE_PATTERNS) {
    if (pattern.test(raw)) return summary;
  }
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLen ? normalized : `${normalized.slice(0, maxLen - 3)}...`;
}
```

tool result 脱敏（仿 `codex-provider.ts:470-505` `summarizeToolBlocks`）：

```ts
const MAX_TOOL_RESULT_CHARS = 240;
const TOOL_RESULT_DROP_PATTERNS: RegExp[] = [
  /<skill_content[\s\S]*?<\/skill_content>/gi,
  /<!--[\s\S]*?-->/g,
  /<citation>[\s\S]*?<\/citation>/gi,
];

export function sanitizeToolResult(raw: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  if (typeof raw !== 'string') return '';
  let text = raw;
  for (const pattern of TOOL_RESULT_DROP_PATTERNS) text = text.replace(pattern, '[已脱敏]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}
```

#### 5.5.4 错误事件 schema

所有 `sseEvent('error', ...)` payload 形状：

```ts
type MavisSseError = {
  code:
    | 'not_ready'           // mavis daemon 未运行
    | 'dispatch_failed'     // session new 退出码非 0
    | 'remote_error'        // status.type === 'error'
    | 'aborted'             // status.type === 'aborted'
    | 'timeout'             // quiet / hard timeout
    | 'send_failed'         // communication send 入队失败
    | 'evidence_lost'       // diff 解析失败
    | 'partial_result'      // 终态 finished 但 messages 拉不到
    | 'workspace_denied'    // workingDirectory 不在 allowedWorkspaceRoots
    | 'read_only_violation' // mavisReadOnly 但 prompt 是写模式
    | 'json_parse'          // 客户端 stdout 解析失败
    | 'unknown';
  short: string;             // 用户可读短句（≤80 字符）
  // 不带 detail；详情进 bridge 审计日志
};
```

错误事件**不**带原始 `status.message`、**不**带 stdout、**不**带 diff 全文。

---

## 6. 测试计划

| 文件 | 改动 | 关键 case |
| --- | --- | --- |
| `__tests__/mavis-cli-client.test.ts`（新） | 真实 `mavis status` / `agent list` 跑一发；mock child_process 覆盖 timeout / 退出码 / 解析失败 | 解析、脱敏、错误分类 |
| `__tests__/mavis-session-store.test.ts`（新） | upsert / read / findByMvs / 并发写不损坏 `tmp+rename` | 持久化 |
| `__tests__/mavis-executor-provider.test.ts`（新） | 1) 新建路径；2) 续聊路径命中 binding；3) 终态 finished / error / aborted；4) quietTimeout；5) diffs 映射；6) readOnly 拒绝 acceptEdits | 状态机 |
| `__tests__/executor-registry.test.ts` | 补 1 条 `mavis-agent` 注册；1 条 `@mavis` hint；1 条 `mavisReadOnly=true` 时 riskLevel=read_only | 注册 |
| `__tests__/hub-llm-provider.test.ts`（新） | 选 `mavis-agent` 时由 `ExecutorProviderRegistry.resolveForRequest` 真分派到 `MavisExecutorProvider`（**不**是 v1 "替换 fallbackProvider"）；分派后 streamChat 路径走 §4.3.2.1 / §4.3.2.2 两阶段；落空（isExternal=false）时 message 流仍走原 `HubLlmProvider` 内部路由链 + `cti-final` 收口 | 路由 |

集成测试 fixture（**不**写死模型版本 / sessionId 格式）：

```ts
const client = createMavisClient({ cliPath: 'mavis', commandTimeoutMs: 25_000 });
const session = await client.createSession({ agent: 'mavis', from: 'root', prompt: '只回 pong' });
// 轮询直到 status.type === 'finished'（≤ 30s）
const info = await client.info(session.session.sessionId);
const msgs = await client.messages(session.session.sessionId, { limit: 5 });
assert.equal(msgs.messages.at(-1)?.msg_content, 'pong');
```

---

## 7. 改动清单

### 7.1 新增（v3.2 修订 — **共 14 个文件**：7 源代码/manifest + 7 测试）

1. `packages/bridge-runtime/src/mavis-cli-client.ts`
2. `packages/bridge-runtime/src/mavis-session-store.ts`
3. `packages/bridge-runtime/src/mavis-executor-provider.ts`
4. `packages/bridge-runtime/src/executor-provider-registry.ts`  ← **v3 新增**（codex 阻断点 ③：替换 v1 fallbackProvider 替换方案的真分派组件；v3.1 修订为只接 `ExecutorRequest`）
5. `packages/bridge-runtime/src/mavis-failure-summarizer.ts`  ← **v3 新增**（`summarizeMavisFailureMessage` / `sanitizeToolResult`）
6. `packages/bridge-runtime/src/mavis-session-title.ts`  ← **v3.1 新增**（`buildMavisSessionTitle`，从 `StreamChatParams` 派生 mavis session.title）
7. `config/runtime.d/executor.mavis-agent.json`  ← **仅供控制面板可观测**（codex 阻断点 ⑥：见 §4.4.1）
8. `packages/bridge-runtime/src/__tests__/mavis-cli-client.test.ts`
9. `packages/bridge-runtime/src/__tests__/mavis-session-store.test.ts`
10. `packages/bridge-runtime/src/__tests__/mavis-executor-provider.test.ts`
11. `packages/bridge-runtime/src/__tests__/mavis-failure-summarizer.test.ts`  ← **v3 新增**
12. `packages/bridge-runtime/src/__tests__/mavis-session-title.test.ts`  ← **v3.1 新增**（覆盖 6 个 case：纯 prompt / 短 prompt / 长 prompt / 仅空白 / 含 emoji / 全缺省）
13. `packages/bridge-runtime/src/__tests__/executor-provider-registry.test.ts`  ← **v3 新增**（v3.1 增「接收 `ExecutorRequest` 而非 `StreamChatParams`」；v3.2 增「`sessionDefaultId` 折进 `requestedExecutorId`」；**v3.3 必修**改「`sessionDefaultId` + `@hint` 同时存在时 **`@hint` 优先于 `sessionDefault`**」1 条 case）
14. `packages/bridge-runtime/src/__tests__/hub-llm-provider.test.ts`

### 7.2 修改（最小）

1. `packages/bridge-runtime/src/executor-registry.ts` — append manifest + 1 行 hint。
2. `packages/bridge-runtime/src/config.ts` — `Config` 末尾加 **11** 个可选字段（含 `mavisDefaultExecutor`），**且**同步改 `loadConfig()` / `saveConfig()` 双向映射（v3 阻断点 ⑤）；**v3.1 修订** env 主命名 `CTI_MAVIS_*` + 兼容 alias `MAVIS_*`（实施级问题 ③）。
3. `packages/bridge-runtime/src/main.ts` — **覆盖两个 selectExecutor 入口**（codex 阻断点 ③；v3.1 修订 caller 构造 `ExecutorRequest`）：
   - `main.ts:891`（`startObservedWorkflow` 里的 `selectExecutor`）→ 改为走 `executorRegistry.resolveForRequest(...)`，传入 caller 构造的完整 `ExecutorRequest`（**v3.2**：`sessionDefaultId` 已折进 `requestedExecutorId`；`preferredExecutorId` = `this.primaryExecutorId`；`taskKind` 已推断）
   - `main.ts:1780`（`pipeFallbackStream` 实际 stream 调用点）→ 改为走 `executorRegistry.resolveForRequest(...)`，isExternal 走 §4.3.2.1 / §4.3.2.2 的两阶段逻辑
   - `HubLlmProvider` 构造里**不再**写"替换 fallbackProvider"，改为注入 `ExecutorProviderRegistry` + `defaultCodexProvider`
4. `packages/bridge-runtime/src/__tests__/executor-registry.test.ts` — 补 3 条 case。

### 7.3 不改

- `suite.manifest.json`（**v2 维持** — `executorProtocol` 放 `configSchema.protocol`，不动 `requiredFields`；见 §4.4）
- `packages/contracts/**`
- `live skill` / `release/` / `apps/installer/`

### 7.4 架构文档同步（v2 关键修复 — codex 第 6 点）

codex 明确指出：v1 "不触发架构文档同步"是设计评审阶段的临时状态；**实现落地**属于"provider/executor 路由策略变化"，按 `AGENTS.md §5.1` **必须**跑：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\update-architecture-docs.ps1
```

并在合并前补齐以下文档：

| 文档 | 改动 |
| --- | --- |
| `docs/PROJECT-ARCHITECTURE.md` | 新增 §"外部 Agent Executor"：定义 mavis-agent 是首个 external agent executor；说明 `ExecutorProviderRegistry` 在 `selectExecutor` 之后真分派的边界（pre-dispatch 可回落 / post-dispatch 禁止回落）；说明 binding store 与 mavis sessionId 的关系；说明 opt-in 触发条件 |
| `docs/DEVELOPMENT-LOG.md` | 新增一条记录：v1.x 引入 `MavisExecutorProvider` + `ExecutorProviderRegistry`；标注本 PR 不改 suite.manifest.json、live skill、release；标注风险（详见 §8）和已知限制（24h 续聊窗口、abort 弱保证） |
| `README.md` | 在"运行版同步"或"扩展点"段落加 1 句：mavis-agent 是 opt-in executor，需在 `config.env` 设 `mavisEnabled=true` 启用 |
| `AGENTS.md` | **不**改（executor 命名规则已在 v1 中；本次只加新 manifest） |
| `extensions/skills/` | **不**改 |

实现完成后 git diff 应包含上述文档改动，缺一则 CI / 合并流程需拦截。

---

## 8. 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| daemon 端口漂移 | 中 | `--port` / `--data-dir` 显式；`probe()` 启动探活 |
| `session diff` 在某些 framework 下不是文件级 diff | 中 | 不强依赖；diff 仅作审计，无则只输出文本 + 显式标注 |
| 续聊时旧 mavis session 已被服务端 GC | 中 | binding 带 `lastTurnAt`；info 探活 404 → 重建 |
| Provider 把 `status.message` 全文外发 | 中 | `summarizeMavisFailureMessage` 统一 180 字符截断 + 短句化 |
| 并发改 `mavis-session-bindings.json` 损坏 | 低 | `tmp + rename`；OS 串行化 |
| `mavis-agent` 健康但 daemon 不可用 → 整轮空跑 | 中 | `enabled` 跟随 `probe()` 动态切换 |
| `mavis` 未来变更 JSON 字段名 | 中 | client 层白名单 + 解析失败退化为空 + 抛 `MavisClientError` |
| 用户配错 `mavisCliPath` | 低 | `probe()` 跑一发 `mavis status` 失败则 `enabled=false` |
| `feishuAppSecret` 等密钥被误写入 binding | 高 | binding 类型白名单化，**不**接受 secret 字段；写盘前 lint 一次 |
| Provider 与 `codex-provider.ts` SSE schema 分叉 | 中 | 复用 `sseEvent` 工具函数（`codex-provider.ts:22`）；状态名严格对齐 |

---

## 9. 开放问题与 codex 结论

### 9.1 codex 第一轮 → v2 落点

| # | 开放问题 | codex 第一轮结论 | v2 落点 |
| --- | --- | --- | --- |
| 1 | `HubLlmProvider` 替换 fallbackProvider 的位置 | **v1 位置不对**；v3 已彻底删除替换方案；走 `ExecutorProviderRegistry` 在 `selectExecutor` 之后立即分派；覆盖 `main.ts:891` 和 `main.ts:1780` 两个 selectExecutor 入口 | §4.3.2 |
| 2 | 续聊 vs 新建边界 | 24h 窗口可以，但要 `session info` 探活 + workspace 校验 | §4.3.3 + §5.5.1 |
| 3 | `diffs` shape 非空样本未拿到 | **不**做 regex/patch-text fallback；只接受结构化 JSON；解析失败 → `evidence_lost` | §5.5.2 |
| 4 | `executorProtocol` 是否进 `suite.manifest.json.requiredFields` | 不用进，放 `configSchema.protocol` 即可 | §4.4 |
| 5 | `config/runtime.d/` 是否要 schema 校验 | 本轮不引入 schema；与现有 4 个 `service.*.json` 一致 | （v2 维持） |
| 6 | `abort` 取消语义 | v1 按 best-effort，**不**作强保证；后续单独实测 | §5.2（best-effort 标注） |
| 7 | mavis-agent 与 codex 的 priority | mavis 默认 `priority=50`，低于 codex(80/100)；只有显式 hint 或 `mavisDefaultExecutor=true` 才自动选中 | §4.4 |
| 8 | `mavisReadOnly` 是否 v1 必选 | v1 就保留，默认由配置决定 | §4.4（capabilities 切换） |
| 9 | `--model` 是否续聊时强锁 | binding 里只记录实际模型作审计，**不**续聊强锁 | §4.2 + §4.3.3 |
| 10 | `partial_result` 走 `cti-final` 还是裸 `error` | 走 `cti-final` 风格的"未完成/部分完成"用户可见文本，比裸 `error` 更稳 | §5.2（partial_result 改 cti-final 风格） |

### 9.2 codex 第二轮 6 个阻断点 → v3 落点

| # | 阻断点 | v3 落点 |
| --- | --- | --- |
| 1 | `extractLastCompleteJson` 用 `Math.max(lastBrace, lastBracket)` 在 `[{...},{...}]\nNote` 上会切到数组内最后一个对象，越界丢根 | §4.1.1 删 `extractLastCompleteJson`；所有 subcommand 统一走 `extractFirstCompleteJson` + `sliceAndParse`（depth=0 闭合后 return，自然忽略尾部 Note） |
| 2 | 外部 executor 失败回落 Codex 边界太宽 — session 已创建 / prompt 已 send 后静默回落会导致 Mavis 和 Codex 重复写仓库 | §4.3.2 拆 pre-dispatch / post-dispatch 两阶段；pre-dispatch 失败可回落，post-dispatch 失败**禁止**回落（只 emit `error` / `partial_result`）；判据 = `binding.mvsSessionId` 非空且 `lastDispatchAt` 已写入 |
| 3 | 文档残留 v1 "HubLlmProvider 构造期替换 fallbackProvider" 描述 | §3 / §4.3.2 / §7.2 / §11 全部改为"注入 `ExecutorProviderRegistry` + `defaultCodexProvider`"；删除所有"构造期替换"字样；新增 `executor-provider-registry.ts` 到新增文件清单；§7.2 明确覆盖 `main.ts:891` 和 `main.ts:1780` 两个 selectExecutor 入口 |
| 4 | 续聊过滤用 `lastUserMessageTimestamp` 不够稳 — 本轮无新 user message 时会漏上一轮最后一条 assistant | §4.3.3 主用 `lastSeenMessageId`（拉最新页 → 升序 → 切到 lastSeen 之后）；`timestamp` 仅作 fallback；明确 `--before` 是翻旧页不是 after cursor；新增 `cursorFallback: true` 状态事件 |
| 5 | 配置清单 v2 写了 9 个字段，缺 `mavisDefaultExecutor`；实现时只改 `Config` 漏改 `loadConfig` / `saveConfig` → `config.env` 改了不生效 | §4.4 把字段数改成 10（含 `mavisDefaultExecutor`）；§7.2 列出**三处必改**位置（`Config` / `loadConfig` / `saveConfig`）+ env 名映射 + 单元测试要求 |
| 6 | `config/runtime.d/` 不等于 executor registry 来源；当前写得像 runtime.d 是路由入口 | §4.4.1 明确拆两份职责：`config/runtime.d/executor.mavis-agent.json` = 控制面板可观测；`executor-registry.ts:buildExecutorManifests(config)` = 真实路由；`config/runtime.d/*.json` 写不写都不影响 selectExecutor |

### 9.3 codex 第三轮 5 个实施级问题 → v3.1 落点

| # | 实施级问题 | v3.1 落点 |
| --- | --- | --- |
| 1 | `ExecutorProviderRegistry.resolveForRequest` 把 `StreamChatParams` 直接传给 `selectExecutor`，但 `selectExecutor` 需要完整 `ExecutorRequest`（含 `sessionId/prompt/workingDirectory/permissionMode/params/preferredExecutorId/taskKind`） | §4.3.2 registry 接口签名改为 `resolveForRequest(config, request: ExecutorRequest, defaultProvider)`；registry **不**内部拼 `ExecutorRequest`；caller（`HubLlmProvider.streamChat`）构造完整 `ExecutorRequest`；**v3.2 修订**：`sessionDefaultId` 折进 `requestedExecutorId`（registry **不**接第 4 参 `sessionDefaultId`） |
| 2 | preDispatch 续聊路径只 `client.info()` 探活，没有 `client.communicationSend({to, command:'prompt', content})` 派发本轮 prompt | §4.3.2.1 续聊路径补全：探活 → `client.communicationSend({ to: binding.mvsSessionId, command: 'prompt', content: buildTurnPrompt(params) })` → upsertBinding 更新 `lastDispatchAt` / `lastTurnAt`；send 失败抛 `send_failed`（让 pre-dispatch 错误路径回落 Codex）；**v3.2 修订**：`from` 字段**省略**（让 mavis CLI 用默认 `$__MAVIS_PARENT_SESSION_ID` env），**不**传 `params.sessionId`（bridge sessionId 不是 Mavis sessionId） |
| 3 | 配置字段实际 11 个不是 10 个；env 主命名必须按项目约定 `CTI_*`（仓库现有 `config.env` 用 `CTI_DEFAULT_WORKDIR` / `CTI_CODEX_*` 等），裸 `MAVIS_*` 只能作为兼容 alias | §4.4 字段数 10 → **11**；§4.4 列出 11 条 `CTI_MAVIS_*` 主命名 + 11 条 `MAVIS_*` 兼容 alias；§7.2 单元测试要求 3 条：主命名解析、alias 兜底、saveConfig 只写主命名不写 alias |
| 4 | `StreamChatParams` 没有 `title` 字段，`createSession.title` 不能用 `params.title` | §4.3.2.0 新增独立函数 `buildMavisSessionTitle(params)`，从 `params.prompt`（摘要 ≤30 字符）/ `params.sourceMessageId` / `params.sessionId` 末段派生短标题（≤64 字符）；新建路径用 `buildMavisSessionTitle(params)` 取代 `params.title`；续聊路径**不**调；新增 `mavis-session-title.ts` + 单测 6 case |
| 5 | 文档清理：TL;DR 旧数量 "3 个新文件 + 3 个测试" + hub-llm-provider.test "fallback 切换" 旧措辞 | §0 TL;DR 改为"**14 个新文件（7 源代码/manifest + 7 测试）** + 4 个老文件小改"（v3.1 当时误数 13，v3.2 修正为 14）；§6 hub-llm-provider.test 改为"由 `ExecutorProviderRegistry.resolveForRequest` 真分派到 `MavisExecutorProvider`（**不**是 v1 替换 fallbackProvider）" |

---

---

## 10. 评审 checklist（请 codex 给结论）

### 10.1 v1 原始项

- [ ] 协议基线（§2）是否与 codex 已知的 mavis 一致？有缺字段 / 多字段请指出。
- [ ] 接入点（§3）选的文件是否合理？是否漏掉某个关键 hook？
- [ ] 客户端层（§4.1）抽象粒度是否合适？还是应该更细（按 subcommand 分接口）？
- [ ] binding store（§4.2）字段是否够？是否需要记录 `effectiveModelVariant`？
- [ ] Provider 状态机（§4.3）分支是否覆盖了所有已知失败模式？
- [ ] Manifest 字段（§4.4）是否需要进 `suite.manifest.json.runtimeProtocol.requiredFields`？
- [ ] Polling / Timeout（§5.1）默认值是否合理？尤其 `hardTimeoutMs = 480s` 在长任务（截图、模型训练）场景是否够。
- [ ] 错误分类（§5.2）是否漏掉关键 case？
- [ ] 续聊策略（§5.3）的 24h 滑动窗口是否合理？
- [ ] 能力 / 风险门控（§5.4）是否与现有 `executor-registry` 的 `HIGH_RISK` 列表对齐？
- [ ] 测试计划（§6）是否覆盖关键路径？fixture 写得是否过严？
- [ ] 改动清单（§7）是否最小？是否有更短的实现路径？
- [ ] 风险（§8）是否漏了关键项？尤其 token 泄露、daemon 越权这两个红线是否已堵死。
- [ ] 整体：approve / approve with fix / reject。

### 10.2 v2 关键修复确认点（codex 第一轮 6 条）

- [ ] **JSON 解析**（§4.1.1）：`extractFirstCompleteJson` 配合 `sliceAndParse` 是否覆盖所有 subcommand 边界（包括 `[{...},{...}]\nNote`）？**v3 已删除 `extractLastCompleteJson`**，是否同意此收敛？
- [ ] **Executor 真分派**（§4.3.2）：`ExecutorProviderRegistry` 注入 `HubLlmProvider` 后的 `isExternal` 路径是否还会进入 `decideConservativeRoute` / `ManifestSlimCodexProvider` 等任何本地路由组件？`main.ts:891` 和 `main.ts:1780` 两个 selectExecutor 入口是否都被 `resolveForRequest` 统一接管？
- [ ] **续聊游标**（§4.2 / §4.3.3）：3 个游标字段是否够？v3 主用 `lastSeenMessageId` + `timestamp` 兜底 + `--before` 仅翻旧页，是否符合预期？
- [ ] **opt-in**（§4.4）：`mavisEnabled=false` 默认 + `priority=50` + 显式 hint / `mavisDefaultExecutor=true` 三道闸门是否够？
- [ ] **硬安全门控**（§5.5）：`assertWorkspaceAllowed` / `readDiffEvidence` / `sanitizeToolResult` / `summarizeMavisFailureMessage` 是否堵死了 token 泄露 / daemon 越权 / 自由文本声明 diff 这三条红线？
- [ ] **架构文档同步**（§7.4）：`docs/PROJECT-ARCHITECTURE.md` / `docs/DEVELOPMENT-LOG.md` / `README.md` 三份文档改动点是否覆盖完整？AGENTS.md 规则触发是否到位？

### 10.3 v3 阻断点确认（codex 第二轮 6 条 — **必须全部 ✅ 才能进入实现**）

- [ ] **JSON 提取器**（§4.1.1，codex 阻断点 ①）：`extractLastCompleteJson` 已删除；`extractFirstCompleteJson` + `sliceAndParse`（depth=0 闭合后 return）能否保证 `[{...},{...}]\nNote` 这种结构解析为完整 array？**v3 单元测试**必须包含「array 根 + 尾注」「object 根 + 前缀说明」「嵌套对象内部 `{` 不影响 depth」三个 case。
- [ ] **回落边界**（§4.3.2，codex 阻断点 ②）：pre-dispatch / post-dispatch 两阶段判据（`binding.mvsSessionId` 非空 + `lastDispatchAt` 已写入）是否清晰？post-dispatch 失败时只 emit `error` / `partial_result`、不调 `pipeCodexPrimaryWithFallback`，是否同意？
- [ ] **v1 fallbackProvider 替换残留**（codex 阻断点 ③）：`§3` / `§4.3.2` / `§7.2` / `§11` 是否全部统一为"注入 `ExecutorProviderRegistry` + `defaultCodexProvider`"？`HubLlmProvider` 是否还有任何"构造期替换"字样？`executor-provider-registry.ts` 是否进 §7.1 新增文件清单？`main.ts:891` 和 `main.ts:1780` 是否都明确被覆盖？
- [ ] **续聊过滤**（§4.3.3，codex 阻断点 ④）：`lastSeenMessageId` 主用 + `timestamp` 兜底 + `--before` 仅翻旧页，三者职责是否清晰？`cursorFallback: true` 状态事件是否覆盖了"消息流被服务端截断"这种边缘 case？
- [ ] **配置清单**（§4.4 / §7.2，codex 阻断点 ⑤）：**11** 个字段是否齐全（含 `mavisDefaultExecutor`）？`Config` + `loadConfig()` + `saveConfig()` 三处是否都被 §7.2 标注为必改？**v3.1 修订**：env 主命名 `CTI_MAVIS_*`（11 条），兼容 alias `MAVIS_*`（11 条）；`saveConfig` 只写主命名不写 alias。**单元测试**必须覆盖：主命名解析 / alias 兜底 / saveConfig 单写主命名 — 3 条 case。
- [ ] **runtime.d vs registry 来源**（§4.4.1，codex 阻断点 ⑥）：`config/runtime.d/executor.mavis-agent.json` 是否明确写为"控制面板可观测，不参与 selectExecutor"？真实路由来源 `executor-registry.ts:buildExecutorManifests(config)` 是否在 §4.4 顶部和 §1 边界里都明确强调？

### 10.4 v3.1 实施级问题确认（codex 第三轮 5 条 — **必须全部 ✅ 才能进入实现**）

- [ ] **ExecutorRequest 形状**（§4.3.2，codex 实施级问题 ① / v3.2 实施级问题 ④ / v3.3 P1 必修）：`ExecutorProviderRegistry.resolveForRequest` 是否改为只接受 `ExecutorRequest`、**不**内部从 `StreamChatParams` 拼？caller（`HubLlmProvider.streamChat`）是否构造完整 `ExecutorRequest`？**v3.2**：registry 是否**不**接第 4 参 `sessionDefaultId`？caller 是否把 `sessionDefaultId` 折进 `requestedExecutorId`（`hintedExecutorId ?? sessionDefaultId ?? undefined`，**v3.3 必修**：`@hint` 优先）？`ExecutorRequest` 是否仍然只含 `requestedExecutorId` / `preferredExecutorId` / `taskKind` 3 个可选字段（**不**含 `sessionDefaultId`）？`executor-provider-registry.test.ts` 是否覆盖「接收 `ExecutorRequest` 而非 `StreamChatParams`」「`sessionDefaultId` 折进 `requestedExecutorId`」「`@hint` 优先于 `sessionDefault`」（v3.3 改）3 条 case？
- [ ] **续聊发本轮 prompt**（§4.3.2.1，codex 实施级问题 ② / v3.2 实施级问题 ③）：命中已有 binding 的续聊路径是否在 `client.info()` 探活之后**必**调 `client.communicationSend({ to: binding.mvsSessionId, command: 'prompt', content: buildTurnPrompt(params) })`（**v3.2**：`from` 字段**省略**，让 mavis CLI 用默认 `$__MAVIS_PARENT_SESSION_ID`，**不**传 `params.sessionId`）？send 失败是否抛 `send_failed` 让 pre-dispatch 错误路径回落 Codex？`mavis-executor-provider.test.ts` 是否覆盖「续聊路径 = 探活 + send + upsertBinding」3 步全流程？
- [ ] **字段数 11 + env `CTI_MAVIS_*`**（§4.4 / §7.2，codex 实施级问题 ③）：字段数是否标 11（含 `mavisDefaultExecutor`）？env 主命名是否 `CTI_MAVIS_*`（11 条）？裸 `MAVIS_*` 是否只作 alias（load 时兜底 + warn 一次；save 时**不**写）？单元测试是否覆盖 3 条（主命名解析 / alias 兜底 / saveConfig 单写主命名）？
- [ ] **`buildMavisSessionTitle` 派生**（§4.3.2.0，codex 实施级问题 ④）：`createSession.title` 是否**只**用 `buildMavisSessionTitle(params)` 派生、**不**用 `params.title`（`StreamChatParams` 无此字段）？`mavis-session-title.test.ts` 是否覆盖 6 case（纯 prompt / 短 prompt / 长 prompt / 仅空白 / 含 emoji / 全缺省）？`mavis-executor-provider.test.ts` 是否断言「新建路径调 `buildMavisSessionTitle`，续聊路径不调」？
- [ ] **TL;DR 旧数量 + 旧措辞**（§0 / §6，codex 实施级问题 ⑤ / v3.2 实施级问题 ⑤）：TL;DR 是否已更新为"**14 个新文件（7 源代码/manifest + 7 测试）** + 4 个老文件小改"（v3.1 误数 13，v3.2 修正为 14）？`__tests__/hub-llm-provider.test.ts` 行是否改为"由 `ExecutorProviderRegistry.resolveForRequest` 真分派"、**不**再有"fallback 切换"旧措辞？

### 10.5 v3.2 实现前小修确认（codex 第四轮 5 条 — **必须全部 ✅ 才能进入实现**）

- [ ] **line 528 旧调用已删**（codex 实施级问题 ①）：`HubLlmProvider.streamChat` 内是否**不再**有 `resolveForRequest(this.config, params, this.defaultCodexProvider)` 这种 `params` 直接传的形式？`streamChat` 内部是否**先**构造完整 `ExecutorRequest`（含 `requestedExecutorId` / `preferredExecutorId` / `taskKind` / `prompt` / `workingDirectory` / `permissionMode` / `sessionId` / `params`）再传？
- [ ] **import 来源**（codex 实施级问题 ②）：`executor-provider-registry.ts` 是否**只**从 `./executor-registry.js` 导入 `selectExecutor`（函数）、从 `./executor-types.js` 导入 `ExecutorRequest` / `ExecutorSelection`（类型）？是否**没有**把 `ExecutorRequest` 从 `./executor-registry.js` 导入？
- [ ] **`communicationSend.from` 已省略**（codex 实施级问题 ③）：`MavisExecutorProvider.preDispatch` 续聊路径的 `client.communicationSend(...)` 调用是否**不**传 `from: params.sessionId`（bridge sessionId 不是 Mavis sessionId）？是否**省略** `from` 让 mavis CLI 默认 `$__MAVIS_PARENT_SESSION_ID` 接管？`MavisClient.communicationSend` 类型的 docstring 是否明确写"`from` 强烈建议省略，不要传 bridge sessionId"？
- [ ] **`sessionDefaultId` 折进 `requestedExecutorId`**（codex 实施级问题 ④ / **v3.3 P1 必修**）：`ExecutorRequest` 是否**不**含 `sessionDefaultId` 字段（只含 `requestedExecutorId` / `preferredExecutorId` / `taskKind` 3 个可选字段）？`ExecutorProviderRegistry.resolveForRequest` 签名是否**不**接第 4 参 `sessionDefaultId`？caller 是否把 `sessionDefaultId` 折进 `requestedExecutorId`（**v3.3**：`hintedExecutorId ?? sessionDefaultId ?? undefined`——`@hint` 优先，不是 `sessionDefaultId ?? hintedExecutorId`）？`executor-provider-registry.test.ts` 是否覆盖「`sessionDefaultId` 折进 `requestedExecutorId`」「**`@hint` 优先于 `sessionDefault`**」（v3.3 改）2 条 case？
- [ ] **新增文件数 14**（codex 实施级问题 ⑤）：§7.1 是否实际列 **14** 个文件（7 源代码/manifest + 7 测试）？TL;DR / §11 / §10.4 文字描述是否统一为"**14** 个新文件"（不再是 13 或 6+6）？

---

### 10.6 v3.3 P1 必修确认（codex 第五轮 1 条 — **必须 ✅ 才能进入实现**）

- [ ] **`@hint` 优先于 `sessionDefault`**（§4.3.2，codex 第五轮 P1 必修）：caller（`HubLlmProvider.streamChat`）构造 `requestedExecutorId` 时是否**改为** `hintedExecutorId ?? sessionDefaultId ?? undefined`（**不**是 v3.2 的 `sessionDefaultId ?? hintedExecutorId ?? undefined`）？`executor-provider-registry.test.ts` 测试 case 是否改为「`@hint` 优先于 `sessionDefault`」？

### 10.7 v3.4 残留 P2 必修确认（codex 第六轮 1 条 — **必须 ✅ 才能进入实现**）

- [ ] **§4.3.2 main.ts 实施片段优先级已修正**（codex 第六轮 P2）：`HubLlmProvider.streamChat` 内的完整实现片段（line ~553 起的 `streamChat(params)` 代码块）是否**改为** `hintedExecutorId ?? sessionDefaultId ?? undefined`（**不**再是 v3.3 残留的 `sessionDefaultId ?? inferRequestedExecutorId(params.prompt)`）？§4.3.2 不变量段是否**已**写"caller 内部用 `hintedExecutorId ?? sessionDefaultId` 顺序"（v3.4 修订）？§7.1 row 13 `executor-provider-registry.test.ts` 描述是否**已**写"sessionDefaultId + @hint 同时存在时 **`@hint` 优先于 `sessionDefault`**"（v3.4 修订，v3.3 残留说反了）？

---

## 11. v3.4 改动清单（与 v3.3 的 diff）

| 区域 | v3.3 → v3.4 |
| --- | --- |
| §4.3.2 main.ts 实施片段（line ~553） | `streamChat(params)` 内的 `requestedExecutorId = sessionDefaultId ?? inferRequestedExecutorId(params.prompt) ?? undefined` **改**为 `hintedExecutorId ?? sessionDefaultId ?? undefined`（**v3.4 残留 P2 必修** — codex 第六轮指出 v3.3 修了一处但 §4.3.2 第二个代码片段（main.ts 实施示例）仍残留旧优先级） |
| §4.3.2 不变量 | （v3.3 已修） |
| §7.1 row 13 测试描述 | "sessionDefaultId + @hint 同时存在时 sessionDefault 优先" **改**为 "sessionDefaultId + @hint 同时存在时 **`@hint` 优先于 `sessionDefault`**"（**v3.4 残留 P2 必修** — v3.3 修了 §11 diff 文字但忘了改 §7.1 row 13 的描述） |
| §10 checklist | 增 §10.7 v3.4 残留 P2 必修确认（codex 第六轮 1 条；**必须 ✅ 才能进入实现**） |
| §11 | 本节（v3.4 改动日志） |

---

## 12. v3.3 改动清单（与 v3.2 的 diff）— 历史快照

> v3.4 只动 2 处残留，下表保留 v3.3 改动作为历史快照。**生效**以 §11 v3.4 为准。

---

## 12. v3.2 改动清单（与 v3.1 的 diff）— 历史快照

> v3.3 仅调整 v3.2 一行的优先级，下表保留 v3.2 改动作为历史快照。**生效**以 §11 v3.3 为准。

| 区域 | v3.1 → v3.2 |
| --- | --- |
| §4.3.2 registry import | 类型 `ExecutorRequest` / `ExecutorSelection` 从 `./executor-types.js` 导入（**不**再从 `./executor-registry.js` 导入类型）；函数 `selectExecutor` 仍从 `./executor-registry.js` 导入 |
| §4.3.2 registry 签名 | 删 "保留 `sessionDefaultId`（从 readSessionExecutorDefaults 读）" 注释；registry **不**接第 4 参 `sessionDefaultId` |
| §4.3.2 line 528 旧调用 | `HubLlmProvider.streamChat` 内 `resolveForRequest(this.config, params, ...)` 旧调用**已删**；改为先构造 `executorRequest` 再传 `executorRequest`（v3.2 实施级问题 ①） |
| §4.3.2.1 communicationSend | `from: params.sessionId` **已删**；`from` 字段**省略**，让 mavis CLI 用默认 `$__MAVIS_PARENT_SESSION_ID` env（v3.2 实施级问题 ③） |
| §4.1 MavisClient 类型 | `communicationSend` 类型 docstring 明确"`from` 强烈建议省略，不要传 bridge sessionId" |
| §7.1 新增 | 实际列 **14** 个文件（7 源代码/manifest + 7 测试）；v3.1 误数 13，v3.2 修正为 14 |
| §7.1 row 13 | `executor-provider-registry.test.ts` 增 v3.2 case「`sessionDefaultId` 折进 `requestedExecutorId`」「`sessionDefault` 优先于 `@hint`」 |
| §7.2 row 3 | `main.ts:891` 描述去掉 `sessionDefaultId`，改为"已折进 `requestedExecutorId`" |
| §9.3 row 1/2 | row 1 加"v3.2 修订：`sessionDefaultId` 折进 `requestedExecutorId`"；row 2 重写"`from` 字段**省略**（让 mavis CLI 用默认 `$__MAVIS_PARENT_SESSION_ID` env），**不**传 `params.sessionId`" |
| §10 checklist | 增 §10.5 v3.2 实现前小修确认（codex 第四轮 5 条；**必须全部 ✅ 才能进入实现**） |
| §11 | 本节（v3.2 改动日志） |

---

> 本文档只描述设计意图，不写最终代码。**v3.4 通过后**再进入实现，按 §7 的最小清单实施；实施时按 §7.4 同步 4 份文档（`PROJECT-ARCHITECTURE` / `DEVELOPMENT-LOG` / `README` + 跑 `scripts/update-architecture-docs.ps1`），并按 §5.5 走硬安全门控。v3.4 的 2 个 P2 残留必修对应到 §10.7，codex 第七轮评审时这是必查清单（如果还有的话；按 codex 第六轮"这两处补完即可进入实现"判断，v3.4 之后直接进入实现）。
