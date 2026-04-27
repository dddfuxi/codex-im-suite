# codex-im-suite 项目架构

更新时间：2026-04-27

## 0. 架构文档维护规则

- 本文是 suite 当前架构的唯一主文档，后续不要再新增平行的架构说明文档。
- 项目内已安装 `project-architecture-diagram` skill，架构变更时优先使用该 skill 更新本文。
- 修改模块边界、运行链路、provider 路由、MCP manifest、Feishu 收发、记忆索引、打包发布链路时，必须检查本文是否需要同步。
- 检查入口：`scripts/update-architecture-docs.ps1`。
- 变更过程和阶段性风险记录到 `docs/DEVELOPMENT-LOG.md`，不要塞进本文。

## 1. 总体定位

`codex-im-suite` 是一个 Windows 优先的本地 AI 协作套件，核心目标是把飞书聊天入口、Codex 执行、MCP 工具、Unity/Blender 工作流、本地记忆和打包发布统一到一个可迁移的项目目录里。

当前不是单体应用，而是一个发行层加多个内部模块：

- `bridge-core` 负责 IM 桥接核心能力。
- `bridge-runtime` 负责把核心库、本地配置、Codex、本地模型和脚本组装成可运行服务。
- `apps/control-panel` 负责可视化运维。
- `config/*.d` 负责 manifest 驱动的扩展发现。
- `scripts` 负责构建、同步、打包、发布。

### 1.1 系统上下文图

```mermaid
flowchart TD
  FeishuUser[飞书用户] --> FeishuBot[飞书机器人]
  FeishuBot --> BridgeCore[bridge-core 消息桥接]
  BridgeCore --> BridgeRuntime[bridge-runtime 运行时]
  BridgeRuntime --> CodexBrain[Codex 主脑]
  BridgeRuntime --> LocalHelper[本地辅助模型和执行器]
  BridgeRuntime --> McpBridge[MCP Bridge]
  McpBridge --> UnityMcp[Unity MCP]
  McpBridge --> BlenderMcp[Blender MCP]
  McpBridge --> PictureMcp[Picture MCP]
  McpBridge --> IgnisMcp[Ignis MCP]
  IgnisMcp --> IgnisCloud[Ignis 创意生成服务]
  IgnisCloud --> AssetPipeline[GLB 资产后处理]
  AssetPipeline --> BlenderCli[Blender Python 导出 FBX 和贴图]
  BridgeCore --> LocalHistory[(本地历史和记忆索引)]
  ControlPanel[控制面板] --> BridgeRuntime
  ControlPanel --> McpBridge
  Scripts[构建和发布脚本] --> Release[(Portable 和 Installer)]
  Scripts --> LiveSkill[本机 live skill 运行副本]
```

### 1.2 模块边界图

```mermaid
flowchart TD
  Panel[apps/control-panel] --> Runtime[packages/bridge-runtime]
  Runtime --> Core[packages/bridge-core]
  Runtime --> ProviderLayer[Codex 和本地模型 Provider]
  Runtime --> McpLayer[MCP manifest 和调用层]
  McpLayer --> IgnisPackage[packages/mcp-ignis]
  Core --> FeishuAdapter[Feishu Adapter]
  Core --> PermissionBroker[权限和高危操作门禁]
  Core --> ReplyEnvelope[cti-final 结果块收口]
  Config[config/*.d] --> Runtime
  Extensions[extensions/skills] --> Scripts[scripts/install-suite-skills.ps1]
  Scripts --> CodexSkills[本机 Codex skills 和 live skill]
```

## 2. 运行链路

### 2.1 Feishu 入站

Feishu 接收现在是双通道：

- WS 长连是主链路。
- p2p 私聊有历史轮询补捞兜底，避免私聊事件偶发漏掉。

收到消息后进入 `bridge-core` 的消息处理主线：

1. 记录运行审计。
2. 去重。
3. 先在 `bridge-manager` 处理无需模型参与的确定性入口，例如权限数字快捷回复、飞书文档列表和 owner 二次确认系统动作。
4. 绑定 chat/session。
5. 构造上下文。
6. 调用运行时 provider。
7. 解析最终结果块。
8. 通过 Feishu 原生 reply/card/image 等方式回复。

```mermaid
sequenceDiagram
  participant User as 飞书用户
  participant Feishu as Feishu WS/History
  participant Core as bridge-core
  participant Runtime as bridge-runtime
  participant Provider as Codex 或本地辅助
  participant Sender as Feishu 发送器

  User->>Feishu: 发送群聊或私聊消息
  Feishu->>Core: WS 事件或 p2p 轮询补捞
  Core->>Core: 去重、审计、直接命令门禁
  Core->>Runtime: 构造上下文并请求执行
  Runtime->>Provider: 按策略选择执行层
  Provider-->>Runtime: 返回 cti-final 或可见结果
  Runtime-->>Core: 返回最终候选回复
  Core->>Core: 解析结果块和附件声明
  Core->>Sender: 发送 card、reply、图片或文件
  Sender-->>User: 飞书可见回复
```

- `关机 / shutdown` 这类系统级动作不再交给模型自由发挥，而是在 `bridge-manager` 里走固定链路：
  - 仅 `Owner` 角色可发起，适用于所有 IM 渠道。
  - 第一步只记录审计并返回确认提示。
  - 第二步要求用户明确回复 `确认关机`。
  - 确认后桥接先发送执行提示，再直接调用 Windows `shutdown /s /t 0`。
  - 这条链路不经过 Codex、本地模型或本地辅助执行器。

### 2.2 权限门禁

截至 2026-04-27，桥接权限从 Feishu 单 owner 列表升级为三档角色模型：

- `Viewer`：允许普通聊天入口，对应各渠道 allowed users。
- `Operator`：允许中风险运维，例如批准普通工具权限、重启 bridge、启停 MCP 或本地模型。
- `Owner`：允许高危动作，例如关机、发布、越权路径、权限管理和系统级命令。

权限主数据存储在：

- `C:\Users\admin\.claude-to-im\data\permissions.json`

兼容规则：

- JSON 权限库是主数据。
- 启动和面板刷新时会从 `CTI_*_ALLOWED_USERS` 导入 `Viewer`，从 `CTI_*_OWNER_USERS` 导入 `Owner`。
- 保存权限后同步写回兼容 env，避免旧配置和脚本失效。
- 没有权限 JSON 且 Feishu 只有一个 allowed user 时，仍保留旧逻辑临时视为 owner。

```mermaid
flowchart TD
  Message[IM 入站消息] --> Subject[channelType + userId]
  Subject --> JsonPerm[permissions.json]
  Subject --> EnvCompat[CTI allowed/owner env]
  JsonPerm --> Role[Viewer / Operator / Owner]
  EnvCompat --> Role
  Role --> ViewerGate[普通聊天]
  Role --> OperatorGate[工具批准 / MCP / bridge 运维]
  Role --> OwnerGate[关机 / 发布 / 越权路径 / 权限管理]
```

### 2.3 Provider 选择

截至 2026-04-25，运行时新增第一阶段 workflow / executor 内核。旧 provider 仍负责真实流式执行，但请求进入 provider 前会被标准化为可观察的 workflow run，并通过 executor registry 记录路由选择。当前阶段目标是先打通“入站请求 -> 执行器选择 -> 执行中 -> 成功/失败”的稳定观测闭环，后续再把真实执行实现逐步迁移到 executor adapter。

Workflow 状态：

- `received`
- `authorized`
- `contextualized`
- `routed`
- `executing`
- `finalizing`
- `delivered`
- `failed`

运行时状态文件：

- `C:\Users\admin\.claude-to-im\runtime\workflow-runs.json`
- `C:\Users\admin\.claude-to-im\runtime\executor-status.json`
- `C:\Users\admin\.claude-to-im\runtime\executor-session-defaults.json`

Executor 目录当前内置三类：

- `codex`：默认主脑 CLI / SDK 执行器，能力包含对话、代码、仓库查询、文件读写、图片输入和 artifact delivery。
- `claude-cli`：可切换 CLI 后端，能力包含对话、代码、仓库查询、文件读写和图片输入。
- `local-tool-agent`：受控本地模型 agent，声明本地工具能力和 sandbox 策略，只允许白名单内的低风险或授权后操作。

路由规则：

- `@codex`、`@claude`、`@local`、`@本地` 显式覆盖当前会话路由。
- 控制面板可按 session 写入默认 executor。
- 没有显式覆盖时，按 capability、executor priority 和当前真实 provider 偏好做自动选择。
- 本地 agent 的工具边界由 `ToolSandboxPolicy` 声明，当前允许只读 git、文件读取、文本搜索、受限单文件写入和 MCP 运维入口；高风险动作必须进入权限策略。

```mermaid
flowchart TD
  Inbound[Feishu 入站请求] --> CoreAdapter[bridge-core 适配和上下文]
  CoreAdapter --> Workflow[bridge-runtime workflow run]
  Workflow --> Registry[ExecutorRegistry]
  Registry --> Router[ExecutorRouter capability + 显式覆盖 + 会话偏好]
  Router --> CodexExecutor[codex executor]
  Router --> ClaudeExecutor[claude-cli executor]
  Router --> LocalAgentExecutor[local-tool-agent executor]
  LocalAgentExecutor --> Sandbox[ToolSandboxPolicy]
  Sandbox --> LocalTools[只读 git / 文件 / 搜索 / MCP 运维]
  CodexExecutor --> Provider[现有 provider 执行层]
  ClaudeExecutor --> Provider
  LocalAgentExecutor --> Provider
  Provider --> FinalResponse[cti-final / 可见结果]
  FinalResponse --> WorkflowDone[workflow delivered 或 failed]
```

当前默认策略是 `Codex 主脑 + 本地辅助执行器`：

- `hybrid` 模式：默认先由 Codex 判断和执行；只有显式小活才允许本地直接接管，仓库查询和文件检索默认也先交给 Codex。
- `local_only` 模式：只用本地能力，不能完成的任务明确拒绝。
- `codex_only` 模式：禁用本地辅助，全部走 Codex。

本地辅助范围：

- 简单 shell / PowerShell 命令草案。
- Codex 不可用时的只读仓库查询兜底，例如 `git status`、`git branch --show-current`、`git log --oneline -n 10`。
- Codex 不可用时的文件读取、文本搜索和受控单文件写入兜底。
- MCP 运维小活：状态、启动、停止、工具列表、显式 HTTP tool call。
- Ignis 创意生成快路径：原画、生成图、视频、模型、canvas、file_id、turn_id 的提交和查询。
- 本地快路径在进入 Ignis、MCP、本地执行器前，统一先做“询问 / 操作”判定；歧义默认按询问处理，只允许只读查询，不直接触发生成、启动、停止、写入或 `git pull`。
- 所有 fast-path handler 在触碰 MCP manifest、启动服务、调用工具或执行本地计划前，都必须重新做 intent preflight；旧 MCP 快路径入口也委托到同一套判断，避免绕过新版规则。
- Ignis 的“最近几次 / 历史 / 整理成列表”优先走历史列表意图，不再因为出现 “Ignis + 检查” 就误落到状态检查。
- Ignis 状态、安装、配置、工具列表类问题不进入生成接口；只有明确创意生成意图才提交任务。
- MCP 快路径只在明确动词下才执行启动、停止、重启和显式 tool call；只说“看看 MCP”时默认返回状态/帮助，不自动操作任何 MCP。
- Unity/Blender 场景、节点、Prefab、模型、截图、导入导出这类实际工作即使写了 `unitymcp` / `blendermcp`，也不允许被本地 MCP 状态快路径抢答，必须回到 Codex 主脑做正式工具编排。
- 本地执行器把 `git status`、`git branch --show-current`、`git log --oneline -n 10`、读文件、搜索文本视为只读查询；`git pull`、`git fetch`、写文件等 mutating 操作必须命中明确动作语义才会执行。
- 本地执行器的文本搜索优先走内置 `search_text`，不依赖本机 `rg.exe`；如果本地模型误生成简单 `rg ... "pattern"` 计划，运行时会转换成 sandbox 内搜索，避免系统拒绝执行外部检索命令导致辅助器误报失败。
- 中文仓库查询仍会命中同一套只读规则，例如“帮我看看 git 状态”“当前分支是什么”“最近几条提交”；但在 `hybrid` 模式下它们默认先交给 Codex，只有 Codex 不可用时才回退到本地 repo fast-path。
- “读取文件 / 查看文件 / 搜索文本”在 `hybrid` 模式下同样默认先交给 Codex；本地执行器只保留为失败后的窄兜底，不再抢答主链路。
- `关机`、`shutdown`、重启机器等系统级动作现在直接标记为高风险请求，不允许走本地省流路径。
- 对 Unity、Blender、MCP、仓库、文件、图片和历史这类可执行请求，回复契约要求“解决问题优先”：必须基于真实工具结果、真实命令结果或明确阻塞原因回报；不得用通用教程、占位表格或示例脚本替代执行结果。
- Codex/MCP 执行链失败时，Unity/Blender/MCP/文档等需要真实工具输出的任务不会再降级给本地模型生成教程；runtime 会直接返回确定性 `未完成 + 阻塞原因`，bridge-core 出站前还会拦截“请手动检查 / 自行打开 Unity / 示例列表草案”等外包式回复。
- bridge runtime 会为 Codex 使用独立 `CTI_CODEX_HOME`，同步全局认证和 MCP 配置时剔除全局顶层 `model = ...`，避免本机 Codex UI 的新模型配置拖垮旧 CLI；运行版可用 `CTI_CODEX_MODEL` 显式指定当前 CLI 已验证可用的模型。
- Ignis 生成类任务提交后会等待完成并下载可回传资产，最终回复走 `cti-final`，避免向飞书裸发 CLI JSON 或大段技术字段。
- Ignis 仅在“该/这张/刚才/上一版/继续”等明确引用时复用上一轮 session 和参考图；普通新生成请求默认新开会话。
- Ignis 模型生成如果明确要求拆成 FBX/贴图，会在 GLB 下载完成后调用 `scripts/export-glb-asset-package.ps1`，输出 FBX、贴图、材质映射和 manifest，并通过 `cti-final.files` 回传不超过飞书限制的文件。
- Codex 不可用时的记忆类兜底回答。

不交给本地辅助直接完成的范围：

- Unity / Blender / MCP 多步编排；Ignis GLB 的固定 FBX/贴图后处理是受控例外，只走固定脚本，不让本地模型自由编排 Blender。
- 截图、渲染、导入、场景操作。
- 飞书文档创建/删除。
- 图片或附件理解，Ignis 附件只作为参考文件上传，不由本地模型理解内容。
- 项目级复杂重构和排障。

```mermaid
flowchart TD
  Request[入站请求] --> Mode{当前模式}
  Mode -->|codex_only| Codex[Codex 主脑]
  Mode -->|local_only| LocalScope{是否本地可处理}
  Mode -->|hybrid| CodexFirst{是否需要 Codex 先判}
  CodexFirst -->|默认是| Codex
  CodexFirst -->|显式小活| ExplicitSmallTask{是否允许本地直处理}
  ExplicitSmallTask -->|是| LocalAgent[本地辅助执行器]
  ExplicitSmallTask -->|否| Codex
  LocalScope -->|是| LocalAgent
  LocalScope -->|否| LocalLimit[说明本地模式限制]
  Codex -->|成功| FinalReply[cti-final 结果块]
  Codex -->|不可用或额度失败| LocalFallback[本地兜底]
  LocalAgent --> FinalReply
  LocalFallback --> MemoryRecall[检索本地记忆]
  LocalAgent --> IgnisFastPath[Ignis MCP 异步生成和查询]
  IgnisFastPath --> FinalReply
  MemoryRecall --> FinalReply
  LocalLimit --> FinalReply
```

## 3. 核心包职责

### 3.1 packages/bridge-core

核心职责：

- Channel adapter 抽象。
- Feishu/Lark 适配器。
- 消息路由和 session 绑定。
- 权限请求和高危操作门禁。
- 飞书 Markdown/card/image/file/reply 发送。
- 最终结果块解析和出站收口。
- 运行审计落盘。

关键能力：

- Feishu 群聊原生 reply。
- 群聊 reply 时可自动 @ 提问人。
- Feishu Markdown 默认走 card。
- 图片和文件由结果块显式声明，桥接不再靠正文猜路径。
- 飞书本地图片和本地文件分别走原生 image/file 消息回传；`.glb` 等非图片资产不能退化成仅发本地路径。
- 超过飞书 IM 单文件上传限制的生成资产改发文档链接或下载链接，不再假装“已发送文件”。
- 本地 `cti-final.files` 文件超过飞书 30MB 单文件限制时，出站层不再分卷，而是走 artifact delivery provider；飞书场景优先支持 `feishu_docx`，会自动创建新版云文档、把文件作为 `docx_file` 附件挂入文档，并回文档链接；也保留 `local_http` 作为公网目录备用方案。
- 用户回复到上一条图片/文件时，Feishu adapter 会尽量读取被回复消息并把附件并入本次请求。
- `bridge-runtime-audit.json` 记录最后阶段、最后消息、WS 状态、p2p 补捞状态。
- 权限门禁统一通过 `hasRole(message, role)` 判定；`Owner` 包含 `Operator` 和 `Viewer` 能力，`Operator` 包含 `Viewer` 能力。关机、发布、越权路径和 mutating 直达命令只允许 `Owner`，普通工具授权和中风险运维允许 `Operator` 或 `Owner`。

### 3.2 packages/bridge-runtime

核心职责：

- 读取 `config.env`。
- 启动 daemon/supervisor。
- 接入 Codex / Claude CLI provider。
- 接入本地 llama.cpp 模型。
- 本地辅助执行器。
- MCP manifest 解析和调用。
- 本地 JSON store。
- 记忆检索和 Feishu 历史索引。

关键能力：

- Codex 失败时切本地模型兜底。
- 本地模型兜底时会检索本地记忆，不再空猜。
- MCP 工作目录检查，防止误连其他项目。
- 默认工作区和 Unity 工程路径由配置控制。

### 3.3 packages/mcp-picture

图片相关 MCP，定位为独立能力包。

用途：

- 图片标注。
- 视觉布局辅助。
- 图片工作流中间能力。

### 3.4 packages/mcp-unity-prefab

Unity Prefab MCP，定位为独立 Unity 资源分析/生成能力。

用途：

- Prefab 扫描。
- Prefab 数据服务。
- Unity 资源侧辅助。

### 3.5 packages/mcp-ignis

Ignis CLI MCP，定位为创意生成能力包。

用途：

- 原画、概念图、生成图、视频和 3D 模型任务提交。
- `turn_id`、`session_id`、`canvas_id`、`file_id` 的结果查询。
- 本地参考文件上传到 Ignis。
- 会话历史、可用 Ignis 内部技能和中断追问恢复。

接口：

- HTTP MCP：给面板和本地模型快路径使用，默认 `http://127.0.0.1:8787/mcp`。
- stdio MCP：给 Codex `codex mcp add` 注册使用。
- 本机 CLI 配置：`C:\Users\admin\.ignis\config.json`。

安全边界：

- Ignis config URL 和 token 不进入仓库、release 包或日志。
- 生成任务默认异步提交；桥接内部保存 `turn_id`、`session_id`、`canvas_id` 和 `file_id`，飞书侧默认只发送用户可见摘要和可回传附件。
- 模型资产后处理只读取本地已下载的 Ignis GLB/GLTF；依赖本机 Blender 或 `BLENDER_EXE`，找不到 Blender 时只报告拆分失败，不伪造 FBX/贴图结果。

## 4. 控制面板

位置：

- `apps/control-panel`
- `apps/control-panel/web`

职责：

- 启停 Feishu bridge。
- 查看真实进程状态。
- 查看 Feishu WS 和私聊补捞状态。
- 查看 Codex / 本地辅助模式。
- 启停和检查 MCP。
- 自动发现 `mcp.d`、`skills.d`、`plugins.d`。
- 展示 suite 版本、扩展协议版本、启用扩展数量、缺失依赖和本机配置覆盖数量。
- 通过“设置”弹窗修改非敏感路径配置和回复风格配置。
- 通过“查看会话”弹窗查看会话、历史索引检索和同步状态。
- 查看 workflow run、executor 目录、最近路由选择和会话默认 executor。
- 管理 IM 用户权限、角色和最近会话参与人。
- 本机备份发布和主干发布预检。

截至 2026-04-27，控制面板采用 `Control API + React/Vite + 可选 WinForms/WebView2 壳`：

- Control API 是状态读取、白名单命令分发、会话详情、媒体缓存、workflow/executor/permissions 和本机脚本调用的统一后端。
- WinForms 负责窗口生命周期、WebView2 Runtime 检测，并启动或连接本机 Control API；桌面壳不再把业务命令硬塞进 WebView 事件。
- React 前端负责信息架构、导航、状态展示、长任务 pending 状态和活动流。
- 前端通过 `HostBridge` 自动探测传输层：WebView2 内仍可走 `window.chrome.webview`，普通浏览器走 HTTP API 和 SSE。
- 前端只能通过 HostBridge 请求后端执行白名单命令，不能直接运行 shell、PowerShell、Git 或文件系统操作。
- Control API 默认只监听 `127.0.0.1:8788`；只有显式配置 `CTI_CONTROL_API_ALLOW_REMOTE=true` 和 `CTI_CONTROL_API_AUTH_TOKEN` 后才允许非本机访问。
- 远程 token 默认角色是 `viewer`；`CTI_CONTROL_API_AUTH_ROLE=operator|owner` 决定远程请求能否进入中风险或高风险命令。
- 远程 Owner 高危命令默认关闭，必须额外配置 `CTI_CONTROL_API_ALLOW_REMOTE_DANGEROUS=true` 才能继续进入权限门禁。
- 本机缺少 WebView2 Runtime 时，宿主显示轻量降级页和安装提示，不回退旧完整 WinForms 面板。
- 面板主界面已取消底图依赖，统一改成高密度运营台布局；总览、服务、扩展、会话、设置和日志都按窗口宽度自适应重排。
- WinForms 宿主新增统一运行单元注册表，桥接服务、Codex CLI、本地辅助执行器、MCP 和扩展 manifest 在前端统一收敛成一套卡片和动作模型。
- 运行单元动作现在允许按 manifest 暴露安装入口；skill 和部分 MCP 只要声明 `installer` / `bootstrap`，面板就会显示“安装”按钮并走宿主白名单执行。
- CLI 工具更新也走 `runtime.invokeAction` 白名单。当前 Codex CLI 只有在检测到 npm 全局 `@openai/codex` 安装时才显示“更新”，宿主固定执行 `npm install -g @openai/codex@latest`，不接受前端传入任意命令。
- 扩展页新增“导入本地目录”入口：可选择或拖入本地目录，宿主会先按 `SKILL.md` / `package.json` / 目录名规则识别为 `skill` 或 `mcp`，预览生成的 manifest，再写入 `config/skills.d` 或 `config/mcp.d`。
- 扩展页的 MCP 运行状态按健康检查、Codex 注册和托管进程综合判断；`bundled`、`external` 只作为安装来源展示，不再直接映射成“待处理”状态。
- 会话区新增 WebView 详情抽屉，宿主通过 `history.getSessionDetail` 返回完整消息流；旧 `ConversationViewerForm` 保留为兼容调试入口。
- 会话详情现在会解析消息类型、消息 ID 和附件元数据；对飞书图片/文件消息，宿主会按消息资源接口拉取原始资源，缓存到 `CTI_HOME\\runtime\\control-panel-media`，并通过 Control API `/media/*` 暴露给前端。前端直接展示图片缩略图和附件状态，不再只显示 `[图片]` 这类占位文本。
- 会话详情支持强制刷新，宿主会绕过详情缓存重新读取会话历史；旧索引中图片/文件消息缺少资源键时，会触发会话级远端重同步。
- 会话详情读取旧本地消息时只做显示层 mojibake 修复；疑似 UTF-8 被 GBK 错读的文本会在面板里还原展示，原始历史 JSON 不被自动改写。
- 会话详情会按 `sessionId` / `chatId` 关联 `workflow-runs.json`，展示 executor、阶段状态、prompt 摘要和事件时间线，方便回溯一次飞书请求从接收、路由、执行到交付或失败的运行历程。
- “权限”页读取 `permissions.json` 和最近会话参与人，支持按渠道、角色、名称或 ID 过滤，能把用户设置为 `Viewer`、`Operator` 或 `Owner`，并同步兼容 env 后重启 bridge。
- 会话详情的参与人列表不再只提供一次性“加 Owner”，而是进入同一套权限库，可直接设置三档角色；显示名优先来自飞书历史，拿不到时显示原始 ID。
- 设置页新增 `path.pickFolder` / `path.pickFile` / `path.openAny` 等目录选择协议，路径字段支持拖拽、回填和快速打开。
- 回复风格预设通过 `settings.listReplyPresets` / `settings.applyReplyPreset` / `settings.summarizeReplyStyle` 暴露给 WebView，继续沿用宿主保存语义。
- 本地辅助执行器状态卡只展示当前 daemon 生命周期内的最近路由；bridge 重启时会清掉旧的 fallback / refusal 瞬时状态，避免把历史 `usage limit` 或旧兜底信息当成当前异常。
- bridge 启动时会立即写入 `executor-status.json` 的 executor 基线状态；即使还没有新的飞书请求进入 provider，控制面板也能看到执行器目录和会话默认 executor，不再把缺失状态文件误解为辅助器异常。
- 记忆仓库路径现在强制落在工作目录外；如果 `CTI_MEMORY_REPO_DIR` 指向默认工作目录、Unity 项目目录或其子目录，宿主和运行时都会自动回退到 `CTI_HOME\\memory-repo`。
- 对“你还记得吗 / 常用场景名称”这类命中本地笔记的回忆型问题，运行时新增确定性记忆快答：优先直接读取 `CTI_MEMORY_REPO_DIR` 下的 Markdown 笔记并返回，不再依赖 Codex 或本地模型生成。

面板原则：

- 面板只做 orchestration，不承载桥接业务逻辑。
- 主窗口优先服务日常运维，只常驻服务总览、MCP 管理和日志记录。
- 服务按钮放在对应服务卡里。
- 状态优先读真实进程和运行审计，不再只信旧 `status.json`。

HostBridge 命令协议：

```json
{ "id": "request-id", "type": "command", "command": "state.refresh", "payload": {} }
```

响应：

```json
{ "id": "request-id", "type": "result", "ok": true, "data": {} }
```

宿主推送：

```json
{ "type": "state", "data": {} }
```

当前核心白名单命令分组：

- 状态与服务：`state.refresh`、`bridge.*`、`codex.*`、`localLlm.*`
- Workflow 和执行器：`workflow.listRuns`、`workflow.getRun`、`workflow.getEvents`、`executor.list`、`executor.check`、`executor.setSessionDefault`
- 权限：`permissions.list`、`permissions.upsert`、`permissions.remove`、`permissions.syncFromConfig`、`permissions.applyAndRestart`
- 运行单元：`runtime.listUnits`、`runtime.invokeAction`
- 扩展：`extension.enable`、`extension.disable`、`extension.remove`、`extension.install`
- 扩展导入：`extension.detectImport`、`extension.importFromFolder`
- 会话：`history.listSessions`、`history.getSessionDetail`、`history.openConversationViewer`
- 设置与路径：`settings.read`、`settings.save`、`settings.listReplyPresets`、`settings.applyReplyPreset`、`settings.summarizeReplyStyle`、`path.pickFolder`、`path.pickFile`、`path.openAny`
- 历史消息解析会优先提取 Feishu `text / post / interactive` 内容；卡片消息不再统一显示成 `[卡片消息]` 占位。对旧索引里遗留的卡片占位，控制面板会按 `messageId` 从 `data/audit.json` 回填可见摘要，尽量不要求用户手动全量重同步。
- 历史消息解析会保留飞书 `image / file` 资源键和文件名；旧索引缺少资源元数据时，详情页会触发一次会话级 full sync 尝试补齐。资源下载失败或权限不足时，前端显示明确的附件占位和状态，不伪装成已加载图片。

Control API HTTP 接口：

- `GET /healthz`
- `GET /api/state`
- `POST /api/commands`
- `GET /api/events`
- `GET /api/session/{chatId}/{sessionId}`
- `GET /media/{resourceId}`

远程部署入口：

- `scripts/start-control-api.ps1` 可直接启动 API-only 模式。
- `CTI_CONTROL_API_HOST` / `CTI_CONTROL_API_PORT` 控制监听地址。
- `CTI_CONTROL_API_PUBLIC_BASE_URL` 用于反向代理或公网地址下生成媒体 URL。
- `CTI_CONTROL_API_AUTH_ROLE` 控制远程 token 的角色等级，默认 `viewer`。
- 非本机请求通过 `Authorization: Bearer <token>` 或 `?token=<token>` 认证；浏览器模式会保存 URL 里的 token 并用于 HTTP/SSE 请求。

## 5. Manifest 驱动扩展

截至 2026-04-22，扩展 manifest 使用 `extension-manifest/v1` 协议。`suite.manifest.json` 是协议版本和 manifest 目录的入口，`scripts/validate-extension-manifests.ps1` 负责校验现有 MCP、skill、plugin 清单。

所有扩展 manifest 都必须声明：

- `id`
- `displayName`
- `type`
- `version`
- `compatibility`
- `category`
- `optional`
- `installState`
- `source`
- `enabled`
- `description`

通用字段含义：

- `compatibility.protocol` 固定为 `extension-manifest/v1`。
- `compatibility.suite` 声明兼容的 suite 版本范围。
- `category` 用于面板展示和运营分组。
- `optional` 表示缺失时是否阻断主流程。
- `installState` 表示 `bundled`、`external`、`configured` 或 `missing`。
- `source` 指向项目内路径、外部插件标识或外部安装源。
- `aliases` 给运行时提供自然语言匹配词，MCP 快路径按 manifest 动态解析目标，不再维护固定 MCP 名称列表。
- `installer` / `bootstrap` 用于声明可由控制面板触发的安装脚本；宿主通过白名单环境变量把扩展 ID、类型、source 和 manifest 路径传给安装脚本，不允许前端直接执行 shell。

### 5.1 MCP

目录：

- `config/mcp.d`

当前 MCP：

- `unityMCP`
- `blenderMCP`
- `pictureMCP`
- `unityPrefabMCP`
- `ignisMCP`

每个 MCP 通过 JSON manifest 声明：

- `id`
- `displayName`
- `type`
- `version`
- `compatibility`
- `category`
- `optional`
- `installState`
- `source`
- `aliases`
- `enabled`
- `launcher`
- `stopLauncher`
- `cwd`
- `env`
- `healthCheck`
- `registerName`
- `description`
- `installer`

MCP 安全规则：

- MCP 的 `cwd` 必须命中当前默认工作区、允许根目录或 Unity 工程路径。
- 不符合时拒绝启动、检查、列工具和调用工具。
- Unity 截图、Blender 操作等复杂任务默认走 Codex 主脑，不由本地 MCP 快路径接管。
- Ignis MCP 允许本地模型快路径直接提交和查询创意生成任务，但不接收仓库内保存的密钥。

```mermaid
flowchart LR
  SuiteManifest[suite.manifest.json] --> Protocol[extension-manifest/v1]
  Protocol --> ManifestDir[config/mcp.d]
  ManifestDir --> Loader[MCP manifest loader]
  Loader --> AliasMatch[按 aliases 和 displayName 匹配目标]
  Loader --> WorkspaceCheck{cwd 是否允许}
  WorkspaceCheck -->|否| Reject[拒绝启动或调用]
  WorkspaceCheck -->|是| Register[注册到 Codex]
  WorkspaceCheck -->|是| StartStop[面板启动和停止]
  WorkspaceCheck -->|是| Health[健康检查]
  StartStop --> ManagedProcess[托管进程]
  Health --> HttpMcp[HTTP MCP]
  Health --> StdioMcp[stdio MCP]
```

### 5.2 Skills

目录：

- `config/skills.d`
- `extensions/skills`

当前纳入项目备份的 skills：

- `memory-repo-retrieval`
- `feishu-document-generation`
- `unity-mcp-orchestrator`
- `blender-mcp-glb-unity-pipeline`
- `github-bmad-master`
- `github-memory-protocol`
- `ignis-cli`

同步到本机 Codex：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-suite-skills.ps1
```

### 5.3 Plugins

目录：

- `config/plugins.d`

当前记录：

- `build-web-apps`
- `game-studio`

## 6. 本地模型

当前本地模型链路：

- llama.cpp server
- Qwen2.5-Coder 7B GGUF
- OpenAI-compatible HTTP API

定位：

- 不是主脑。
- 是本地辅助执行器和 Codex 不可用时的兜底。
- 适合小命令、简单解释、记忆类兜底、轻量文件操作。
- 在 `local_only` 模式下，原画、生成图、视频、模型等 Ignis 请求可以直接调用 Ignis MCP。

脚本：

- `scripts/local-llm/setup-llama-cpp.ps1`
- `scripts/local-llm/start-local-llm.ps1`
- `scripts/local-llm/stop-local-llm.ps1`
- `scripts/local-llm/healthcheck-local-llm.ps1`
- `scripts/export-glb-asset-package.ps1`

Ignis 会话映射：

- `C:\Users\admin\.claude-to-im\runtime\ignis-sessions.json`
- 按飞书 chat/session 保存最近 `turn_id`、`session_id`、`canvas_id` 和 `file_id`。
- 支持“继续上一版”“查上一个结果”“等待完成”等追问；只有明确引用语义才复用上一轮参考资产。

## 7. 记忆与历史

本地桥接数据默认在：

- `C:\Users\admin\.claude-to-im\data`

主要文件：

- `sessions.json`
- `bindings.json`
- `permissions.json`
- `messages`
- `message-archives`
- `feishu-chat-index.json`
- `feishu-p2p-user-index.json`
- `feishu-history-index.json`
- `feishu-history`

记忆策略：

- 远端 Feishu 历史是主来源。
- 本地索引用于检索、加速、压缩和容灾。
- AI 不直接吃全量历史，而是先检索相关片段。
- Codex 不可用时，本地模型会先检索本地记忆再回答记忆类问题。

## 8. 结果封装协议

桥接已经从“猜测裁剪结果”改成结果块协议。

Codex 应输出：

```text
```cti-final
{
  "kind": "text",
  "text": "最终发给用户的内容",
  "images": [],
  "files": [],
  "reply_mode": "markdown"
}
```
```

桥接行为：

- 优先解析 `cti-final`。
- 命中后只发送结果块内容。
- Markdown 统一走 Feishu card。
- 图片和文件由结果块显式声明。
- 协议失败时保守兜底，不再强行猜半截结果。

## 9. 打包与发布

本机备份打包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

本机备份发布：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-backup.ps1
```

本机备份发布脚本职责：

- 构建 package。
- 构建控制面板。
- 用开发版生成 live skill。
- 组装 portable。
- 组装 installer。
- 生成 `publish-summary.md`。
- 追加 `release-notes.md`。
- git add / commit / push。

主干发布预检：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-main-release.ps1
```

主干发布预检职责：

- 校验 `extension-manifest/v1`。
- 检查架构文档维护状态。
- 扫描疑似密钥和 token。
- 构建 package 和控制面板。
- 组装 portable 和 installer。
- 生成 `publish-summary.md` 并追加 `release-notes.md`。
- 不同步 live skill，不自动 commit，不自动 push。

主干发行标签：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-main-release-tag.ps1
```

标签脚本只做只读门禁和 `git tag -a v<version>`：要求工作区干净，默认要求位于 `main`，并重新执行扩展 manifest 严格校验。`prepare-main-release.ps1` 不负责打 tag，避免预检生成的摘要或打包产物把工作区变脏后阻断标签创建。

`main` 是稳定产品主干，`codex/dev` 是日常集成分支，功能分支使用 `codex/<topic>`。合入 `main` 前必须完成构建、测试、扩展 manifest 校验、架构文档检查和发布摘要。

```mermaid
flowchart TD
  DevTree[开发版 codex-im-suite] --> BuildPackages[build-packages.ps1]
  DevTree --> ValidateManifest[validate-extension-manifests.ps1]
  BuildPackages --> SyncLive[sync-live-skill.ps1]
  SyncLive --> LiveRuntime[本机 live skill 运行副本]
  DevTree --> ArchCheck[update-architecture-docs.ps1]
  BuildPackages --> Assemble[assemble-portable.ps1]
  Assemble --> Portable[release/portable]
  Portable --> Zip[portable zip]
  Portable --> Installer[Windows installer]
  DevTree --> MainPreflight[prepare-main-release.ps1]
  MainPreflight --> ValidateManifest
  MainPreflight --> ArchCheck
  MainPreflight --> Assemble
  DevTree --> PublishSummary[publish-summary.md]
  PublishSummary --> ReleaseNotes[release-notes.md]
  ReleaseNotes --> Git[git commit 和 push]
  Git --> Tag[create-main-release-tag.ps1]
```

同步方向固定为 `suite -> live`。`scripts/import-live-to-suite.ps1` 只用于手动救回 live 中的历史改动，默认 dry-run，不属于主干发布链路。

### 9.1 入口定位

日常维护入口：

- 主源码：`C:\Users\admin\Documents\New project\codex-im-suite`
- 面板源码：`apps/control-panel`
- 目标检查：`scripts/doctor-suite-targets.ps1`

非日常源码入口：

- `.codex\skills\claude-to-im*` 是运行副本。
- `release/portable` 和 `release/installer` 是发布产物。
- 旧 `packages/bridge-runtime/tools/ControlPanel` 和 `packages/bridge-runtime/tools/Installer` 已移除，不作为面板或安装器维护入口。

## 10. 当前安全边界

- 默认工作区固定到配置里的 ST3。
- 非授权路径默认拒绝。
- MCP 工作目录必须在允许范围内。
- 高危操作走 `Owner` 门禁，中风险运维走 `Operator` 或 `Owner` 门禁。
- 本地模型不能绕过权限。
- 本地模型不能伪造执行结果。
- 私有 token/config 不进入 Git。
- Ignis token 只保存在 `C:\Users\admin\.ignis\config.json`，发布和同步流程不得复制该文件。

## 11. 运行状态排障入口

优先看：

- `C:\Users\admin\.claude-to-im\runtime\bridge-runtime-audit.json`
- `C:\Users\admin\.claude-to-im\logs\bridge.log`
- 控制面板服务总览

关键字段：

- `lastStage`
- `lastInboundMessage`
- `lastActiveRequest`
- `lastCompletedRequest`
- `feishuWs`
- `feishuP2pPoll`
- `lastUnhandledError`
