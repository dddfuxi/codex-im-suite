# codex-im-suite

`codex-im-suite` 是飞书桥接、Codex 执行层、本地辅助模型、MCP、Skill、控制面板和 Windows 打包流程的统一开发与发布目录。

当前目标很明确：

- 开发入口收口到本仓库，不再依赖散落在外部目录的历史副本。
- 运行版 live skill 可以从本仓库同步生成。
- 本机备份发布继续先同步、构建、打包，再提交和推送，保证 GitHub 备份与可运行产物一致。
- `main` 主干发布先做协议校验、架构检查和可复现打包，不把本机 live skill 当作主干事实来源。

## 本次大更新

这次更新把仓库从“本机插件拼接版”推进到了“可复现发布的通用套件”：

- 版本治理收口：`main` 定位为稳定主干，`codex/dev` 用于日常集成；主干发布预检、独立打 tag、扩展协议校验和架构检查都已经脚本化。
- 扩展协议通用化：`config/mcp.d`、`config/skills.d`、`config/plugins.d` 统一升级到 `extension-manifest/v1`，MCP / Skill / Plugin 不再靠硬编码名称驱动。
- 控制面板重做：面板升级为 `WinForms + WebView2 + React/Vite`，支持统一服务模块、权限管理、扩展 / MCP 市场视图、会话详情抽屉、路径拖拽选择、回复风格快捷预设，以及白天 / 夜晚主题和自适应布局。
- Ignis / MCP 能力并入套件：新增 `packages/mcp-ignis`、Ignis manifest、生成结果回传和 GLB 资产后处理链路，MCP 注册和状态发现也统一收口。
- Workflow / Executor 平台落地：运行时开始记录请求阶段、执行器路由和会话默认 executor，面板可查看 workflow run、executor 状态和单次请求运行历程。
- Ollama 本地后端落地：旧 `llama.cpp` / GGUF / `127.0.0.1:8080` 默认链路废弃，统一使用 `CTI_OLLAMA_*` 配置，默认 `http://127.0.0.1:11434` 和 `qwen2.5-coder:7b`。
- 记忆知识库 v1：默认索引 `E:\cli-md` Markdown 到 `.cti-index\knowledge.json`，并把 watcher 心跳写入 `.cti-index\status.json`；面板“记忆”页可搜索来源片段并查看真实监听状态。
- 待办主动提醒 v1：从记忆 Markdown 待办和 Codex `cti-reminder` 动作派生 `.cti-index\reminders.json`，状态写入 `.cti-index\reminder-state.json`；记忆待办默认关闭，直接提醒可由 bridge 统一创建并按来源会话到点推送一次，飞书优先发送可点击完成的互动卡片，微信显示未接入。
- 飞书云文档读取 v1：飞书消息里的 Docx、Sheets、Base 链接会先用应用 `tenant_access_token` 读取，应用无权时再按发起人 OAuth 用户身份读取；缺少用户授权时发送登录卡片，登录后仍无权限则明确提示需要文档所有者分享或导出。
- 会话详情升级：飞书图片和文件会下载到本机缓存并在面板里直接预览；详情页同时展示关联 workflow 事件，方便回溯一次请求从接收、路由、执行到交付的完整链路。
- 扩展和 CLI 运维补齐：MCP 状态按健康检查、Codex 注册和托管进程综合判断；支持本地扩展导入、manifest 安装入口，以及 npm 全局 Codex CLI 的白名单更新按钮。
- 控制面板 HTTP 化：桌面面板会启动同一套本机 Control API，React 前端可在 WebView2 或普通浏览器里通过 HTTP/SSE 读取状态、会话、图片、workflow 和权限数据；远程监听默认关闭，必须显式配置 token。
- 本地 Agent 兜底收紧：本地模型不再直接回复普通飞书消息；Codex 主 API 失败时改由 Codex agent 切到本地 OpenAI-compatible API 继续执行。
- 打包链路补齐：portable / installer / live skill 同步都按 suite 目录生成，控制面板 Web 前端和 `wwwroot` 资源会一并进入发布产物。

## 快速入口

- Agent 维护规则：[AGENTS.md](./AGENTS.md)
- 架构说明：[docs/PROJECT-ARCHITECTURE.md](./docs/PROJECT-ARCHITECTURE.md)
- 开发记录：[docs/DEVELOPMENT-LOG.md](./docs/DEVELOPMENT-LOG.md)
- 目标目录检查：`scripts/doctor-suite-targets.ps1`
- 架构文档检查：`scripts/update-architecture-docs.ps1`
- 扩展协议校验：`scripts/validate-extension-manifests.ps1`
- 旧记忆规则 dry-run 归档：`scripts/memory/archive-legacy-rules.ps1`
- 主干发布预检：`scripts/prepare-main-release.ps1`
- 主干发行标签：`scripts/create-main-release-tag.ps1`
- 控制面板前端源码：`apps/control-panel/web`
- Control API 启动脚本：`scripts/start-control-api.ps1`
- 最近发布摘要：[publish-summary.md](./publish-summary.md)
- 发布历史：[release-notes.md](./release-notes.md)
- 套件清单：[suite.manifest.json](./suite.manifest.json)

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

开发版面板入口是 `release\artifacts\control-panel\CodexImSuiteControlPanel.exe`，live 面板入口是 `C:\Users\admin\.codex\skills\claude-to-im\dist\control-panel\CodexImSuiteControlPanel.exe`。旧 `ClaudeToImControlPanel.exe` 已不再作为入口发布，若快捷方式仍指向旧名应改到正式入口。主窗口现在按“总览 / 服务 / 执行器 / 权限 / 扩展 / 发布 / 会话 / 记忆 / 设置 / 日志”分区；顶部工具区提供刷新、重启面板和发布入口，权限页可管理 Viewer / Operator / Owner，会话页可直接查看完整消息流，记忆页用网格查看知识单元、关系图节点/边、分类原因和答案审查 warning，设置页支持目录选择、拖拽回填和回复风格快捷预设。

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
- `packages/mcp-picture`：图片能力 MCP。
- `packages/mcp-unity-prefab`：Unity Prefab MCP。
- `packages/mcp-ignis`：Ignis CLI MCP，负责原画、图片、视频、3D 模型生成和结果查询。
- `apps/control-panel`：Windows 中控面板。
- `apps/installer`：Windows 安装器。
- `config/mcp.d`：MCP manifest，面板和注册脚本都从这里发现 MCP。
- `config/skills.d`：随项目备份的 skill manifest。
- `config/plugins.d`：随项目备份的 plugin manifest。
- `config/extension-catalog.json`：在线扩展目录的本地种子，远端目录可通过 `CTI_EXTENSION_CATALOG_URLS` 追加。
- `extensions/skills`：自定义 skill 的项目内副本。
- `scripts`：启动、注册、构建、打包、发布、同步脚本。
- `release`：portable、installer、zip 等发布产物。

控制面板下载安装到本机的数据不进入仓库，默认落在 `C:\Users\admin\.claude-to-im\extensions`；其中用户 manifest overlay 位于 `extensions\manifests\mcp.d`、`extensions\manifests\skills.d` 和 `extensions\manifests\plugins.d`，会和 `config/*.d` 一起被面板、MCP 注册脚本和 skill 同步脚本读取。

## 当前运行模型

默认是 `Codex 主脑 + 本地 Agent API（兜底/省流）`：

- 运行时已加入第一阶段 workflow / executor 平台：请求会记录 `received -> authorized -> contextualized -> routed -> executing -> delivered/failed`，执行器目录当前包含 `codex`、`claude-cli`、`codex-local-fallback`、历史兼容的 `local-tool-agent` 和实验性的 `codex-oss-ollama`。
- 用户可用 `@codex`、`@claude`、`@local`、`@ollama` 显式选择执行器；控制面板“执行器”页可查看最近 workflow run、executor 状态和会话默认 executor。
- 普通对话、复杂判断、Unity/Blender/MCP 多步任务默认走 Codex。
- Codex 主 API 失败后，运行时不再让本地模型直接生成用户回复，而是复用 Codex agent 执行链并把 API 切到本地 OpenAI-compatible 后端；主 API 和本地 Agent API 都不可用时才返回明确阻塞。
- 设置页的“AI API”改为运行策略向导：可选“默认 Codex”“Codex + 本地兜底”“完全使用自定义 API”。常用模式只需填服务和模型，高级字段折叠保留；保存后用“保存并重启 Bridge”让飞书运行时生效。
- `hybrid` 模式下 MCP 状态、工具和可用性询问默认先走 Codex；只有 `local_only` 或 Codex 不可用后才使用本地 MCP 动态状态兜底，不再返回硬编码入口列表。
- 原画、生成图、视频、模型等 Ignis 生成请求可走 Ignis MCP 快路径；`local_only` 模式下也允许提交和查询 Ignis 任务。
- Ignis 模型请求如果明确要求拆成 FBX/贴图，会在下载 GLB 后调用 Blender 导出脚本，并通过 `cti-final.files` 回传可上传文件。
- 本地模型只作为 agent API 后端和少数内部测试/整理入口使用；普通飞书消息不再走本地模型直答。
- 记忆关键词不再触发本地直答；明确回忆/搜索类请求和符合记忆键形态的短问题会先做通用记忆规划与结构化检索。只有 `quality=high` 的高置信结构化命中才由记忆层直接回复，关系图候选和其他低确定性结果只注入主执行链。
- 直接提醒不再由“任务 / 待办 / 提醒”关键词硬拦截；只有高置信自然语言提醒、Codex 输出 `cti-reminder` 动作块或用户显式使用 `/remind` 时，bridge 才会创建统一 reminder 记录。高置信自然语言提醒必须同时包含创建意图、未来时间和提醒内容；普通任务讨论、脚本请求和待办查询仍走正常对话。Codex 不能自行写 Windows 计划任务或直接调用飞书 API 伪装完成。
- 权限主数据是 `C:\Users\admin\.claude-to-im\data\permissions.json`；面板会继续兼容并同步 `CTI_*_ALLOWED_USERS` 和 `CTI_*_OWNER_USERS`。

## 关键命令

校验 MCP / Skill / Plugin 扩展 manifest：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\validate-extension-manifests.ps1
```

控制面板“扩展”页支持在线目录、HTTPS URL 预览和本机安装。飞书 Owner 也可以用 `/ext search <关键词>`、`/ext install <关键词或id>`、`/ext remove <id>` 搜索和发起确认卡片；移除语义是“移除记录”，不会删除 Ollama 模型本体、OpenAI bundled 插件缓存或外部包管理器内容。精选目录写入：

```powershell
CTI_EXTENSION_CATALOG_URLS=https://example.com/codex-im-suite/catalog.json
```

构建全部 package 和面板：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-packages.ps1
```

控制面板采用 WinForms 宿主 + WebView2 + React/Vite 前端。`build-packages.ps1` 会先构建 `apps/control-panel/web`，再发布桌面壳；如果本机缺少 WebView2 Runtime，面板启动时会显示安装提示。当前主界面支持白天 / 夜晚主题切换、统一运行单元动作、会话详情抽屉、面板自重启，以及随窗口宽度自动重排导航、列表、详情区和设置表单。

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

修复器会扫描 `data\messages`、`data\message-archives`、`data\feishu-history`、Feishu/记忆相关索引和记忆 Markdown，识别典型 UTF-8 被 GBK、Latin-1 或替换字符错读后的文本。运行时的 Feishu 历史检索、Markdown 知识索引和待办提醒派生也会先修复或跳过仍无法确认的坏文本，避免继续把乱码喂给 Codex 记忆上下文或提醒推送。

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

运行时会从 `.cti-index\knowledge.json` 派生 `.cti-index\reminders.json`，并用 `.cti-index\reminder-state.json` 记录已发送、失败、跳过和完成状态，避免重复推送。来源会话无法确认、状态不是未完成或缺少提醒时间的待办不会发送，只会在面板“记忆”页标注原因。飞书提醒优先发互动卡片，用户点击“完成”后会走 `card.action.trigger` 回调更新本地 Markdown 和状态文件；面板也提供同一套完成入口。知识单元可在面板归档，归档会从源 Markdown 精确移除该行并写入 `archive\knowledge-units`，归档目录不会重新进入索引，归档项可手动永久删除。

直接提醒入口默认开启。Codex 判断用户确实要创建提醒时，只能输出 `cti-reminder` 动作块；bridge 负责写入 `E:\cli-md\data\todos\direct-reminders`、重建索引、记录 `pending / sent / failed / skipped` 状态并到点推送。显式命令也可使用：

```text
/remind 10分钟后 看电脑
/remind 2026-04-29 19:42 看电脑
```

相关配置：

```powershell
CTI_DIRECT_REMINDER_ENABLED=true
CTI_DIRECT_REMINDER_PUSH_ENABLED=true
CTI_DIRECT_REMINDER_DECISION_MODE=codex_action
CTI_DIRECT_REMINDER_ALLOW_SLASH_COMMAND=true
```

飞书云文档读取默认支持 Docx、Sheets 和 Base/多维表格。bridge 会先用应用 `tenant_access_token` 读取；如果应用没有该文档访问权限或开放平台 scope 不足，再给发起人发送飞书 OAuth 登录卡片，使用该用户自己的文档权限读取内容。不使用 owner 代读，也不自动替用户加权限。应用 token 首试不需要公网回调；用户 OAuth fallback 支持公网回调模式，也支持无公网的手动 code/state 回传模式。飞书开放平台需要给应用申请只读权限：

```powershell
CTI_FEISHU_GRANTED_SCOPES=im:message,im:message:receive_v1,im:resource,im:message.group_msg,im:message.reactions:write_only,im:message.reactions:read,cardkit:card:write,cardkit:card:read,im:message:update,docx:document,docx:document:readonly,drive:drive,drive:drive:readonly,offline_access,auth:user.id:read,sheets:spreadsheet:readonly,sheets:spreadsheet:read,bitable:app:readonly,base:table:read,base:field:read,base:record:retrieve
CTI_FEISHU_OAUTH_MODE=manual
CTI_FEISHU_OAUTH_PUBLIC_BASE_URL=https://bot.example.com
CTI_FEISHU_OAUTH_MANUAL_REDIRECT_URI=http://127.0.0.1:17321/feishu/oauth/callback
CTI_FEISHU_OAUTH_CALLBACK_PATH=/feishu/oauth/callback
CTI_FEISHU_OAUTH_CALLBACK_PORT=17321
CTI_FEISHU_OAUTH_SCOPES=offline_access,auth:user.id:read,docx:document:readonly,sheets:spreadsheet:readonly,sheets:spreadsheet:read,drive:drive:readonly,bitable:app:readonly,base:table:read,base:field:read,base:record:retrieve
CTI_FEISHU_CLOUD_MAX_CHARS=80000
CTI_FEISHU_CLOUD_MAX_ROWS=500
CTI_FEISHU_CLOUD_MAX_RECORDS=500
CTI_FEISHU_CLOUD_MAX_SHEETS=5
```

`CTI_FEISHU_GRANTED_SCOPES` 是本地记录“已经在飞书开放平台开通并发布过的权限”的诊断清单，不是密钥；Owner 可以在飞书里发 `/feishu` 查看当前能力矩阵、应用 token 直读能力、OAuth fallback 请求 scope 和声明的权限缺口。`CTI_FEISHU_OAUTH_MODE=manual` 时不需要公网入口，bridge 会启动本机 `127.0.0.1:${CTI_FEISHU_OAUTH_CALLBACK_PORT}` 回调监听，授权卡片会打开飞书官方 `authen/v1/index` 免登授权页；如果用户在运行 bridge 的同一台 Windows 机器浏览器里完成授权，会自动回调、保存 user token、回复“已收到，正在处理中。”并续跑原始云文档问题。如果用户在手机或另一台电脑打开授权页，`127.0.0.1` 指向用户自己的设备，无法自动连到 bridge，此时需要把浏览器地址栏里的完整 `code/state` 回调 URL 复制回飞书，bridge 会走同一套校验和续跑逻辑。callback 模式才需要 `CTI_FEISHU_OAUTH_PUBLIC_BASE_URL + CTI_FEISHU_OAUTH_CALLBACK_PATH`，且必须和飞书应用后台登记的 OAuth redirect URI 一致。用户 token 保存在 `C:\Users\admin\.claude-to-im\data\feishu-oauth-tokens.json`，Windows 下使用 DPAPI 加密。

本轮权限映射按飞书开放平台服务端 API 文档整理：Docx 读取走 `docx/v1/documents/:document_id/raw_content`，Sheets 先 `sheets/query` 再读范围，Base 读取 tables / fields / records。遇到 401/403 或飞书权限错误码时，bridge 会同时提示“用户没有文档访问权限”和对应 API 所需 scope，避免只给 404/空总结。若已有 user token 因新开通 Sheets/Drive scope 而过期失配，bridge 会重新发送授权卡片刷新 token；刷新后仍失败才按文档权限或开放平台权限阻断处理。

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

发布脚本会先构建开发版，再同步 live、组装 portable 和 installer，并用 `test-release-fork-health.ps1` 阻断“开发版”“运行版”和“打包版”漂移。

## GitHub

仓库地址：[dddfuxi/codex-im-suite](https://github.com/dddfuxi/codex-im-suite)

分支定位：

- `main`：稳定产品主干，只保留可复现源码、通用扩展协议、默认示例和文档。
- `codex/dev`：日常集成分支。
- `codex/<topic>`：功能分支前缀。

合入 `main` 前应完成构建、测试、扩展 manifest 校验、架构文档检查、发布摘要和疑似密钥扫描。个人 live skill 更新可以更频繁，但只从已验证的开发版同步，不反向覆盖主干。
