# codex-im-suite

## 项目内 Git 会话存档

本仓库启用了项目内 Git 会话存档，用于把 Codex/AI 维护过程和 Git commit 关联留痕。安装入口只写当前仓库的 `.git/config`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-git-session-archive.ps1
```

该脚本会把 `entireio/cli` 固定版本构建到 `.codex-tools\bin\entire.exe`，并设置 `core.hooksPath=.githooks`。`.codex-tools` 是本仓库本地工具缓存，不提交、不全局安装；其他项目需要同样能力时，应在对应项目内单独安装。默认策略是 `manual-commit`，只做会话和 Git checkpoint 留痕；不自动提交、不自动合并到 `codex/dev`，也不自动 push。

`codex-im-suite` 是飞书桥接、Codex 执行层、本地模型来源、MCP、Skill、控制面板和 Windows 打包流程的统一开发与发布目录。

当前目标很明确：

- 开发入口收口到本仓库，不再依赖散落在外部目录的历史副本。
- 运行版 live skill 可以从本仓库同步生成。
- 本机备份发布继续先同步、构建、打包，再提交和推送，保证 GitHub 备份与可运行产物一致。
- 本机备份发布在 `git push` 前会自动执行 Git LFS 预同步；只要仓库里存在 LFS 跟踪文件，就会先向目标 remote 补传缺失对象，避免发布产物已提交但远端缺少 LFS blob 时被 GitHub 预接收钩子拒绝。
- `main` 主干发布先做协议校验、架构检查和可复现打包，不把本机 live skill 当作主干事实来源。

## 本次大更新

这次更新把仓库从“本机插件拼接版”推进到了“可复现发布的通用套件”：

- 版本治理收口：`main` 定位为稳定主干，`codex/dev` 用于日常集成；主干发布预检、独立打 tag、扩展协议校验和架构检查都已经脚本化。
- 扩展协议通用化：`config/mcp.d`、`config/skills.d`、`config/plugins.d` 统一升级到 `extension-manifest/v1`，MCP / Skill / Plugin 不再靠硬编码名称驱动。
- 运行单元协议落地：新增 `config/runtime.d` 和 `runtime-manifest/v1`，把内建服务收口成声明式运行单元；服务页和非 Skill 扩展继续复用通用 `update` 协议与白名单执行模板。
- Registry 驱动 Skill 治理：`bridge-runtime` 统一维护 Skill Registry、官方创建/校验/安装适配、审批、审计和回滚；飞书与控制面板共用同一 lifecycle，面板不再维护第二套 Skill 安装逻辑。
- 控制面板重做：面板升级为 `WinForms + WebView2 + React/Vite`，并按“运行 / 机器人 / 能力 / 治理”四域组织服务、会话、计划任务、架构、Prompt Snapshot、Memory、Skills、MCP、模型、插件、权限和设置。
- Ignis / MCP 能力并入套件：新增 `packages/mcp-ignis`、Ignis manifest、生成结果回传和 GLB 资产后处理链路，MCP 注册和状态发现也统一收口。
- Workflow / Executor 平台落地：运行时开始记录请求阶段、执行器路由和会话默认 executor，面板可查看 workflow run、executor 状态和单次请求运行历程。
- 多节点控制面打底：新增共享契约包和控制面板“节点”页，当前先暴露本机 node 与 fake remote node 的 heartbeat、能力清单和可管理状态，为后续多 runtime 管理预留协议边界。
- Ollama 本地后端落地：旧 `llama.cpp` / GGUF / `127.0.0.1:8080` 默认链路废弃，统一使用 `CTI_OLLAMA_*` 配置，默认 `http://127.0.0.1:11434` 和 `qwen2.5-coder:7b`。
- 工作区、记忆与自维护分层：每轮只挂载当前工作区，项目注册根只作为权限上界；本轮明确引用的其他项目才进入临时挂载。`E:\cli-md` 使用可见的 Agent Home、memory v3 分区、工作档案、每日反思和纠错档案，`.cti-index` 只保存机器索引。
- 记忆数据治理：整理草稿、勾选应用、撤销、定期整理和归档恢复/删除统一放在“治理 → 设置”；提醒检查、完成和测试发送放在“运行 → 会话”，旧命令协议保持兼容。
- 统一计划任务：`notify / agent_turn / controlled_tool` 共用 Scheduler、原子 Store、slot 幂等和运行账本；`cti-reminder` 与 `/remind` 兼容转换为单次 `notify`，周期任务使用 `cti-scheduled-task`。执行成功但飞书投递失败时只重试投递，不重跑 Agent；运行态固定写入 `CTI_HOME\data\scheduled-tasks`，不进入工作区或记忆库。
- 飞书云文档读取 v1：飞书消息里的 Docx、Sheets、Base 链接会先用应用 `tenant_access_token` 读取，应用无权时再按发起人 OAuth 用户身份读取；缺少用户授权时发送登录卡片，登录后仍无权限则明确提示需要文档所有者分享或导出。
- 会话详情升级：飞书图片和文件会下载到本机缓存并在面板里直接预览；详情页同时展示关联 workflow 事件，方便回溯一次请求从接收、路由、执行到交付的完整链路。
- 能力和 CLI 运维补齐：能力区拆为 Skills、MCP、模型与插件；MCP 状态按健康检查、Codex 注册和托管进程综合判断，Skill 安装只走 lifecycle，其他扩展保留 manifest 和白名单更新模板。
- 控制面板 HTTP 化：桌面面板会启动同一套本机 Control API，React 前端可在 WebView2 或普通浏览器里通过 HTTP/SSE 读取状态、会话、图片、workflow 和权限数据；远程监听默认关闭，必须显式配置 token。
- Workflow 契约适配：`workflow-runs.json` 继续作为本地事实来源，runtime 额外提供共享 `WorkflowRunContract` 映射，统一 checkpoint、trace event、recovery 和 delivery 字段。
- AI 执行来源收口：设置页支持选择默认 executor 来源，执行器页可一键设为默认或恢复自动；Codex 内部仍支持官方 Codex、本地 API、外部 API 和自动切换链作为模型来源。Feishu 最终卡片底部会分开展示“来源”（executor/provider）与“模型 / token”，便于确认本轮到底由 Codex、Claude CLI 还是外部 agent 执行。
- 打包链路补齐：portable / installer / live skill 同步都按 suite 目录生成，控制面板 Web 前端和 `wwwroot` 资源会一并进入发布产物。

## 快速入口

- Agent 维护规则：[AGENTS.md](./AGENTS.md)
- 架构说明：[docs/PROJECT-ARCHITECTURE.md](./docs/PROJECT-ARCHITECTURE.md)
- 开发记录：[docs/DEVELOPMENT-LOG.md](./docs/DEVELOPMENT-LOG.md)
- 目标目录检查：`scripts/doctor-suite-targets.ps1`
- 架构文档检查：`scripts/update-architecture-docs.ps1`
- 扩展协议校验：`scripts/validate-extension-manifests.ps1`
- 旧记忆规则 dry-run 归档：`scripts/memory/archive-legacy-rules.ps1`
- 记忆布局迁移：`scripts/memory/migrate-memory-layout.ps1`
- 工作区污染清理（dry-run / 隔离备份 / 恢复）：`scripts/cleanup-workspace-pollution.ps1`
- 计划任务 CLI：`packages/bridge-runtime/dist/scheduled-task-cli.mjs`
- 主干发布预检：`scripts/prepare-main-release.ps1`
- 主干发行标签：`scripts/create-main-release-tag.ps1`
- 控制面板前端源码：`apps/control-panel/web`
- Control API 启动脚本：`scripts/start-control-api.ps1`
- 最近发布摘要：[publish-summary.md](./publish-summary.md)
- 发布历史：[release-notes.md](./release-notes.md)
- 套件清单：[suite.manifest.json](./suite.manifest.json)

## 工作区与记忆入口

- 当前工作区：每轮唯一默认挂载，对应 `CTI_DEFAULT_WORKDIR` 或会话绑定目录。
- 项目注册根：`CTI_ALLOWED_WORKSPACE_ROOTS` 只定义可访问上界，不自动进入 Prompt、Provider 或附加目录。
- 临时挂载：只由本轮消息中的明确绝对路径等强证据生成，随当前回合结束失效。
- Agent Home / 记忆库：默认 `E:\cli-md`，集中放置 `机器人身份.md`、`行为与安全规则.md`、`工具与环境.md`、`记忆总索引.md`、`记忆库说明.md`。
- Agent Home 注入：身份、行为安全和工具环境三份文档每轮按独立 Prompt section 重新读取；当前工作区的 `work/<workspaceId>/工作档案.md` 另以“只读事实证据”限长回读，超预算时保留头部与最新尾部，其他项目档案、每日反思和纠错日志不注入。Git 项目优先使用规范化 origin remote 生成稳定 workspaceId，项目移动、改名或从子目录进入仍共用档案；旧路径 ID 档案会提升到稳定 ID，提升失败时临时回读真实旧来源。
- 受控自主维护：独立、禁工具、无工作目录的 Self-Maintenance classifier 只在候选纠错或任务结果阶段运行。核心三文档只有在确认是 Agent 自身错误，并逐字绑定真实 assistant 错误片段与当前 human/失败 runtime 纠正片段时才能通过稳定 key、`baseHash` 和受控 patch 更新专用规则块；不允许整篇替换用户主体。工作档案使用稳定 key upsert，只保存当前有效状态；默认核心模板已升级到 `cti-agent-home-template:v4`，未改 v1/v3 自动升级，用户手改模板不覆盖。
- 自维护档案：`work/<workspaceId>/工作档案.md`、`daily-reflection/每日反思-YYYY-MM-DD.md`、`corrections/纠错记录-YYYY-MM-DD.md`；写入使用 `.cti-self-history/write.lock` 排他锁和持久化事务 before-image，崩溃后会恢复未完成事务。受控规则记录 `trial / confirmed / regressed` 成熟度和真实 runtime 效果，`regressed` 只标记回归并保留回滚入口，不自动覆盖用户内容。版本、审计和日期档案超过活跃窗口后移动到 `archive/self-maintenance`，不直接删除；控制面板展示 classifier 调用/跳过、平均耗时、规则状态和锁/哈希冲突。
- 未归类根文档：记忆库根目录中不属于五个固定入口的 Markdown 会在控制面板显示警告和打开入口，但不会被自动移动、删除或注入知识索引。
- 分区记忆：用户写入 `memory/users/<channel>/<userId>/用户印象.md`，群聊写入 `memory/groups/<channel>/<chatId>/群聊记忆.md`，公共长期事实写入 `memory/long-term/公共长期记忆.md`。
- 旧 `CTI_CODEX_ADDITIONAL_DIRECTORIES` 只保留为诊断值，不再自动挂载，也不再由控制面板修改。

迁移旧 `data/memory/v2` 前先停止 Bridge，并先预览：

```powershell
npm --workspace packages/bridge-runtime run build
powershell -ExecutionPolicy Bypass -File .\scripts\memory\migrate-memory-layout.ps1 -MemoryRoot E:\cli-md -ReportPath E:\cli-md\reports\记忆迁移预览.json
```

确认报告后再显式应用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\memory\migrate-memory-layout.ps1 -MemoryRoot E:\cli-md -Apply -ReportPath E:\cli-md\reports\记忆迁移结果.json
```

清理工作区旧上传缓存或测试夹具时，先生成中文清单和 Hash：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\cleanup-workspace-pollution.ps1 -Target <候选目录>
```

核对清单后使用同一 JSON manifest 执行隔离移动；不会永久删除：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\cleanup-workspace-pollution.ps1 -ApplyManifest <工作区污染清理清单.json>
```

需要撤销时先停止 Bridge，再恢复：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\cleanup-workspace-pollution.ps1 -RestoreManifest <工作区污染清理清单.json>
```

自动 Apply 只接受旧上传缓存、runtime 上传缓存和测试夹具；Unity `Assets`、源码、未知目录和显式用户产物必须保留并单独确认。

## 我该改哪里

默认只改开发版主仓库：

- `C:\Users\admin\Documents\New project\codex-im-suite`

不要把下面目录当成日常源码入口：

- `C:\Users\admin\.codex\skills\claude-to-im`：运行副本，由开发版同步生成。
- `C:\Users\admin\.codex\skills\claude-to-im-core`：运行副本，由开发版同步生成。
- `release/portable`、`release/installer`：发布产物，由打包脚本生成。

面板源码唯一入口是 `apps/control-panel`。旧的 `packages/bridge-runtime/tools/ControlPanel` 和 `packages/bridge-runtime/tools/Installer` 已移除，拿不准时先运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor-suite-targets.ps1
```

开发版面板入口是 `release\artifacts\control-panel\CodexImSuiteControlPanel.exe`，live 面板入口是 `C:\Users\admin\.codex\skills\claude-to-im\dist\control-panel\CodexImSuiteControlPanel.exe`。旧 `ClaudeToImControlPanel.exe` 已退出发布入口。主窗口按四域组织：运行（总览、服务、会话）、机器人（架构、提示词注入、记忆索引）、能力（Skills、MCP、模型与插件）、治理（权限、发布、日志、设置）。旧 `#extensions` 会进入 Skills，旧节点/执行器地址会进入服务页对应 tab。会话页保留提醒操作，设置页保留记忆整理和归档治理，Memory 只做索引；Skills 页只调用 runtime lifecycle，Prompt 页只展示脱敏只读 Snapshot。

Control API 默认只监听本机：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-control-api.ps1
```

远程服务器查看必须显式提供 token：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-control-api.ps1 -HostName 0.0.0.0 -AllowRemote -AuthToken "replace-with-a-long-random-token"
```

然后通过 `http://server:8788/?token=...` 打开同一套面板。远程 token 默认只有 `viewer` 权限；需要运维动作时配置 `CTI_CONTROL_API_AUTH_ROLE=operator`，需要高危动作时配置 `owner`。远程高危命令默认关闭，只有设置 `CTI_CONTROL_API_ALLOW_REMOTE_DANGEROUS=true` 后才允许 Owner 类命令继续进入门禁。

## 目录结构

- `packages/bridge-core`：IM 桥接核心库，包含 Feishu 适配器、消息路由、权限、审计、发送收口。
- `packages/bridge-runtime`：运行时壳层，包含配置、daemon、provider、Codex、本地模型、本地执行器、MCP 桥接。
- `packages/contracts`：Control API、workflow、node agent 和 extension capability 的共享 TypeScript 契约与 JSON schema。
- `packages/mcp-picture`：图片能力 MCP。
- `packages/mcp-unity-prefab`：Unity Prefab MCP。
- `packages/mcp-ignis`：Ignis CLI MCP，负责原画、图片、视频、3D 模型生成和结果查询。
- `apps/control-panel`：Windows 中控面板。
- `apps/installer`：Windows 安装器。
- `config/mcp.d`：MCP manifest，面板和注册脚本都从这里发现 MCP。
- `config/skills.d`：随项目备份的 skill manifest。
- `config/plugins.d`：随项目备份的 plugin manifest。
- `config/runtime.d`：内建服务的 runtime manifest，声明服务显示信息、来源路径和 update 策略。
- `config/action-manifests.d`：通用工具动作 manifest，声明 MCP / Unity MCP / shell artifact 等可验证动作；旧 `config/local-agent-tools.d` 只作为兼容 overlay。
- `config/extension-catalog.json`：在线扩展目录的静态种子；控制面板还会叠加动态排行榜源和 `CTI_EXTENSION_CATALOG_URLS` 自定义 URL。
- `extensions/skills`：自定义 skill 的项目内副本。
- `scripts`：启动、注册、构建、打包、发布、同步脚本。
- `release`：portable、installer、zip 等发布产物。

控制面板下载安装到本机的数据不进入仓库，默认落在 `C:\Users\admin\.claude-to-im\extensions`；其中用户 manifest overlay 位于 `extensions\manifests\mcp.d`、`extensions\manifests\skills.d`、`extensions\manifests\plugins.d` 和 `extensions\manifests\action-manifests.d`，会和 `config/*.d` 一起被面板、MCP 注册脚本和 skill 同步脚本读取。

## 当前运行模型

默认是 `自动 executor 选择 + Codex CLI agent 模型来源链`：

- 运行时已加入第一阶段 workflow / executor 平台：请求会记录 `received -> authorized -> contextualized -> routed -> executing -> delivered/failed`，执行器目录当前包含 `codex`、`claude-cli` 和实验性的 `codex-oss-ollama`；本地 API 与外部 API 都通过 `codex` 的模型来源接入，不再作为独立本地 agent 或兜底执行器。
- 外部 Agent Executor：`mavis-agent` 是 opt-in external executor，通过本地 `mavis` CLI 派发和续接任务；默认关闭，使用 `CTI_MAVIS_ENABLED=true` 与 `CTI_MAVIS_CLI_PATH=<path>` 启用。用户可用 `@mavis` / `@minimax` / `@minimax-code` 显式选择，也可在控制面板设置默认 executor。当前模块边界、路由和失败收口统一维护在 `docs/PROJECT-ARCHITECTURE.md`，阶段性变更统一记录在 `docs/DEVELOPMENT-LOG.md`。
- 用户可用 `@codex`、`@claude`、`@local`、`@本地`、`@ollama` 显式选择执行器；`@local` / `@本地` 表示本轮 Codex 使用 `local_api` 模型来源。控制面板“执行器”页可查看最近 workflow run、executor 状态，并通过按钮设置或清除全局默认 executor；“节点”页可查看本机 node 与 fake remote node 的能力清单。
- 普通对话、复杂判断、Unity/Blender/MCP 多步任务默认走 Codex。
- 设置页的“AI 执行与模型来源”可选默认 executor；默认 executor 写入 `CTI_DEFAULT_EXECUTOR_ID`，优先级低于显式 `@hint`、高于历史会话默认值。Codex 模型来源仍可选官方 Codex、本地 API、外部 API或自动切换链；手动模式由 `CTI_CODEX_MODEL_SOURCE` 控制，本地 API 使用 `CTI_LOCAL_AI_*`，外部 API 使用 `CTI_CODEX_BASE_URL`、`CTI_CODEX_API_KEY`、`CTI_CODEX_MODEL`、`CTI_CODEX_PASS_MODEL`。
- 本地 API 现在作为 Codex CLI 的普通模型来源接入，不再因为工具探测未通过或旧本地兜底键自动转官方 Codex；`ollama` / `lmstudio` 会通过 provider registry 生成 `codex exec --oss --local-provider <provider> --model <CTI_LOCAL_AI_MODEL>`，不会走 Codex SDK 的 `/v1/responses`。`vllm`、`openai-compatible` 和 `custom` 在未接入 Codex CLI OSS agent 前只显示为 Chat Completions 能力，不能伪装执行。
- 本地 API 的目录/文件读取、明确工具类任务和产物类任务支持 JSON 工具协议：runtime 会先对可安全推断的只读目标、用户原文明示命令、`config/action-manifests.d` 注册的 MCP / Unity MCP 动作或 `shell_artifact` 产物工具生成确定性工具计划；旧 `config/local-agent-tools.d` 只作为兼容 overlay 读取。模糊请求会把可用 MCP 工具 schema 与工具目录注入给本地模型，让模型自己输出 `tool_request`，并在真实 `tool_result` 后继续规划下一步，最多执行多步工具循环。随后统一按 `requiredToolFamilies` 校验允许工具目录和路径 / cwd / MCP manifest / 产物路径，执行 `list_dir/read_file/search_files/shell/shell_artifact/mcp_call/unity_mcp_execute_code`；MCP、Unity MCP 和 artifact 任务不能绕到普通 shell 假完成。处理期间 bridge-core 会按回复表面选择 Feishu CardKit streaming card：工具链展示当前一步用户可见处理动作，轻量聊天和表情包优先使用轻量 reply surface / prompt profile，必要时只短暂显示“正在回复…”。这些等待态内容只用于卡片，不写入最终回复或会话历史。工具完成后，同一张 streaming card 会关闭流式模式并替换为结果正文优先、底部附状态 / 来源 / 工具轨迹 / 耗时 / 当前模型 / 输入输出 token 的结果卡；最终回复会读取设置页保存的回复风格 `CTI_REPLY_STYLE_HINT`，按该语气生成结果优先的 Markdown/`cti-final`，不再强制固定“处理思路 / 执行结果”模板，也不暴露隐藏推理链、协议 JSON 或原始 MCP 返回。工具结果里出现真实存在的本地图片或文件路径时，会自动封装为 `cti-final.images/files` 交给 Feishu 附件链路发送，而不是只回复路径文本。Workflow 会显示 `JSON 工具协议已满足`、工具计数、具体工具名、shell exitCode 和耗时。
- 自动切换由 `CTI_CODEX_ROUTING_MODE=auto_failover` 和 `CTI_CODEX_API_FALLBACK_CHAIN` 控制，默认推荐 `local_api,external_api`；官方 Codex 只有显式加入自动链或手动选择官方时才会被调用，避免意外消耗付费流量。
- 对 `git status`、当前分支、最近提交、暂存区内容、读取文件和搜索文本这类只读固定动作，Codex 模型来源失败后允许走 runtime 自己的受控工具补执行；这不是本地模型直答，也不会用于写入或 Unity/Blender/MCP 多步任务。
- bridge 的 Codex 会话默认使用独立 `CTI_CODEX_HOME`，只同步认证和受控共享资源，不继承桌面全局 `mcp_servers.*`；个人 skills 会保留正常项，但默认过滤会绕过 memory v3 的旧 `github-memory-protocol`，可用 `CTI_CODEX_BLOCKED_SKILLS` 追加禁用 skill。明确记忆请求由受控 memory v3 预检处理，旧短超时会提升到 30 秒，分类超时会进入无工具 `response_only` 回合并明确说明未保存，不会写入 `C:\Users\admin\.codex\memory`。bridge 会保留健康的 Codex 状态数据库，只有诊断确认不兼容时才使用 `CTI_CODEX_RESET_STATE=true` 显式重置，避免每轮回填历史造成分类器锁死。如确实要继承全局 MCP，可显式设置 `CTI_CODEX_INHERIT_GLOBAL_MCP=true`。
- live 同步会校验运行副本里的 `@openai/codex-sdk` 版本，避免 package 已更新但 live `node_modules` 仍停在旧 Codex CLI，导致新旧 `CODEX_HOME` 状态库迁移不兼容。
- 每轮回复都会记录执行证据；如果模型声称已生成图片、创建文件、执行命令或完成 Unity/MCP 当前状态检查，但没有成功工具记录，或 `cti-final` 声明的本地文件路径不存在，bridge 会在发送前改成“未完成”并提示已拦截可能的假完成。若 provider 没有返回任何可展示最终文本，Feishu 最终卡片也会显示“未完成：模型没有返回可展示结果。”，不会只留下空白完成状态。
- `hybrid` 模式下 MCP 状态、工具和可用性询问默认先走 Codex；只有 `local_only` 或 Codex 不可用后才使用本地 MCP 动态状态兜底，不再返回硬编码入口列表。
- 原画、生成图、视频、模型等 Ignis 生成请求可走 Ignis MCP 快路径；`local_only` 模式下也允许提交和查询 Ignis 任务。
- Ignis 模型请求如果明确要求拆成 FBX/贴图，会在下载 GLB 后调用 Blender 导出脚本，并通过 `cti-final.files` 回传可上传文件。
- 本地模型只作为 Codex agent 的可选模型来源、轻量 prompt profile、模型能力检测和少数内部测试/整理入口使用；普通飞书消息不再绕过 agent 生成独立最终回复。本地轻量路由的当前 decision 名称为 `use_local_profile`，旧 `answer_local` 只作为历史 payload 兼容输入。
- 记忆关键词不再触发快捷最终回复；明确回忆/搜索类请求和符合记忆键形态的短问题会先做通用记忆规划与结构化检索。`quality=high` 的高置信结构化命中会作为 `high_confidence_evidence` 注入 agent system prompt，由 agent 按当前问题整理最终回复；关系图候选和其他低确定性结果只注入主执行链。
- 自然语言计划任务不走 provider 前关键词快路：Agent 必须区分固定通知、动态 Agent turn 和受控工具。周期任务输出 `cti-scheduled-task`；单次低风险提醒可输出 `cti-reminder` 或使用 `/remind`，随后由统一 Scheduled Task Host 创建。没有 Host success 时不能声称已创建，Codex 也不能自行写 Windows 计划任务或直接调用飞书 API 伪装完成。
- 权限主数据是 `C:\Users\admin\.claude-to-im\data\permissions.json`；面板会继续兼容并同步 `CTI_*_ALLOWED_USERS` 和 `CTI_*_OWNER_USERS`。

## 关键命令

校验扩展 manifest 和 runtime manifest：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\validate-extension-manifests.ps1
```

该校验会拦截缺少 `cwd` 的 MCP manifest；MCP 启动、健康检查、列工具和调用工具也会使用同一工作区边界，不允许通过省略 `cwd` 绕过路径门禁。

`runtime-manifest/v1` 当前用于 `service.bridge`、`service.codex`、`service.feishuCli`、`service.localLlm` 和 `tool.larkCli`。其中 `service.codex` 通过 `npm_global_package` 更新 npm 全局 `@openai/codex`；`tool.larkCli` 通过同一通用模板维护官方 `@larksuite/cli`，控制面板用它执行群列表、消息/成员查看、资源下载、测试发送和受控撤回等人工平台操作。`service.feishuCli` 保留兼容 id，但显示为 Bridge Skill 更新单元，只按安装来源自动判定走 Git 仓库拉取、复制版重装或开发版 `suite -> live skill` 同步。官方 CLI 不接管 FeishuAdapter 的 WS、OAuth、@ 判断、自动回复或 Agent 主链，也不得启动 `event consume` 与 live Bridge 竞争。复制安装会写入 `.cti-install.json` 保存来源元数据；来源未知时面板会禁用自动更新并说明原因。

控制面板能力区支持三层在线目录、HTTPS URL 预览和本机状态展示。Skills 页按 Registry 展示已安装、草稿、能力目录和审批队列，并遵守官方精选需用户确认、白名单低风险可自动处理、未知/高风险需 Owner 的规则；MCP、模型和 Plugin 分别保留原有动作。飞书 Owner 仍可用 `/ext search <关键词>`、`/ext install <关键词或id>`、`/ext remove <id>` 进入统一受控链路。精选目录写入：

模型与插件页的本地工具模型候选包括 `qwen3-coder-next:latest`、`qwen3-coder-next:q4_K_M`、`qwen3-coder:30b`、`qwen3-coder:30b-a3b-q4_K_M`、`qwen3-coder:30b-a3b-q8_0`、`qwen3:14b`、`qwen3:30b`、`qwen3:32b`、`qwen2.5:32b`；安装后可在设置页“本地 API -> 已安装模型”下拉中选择并“应用并重启”，也仍可手动输入任意 Ollama 模型名。页面会把 Ollama `/api/tags` 中已安装但不在目录里的模型补成“本机已安装”条目，支持直接使用或 `ollama rm` 卸载。默认 `qwen2.5-coder:7b` 只作为文本 / 总结能力基线，不宣称稳定工具执行能力。

```powershell
CTI_EXTENSION_CATALOG_URLS=https://example.com/codex-im-suite/catalog.json
CTI_EXTENSION_CATALOG_DYNAMIC_PROVIDERS=npm,pypi,github,huggingface,ollama,mcp_registry
CTI_EXTENSION_CATALOG_DYNAMIC_TOP_N=5
CTI_EXTENSION_CATALOG_DYNAMIC_REFRESH_HOURS=24
```

构建全部 package 和面板：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-packages.ps1
```

控制面板采用 WinForms 宿主 + WebView2 + React/Vite 前端。`build-packages.ps1` 会先构建 `apps/control-panel/web`，再发布桌面壳；如果本机缺少 WebView2 Runtime，面板启动时会显示安装提示。当前主界面支持四域导航、可操作系统蓝图、机器人架构、Prompt Snapshot、Memory/Skill 索引、统一运行单元动作、计划任务状态/历史/暂停/恢复/删除、会话详情抽屉、面板自重启，以及随窗口宽度自动重排导航、列表、详情区和设置表单。面板会读取 runtime capabilities；尚未接通 daemon 控制面的“立即运行 / 取消运行 / 仅重试投递”保持禁用并显示原因。

打包 portable 和 installer：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

`release\codex-im-suite-portable.zip` 是便携版分发包，体积通常超过 GitHub 普通 Git 单文件 100MB 限制；仓库使用 Git LFS 跟踪 `release/*.zip`，首次克隆或发布前请确认本机已安装并启用 `git lfs`。

独立检查开发版、live skill、portable 和 installer payload 是否分叉：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-release-fork-health.ps1 -Mode BackupPublish -FailOnFork
```

本机备份发布到当前分支：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-backup.ps1
```

该入口会构建开发版、同步 live skill、组装 release、生成摘要、提交并推送当前分支。它用于个人运行副本备份，不作为 `main` 主干门禁。

发布链路会在打包后执行分叉体检，比较关键文件 hash、manifest、构建时间、来源 commit 和 `.suite-release.json` 指纹；发现开发版、live skill、portable 或 installer payload 漂移时会中止，不会继续提交或推送。覆盖发布产物、portable、installer 或 live skill 前，脚本默认会自动结束目标目录内正在运行的进程后继续更新；如果需要保留旧的阻断行为，可传 `-NoForceUpdate` 或设置 `CTI_RELEASE_FORCE_UPDATE=false`。

主干发布预检：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-main-release.ps1
```

该入口会校验扩展协议、检查架构文档、构建、打包、执行 portable / installer payload 分叉体检并生成发布摘要；不会同步 live skill，也不会自动 `git commit`、`git push` 或打 tag。确认 release notes 后再手动提交，并用 `v0.2.0` 这类 tag 标记稳定发行。

主干发行打标签：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-main-release-tag.ps1
```

该入口只允许在干净工作区打当前 suite 版本 tag，默认要求位于 `main`；如需在 release 分支试跑，必须显式加 `-AllowNonMain`。

同步项目内 skills 到本机 Codex：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-suite-skills.ps1
```

注册 MCP 到 Codex：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-external-mcps.ps1
```

检查 Ollama：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-llm\healthcheck-local-llm.ps1
```

首次使用默认模型：

```powershell
ollama pull qwen2.5-coder:7b
```

旧记忆规则归档 dry-run：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\memory\archive-legacy-rules.ps1
```

历史乱码扫描和修复入口：

```powershell
# 只扫描 CTI_HOME 和记忆仓库里的典型 mojibake
powershell -ExecutionPolicy Bypass -File .\scripts\repair-history-mojibake.ps1

# 应用修复，自动写入回滚 manifest，并重建 knowledge/reminders 索引
powershell -ExecutionPolicy Bypass -File .\scripts\repair-history-mojibake.ps1 -Apply

# 按 manifest 回滚
powershell -ExecutionPolicy Bypass -File .\scripts\repair-history-mojibake.ps1 -Restore C:\Users\admin\.claude-to-im\backups\mojibake-repair\<stamp>\manifest.json
```

修复器会扫描 `data\messages`、`data\message-archives`、`data\feishu-history`、Feishu/记忆相关索引、记忆 Markdown，以及记忆仓库 `data\im` / `data\projects` 下的长期 JSON 资产，识别典型 UTF-8 被 GBK、Latin-1 或替换字符错读后的文本。运行时的 Feishu 历史检索、Markdown 知识索引和待办提醒派生也会先修复或跳过仍无法确认的坏文本，避免继续把乱码喂给 Codex 记忆上下文、表情包语义或提醒推送。

待办主动提醒默认关闭。启用前，记忆 Markdown 里的待办需要带来源会话和提醒时间，例如：

```markdown
---
channelType: feishu
chatId: oc_xxx
displayName: 项目群
---

待办: 整理方案 @2026-04-29 18:30 状态: 未完成
```

配置入口：

```powershell
CTI_TODO_PUSH_ENABLED=true
CTI_TODO_PUSH_CHANNELS=feishu
CTI_TODO_PUSH_POLL_MS=60000
CTI_TODO_PUSH_WINDOW_MS=300000
```

运行时会从 `.cti-index\knowledge.json` 派生 `.cti-index\reminders.json`，并用 `.cti-index\reminder-state.json` 记录已发送、失败、跳过和完成状态，避免重复推送。来源会话无法确认、状态不是未完成或缺少提醒时间的待办不会发送，只会在面板“记忆”页标注原因。飞书提醒优先发互动卡片，用户点击“完成”后会走 `card.action.trigger` 回调更新本地 Markdown 和状态文件；面板也提供同一套完成入口。知识单元可在面板归档，归档会从源 Markdown 精确移除该行并写入 `archive\knowledge-units`，归档目录不会重新进入索引，归档项可手动恢复或永久删除；整理草稿应用前会检查索引时间戳，防止旧草稿批量改动新索引。

## 统一计划任务

飞书自然语言示例：

```text
定个任务，每个工作日早上十点半给我发一下每日的单子。
每天 18:00 提醒我提交日报。
```

第一条会创建 `cron 30 10 * * 1-5 + Asia/Shanghai` 的动态 `agent_turn`；第二条属于固定 `notify`。单次低风险提醒继续兼容：

```text
/remind 10分钟后 看电脑
/remind 2026-04-29 19:42 看电脑
```

运行态和配置：

```powershell
CTI_SCHEDULED_TASKS_ENABLED=true
CTI_SCHEDULED_TASKS_POLL_MS=15000
CTI_SCHEDULED_TASKS_MAX_CONCURRENT_RUNS=4
CTI_SCHEDULED_TASKS_FAILURE_ALERT_AFTER=3
CTI_SCHEDULED_TASKS_FAILURE_ALERT_COOLDOWN_MS=3600000
```

任务定义、状态、运行记录、隔离区和迁移清单统一位于 `CTI_HOME\data\scheduled-tasks`。当前调度 tick 仍按安全串行方式执行；`MAX_CONCURRENT_RUNS` 和连续失败告警配置已经保留，但并发与主动告警尚未开放为完成能力，面板和文档不把它们伪装为已生效。

CLI 示例：

```powershell
node .\packages\bridge-runtime\dist\scheduled-task-cli.mjs status --json
node .\packages\bridge-runtime\dist\scheduled-task-cli.mjs list --json
node .\packages\bridge-runtime\dist\scheduled-task-cli.mjs history <taskId> --json
```

旧 `data\todos\direct-reminders\*.md` 只读兼容。迁移默认 dry-run，不写 Store：

```powershell
node .\packages\bridge-runtime\dist\scheduled-task-cli.mjs migrate-direct-reminders --memory-root E:\cli-md --json
```

审核 `create / skip / blocked` 后先停止 Bridge 和记忆 watcher，再显式加 `--apply`。Apply 会重新校验 source hash、备份旧文件、冲突不覆盖，并记录迁移清单；新提醒不再写入记忆 Markdown。

飞书云文档读取默认支持 Docx、Sheets 和 Base/多维表格。bridge 会先用应用 `tenant_access_token` 读取；只有应用身份无法访问且当前任务确实需要读取发起人的私有资源时，才给该发起人发送飞书 OAuth 登录卡片，使用该用户自己的文档权限读取内容。普通消息、原生 @、reply、reaction、sticker 和机器人卡片继续走 bot 长连接，不向普通用户索权。不使用 owner 代读，也不自动替用户加权限。应用 token 首试不需要公网回调；用户 OAuth fallback 支持公网回调模式，也支持无公网的手动 code/state 回传模式。飞书开放平台需要给应用申请只读权限：

```powershell
CTI_FEISHU_GRANTED_SCOPES=im:message,im:message:receive_v1,im:resource,im:message.group_msg,im:message.reactions:write_only,im:message.reactions:read,cardkit:card:write,cardkit:card:read,im:message:update,docx:document,docx:document:readonly,drive:drive,drive:drive:readonly,offline_access,sheets:spreadsheet:readonly,sheets:spreadsheet:read,bitable:app:readonly,base:table:read,base:field:read,base:record:retrieve
CTI_FEISHU_OAUTH_MODE=manual
CTI_FEISHU_OAUTH_PUBLIC_BASE_URL=https://bot.example.com
CTI_FEISHU_OAUTH_MANUAL_REDIRECT_URI=http://127.0.0.1:17321/feishu/oauth/callback
CTI_FEISHU_OAUTH_CALLBACK_PATH=/feishu/oauth/callback
CTI_FEISHU_OAUTH_CALLBACK_PORT=17321
CTI_FEISHU_OAUTH_SCOPES=offline_access,docx:document:readonly,sheets:spreadsheet:readonly,bitable:app:readonly
CTI_FEISHU_CLOUD_MAX_CHARS=80000
CTI_FEISHU_CLOUD_MAX_ROWS=500
CTI_FEISHU_CLOUD_MAX_RECORDS=500
CTI_FEISHU_CLOUD_MAX_SHEETS=5
```

`CTI_FEISHU_GRANTED_SCOPES` 是本地记录“已经在飞书开放平台开通并发布过的权限”的诊断清单，不是密钥，也不会替应用自动开通权限；Owner 可以在飞书里发 `/feishu` 查看当前能力矩阵、应用 token 直读能力、OAuth fallback 请求 scope 和声明的权限缺口。后台新增权限、事件或回调后，必须创建版本、管理员审核发布，并重启 bridge；`admin:app.*` 应用管理员权限只能用于管理员身份诊断，不能替代云文档、消息、卡片、成员或资源 API scope。OAuth 使用飞书官方授权页 `https://accounts.feishu.cn/open-apis/authen/v1/authorize`、PKCE 和当前 Token 端点 `https://accounts.feishu.cn/oauth/v3/token`；授权页、Token 换取和刷新都只携带当前任务需要的规范化 scope。自定义治理层按飞书 sender 身份隔离加密 token 和 state；同一用户、同一组 scope 的并发或重复任务只发送一张授权卡，后续任务合并到同一授权请求，成功后按原消息逐个恢复并记录审计。`CTI_FEISHU_OAUTH_MODE=manual` 时不需要公网入口，bridge 会启动本机 `127.0.0.1:${CTI_FEISHU_OAUTH_CALLBACK_PORT}` 回调监听；如果用户在运行 bridge 的同一台 Windows 机器浏览器里完成授权，会自动回调、保存 user token、回复“已收到，正在处理中。”并续跑等待任务。如果用户在手机或另一台电脑打开授权页，`127.0.0.1` 指向用户自己的设备，无法自动连到 bridge，此时需要把浏览器地址栏里的完整 `code/state` 回调 URL 复制回飞书，bridge 会走同一套校验和续跑逻辑。callback 模式才需要 `CTI_FEISHU_OAUTH_PUBLIC_BASE_URL + CTI_FEISHU_OAUTH_CALLBACK_PATH`，且必须和飞书应用后台登记的 OAuth redirect URI 一致。用户 token 保存在 `C:\Users\admin\.claude-to-im\data\feishu-oauth-tokens.json`，Windows 下使用 DPAPI 加密。

本轮权限映射按飞书开放平台服务端 API 文档整理：Docx 读取走 `docx/v1/documents/:document_id/raw_content`，Sheets 先 `sheets/query` 再读范围，Base 读取 tables / fields / records。遇到 401/403 或飞书权限错误码时，bridge 会同时提示“用户没有文档访问权限”和对应 API 所需 scope，避免只给 404/空总结。若已有 user token 因新开通 Sheets/Drive scope 而过期失配，bridge 会重新发送授权卡片刷新 token；刷新后仍失败才按文档权限或开放平台权限阻断处理。

Token 存储按“用户 + scope grant”选择最小覆盖项；同一用户的 Docx、Sheets、Base 授权可以并存，不会因后一次授权覆盖前一份 Token。旧版以 userId 为唯一键的 Token 文件仍可读取，下一次成功授权后会迁移到 grant 格式。

启动 Ignis MCP：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ignis-mcp.ps1
```

Ignis CLI 配置只放在本机 `C:\Users\admin\.ignis\config.json`，不进入仓库、release 包或日志。项目内只保存 skill 和 MCP wrapper。

大文件下载链路：

```powershell
# 超过飞书 30MB 限制时，优先创建飞书云文档并把文件作为附件挂进去，再回文档链接
CTI_ARTIFACT_UPLOAD_MODE=feishu_docx
CTI_FEISHU_DOCX_LINK_SHARE_ENTITY=tenant_readable
CTI_FEISHU_DOCX_EXTERNAL_ACCESS_ENTITY=closed

# 备用方案：复制到公网目录并回下载链接
# CTI_ARTIFACT_UPLOAD_MODE=local_http
# CTI_ARTIFACT_PUBLIC_BASE_URL=https://files.example.com
# CTI_ARTIFACT_PUBLIC_DIR=C:\artifact-publisher\public
# CTI_ARTIFACT_PUBLIC_SUBDIR=bridge-artifacts
```

手动拆分 GLB 为 FBX 和贴图：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\export-glb-asset-package.ps1 -SourceGlb "C:\path\to\model.glb"
```

检查架构文档是否需要同步：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\update-architecture-docs.ps1
```

## 运行版同步

当前 live skill 仍位于：

- `C:\Users\admin\.codex\skills\claude-to-im`
- `C:\Users\admin\.codex\skills\claude-to-im-core`

仓库里的源码是主版本。需要更新 live 版本时，使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-live-skill.ps1
```

该脚本方向固定为“开发版 suite -> live skill”。如确实需要从 live 救回改动，使用 `scripts/import-live-to-suite.ps1 -Apply`，不要把它接入发布流程。

同步脚本会先构建 `packages/bridge-core` 和 `packages/bridge-runtime`，再复制源码和 `dist` 到 live，避免 live bridge 继续运行旧 bundle。

发布脚本会先构建开发版，再同步 live、组装 portable 和 installer，并用 `test-release-fork-health.ps1` 阻断“开发版”“运行版”和“打包版”漂移。

## GitHub

仓库地址：[dddfuxi/codex-im-suite](https://github.com/dddfuxi/codex-im-suite)

分支定位：

- `main`：稳定产品主干，只保留可复现源码、通用扩展协议、默认示例和文档。
- `codex/dev`：日常集成分支。
- `codex/<topic>`：功能分支前缀。

合入 `main` 前应完成构建、测试、扩展 manifest 校验、架构文档检查、发布摘要和疑似密钥扫描。个人 live skill 更新可以更频繁，但只从已验证的开发版同步，不反向覆盖主干。
