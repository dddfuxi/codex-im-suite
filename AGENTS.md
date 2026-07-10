# codex-im-suite Agent 维护规则

本文件是本仓库的最高优先级本地维护规则。后续 agent 在 `codex-im-suite` 内工作时，必须先遵守这里的约定，再执行具体任务。

## 1. 基本沟通

- 始终使用中文回复。
- 先确认当前修改对象是 `codex-im-suite` 开发版，还是本机 live skill。
- 默认只修改开发版仓库：`C:\Users\admin\Documents\New project\codex-im-suite`。
- 遇到同名文件、旧副本或不确定该改哪里时，先看 `suite.manifest.json`，再运行 `scripts/doctor-suite-targets.ps1`；不要把 live skill 或 `release/*` 当成开发主线。
- 只有用户明确要求“同步运行版 / 修 live / 现在机器人立刻生效”时，才同步到：
  - `C:\Users\admin\.codex\skills\claude-to-im`
  - `C:\Users\admin\.codex\skills\claude-to-im-core`
- 不要把外部仓库、Unity 工程、MCP 工程当成 bridge 主仓库直接改，除非用户明确要求。

## 2. 项目边界

- `packages/bridge-core`：桥接核心，负责 Feishu adapter、消息路由、权限、发送收口、审计。
- `packages/bridge-runtime`：运行时壳层，负责配置、daemon、provider、Codex、Ollama 本地后端、本地执行器、MCP bridge。
- `apps/control-panel`：中控面板，只做服务编排、状态展示、配置入口，不放桥接业务逻辑。
- `apps/control-panel` 是面板源码唯一入口；旧 `packages/bridge-runtime/tools/ControlPanel` 已移除，不要恢复为维护入口。
- 控制面板 exe 唯一正式入口是 `CodexImSuiteControlPanel.exe`；旧 `ClaudeToImControlPanel.exe` 已退出发布入口，只能作为残留检测/清理对象，不得在脚本、文档或快捷方式里继续当主入口。
- `config/mcp.d`：MCP manifest 唯一来源，面板和注册脚本不能硬编码 MCP 名称。
- `extensions/skills`：随项目备份的 skill 副本，不等同于本机 live skill。
- `release`：打包产物目录，不作为源码维护入口，也不要手工修里面的 portable/installer 副本。

## 3. 文档收口规则

当前文档只保留少数固定入口，禁止为每次小改动新建零散 Markdown。

- `README.md`：只写项目入口、快速命令、关键链接，不写长篇历史。
- `docs/PROJECT-ARCHITECTURE.md`：只写当前架构事实和模块边界，避免写流水账。
- `docs/DEVELOPMENT-LOG.md`：记录阶段性开发记录、已知风险、后续 TODO。
- `release-notes.md`：发布历史，由发布流程维护，不手动塞临时想法。
- `publish-summary.md`：最近一次发布摘要，由发布流程生成或覆盖。
- `AGENTS.md`：给 agent 的维护规则，不写成用户说明书。

新增文档前必须先判断：

- 能否补到 `README.md` 的一个链接或短段落。
- 能否补到 `PROJECT-ARCHITECTURE.md` 的对应章节。
- 能否补到 `DEVELOPMENT-LOG.md` 的一条记录。
- 如果只是一次发布说明，应进入 `release-notes.md` 或 `publish-summary.md`。

除非用户明确要求专题文档，否则不要新增新的 `docs/*.md`。

## 4. 文档写法

- 文档必须使用 UTF-8 编码，避免 PowerShell 默认编码造成中文乱码。
- 标题要短，按“事实 / 当前状态 / 约束 / 操作入口”组织。
- 不要把聊天过程、思考过程、工具日志写进文档。
- 不要记录密钥、token、App Secret、私有 config 链接。
- 路径使用 Windows 绝对路径时要明确是否为开发版、live 版、打包版。
- 文档里涉及“当前状态”时，要写清日期或“截至本次记录”，避免过期信息被当成事实。

## 5. 修改代码后的记录要求

以下改动必须同步更新文档：

- Feishu 入站、出站、reply、mention、card、图片、私聊补捞。
- Codex / 本地模型 / 本地执行器路由策略。
- MCP manifest 协议、启动、停止、健康检查、工作区校验。
- 控制面板入口、服务卡片、发布按钮、状态展示。
- 记忆仓库、历史同步、检索、会话绑定。
- 打包、发布、GitHub 备份流程。
- 默认工作区、安全边界、owner 权限、高危操作门禁。

更新位置：

- 架构或边界变化：更新 `docs/PROJECT-ARCHITECTURE.md`。
- 阶段性修复或风险：更新 `docs/DEVELOPMENT-LOG.md`。
- 用户入口或命令变化：更新 `README.md`。
- agent 操作规则变化：更新本文件。

## 5.1 架构文档同步规则

本仓库已安装 `project-architecture-diagram` skill。遇到以下情况必须使用该 skill 检查并维护 `docs/PROJECT-ARCHITECTURE.md`：

- 新增、删除或重命名 package、app、script、manifest 目录。
- 修改 Feishu 入站/出站主链路、私聊补捞、reply、mention、card、图片发送。
- 修改 Codex provider、本地模型、本地执行器、fallback、路由策略。
- 修改 MCP manifest 协议、MCP 启停、健康检查、工作区校验。
- 修改控制面板与 bridge/runtime 的职责边界。
- 修改打包、安装、发布、一键 bootstrap、live skill 同步链路。
- 修改记忆索引、历史同步、检索上下文、会话绑定。

完成架构相关代码改动前，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\update-architecture-docs.ps1
```

如果脚本提示 `Architecture review: REQUIRED`，必须确认 `docs/PROJECT-ARCHITECTURE.md` 是否需要同步。若不需要，在最终回复中说明“不涉及架构文档更新”。

## 6. 运行版同步规则

- 开发版是主版本，live skill 是运行副本。
- 修改开发版后，如果用户要求立即生效，运行 `scripts/sync-live-skill.ps1`，方向固定为“开发版 suite -> live skill”，不要手工复制零散文件。
- `scripts/sync-live-skill.ps1` 必须在复制前构建 `packages/bridge-core` 和 `packages/bridge-runtime`，确保 live `dist/daemon.mjs` 与开发版源码一致；不要只复制源码后让旧 bundle 继续运行。
- 截至 2026-05-15，用户已要求 bridge/runtime 相关修复后默认让本机 live 机器人立刻生效；因此涉及 Feishu bridge、`bridge-core`、`bridge-runtime`、provider 路由、MCP 工具链、出站收口、reminder、memory 或控制面板运行行为的开发版修改，在完成构建和验证后，应自动执行 `scripts/sync-live-skill.ps1` 并重启 live bridge，再复核 `status.json`、`bridge-runtime-audit.json` 和 `bridge.log`。纯文档、测试、非运行时脚本或用户明确要求“不同步 live”时除外。
- 控制面板顶部的 live 同步提示以 live runtime `.suite-release.json.generatedAt`、suite/live commit 和关键内容 hash 为依据；看到“Live 落后 / 未记录同步时间 / 读取失败”时，优先使用面板“一键同步”或手动运行 `scripts/sync-live-skill.ps1`，不要改 live 副本里的零散文件。
- 面板 `live.sync` / “一键同步”只允许执行开发版 suite -> live skill 同步；它不打包、不提交、不推送，也不自动重启 bridge。需要让 daemon 重新加载新代码时，必须把“同步”和“重启 bridge”作为两个明确步骤处理。
- live 控制面板路径统一为 `C:\Users\admin\.codex\skills\claude-to-im\dist\control-panel\CodexImSuiteControlPanel.exe`；`scripts/sync-live-skill.ps1` 成功同步后应清理旧 `ClaudeToImControlPanel.exe` / `.pdb`，doctor、fingerprint 和 hash 检查只认正式入口。
- `scripts/sync-live-skill.ps1` 复制控制面板发布目录时必须排除 `CodexImSuiteControlPanel.exe.WebView2` 用户数据目录，避免 WebView2 Cookie/Cache 临时文件导致 robocopy 误报失败。
- 如确实需要从 live 救回历史改动，只能手动运行 `scripts/import-live-to-suite.ps1 -Apply`，并先确认 `git status`；发布流程不得调用该脚本。
- 发布前必须确认开发版、live skill、portable 打包版没有分叉。
- 面板显示异常时，先看 exe 路径、构建时间、commit，再判断是不是旧版本；如果路径仍指向 `ClaudeToImControlPanel.exe`，应改用正式入口而不是修旧入口。

## 7. Feishu 回复收口规则

- 排查 Feishu 消息、卡片、成员、群机器人、云文档、附件、提醒完成按钮或 OAuth 失效时，必须先检查飞书开放平台外部前置条件：对应 API 权限是否在“权限管理”开通，权限类型是否匹配应用身份 `tenant_access_token` 或用户身份 `user_access_token`，是否已创建版本并通过管理员审核发布，`im.message.receive_v1` 事件和 `card.action.trigger` 回调是否配置为长连接并发布生效，bridge 是否已重启读取最新配置。不能把缺 scope、未发布、未审批、事件/回调未配置或文档资源未授权误判为代码已坏，也不能伪造平台权限或数据。
- 飞书应用管理员类权限（如 `admin:app.admin_id:readonly`、`admin:app.admin:check`）只能用于应用管理员身份诊断或门禁辅助，不能替代 IM、CardKit、Drive、Docx、Sheets、Base、成员列表、消息资源等业务 API scope。文档能力必须同时满足开放平台 scope、应用/用户身份 token、文档本身分享/授权和 OAuth redirect 配置；缺任一项时应返回明确阻塞和所需权限，而不是降级成空总结或假装已读取。
- `/feishu` 能力诊断应作为 Feishu 平台权限和事件回调问题的一线入口：展示本地声明的 `CTI_FEISHU_GRANTED_SCOPES`、实际 token/API probe、OAuth 请求 scope、事件/回调配置提示和能力缺口。`CTI_FEISHU_GRANTED_SCOPES` 只是“后台已开通并发布”的本地声明，不会自动给应用开权限；后台改动后必须发布审批并重启 bridge。
- Feishu `interactive` 卡片入站、reply/light context 和历史索引必须先生成受控卡片 evidence：递归解析 `body.content`、转义 JSON、标题、markdown、plain_text、按钮、summary、alt、资源 key 和卡片引用，剔除“请升级客户端”兼容占位；他方应用资源被飞书拒绝读取时，错误码只进入 `raw.feishuInteractiveCard.resourceDownloadFailures` / 审计，不得作为用户可见快答正文或绕过 agent 的最终回复。
- 飞书最终回复默认同时包含用户可见结果与可展示的思考过程；允许展示面向用户整理后的“处理思路 / 依据 / 执行过程 / 结果”，不再默认压缩为只给结论。但禁止泄漏密钥、token、内部协议名、原始工具日志、未脱敏路径、权限票据或其他不适合外发的原始调试细节。
- 用户等待期间默认通过 Feishu streaming card 展示 `progress` 事件，支持持续更新的富文本处理进度；该内容应优先呈现用户可读的思考过程、判断依据、工具计划、执行进展和阶段结果。允许把模型或执行链的思路整理后外发到进度卡与最终回复正文，但必须做面向用户的重写，不能直接转发内部协议、原始工具日志、密钥、token 或未脱敏调试输出。任务完成后同一张卡片应更新为最终结果；如果候选回复包含“处理思路 / 执行结果”，收尾卡片应保留思考过程和最终结果两部分，而不是只保留结果段。
- Codex 最终结果优先使用 `cti-final` 结果块协议。
- 明确要求工具、MCP、文件、命令、截图、生成物或本地产物的任务，禁止降级成快问快答、闲聊短路或本地模型直答；必须进入 workflow / 工具证据链，成功时带真实 `tool_result`，失败时返回具体“未完成”阻塞原因。
- 工具链成功后，用户可见正文应由 agent/model 基于真实工具历史整理成可读 Markdown/卡片内容；不要把原始 MCP JSON、运行时验证摘要或 `JsonTool/tool_request/tool_result` 协议名直接当最终回复。
- 工具或 MCP 产生图片、文件等本地产物时，最终回复必须通过通用 `cti-final.images/files` 声明真实存在的路径，让飞书发送附件；不要只把路径当普通文本发出。
- Markdown 默认走 Feishu card。
- 结果块解析失败时，不允许蠢裁剪成半截废话；应走可读兜底。
- 记忆回捞命中结构化键值时，必须保留原始键和值，不能只发概括词。
- 高危 / owner 权限门禁不得只靠危险关键词命中；必须区分“用户当前要求机器人执行”与“报错、日志、卡片资源状态、故事/游戏文本、引用证据里提到危险词”。adapter 生成的诊断边界、飞书资源错误（例如资源已删除）、历史 evidence 和叙事规则只能作为上下文交给 agent，不应触发 owner 快速拒绝。
- Feishu 出站 @、私发、提醒和工具触发不得为了某个现场截图、某个玩法或某个机器人名写死规则；只能基于本轮 adapter 身份、wake alias、原生 @、结构化 action、权限和真实 resolver/工具证据做通用判断。流程规则、转述别人动作、未来动作和泛指目标应作为上下文交给 agent，而不是触发确定性快捷执行。
- Feishu 群聊 `require_mention` 下，用户“回复/引用本机器人已发送消息”也是明确唤醒证据；应优先用本地 `outbound-refs` 或被回复消息 sender 证明目标确为当前 bot，再放行文本、图片、表情包等消息进入 agent。不能把所有无 @ 的普通群聊 reply 都放行，也不能让表情包在进入 sticker 语义链前被 `bot not @mentioned` 过滤。
- Feishu 表情包语义必须事实优先：`source=user` 的用户解释只能写入未核验 `userAnnotation` evidence，不能直接进入可发送的 `label/intent/usage` 主语义，也不能出现在 sticker prompt 候选或显式 `[表情包:别名]` 发送匹配里。只有视觉模型基于真实图片返回的 `source=vision` 标注或人工审核的 `source=manual` 才能作为后续自动发送候选；当用户回复表情包解释含义且本地已有 media 时，必须把图片附件和用户说法一起交给 agent 交叉核验，图片文字/图案/上下文与用户说法冲突时以图片事实为准。
- Feishu 历史同步和短上下文中的 `sticker` 消息必须进入表情包库并尽量缓存真实图片；用户明确要求“发/回/来个表情包”时，应把当前聊天以来可用的候选表情包图片作为受控 sticker library evidence 注入 agent，由 agent 视觉分析语义和时机后决定是否输出 `[表情包:file_key]`。如果旧本地历史索引里只有 `[sticker]` 且没有 `file_key`，不得凭空恢复图片；显式表情包请求可按 chat 历史水位触发一次远端 full backfill，能从飞书历史页回捞到真实 `file_key` 和图片时再进入候选库，同一水位不应重复全量回扫。候选图片进入 agent 后，应通过隐藏 `cti-sticker-candidate-analysis` 写回看图语义；bridge 只接受本轮真实附加过的候选 `fileKey`，写入 `source=vision`、带有效置信度且达到阈值、并包含具体画面/情绪/用途/语气语义时，才可用精确 `[表情包:file_key]` 发送。“随便发一个”也必须先知道图的大致含义再发，不能因为旧元数据为空就不发，也不能接受模型幻觉出的未附加 `fileKey`。低置信或缺置信度视觉读图、不可读图片、泛泛“这是表情包/用于聊天”语义、未核验用户解释、source-less 旧语义和看起来像平台资源 key 的裸 `file_key` 都只能作为 evidence，不能绕过表情包库的可信语义门禁直接发送。裸 `[表情包]` 不是强制发送：如果回复文本有明确夸赞、安慰、吐槽、疑惑等语义约束但没有可靠匹配，应降级为自然文字或合适 reaction，禁止只因为库里只有一个旧候选就硬发错图。
- Feishu 私发给成员必须走 `cti-direct-message` 受控动作，不允许模型口头声称已私发或手写平台 API。目标可以是明确显示名、原生 mention evidence、历史/群成员唯一候选，或本轮当前发送者（如“我 / 本人 / 发起人 / 发送者”）；群聊成员列表不可用时仍可用本轮 sender open_id/user_id 给当前发送者私发，但不能把群名误当发送者姓名，其他模糊目标必须要求用户提供准确对象。
- Feishu 跨群、跨会话或按 `chat_id/session_id/targetId` 发送消息必须仍走 `cti-direct-message` 受控动作，但属于 owner-only 操作。bridge 必须先通过 adapter resolver 得到唯一目标，向发起 owner 展示目标名称、类型和平台 ID 并要求确认；确认回调必须来自同一源会话、同一 owner，确认后才调用 adapter 发送。确认卡和源会话结果不得回显待发送正文；目标不唯一、权限不足、确认过期或 resolver 不支持时必须返回未完成，不得让模型口头声称已跨会话发送。
- Feishu @ 投递、事件订阅、回调、入站、通知送达等诊断文本，以及引用他人消息或规则说明里出现的 `@名字`，只能作为 evidence prompt 交给 agent 判断；不得触发出站原生 mention 补全、resolver 检索或假 @ 安全拦截。真实当前命令式请求（例如“请艾特某人让他看一下”）仍必须走结构化 mention 解析和权限/候选校验。
- Feishu 出站 mention 的目标必须是明确飞书显示名、原生 mention evidence 或结构化 mention；“你自己的主人 / 开发者 / 维护者 / 某个成员 / 相关机器人”这类关系描述和泛称不是可执行目标，不得补 `@目标`、不得触发 resolver/inspector 机械 blocker。若模型输出 `@关系描述`，发送前应移除裸 `@` 并保留文字语义。
- Feishu 用户问机器人“主人 / 开发者 / 维护者 / 管理员 / owner”是谁时，应基于 bridge 权限库、`CTI_*_OWNER_USERS`、当前发送者角色、adapter bot/app 身份和可用平台管理员 API evidence 生成受控身份上下文交给 agent；不得因为关系词不能 @ 就回答“无法确认”，也不得把 bridge owner 伪称为飞书开放平台开发者，除非有 admin API 证据。

## 8. 本地模型与 Codex 规则

- 默认策略是同一个 Codex agent 执行任务；官方 Codex、本地模型 API、外部 API 都只是可切换的模型来源。
- 本地模型不是独立本地 agent 兜底，也不能绕过 Codex agent 自行宣称完成任务。
- 本地模型后端统一是 Ollama；默认地址 `http://127.0.0.1:11434`，默认模型 `qwen2.5-coder:7b`。
- 不要恢复 `llama-server.exe`、GGUF 模型路径或 `127.0.0.1:8080` 作为默认本地模型链路。
- 本地模型可以作为 `local_api` 模型来源参与命令、git 状态、文件读取、记忆检索、简单总结和经证据验证的任务执行。
- 本地模型不能伪装完成 Unity、Blender、MCP 多步编排、文档创建、仓库修改；没有真实工具证据时必须返回未完成和具体阻塞。
- 本地 API 作为 Codex 模型来源时，`tool_required` / `local_read_required` / `artifact_required` 必须走通用 JSON 工具协议和 manifest/配置驱动动作；不得为了某个中文请求、某个 MCP 名称或某个截图路径写死特例。
- 本地 API 的 JSON 工具协议必须支持模型基于 MCP 工具 schema 自主规划多步调用；当参数不明确时，应先查找/读取，再用真实返回的 path/id/name 执行动作，不能只靠预置单步 manifest 才算可用。
- 本地 API 工具执行完成后，终答整理也应走模型生成，但输入只能是真实用户请求和真实工具历史；允许输出可展示处理思路，不允许伪造未执行动作或泄漏内部协议。
- 选定模型来源没额度、不可用或自动切换链耗尽时，用户侧要得到明确阻塞和可操作原因，而不是原始错误堆栈。
- 记忆关键词命中不能绕过 agent 主链路直接生成最终回复；明确回忆/搜索类请求可检索记忆，其他请求只能把相关记忆注入主执行链。

## 9. MCP 与工作区安全

- MCP 只能从 `config/mcp.d/*.json` 发现。
- MCP 的 `cwd` 必须命中默认工作区、允许根目录或明确的 Unity 工程路径。
- Unity 默认项目是 `C:\unity\ST3\Game`。
- Ignis 生成能力通过 `config/mcp.d/ignis-mcp.json` 和 `packages/mcp-ignis` 维护，config/token 只允许放在 `C:\Users\admin\.ignis\config.json`，不得写入仓库、release 包或日志。
- 没有授权时，不要操作其他 Unity 工程或外部项目。
- 截图、运行游戏、导入资源这类任务不能被降级成“只检查 MCP 在线”。

## 10. 提交与发布

- 不要自动提交或推送，除非用户明确要求。
- 发布前先运行发布脚本的语法预检和变更摘要。
- 一键发布应同步开发版、构建、打包、生成摘要、提交并推送。
- 发布摘要必须说明 MCP、skill、面板、bridge/runtime 的相关变更。
