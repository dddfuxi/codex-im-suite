# codex-im-suite 开发记录

更新时间：2026-04-28

本文记录当前项目已经完成的主要改造和后续维护注意事项。详细架构见 [PROJECT-ARCHITECTURE.md](./PROJECT-ARCHITECTURE.md)。

## 1. 项目收口

已完成：

- 建立 `codex-im-suite` 作为统一开发和发布目录。
- 安装 `project-architecture-diagram` 到项目内扩展目录，并加入 `config/skills.d`。
- 新增 `scripts/update-architecture-docs.ps1`，用于发布前或架构变更后检查架构文档维护状态。
- 将原先分散的桥接核心、运行时、MCP、控制面板、安装器收口到 `packages` 和 `apps`。
- 建立 `suite.manifest.json` 作为发行层总清单。
- 建立 `publish-backup.ps1`，发布前自动同步、打包、生成摘要、提交并推送。
- 建立 `publish-summary.md` 和 `release-notes.md`。
- 新增 `scripts/doctor-suite-targets.ps1`，用于检查开发版、live skill、portable、installer 和面板 exe 的职责与漂移情况。
- 新增 `scripts/test-release-fork-health.ps1`，发布前比较开发版、live skill、portable、installer payload 的关键文件 hash、manifest、构建时间、commit 和 `.suite-release.json` 指纹；发现分叉时中止发布。
- 将 `scripts/sync-live-skill.ps1` 收口为“开发版 suite -> live skill”方向，避免 live 反向覆盖开发版。
- 新增 `scripts/import-live-to-suite.ps1` 作为手动救回 live 改动入口，默认 dry-run，不进入发布流程。
- 移除 `packages/bridge-runtime/tools/ControlPanel` 和 `packages/bridge-runtime/tools/Installer` 旧副本，避免面板和安装器源码入口混淆。
- 将 suite 版本提升到 `0.2.0`，并在 `suite.manifest.json` 中声明 `extension-manifest/v1`。
- 给 `config/mcp.d`、`config/skills.d`、`config/plugins.d` 补齐统一扩展字段：`version`、`compatibility`、`category`、`optional`、`installState`、`source` 和 `aliases`。
- 新增 `scripts/validate-extension-manifests.ps1`，构建和 MCP 注册前都会先校验扩展 manifest。
- 新增 `scripts/package-main-release.ps1` 和 `scripts/prepare-main-release.ps1`，主干发布预检不再同步 live skill，也不自动提交、推送或打 tag。
- 新增 `scripts/create-main-release-tag.ps1`，打 tag 从预检流程拆出，只允许在干净工作区和稳定分支上执行。
- 控制面板升级为 WinForms 宿主 + WebView2 + React/Vite 前端；旧 WinForms 控件退为宿主状态层，前端通过白名单命令协议调用本机脚本和状态读取。
- 控制面板新增 `apps/control-panel/web` 前端源码、GPT 生成的无文字 PNG 氛围素材和 WebView2 Runtime 降级提示。
- 控制面板新增 Control API 宿主：桌面壳启动本机 HTTP API 并加载同一套 React 页面；普通浏览器可通过 HTTP/SSE 查看状态、会话详情、图片、workflow 和权限数据。
- 新增 `scripts/start-control-api.ps1`，用于本机或服务器启动 API-only 模式。默认只监听 `127.0.0.1`，远程监听必须配置 token，远程高危命令需要额外显式开启。
- 桌面面板的 Control API 启动已补端口冲突保护：本机 loopback 模式下如果默认 `8788` 被占用，会自动尝试后续端口，避免多开面板时直接弹未处理异常；远程显式监听仍保持严格失败。
- `build-packages.ps1` 会先构建控制面板 Web 前端，`assemble-portable.ps1` 会复制完整控制面板发布目录，确保 `wwwroot` 和 WebView2 运行依赖进入 portable/installer。
- `assemble-portable.ps1`、`build-installer.ps1` 和 `sync-live-skill.ps1` 在覆盖运行副本或发布产物前会检查目录下是否有运行进程占用；命中时输出 PID 和路径并停止，不自动 kill。
- 控制面板把发布入口拆成“本机备份发布”和“主干发布预检”，版本卡片显示 suite 版本、扩展协议、启用扩展数量、缺失依赖和本机配置覆盖数量。
- 控制面板主界面已切到无底图运营台样式，支持白天 / 夜晚主题切换，并按窗口宽度自适应切换侧栏、顶部工具条、概览卡片和详情区布局。
- 控制面板第二轮改造已完成：服务、Codex CLI、本地辅助执行器、MCP、扩展 manifest 统一抽象成运行单元卡片，WebView 通过 `runtime.listUnits` / `runtime.invokeAction` 渲染和执行动作。
- 会话页新增详情抽屉，支持直接查看完整消息流、复制摘要和复制消息文本，不再强依赖旧 WinForms 会话查看器。
- 会话详情抽屉补齐图片和附件查看：宿主会读取 Feishu 原始消息资源键，下载图片/文件到本机 `runtime/control-panel-media` 缓存，并通过 WebView2 虚拟域 `control-panel-media.local` 给前端加载。前端展示图片缩略图、附件名称、大小、MIME、路径和下载状态，不再把图片简单显示成占位文本。
- 会话详情新增“刷新详情”，会绕过宿主详情缓存重新读取历史和附件；旧索引只要图片/文件消息缺少资源键，也会触发会话级远端重同步，避免长期停留在 `[图片]` 占位。
- 会话详情对旧本地消息增加只读显示修复：检测到 `鍖/涓/妫/杩/€` 等典型 UTF-8 被 GBK 错读的 mojibake 时，使用 Windows 936 代码页还原后展示，不改写原始历史 JSON。
- 会话详情新增运行历程回溯：按 `sessionId` / `chatId` 关联 workflow run，展示 executor、阶段、状态、prompt 摘要和事件时间线，便于排查一次请求是否卡在授权、路由、执行、收尾或回传阶段。
- 飞书图片出站收紧：不再从最近 assistant 历史消息里自动捞旧图片随新回答发送；只有当前 `cti-final.images` 或当前回复文本明确出现的本地图片路径会被发送，避免 Unity 截图任务失败时重复发旧截图。
- 回复风格快捷预设改为点击即保存到 `CTI_REPLY_STYLE_HINT`，避免前端临时状态被后续 `state.refresh` 用旧配置覆盖。
- 设置页恢复目录选择和回复风格快捷设置：路径字段支持拖拽、目录选择、快速打开；回复风格支持预设、当前摘要和本地 AI 整理入口。
- bridge-core 新增纯闲聊短路：问候、感谢、确认等不含任务意图的消息直接自然回复并记录会话，不再启动 Codex/本地模型执行链。
- bridge-runtime 新增 `memory-profiles.json` 轻量记忆画像：按用户 ID、聊天和全局 scope 汇总事实/偏好、近期主题和待跟进项；普通消息和 Feishu 历史同步都会增量更新。
- Codex 上下文记忆注入改为“会话摘要 + profile 命中 + Feishu 历史命中”的检索式组合，继续受字符预算限制，避免把全部记忆一次性注入导致 token 膨胀。

当前约定：

- 以后开发优先改 suite 目录。
- live skill 通过同步脚本生成。
- 完成发布脚本改动后，同步当前使用版本时仍只允许执行 `scripts/sync-live-skill.ps1`，方向固定为开发版 suite -> live skill。
- 本机备份发布可以同步 live skill 并推送当前分支；合入 `main` 前必须走主干发布预检。
- `main` 是稳定产品主干，`codex/dev` 是日常集成分支，功能分支使用 `codex/<topic>`。
- 面板源码唯一入口是 `apps/control-panel`；安装器源码唯一入口是 `apps/installer`。

## 2. Feishu 桥接

已完成：

- Feishu 文本、Markdown card、图片发送、群聊 reply 支持。
- 群聊中回复某条消息时支持原生 reply，并可 @ 提问人。
- Markdown 输出统一走 Feishu card，避免纯文本表格错乱。
- 结果块协议 `cti-final` 已接入，避免桥接再靠猜测裁剪最终回复。
- p2p 私聊双通道接收：WS 长连 + 历史轮询补捞。
- 私聊 `chatId` 主键保留，新增 `userId -> latestChatId` 兜底别名索引。
- 新增 supervisor 常驻，bridge 掉进程后自动拉起。
- 新增运行时审计文件 `bridge-runtime-audit.json`。

最近重点修复：

- 面板假在线问题：状态不再只信旧 `status.json`。
- 私聊漏事件问题：新增 p2p 补捞，轮询间隔已降到 5 秒，并在启动时立即补捞一次。
- 出站卡住问题：Codex SSE error/result.is_error 现在会触发本地兜底，不再把原始报错发给用户。

## 3. Codex 与本地模型策略

当前策略：

- Codex 是主脑。
- 本地模型是辅助执行器和兜底。
- 本地模型不再作为默认中枢先判断所有请求。

已完成：

- 本地 llama.cpp 接入。
- 本地执行器支持 shell、git、文件读写、文本搜索。
- `hybrid / local_only / codex_only` 三种模式。
- Codex 失败时切本地兜底。
- 本地兜底处理记忆类请求时，会先检索本地记忆和 Feishu 历史命中片段。
- 本地模型不能伪造“已执行 / 已修改 / 已导入 / 已创建”结果。
- Ignis 创意生成请求可走本地模型快路径，`local_only` 模式下也能提交和查询 Ignis 任务。
- 本地快路径新增统一前置判定层：进入 Ignis、MCP、本地执行器前，先判定当前消息是询问、只读查询、明确操作还是歧义混合；歧义默认按询问处理，不直接做 mutating 操作。
- Ignis、MCP、本地执行器不再各自用散落正则单独决定“是否执行”；统一复用 `fast-path-intent` 内部判定模块。
- `git status`、读文件、搜索文本现在可作为只读查询由本地执行器直接处理；`git pull`、`git fetch`、写文件等 mutating 操作必须命中明确动作语义才会执行。
- 中文仓库查询的只读命中已补齐，但 `hybrid` 模式下不再默认由本地先接；“帮我看看 git 状态”“当前分支是什么”“最近几条提交”现在默认先交给 Codex，只有 Codex 不可用时才回退到本地 repo fast-path。
- 文件读取 / 搜索文本在 `hybrid` 模式下同样改成 Codex 优先，本地只保留窄兜底。
- `关机`、`shutdown`、重启机器等系统级动作已加入高风险排除列表，不允许本地辅助器省流接管。
- bridge 重启时现在会清空本地辅助执行器的瞬时 fallback / refusal 状态，控制面板不再把历史 `You've hit your usage limit...` 之类旧兜底文案当成当前异常显示。
- 控制面板服务状态卡的颜色判定已收紧为“首行状态 + 明确故障短语”优先，不再因为统计项里出现“失败 3”这类历史计数就把本地辅助执行器误标成“异常”。
- bridge-runtime 启动阶段现在会立即写入 executor 基线状态，避免首次请求前 `executor-status.json` 缺失导致执行器页或辅助器状态缺少依据。
- 本地执行计划器新增 `rg` 降级保护：简单 `rg ... "pattern"` shell 计划会转换成内置 `search_text`，并在提示词里要求读取/搜索优先使用受控工具，减少 Windows 上 `rg.exe` 被拒绝执行造成的本地辅助失败。
- MCP 快路径继续收紧：带 `unitymcp` / `blendermcp` 但实际要求检查场景、节点、Prefab、模型、截图或导入导出的任务，不再被本地辅助当成 MCP 状态查询抢答，必须交回 Codex 做正式工具编排。
- fast-path 执行前判断改为硬约束：Ignis handler 先判断 intent 再读取 manifest / 健康检查；旧 MCP handler 全部委托到新版 preflight，避免老入口继续用散落正则绕过判断。
- Skill、Codex prompt 和本地兜底 prompt 已补“解决问题优先”约束：工具类任务不能用通用步骤、示例表格或样例脚本代替真实执行；没有真实工具结果时必须明确说未完成和具体阻塞点。
- 工具任务降级已加硬收口：Codex/MCP 执行链失败后，Unity/Blender/MCP/文档类请求直接返回确定性阻塞原因，不再交给本地模型生成“请手动检查”的教程式回复；bridge-core 出站前也会拦截这类外包式文案。
- Codex/桥接提示词补齐 Unity 截图和 MCP 握手约束：截图类任务不得用扫描到的历史截图冒充当前刷新结果；`/mcp` 返回 406 时按“服务在线但缺 MCP Accept 握手头”处理，必须重试正式 initialize/list-tools 流程后才能判定不可用。
- Codex provider 已补模型隔离：bridge 生成自己的 Codex Home 时剔除全局 `model = ...`，并支持 `CTI_CODEX_MODEL` 运行时覆盖。当前本机 Codex CLI 已从 `0.121.0` 升级到 `0.125.0`，`gpt-5.5` 已通过最小请求验证；live 版当前显式设置 `CTI_CODEX_MODEL=gpt-5.5`。

当前限制：

- Unity/Blender/MCP 多步任务不交给本地模型做主脑。
- 本地模型适合轻任务，不适合复杂规划。
- 记忆类兜底依赖已有本地索引和检索命中质量。
- Ignis “再发 / 重发 / 补发上次结果” 现在优先从本机持久化的 session/fileIds 直接回传，不再误判成新生成，也不附带远端助理的长段解释文本。

## 3.1 Workflow / Executor 平台第一阶段

截至 2026-04-25 已完成：

- 新增 root npm workspace，先把 `bridge-runtime` 对 `bridge-core` 的依赖从本机 junction 改为仓库内 `file:../bridge-core`，降低不可复现风险。
- 新增 `ExecutorManifest`、`ExecutorRequest`、`ExecutorSelection`、`ExecutorRun` 和 `ToolSandboxPolicy` 类型，为 Codex、Claude CLI、本地模型 agent、未来 MCP/外部 agent 留出统一声明接口。
- 新增 `ExecutorRegistry` 和自动路由：支持 capability 推断、显式 `@codex` / `@claude` / `@local` 覆盖、会话默认 executor、当前真实 provider 偏好。
- 新增 `workflow-runs.json` 状态存储，记录 `received -> authorized -> contextualized -> routed -> executing -> delivered/failed` 的第一阶段状态事件。
- 新增 `executor-status.json` 和 `executor-session-defaults.json`，供控制面板读取执行器目录、最近路由和会话默认设置。
- bridge-runtime 的 provider 入口已接入 workflow 观测；Codex / Claude / 本地 hub 请求都会在运行时留下 executor selection 和 workflow run。
- 控制面板新增“执行器”页和只读 WebView 命令：`workflow.listRuns`、`workflow.getRun`、`workflow.getEvents`、`executor.list`、`executor.check`、`executor.setSessionDefault`。
- 新增 executor registry 和 workflow status 单测，覆盖执行器注册、显式覆盖、自动路由、sandbox 策略、workflow 成功和失败记录。

当前限制：

- 这一阶段是 strangler migration 的外壳层：真实执行仍复用现有 provider / local agent 实现，尚未把每个执行器拆成独立 adapter 文件。
- workflow 当前只做可观察状态机，不做进程重启后的自动续跑。
- `cti-final` 解析、Markdown card、图片/文件、大文件交付和 owner 二次确认仍在旧链路内，后续需要逐步挂到 workflow event。
- 本地模型 agent 已有 sandbox policy 声明，但工具执行层仍需继续从 `local-agent-provider.ts` 拆出独立 tool sandbox。
- `codex_only` 或部分早退路径仍可能只有 provider 级执行，没有完整业务阶段细分；后续应把权限等待、finalizing 和 delivered 结果收口补齐。

## 4. MCP 管理

已完成：

- `config/mcp.d` manifest 驱动。
- 控制面板自动发现 MCP。
- 每个 MCP 自动获得启动、停止、检查、注册、打开目录等动作。
- MCP 状态区分托管进程和宿主服务。
- HTTP MCP 的 406/405 等协议探测响应视为“服务在线”。
- Unity / Blender stopLauncher 已补。
- MCP 工作目录校验已加到桥接层。

当前 MCP：

- `unityMCP`
- `blenderMCP`
- `pictureMCP`
- `unityPrefabMCP`
- `ignisMCP`

当前扩展协议：

- `extension-manifest/v1` 由 `suite.manifest.json` 声明。
- MCP / skill / plugin manifest 使用统一字段管理版本、兼容范围、分类、安装状态和来源。
- MCP 快路径按 manifest 的 `aliases`、`displayName`、`id` 动态匹配目标，不再在本地执行器里维护固定 MCP 名称列表。

最近重点修复：

- 本地辅助执行器不再把“呼起 Unity 并截图”误判成 MCP 状态检查。
- 只允许明确 MCP 运维小活走本地 MCP 快路径。
- MCP 的 `cwd` 必须命中当前默认工作区、允许根目录或 Unity 工程路径，防止串到别的项目。

## 4.1 Ignis 创意生成接入

已完成：

- 安装并初始化本机 `ignis-agent-cli`。
- 将远端 Ignis skill 固化为项目内 `extensions/skills/ignis-cli`，并同步到本机 Codex skills。
- 新增 `packages/mcp-ignis`，同时提供 HTTP MCP 和 stdio MCP。
- 新增 `config/mcp.d/ignis-mcp.json` 和 `config/skills.d/ignis-cli.json`。
- 新增 `scripts/launch-ignis-mcp.ps1` 和 `scripts/stop-ignis-mcp.ps1`。
- `scripts/register-external-mcps.ps1` 支持 HTTP MCP 注册。
- 本地模型新增 Ignis fast-path，支持原画、图片、视频、模型、结果查询、等待完成和继续上一版。
- 飞书 chat/session 的 Ignis 会话映射保存到 `C:\Users\admin\.claude-to-im\runtime\ignis-sessions.json`。
- 收紧 Ignis 意图识别：状态/安装/配置问题只检查可用性，不再误提交生成任务。
- 继续收紧 Ignis 意图识别：“最近几次 / 历史 / 整理成列表” 优先走历史列表，不再因为句子里有 “检查” 就误落到状态查询。
- “再发我一下上次 Ignis 生成的模型文件 / 重发结果” 现在优先走结果回传，不再被误判成新生成请求。
- Ignis 回复改为 `cti-final` 结果块，飞书只看到短文本和图片/文件，不再裸发 CLI JSON。
- 生成任务提交后会等待结果并下载 Ignis 资产，完成时自动随回复回传；超时才提示用户稍后查询。
- 修复参考图回传误判：Ignis 回复只回传 `artifact_summary` / tool output 中的生成文件，不再把用户上传的 `input.file_ids` 当作生成结果发送。
- Feishu 适配器补齐本地文件上传，Ignis 生成的 `.glb` 等非图片资产会作为飞书文件回传，不再降级为本地路径文本。
- 超过飞书 IM 单文件上传限制的 Ignis 资产不再伪装成已回传文件，会改为发送可下载链接和限制说明。
- 如果本地文件上传失败，bridge 会给用户发出文件名和失败原因，不再只在日志里静默失败。
- Feishu 回复消息如果指向上一条图片/文件，bridge 会尝试读取被回复消息并把附件带入本次请求。
- Ignis fast-path 仅在“该/这张/刚才/上一版/继续”等明确引用时复用上一轮 session 和参考图；普通新请求默认新开会话，避免串到旧图。
- 新增 Ignis 模型资产后处理：用户明确要求“模型拆成 FBX 和贴图”时，bridge 会下载 Ignis GLB/GLTF，调用 `scripts/export-glb-asset-package.ps1` 通过 Blender 导出 `unity/Model`、`unity/Textures`、`unity/Materials` 和 `manifest.json`，再用 `cti-final.files` 回传未超限文件。
- Ignis 模型后处理的飞书回传现在只默认交付用户真正需要的 `FBX + 贴图`；`manifest.json` 和 `*.mat.json` 保留为本机内部辅助文件，不再误发给用户。
- 本地文件出站改成正式的大文件交付链路：`cti-final.files` 中单文件超过 30MB 时不再分卷，而是改走 artifact delivery provider。当前飞书优先支持 `feishu_docx`，会自动创建新版云文档、把超限文件作为附件挂入文档并返回文档链接；也保留 `local_http` 作为公网目录备用方案。未配置上传服务时明确提示配置缺失。

当前约束：

- Ignis config 和 token 只保存在 `C:\Users\admin\.ignis\config.json`。
- 用户提供的 config 链接不写入仓库、不写入日志、不进入 release 包。
- 生成任务默认异步返回，避免飞书请求长时间阻塞。
- 如果用户上传飞书附件，bridge 只负责把已落地的文件上传为 Ignis 参考文件，不由本地模型理解图片内容。
- FBX/贴图拆分依赖本机 Blender；未安装 Blender 或未设置 `BLENDER_EXE` 时，只回报拆分失败原因，不影响 Ignis 原始模型生成结果。

## 5. Unity / Blender 工作流

已完成：

- Unity MCP manifest 和启动脚本。
- Blender MCP manifest、addon 下载说明、启动/停止脚本。
- `blender-mcp-glb-unity-pipeline` skill。
- GLB/GLTF 资产整理到 Unity 的流程说明和脚本。

关键约束：

- 默认 Unity 项目为 `C:\unity\ST3\Game`。
- “运行游戏”默认指可玩入口场景，不把美术预览场景当游戏运行结果。
- 截图类任务必须走 Game 视角或明确指定视角，不能抓错别的 Unity 工程窗口。
- 默认只回发用户要求的图片数量，通常是一张。

## 6. 控制面板

已完成：

- 主窗口收口为服务总览、MCP 列表、面板日志和常用工具入口。
- 顶部 ToolStrip 提供刷新状态、一键发布、设置、查看会话、同步历史等日常入口。
- MCP 列表 / 日志可拖拽分割。
- 每个服务卡内放对应操作按钮。
- 显示版本、构建时间、commit、当前 exe 路径、suite 根目录。
- 一键发布前显示变更摘要。
- 打开最近发布摘要和发布历史。
- 路径配置、机器人回复风格预设、自定义风格和本地 AI 整理已移入“设置”弹窗。
- “查看会话”弹窗使用页签承载会话记录、历史索引检索和同步状态。
- 本地辅助执行器状态和路由摘要。
- Feishu WS、私聊补捞、最后阶段、最后活跃请求显示。
- WebView 会话详情支持手动删除会话。删除会写入本机面板墓碑记录，当前列表立即隐藏该会话；如果远端会话后续产生新更新时间，下一次同步/刷新会重新拉回。
- WebView 会话详情现在支持图片缩略图和附件状态展示；旧索引缺少媒体元数据时会尝试重新同步远端会话历史，失败时保留可解释的下载失败状态。
- WebView 会话详情现在展示关联 workflow run 和事件时间线，配合执行器页可以从单条会话追溯到具体路由和运行阶段。
- 群聊会话详情加载改为“消息流优先”：历史消息先快速返回，附件优先使用本地缓存，只对最近附件做有限下载，避免大群图片过多时详情请求被媒体下载长期阻塞。
- 飞书历史同步合并旧索引时按 `messageId` 去重，兼容早期历史文件里同一消息同时存在大小写字段版本的情况，避免群聊详情因重复 key 直接加载失败。
- 飞书 `interactive` 卡片详情展示会识别“请升级至最新版本客户端”等客户端兜底文案，并优先用 `audit.json` 中同 `messageId` 的发送摘要回填，避免卡片消息只显示不可读占位。
- WebView 权限管理升级为三档角色模型：新增 `permissions.json` 权限库和“权限”页，支持按渠道、角色、名称或 ID 管理 `Viewer`、`Operator`、`Owner`，并从最近会话参与人添加权限。
- WebView 会话详情里的 Feishu ID 快捷 owner 按钮已改为“设置权限”，直接写入统一权限库；消息会显示发送者 open_id 和飞书显示名，权限变更同步兼容 env 并可重启 bridge 立即生效。
- WebView 扩展页已按 `MCP / Skill / Plugin / 其他扩展` 分类展示，不再把 manifest 和 MCP 运行单元混成一张“统一扩展 / MCP 清单”。
- WebView 扩展页已补齐安装入口：skill 通过 `scripts/install-suite-extension.ps1` 同步到本机 Codex skills，带 `installer` 的 MCP 会显示“安装”按钮并走宿主白名单安装脚本。
- WebView 扩展页已新增“导入本地目录”：支持选择或拖入目录，识别为 skill / mcp，预览将写入的 manifest，再一键导入到 suite 清单。
- WebView 扩展页的 MCP 状态显示已改为按健康检查、Codex 注册和托管进程综合判断；HTTP 在线或已注册的 MCP 显示为可用，不再把 `bundled` / `external` 安装来源误显示成“待处理”。
- Unity MCP 面板检查已细分为 endpoint、MCP initialize、Unity instances/session 三层；`/mcp` 裸 406 或 HTTP 可达不再被视为可执行可用，Unity session 不可用会明确显示失败或超时。该三层 Unity 检查只应用于 Unity MCP，Ignis 等非 Unity HTTP MCP 不再读取 `mcpforunity://instances`。
- Unity MCP 运行单元的“启动”动作在 HTTP 外部宿主场景下改为“修复”，会重启 `mcp-for-unity` helper 并复用 Unity 工程里的 `Library\MCPForUnity\TerminalScripts\mcp-terminal.cmd`。
- bridge-runtime 的 Unity MCP 预检也改为真实 MCP initialize + `mcpforunity://instances`，只有 `instance_count > 0` 才返回 READY，避免飞书任务在没有 Unity session 时误走截图或场景操作。
- WebView 服务页新增 Codex CLI 自动更新动作：仅当宿主检测到 npm 全局 `@openai/codex` 安装时显示“更新”，点击后执行固定白名单命令 `npm install -g @openai/codex@latest` 并刷新 Codex 状态。
- WebView 设置页的“本地 AI 整理”现在会把生成的回复风格摘要直接保存为当前生效配置，并在快捷预设区显示“自定义”状态，避免整理结果被旧预设状态刷新覆盖。
- “本地 AI 整理”增加角色逃逸保护：本地模型只能输出以“回复时”开头的风格配置规则；如果返回“好的，请问有什么可以帮忙”等聊天式回复，会被丢弃并用确定性摘要兜底，避免该入口变成可聊天窗口。
- WebView 的“一键发布”和“主干发布预检”不再弹 WinForms 原生确认框，避免 Web 面板点击后被隐藏弹窗卡住；发布脚本 exit 非 0 时会向前端返回明确错误，不再静默显示 finished。
- WebView 顶部工具区和发布页都新增醒目的“一键发布”入口，直接调用 `release.publishBackup`，避免用户只能在发布页看到旧的“本机备份发布”名称。
- 记忆仓库路径已加门禁：`CTI_MEMORY_REPO_DIR` 不允许落在默认工作目录、Unity 项目目录或它们的子目录下；命中时自动回退到 `CTI_HOME\\memory-repo`，避免把记忆文件写进工程目录。
- 运行时已补“本地记忆笔记快答”：像“常用场景名称你还记得吗”这类命中 `memory-repo` 笔记的请求，会直接返回笔记内容，不再因为 Codex 失效或本地模型超时而把错误抛给用户。
- 会话历史里飞书 `interactive` 卡片消息现在会尽量解析正文文本；对旧的 `[卡片消息]` 占位记录，控制面板会优先按 `messageId` 从 `audit.json` 回填摘要，只有 audit 里也缺内容时才需要重新同步飞书历史。

近期注意：

- 面板源码以 `apps/control-panel/Program.cs` 为主版本。
- live 面板源码镜像和 exe 会从 suite 生成。
- 如果出现“打开的面板不是最新版”，先看 exe 路径和构建时间。
- 服务动作已从页面硬编码按钮收口到统一运行单元动作表；后续新增 CLI / daemon / manifest 能力时，优先先补宿主运行单元描述，再接前端展示。

## 7. 记忆与历史

已完成：

- 本地消息、归档、审计、Feishu chat index。
- Feishu 历史按 chatId 增量同步到本地索引。
- `memory-profiles.json` 按 userId、chatId、global 三档记录轻量摘要，保留事实/偏好、近期主题和待跟进项。
- 查看器优先使用远端 / 本地索引组合。
- 本地历史检索支持群名、关键词、发言人、时间段。
- Codex 不可用时，本地模型可用记忆命中片段回答。

当前原则：

- Feishu 远端记录是主事实来源。
- 本地索引用于检索、摘要、节省 token 和容灾。
- 记忆只按查询相关性少量注入，不允许把所有用户画像或全部历史塞进模型上下文。
- 记忆类回复不能只给概括，命中结构化键值时应保留原始键和值。

## 8. 已知风险和后续建议

## 2026-04-24

已完成：

- `关机 / shutdown` 由桥接层改为确定性系统动作，不再让模型只回确认文案。
- 这条链路现在只允许 Feishu owner 发起，并要求二次确认 `确认关机`。
- 二次确认成功后，桥接会先写审计、发送执行提示，再直接调用 Windows `shutdown /s /t 0`。
- 新增了桥接核心单测，覆盖关机请求和确认短语识别。

风险：

- 仍有历史文件存在乱码内容，部分旧记录回捞可能需要编码修复。
- 本地模型能力有限，对复杂任务仍不稳定。
- 本机安全策略可能拒绝 `rg.exe` 等外部检索命令；本地执行器已有基础降级，但 skills 或外部脚本仍应优先使用 PowerShell 原生命令或受控搜索工具。
- Ignis 生成能力依赖本机 CLI 配置和远端服务可用性，资产生成可能产生等待时间或服务侧额度消耗。
- 正在处理的消息如果 bridge 被强制重启，目前没有断点续跑。
- Feishu 私聊 WS 漏事件已补捞，但如果历史接口也异常，仍可能延迟。
- `packages/bridge-runtime/scripts/build-control-panel.ps1` 和 `package-release.ps1` 仍作为兼容入口存在，但不再承载旧源码。

建议下一步：

- 做处理中消息自动重试和断点续跑。
- 给 Feishu 历史索引增加编码修复工具。
- 控制面板增加“当前消息是否从 WS 收到还是轮询补捞”的可视标签。
- Unity MCP 进一步强制匹配 `CTI_UNITY_PROJECT_PATH`，不只依赖 allowed roots。
- 给结果块协议增加单元测试，避免 JSON 裸漏和 Markdown card 回归。

## 9. 当前未发布改动提示

截至本记录生成时，工作区仍有以下近期代码改动，发布前应按目标分支选择发布入口：

- 如果只是更新本机运行副本，使用 `publish-backup.ps1`。
- 如果准备合入 `main`，先使用 `prepare-main-release.ps1` 完成主干发布预检。
- 当前重点改动是扩展 manifest v1、主干发布预检脚本、版本治理说明和控制面板运营信息展示。
