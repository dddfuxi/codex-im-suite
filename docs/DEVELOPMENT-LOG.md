# codex-im-suite 开发记录

更新时间：2026-04-21

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
- 将 `scripts/sync-live-skill.ps1` 收口为“开发版 suite -> live skill”方向，避免 live 反向覆盖开发版。
- 新增 `scripts/import-live-to-suite.ps1` 作为手动救回 live 改动入口，默认 dry-run，不进入发布流程。
- 移除 `packages/bridge-runtime/tools/ControlPanel` 和 `packages/bridge-runtime/tools/Installer` 旧副本，避免面板和安装器源码入口混淆。

当前约定：

- 以后开发优先改 suite 目录。
- live skill 通过同步脚本生成。
- 上传 GitHub 前必须先打包最新开发版。
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

当前限制：

- Unity/Blender/MCP 多步任务不交给本地模型做主脑。
- 本地模型适合轻任务，不适合复杂规划。
- 记忆类兜底依赖已有本地索引和检索命中质量。

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

最近重点修复：

- 本地辅助执行器不再把“呼起 Unity 并截图”误判成 MCP 状态检查。
- 只允许明确 MCP 运维小活走本地 MCP 快路径。
- MCP 的 `cwd` 必须命中当前默认工作区、允许根目录或 Unity 工程路径，防止串到别的项目。

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

近期注意：

- 面板源码以 `apps/control-panel/Program.cs` 为主版本。
- live 面板源码镜像和 exe 会从 suite 生成。
- 如果出现“打开的面板不是最新版”，先看 exe 路径和构建时间。

## 7. 记忆与历史

已完成：

- 本地消息、归档、审计、Feishu chat index。
- Feishu 历史按 chatId 增量同步到本地索引。
- 查看器优先使用远端 / 本地索引组合。
- 本地历史检索支持群名、关键词、发言人、时间段。
- Codex 不可用时，本地模型可用记忆命中片段回答。

当前原则：

- Feishu 远端记录是主事实来源。
- 本地索引用于检索、摘要、节省 token 和容灾。
- 记忆类回复不能只给概括，命中结构化键值时应保留原始键和值。

## 8. 已知风险和后续建议

风险：

- 仍有历史文件存在乱码内容，部分旧记录回捞可能需要编码修复。
- 本地模型能力有限，对复杂任务仍不稳定。
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

截至本记录生成时，工作区仍有以下近期代码改动，发布前应通过 `publish-backup.ps1` 打包并提交：

- Feishu p2p 补捞优化。
- 本地记忆兜底增强。
- 本地 MCP 快路径收紧。
- MCP 工作目录校验。
- 本架构文档和 README 修复。
