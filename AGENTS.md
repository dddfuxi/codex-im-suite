# codex-im-suite Agent 维护规则

本文件是本仓库的最高优先级本地维护规则。后续 agent 在 `codex-im-suite` 内工作时，必须先遵守这里的约定，再执行具体任务。

## 1. 基本沟通

- 始终使用中文回复。
- 在 Windows/PowerShell 中把中文内容交给 Node/Python/CLI 时，禁止用未设置 UTF-8 的管道或 here-string 直接喂 stdin；优先用 UTF-8 文件、Unicode 环境变量或 base64，并在外发前用码点/回读验证没有变成 `?`。
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

## 2.1 机器人架构分层边界

- `packages/bridge-core/src/lib/bridge/agent-architecture.ts` 是机器人分层、策略归属和路径职责分类的第一入口；新增通用 policy、prompt 片段、路径类别或角色门禁时，先在这里声明并补 `bridge-agent-architecture.test.ts`。
- 跨包依赖只能使用 `packages/bridge-core/src/index.ts` 及 `host/evidence/policy/channel/workspace/runtime-audit/architecture` 稳定公共出口；runtime、Web、脚本和测试禁止导入 `claude-to-im/src/*` 或其他 package 的 `src`。Web 只能消费浏览器安全出口，`bridge-core` 禁止反向依赖 runtime；新增出口或调整依赖后必须运行 `npm run test:boundaries` 和 `npm run check:boundaries`。
- 控制面板跨语言 wire DTO 以 `packages/contracts/src/control-api.ts`、`workflow.ts`、`project-registry.ts` 和 `packages/contracts/schemas/*.schema.json` 为共享来源；React 不得在 `main.tsx` 重新声明 `PanelState / WorkflowRun / RuntimeUnit / HostResult`，C# 只允许维护无业务规则的薄 DTO，并由 `ControlApiContractTests` 逐字段核对 schema。新增或修改 schema ID、顶层字段、command/result 或项目注册表快照时，必须同阶段更新 README、架构、开发日志、实施计划勾选和必要的 AGENTS 规则，不能只更新机器协议。
- 代码、协议、Manifest、运行行为或模块边界发生阶段性变化时，人类可读入口也是完成条件：架构事实更新 `docs/PROJECT-ARCHITECTURE.md`，阶段结果与风险更新 `docs/DEVELOPMENT-LOG.md`，长期维护约束更新 `AGENTS.md`，用户入口变化才更新 `README.md`，实施计划同步真实勾选。提交前必须运行 `npm run check:human-docs`；门禁失败时不能用空段落或伪造状态绕过。人类文档只投影已验证的当前事实和真实入口，不复制动态状态形成第二事实源，也不得显示尚未实现的能力。
- `bridge-manager.ts` 只保留编排职责：消费入站、调用 context/capability/policy/delivery 入口、串联审计和状态；不要继续把通用角色表、路径表、prompt 规则或平台无关策略内联进 manager。
- Feishu 表情包媒体文件的稳定命名、真实格式嗅探、兼容扩展查找、大小门禁和首份缓存复用统一由 `channels/feishu/media/sticker-media-cache.ts` 维护；adapter 只负责平台下载、失败冷却、sticker 状态和入站编排。媒体缓存模块不得读取语义 revision、选择发送候选或把记忆 media 目录提升为工作区。
- Feishu 云历史的增量/全量分页、水位停止、成员名映射、删除/system/空消息过滤、sticker 采集时序和本地索引 upsert 统一由 `channels/feishu/history/indexed-history-sync.ts` 编排；adapter 只注入平台分页、成员查询、正文解析和 sticker 采集能力。历史模块不得自行持有飞书凭据、调用 Provider、拼接 prompt 或把本地历史索引提升为长期记忆事实源。
- prompt 规则按归属迁移：默认行为和个性属于 Agent Kernel，权限和风险属于 Policy Registry，证据和上下文属于 Context Broker，工具选择属于 Capability Router，最终呈现属于 Delivery Layer。
- `packages/bridge-core/src/lib/bridge/turn-context.ts` 定义当前回合结构化证据协议和纯裁决函数，`turn-context-broker.ts` 负责归一化各来源并按需调用解析 host；current message、原生 reply、mention、附件、近邻、历史、文档和记忆证据必须带 `id/kind/relation/source/confidence`，不得只拼成平台专用自由文本交给模型猜。
- 每轮先运行确定性 `Reference Resolver`；唯一且可读的原生 reply 直接成为主焦点，普通近邻和 memory 只能作为辅助。图片、文件、卡片资源壳或下载失败占位不算“正文已恢复”，只有真实附件或本地耐久摘要可提升为可靠 reply。light context 和 Context Broker 必须按当前入站消息时间剔除之后才出现的平台消息，禁止异步证据准备把未来消息注入当前回合。只有多个强引用、仅有推测上文或引用内容未可靠恢复时，才调用只输出 JSON、禁用工具的解析 Agent；classifier 必须绕过 executor、manifest、MCP 和本地工具路由，不携带工作目录，并在 stop 时由同一 abort signal 取消。解析结果必须引用本轮真实 evidence ID，focus 必须与 primary evidence 的 relation 一致，并复用确定性层的 reply 可读性判断；解析 Agent 不得把 `contentRecovered=false` 且无可靠附件/耐久摘要的资源壳重新提升为 `reply_target`。解析 Agent 不可用、超时或返回无效结果时，只允许对无副作用的短接话做保守 continuation 回退：优先唯一可靠近邻；若存在多条近邻，只能选择紧邻随后不可读卡片壳的最后一条可读文本，并必须在 decision/Prompt 中明确它不是已恢复的引用正文；多候选、资源壳或执行类请求继续保持 ambiguous。
- 只读分析真实附件与生成/编辑输出产物必须分开裁决：前者使用 `cti-input-evidence/v1` 记录 Provider 实际接收的附件 `id/kind/mediaType`，不得再因“图片/文件/截图”等名词强制要求 `tool_use/tool_result`；后者仍使用 `artifact_required` 和真实产物证据。复合请求按最强外部状态或副作用要求优先，“先分析截图，再用 Unity/Blender/MCP 检查、修复、重建”不能降级成纯 input evidence。receipt 只能由受控 Provider 运行时状态基于实际支持并传入模型的附件生成，模型正文、文件名、历史文本、未支持 MIME 或 `cti-final` 声明都不能伪造输入已接收。
- 路径判断必须优先使用统一分类口径：开发仓库、live skill、记忆仓库、运行态数据、临时上传缓存、文档、规则、日志、发布产物各自有边界；不要为了现场问题硬写某个群、机器人名、截图路径或缓存路径。
- 渐进重构顺序固定为：先建立注册表和测试，再迁移纯函数规则，再迁移上下文构造、能力路由、记忆/暂存提升和交付收口；每一步保持兼容并补单测。
- 拆分 `bridge-manager.ts`、`feishu-adapter.ts` 或其 Facade 前，必须维护 `src/__tests__/support/bridge-characterization-catalog.ts`：入站、权限、提醒、私发、历史、表情包、附件、卡片、产物和最终交付十类行为都要绑定仍会执行的真实回归测试。迁移测试文件或改名时同步更新 catalog；禁止用静态清单代替被引用的行为测试。
- Agent Home 三份行为文档必须由 runtime host 每轮重新读取并以独立 Prompt section 注入；只允许把当前稳定 workspaceId 的 `work/<workspaceId>/工作档案.md` 作为独立、限长、不可执行的只读事实 evidence 回读，超预算时必须保留最新状态。Git 项目 workspaceId 优先由规范化 origin remote 生成，子目录、移动和改名共用身份；旧路径 ID 档案只能提升或临时回读，禁止复制形成第二事实源。其他项目工作档案、每日反思、纠错日志、整个记忆库或索引不得拼进 Prompt，也不得在 core 写死记忆根路径。
- 机器人可受控改写 `机器人身份.md`、`行为与安全规则.md`、`工具与环境.md`，但核心文档修改必须经过独立 JSON-only、禁工具、无工作目录的 Self-Maintenance 裁决。存储层必须再次验证置信度、真实 evidence ID、Agent 自身错误结论，以及 `assistant_output` 错误声明片段与当前 `human_message` / 失败 `runtime_result` 纠正片段的逐字双重绑定；引用、历史、文档、提示注入和普通“取消规则”命令不能触发自改。
- Markdown 自维护不能取消 Owner/Operator 角色、密钥保护、平台授权、真实工具证据、高危动作确认等代码级硬约束。所有自维护写入必须先获取 `.cti-self-history/write.lock`；即使 mtime 超时，持锁 PID 仍存活时也不得删除。核心文档只允许稳定 key、`baseHash` 和受控 patch 修改 `Agent 自维护规则` 块，禁止 classifier 整篇 replace 用户主体。多目标提交必须先持久化 transaction manifest 与 before-image，失败时回滚，进程崩溃后在下次持锁时恢复未完成事务；索引重建属于派生数据，失败不得回滚已提交事实源。
- 工作档案按稳定 workspaceId 写入 `work/<workspaceId>/工作档案.md`，使用稳定 key upsert 维护当前有效状态；每日增量反思进入 `daily-reflection`，纠错进入 `corrections`，版本、规则生命周期、事务、指标和机器审计进入 `.cti-self-history`。规则状态只允许依据真实 evidence 演进为 `trial / confirmed / regressed`，同会话重复不得刷成熟度，`regressed` 不代表自动回滚。活跃窗口外内容移动到 `archive/self-maintenance`，不得直接删除用户资料。这些目录属于 Agent Home/记忆仓库，不得挂载成项目工作区或散落到各项目 docs。

## 2.2 工作区与记忆分层边界

- `packages/bridge-core/src/lib/bridge/workspace-plan.ts` 是每轮工作区计划唯一入口；Conversation Engine、官方 Codex、Codex CLI、本地 JSON 工具、本地 Agent 和 Mavis 必须消费同一 `TurnWorkspacePlan`，不得各自重新推断目录。
- `CTI_HOME/project-registry.json`（或 `CTI_PROJECT_REGISTRY_PATH` 指向的文件）是结构化项目记录唯一事实源；共享 `packages/contracts/src/project-registry.ts` 是协议入口，runtime loader 负责校验并注入 Config。`CTI_ALLOWED_WORKSPACE_ROOTS` 只能作为 legacy `generic` 项目兼容输入，控制面板、C#、文档和 Provider 不得维护第二份项目记录。
- 每轮默认只挂载当前会话工作区；`CTI_ALLOWED_WORKSPACE_ROOTS` 和项目注册根只作为权限上界，禁止自动进入 Prompt、`additionalDirectories` 或普通文件工具根。
- 当前会话工作区不得被消息中出现的其他项目路径替换；其他已注册项目只能作为本轮临时挂载。当前绑定目录命中禁止根或超出注册上界时必须选择安全回退，所有候选均不安全时失败关闭。
- 只有本轮当前消息中的明确绝对路径等强证据才能临时挂载其他项目；临时挂载必须记录 evidence、reason、accessMode 和 `expiresAfterTurn=true`，不能沉淀成全局附加目录。
- 记忆库、`CTI_HOME` 运行态、上传缓存、日志和发布产物不得提升为普通 workspace。它们只能通过各自的受控检索、附件、审计或发布能力访问。
- `packages/bridge-runtime/src/turn-storage.ts` 与 `artifacts/*` 是 Upload、Artifact、Scratch 的唯一运行时所有者；入站附件、Provider 生成物和工具结果必须按 `sessionId/turnId` 归属并记录来源、稳定 `artifactId`、SHA-256 和 TTL，不得回退 `process.cwd()`、项目 `.codepilot-uploads` 或平铺 `runtime/ignis-assets|asset-pipeline`。
- 产物写入项目只能使用 `cti-artifact-promote` 结构化动作，且只允许 `artifactId / targetProjectId / targetRelativePath / expectedSha256` 四个字段。Bridge 必须重新验证当前消息的明确写入意图和 Owner 身份，Runtime 必须重新解析 Registry、访问模式、禁止根、相对路径、符号链接、目标存在性和 Hash；模型提供的绝对路径、workspace、角色或替代源路径一律不可信。
- 新长期记忆只写入 `codex-im-suite/memory/v3`：用户使用 `memory/users/<channel>/<userId>/用户印象.md`，群聊使用 `memory/groups/<channel>/<chatId>/群聊记忆.md`，公共长期事实使用 `memory/long-term/公共长期记忆.md`。
- Agent Home 根目录只保留 `机器人身份.md`、`行为与安全规则.md`、`工具与环境.md`、`记忆总索引.md`、`记忆库说明.md` 五个固定入口；`记忆总索引.md` 只引用真实源文件，不得复制事实形成第二事实源。
- 记忆库根目录或 `docs/` 子树出现五入口之外的 Markdown 时，控制面板与 `记忆库说明.md` 必须显式列为未归类文档；不得静默索引、自动移动、注入 Prompt 或删除用户文件。确认过期后只能通过受控人类文档归档写入原路径、Hash 和归档清单，固定五入口禁止归档，还原时必须拒绝目标冲突或 Hash 不匹配。
- 旧 `data/memory/v2` 只读兼容；迁移必须默认 dry-run，Apply 前停止 Bridge/watcher，并经过暂存校验、备份、冲突不覆盖、归档和索引重建。未知 `docs|logs|runtime|config.env` 不得随记忆布局迁移自动移动。
- managed memory hidden state 是 confirmed/candidate 生命周期唯一事实源；普通 conversation profile 只属于当前 session，命令、问题、链接、mention、工具文本和历史重扫不得自动进入 durable candidate。主索引、关系图和默认 Prompt 只消费 confirmed/兼容 legacy，candidate/archive 必须保持隔离。
- 凡机器状态承诺提供人类可读视图，文档投影必须和机器 mutation 同事务自更新：源 Markdown、`记忆总索引.md`、`记忆库说明.md` 受控区块、`archive/memory-items/记忆归档索引.md`、表情包语义档案、`输入附件清单.md`、`回合元数据.md`、`产物清单.md`、`提升记录.md` 等任一写入失败时，必须回滚 managed state、归档记录、索引、项目复制和全部投影；Markdown 只展示确定性摘要与真实入口，不得形成第二事实源，受控区块外用户手写内容必须原样保留。多个领域共享同一人类文档时必须使用互不重叠的稳定受控区块，禁止整篇重建覆盖其他领域投影；Agent Home 核心文档修改与版本回滚也必须同步更新总索引和说明。人类文档治理区块每轮根据真实文件清单确定性刷新，内容不变时禁止重写或刷新时间戳。
- 控制面板只能通过 `MemoryItemGateway -> memory-item-cli.mjs` 执行确认、归档、还原、永久删除和迁移，不得直接编辑 memory JSON/Markdown；浏览器 payload 只允许 opaque `itemId/archiveId`、`expectedBaseHash` 和审核后的 ID 数组，禁止接受任意源路径或归档路径。
- tentative 迁移只允许应用审核过的 manifest 和 source hash；Apply 前复用统一 Bridge/watcher 停止门禁并保留备份与成功 ledger。只有同一 plan hash 的有效 ledger 才能作为幂等依据，不能因为当前文件“看起来已经是 v2”就跳过未审核变更。
- tentative 迁移 Apply 后不得重新启动仍只认识 v1 `tentative` 的旧 live runtime；必须保持 Bridge 停止，先同步支持 managed memory v2 的 suite live 副本，再启动 Bridge。若旧 runtime 已覆盖迁移结果，只能基于原 migration ledger、备份和当前 baseHash 做 dry-run 差异恢复，不得整文件回滚或覆盖后续用户操作。
- 控制面板解析开发根时，显式 `CODEX_IM_SUITE_ROOT` 优先；否则必须优先当前目录和运行程序集所在的 linked worktree，再回退默认主仓库或 live 路径，禁止默认主仓库抢占当前隔离开发入口。

## 2.3 统一计划任务边界

- `packages/bridge-runtime/src/scheduled-tasks` 是计划任务时间计算、Store、运行准入、执行/投递、恢复和迁移的唯一运行时实现；`bridge-core` 只解析 `cti-scheduled-task` / `cti-reminder`、重建真实飞书目标和角色证据、调用 Host 并收口用户回复。
- 新单次提醒和周期任务统一写入 `CTI_HOME/data/scheduled-tasks`；禁止继续把新 direct reminder 写到记忆 Markdown、工作区、聊天日志或面板私有文件。旧 `data/todos/direct-reminders/*.md` 只读兼容，迁移默认 dry-run，Apply 前必须停止 Bridge/watcher、校验 source hash、备份并禁止冲突覆盖。
- 同一计划槽必须使用稳定 `slotKey` 幂等；执行状态和飞书投递状态必须分开记入运行账本。执行成功但投递失败时只能重试投递，不得重新运行 Agent 或受控工具。
- `notify`、`agent_turn`、`controlled_tool` 必须走同一 Host、权限和审计边界。`controlled_tool` 必须 Owner，且只能信 Runtime 工具注册表声明的幂等性；模型提供的 owner、role、chatId、openId、workspace、sourceSessionId 等字段一律不可信。
- 每次 `agent_turn` 运行都重新解析绑定工作区；工作区不可用时失败关闭。`workspaceMode=none` 不得回退默认 cwd 或把 `CTI_HOME`、记忆库、上传缓存、日志、发布产物当工作区。
- 控制面板和 CLI 只能展示 runtime capabilities 明确开放的动作；尚未接通 daemon 控制面的立即运行、取消和仅重试投递必须禁用或返回真实未完成原因。

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
- Feishu 用户 OAuth 采用“官方协议 + 自定义治理层”：授权页、scope 展示、用户确认、PKCE、Token 获取与刷新必须跟随飞书官方当前协议；bridge 自定义层只负责 sender 身份绑定、每用户加密隔离、任务级最小 scope、授权状态持久化、同一用户 + 同一规范化 scope 授权卡去重、多任务恢复和审计。普通消息、原生 @、reply、reaction、sticker 与 bot 卡片继续走应用身份长连接，禁止向普通用户索取 user OAuth；只有应用身份无法访问且当前任务确实需要读取该用户私有资源时才可发起授权。OAuth v3 换得 token 后必须调用官方 `GET /open-apis/authen/v1/user_info`，只有返回 `open_id` 与原 state 发起人精确一致才可保存和恢复任务；失败、缺 ID 或账号不一致一律拒绝绑定。`user_info` 获取 open_id 无需 `auth:user.id:read`，不得把该 scope 作为基础强制项；`offline_access` 仅在需要刷新 token 时保留。复用中的授权请求不得重复发卡，已授权恢复回合必须携带结构化 resume 标记，后续资源权限不足应返回真实阻塞而不是再次发卡，也不得把一个用户的 token、state 或等待任务用于另一个用户。
- Feishu `interactive` 卡片入站、reply/light context 和历史索引必须先生成受控卡片 evidence：递归解析 `body.content`、转义 JSON、标题、markdown、plain_text、按钮、summary、alt、资源 key 和卡片引用，剔除“请升级客户端”兼容占位；他方应用资源被飞书拒绝读取时，错误码只进入 `raw.feishuInteractiveCard.resourceDownloadFailures` / 审计，不得作为用户可见快答正文或绕过 agent 的最终回复。
- 飞书最终回复默认同时包含用户可见结果与可展示的思考过程；允许展示面向用户整理后的“处理思路 / 依据 / 执行过程 / 结果”，不再默认压缩为只给结论。但禁止泄漏密钥、token、内部协议名、原始工具日志、未脱敏路径、权限票据或其他不适合外发的原始调试细节。
- 用户等待期间默认通过 Feishu streaming card 展示 `progress` 事件，支持持续更新的富文本处理进度；该内容应优先呈现用户可读的思考过程、判断依据、工具计划、执行进展和阶段结果。允许把模型或执行链的思路整理后外发到进度卡与最终回复正文，但必须做面向用户的重写，不能直接转发内部协议、原始工具日志、密钥、token 或未脱敏调试输出。任务完成后同一张卡片应更新为最终结果；如果候选回复包含“处理思路 / 执行结果”，收尾卡片应保留思考过程和最终结果两部分，而不是只保留结果段。
- Codex 最终结果优先使用 `cti-final` 结果块协议。
- 明确要求工具、MCP、文件、命令、截图、生成物或本地产物的任务，禁止降级成快问快答、闲聊短路或本地模型直答；必须进入 workflow / 工具证据链，成功时带真实 `tool_result`，失败时返回具体“未完成”阻塞原因。
- 工具链成功后，用户可见正文应由 agent/model 基于真实工具历史整理成可读 Markdown/卡片内容；不要把原始 MCP JSON、运行时验证摘要或 `JsonTool/tool_request/tool_result` 协议名直接当最终回复。
- agent/model 默认采用主动完成姿态：有安全、低风险、受控的上下文读取、工具调用或目标解析可推进任务时，应先尝试完成，而不是把可执行请求退回成教程、泛泛拒绝或让用户手动排查。确实缺少关键信息时只问最小缺口；只能部分完成时保留已验证进展，说明具体阻塞和下一步确认。该规则不能绕过 Owner/Operator 门禁、平台权限、真实工具证据或事实核验。
- 普通自然语言内容不得再走 provider 前快捷出口：自然语言扩展/模型/skill 搜索、通用表情包请求、自然语言提醒、`git status`/`git pull` 这类命令式文本都必须进入 agent/provider 先判断意图；只有 slash 命令、权限按钮/数字、平台 callback、owner 二次确认、`/remind` 等明确系统入口可以由 bridge-manager 前置处理，并且仍要复用统一角色和风险门禁。
- 工具或 MCP 产生图片、文件等本地产物时，最终回复必须通过通用 `cti-final.images/files` 声明真实存在的路径，让飞书发送附件；不要只把路径当普通文本发出。
- Markdown 默认走 Feishu card。
- 结果块解析失败时，不允许蠢裁剪成半截废话；应走可读兜底。
- 记忆回捞命中结构化键值时，必须保留原始键和值，不能只发概括词。
- 所有可处理的纯文本 turn 都必须先经过独立记忆意图分类，再决定忽略、仅保留当前会话、写入用户/群聊/公共长期分区或向用户追问；不得由“记住/记录”等关键词正则、历史文本、显示名或路径直接推断写入范围。分类不明确、低置信、缺少具体事实、来源不是 human 或运行时写入服务不可用时，禁止落长期库，必须让主 agent 以最小问题追问。`temporary` 只进入当前 session 上下文，不得调用持久化写入；任何分类结果都不得绕过主 agent 生成最终回复。
- IM/bridge 里的“记住/保存/记录”只能通过受控 memory v3 写入链进入设置的记忆仓库；禁止 agent 使用 `github-memory-protocol`、`~/.codex/memory` / `C:\Users\admin\.codex\memory`、项目 Markdown 或聊天日志替代记忆仓库。只有本轮存在成功的受控写入 evidence，最终回复才可以说“已记住/已保存”；否则必须说明未保存并追问最小缺口或报告具体阻塞。
- 高危 / owner 权限门禁不得只靠危险关键词命中；必须区分“用户当前要求机器人执行”与“报错、日志、卡片资源状态、故事/游戏文本、引用证据里提到危险词”。adapter 生成的诊断边界、飞书资源错误（例如资源已删除）、历史 evidence 和叙事规则只能作为上下文交给 agent，不应触发 owner 快速拒绝。
- IM 工具权限批准必须读取 pending permission link 里的工具名和输入 evidence 后再判定角色：只读/检索类工具可由 Operator 批准；shell、写文件、删除/移动/发布/安装/系统控制、跨会话发送等具备副作用或高风险的工具必须 Owner 批准。Feishu 卡片按钮、数字快捷回复和 `/perm` 文本命令必须复用同一套风险与角色门禁，不能因为入口不同绕过 Owner。
- IM slash 命令必须按影响范围声明最低角色：普通聊天、`/whoami` 和低风险 `/remind` 可开放给普通用户；会话、工作目录、模式、状态、历史列表、文档列表和停止会话等运行态管理命令必须至少 Operator；`/feishu` 等平台权限诊断和高危动作必须 Owner。新增 slash 命令时必须接入统一角色门禁或在命令内部写明更严格的结构化 action 门禁，不能靠隐藏快答或关键词绕过。
- `cti-reminder` 和 `/remind` 只允许创建低风险单次提醒；自然语言提醒必须先进入 agent，由 agent 输出 `cti-reminder` 后才允许 bridge 执行。模型只口头声称“已设置/已创建提醒”但没有动作块时一律按伪完成拦截，不得再用正则从原文补建。关机、关闭屏幕、运行命令、发送文件、安装发布等系统/文件/外部副作用类“定时执行”不得落成普通 reminder。普通用户必须被 Owner 门禁拦截，Owner 也必须走受控工具/命令链和真实工具证据，而不是用提醒伪装完成。
- Feishu 出站 @、私发、提醒和工具触发不得为了某个现场截图、某个玩法或某个机器人名写死规则；只能基于本轮 adapter 身份、wake alias、原生 @、结构化 action、权限和真实 resolver/工具证据做通用判断。流程规则、转述别人动作、未来动作、广播受众（如“各位飞书机器人”）和格式/规则对象（如“按这个格式”）应作为上下文交给 agent，而不是触发确定性快捷执行、原生 @ 补全或 resolver 检索。
- Feishu 群聊 `require_mention` 下，主入口只接受原生 @ 当前 bot 的消息：优先按 `message.mentions` 中的 `open_id/user_id/union_id` 与当前 bot 身份精确匹配，飞书长连缺失 `mentions` 时仅允许正文结构化 `<at ...>` / `tag=at` 携带同一身份 ID 作为兼容证据。唯一窄例外是用户用飞书原生 reply/引用“当前 bot 已发送的消息”补发 `sticker` 或 `image`：必须通过本地 `outbound-refs` 或被回复消息 sender 证明确为当前 bot，才可作为本轮媒体交互唤醒并进入表情包/图片识别链。普通文本 reply、回复未知/其他人的消息、文本别名、显示名、其他 bot/app sender 或 @ 其他机器人都不能替代原生 @ 唤醒；这类内容只作为审计或上下文证据，不触发 agent。
- Feishu 用户明确说“看我上面消息 / 上面那条卡片 / 上文 / 前面消息 / 上几条 / 上一条”并要求查看、分析、回复、总结、对照或纠错时，必须走飞书云端消息页同步与本地历史索引检索，不得只用 `Feishu recent conversation context` 的近邻窗口、reply target 或截图猜测。light context 只服务短指代接话；一旦语义是回看上方消息，就应由 `parseHistoryIntentV2()` 生成受控历史 evidence 后交给 agent。
- 历史/记忆检索命中旧的用户问题时，必须尝试回捞相邻 assistant 的最终答复；结构化 assistant 消息优先使用 `cti-final.text` 作为用户真正看见的结果。`tool_use`、`tool_result`、命令、路径和原始日志只能作为低权重诊断或执行证据，不能混入主记忆摘要、不能覆盖相邻最终答复，也不能因为 Feishu 云历史缺少 bot 卡片正文就判定聊天记录丢失。旧的“没找到 / 没保存完整清单 / 归档没命中 / 请手动记录”类失败答复只能作为低价值历史，不得和真实映射、命名表或最终答复竞争。
- Codex / agent 工具环境必须显式携带解析后的 `CTI_HOME`，确保 `memory-repo-retrieval`、Feishu history、message archives 和审计脚本读取当前 bridge runtime 的 `CTI_HOME\data`，不得在 env 缺失时落到旧 `E:\cli-md` 聊天副本。`E:\cli-md` 是长期记忆仓库默认路径，不是原始飞书聊天记录主存储；Windows/PowerShell 读中文 skill、JSON、日志和 Markdown 时必须使用 UTF-8。
- Feishu CLI / lark-cli 只能作为 `/feishu` 能力诊断或人工 API 调试证据；即使配置了 `CTI_FEISHUCLI_ENABLED=true`，也不得把它当成入站、@ 判断、成员 resolver、云聊天记录同步或消息发送主链路。`service.feishuCli` 只是历史兼容 id 的 Bridge Skill 更新单元，不得因名称恢复 CLI 快捷 provider；飞书云历史必须由 FeishuAdapter 的 OpenAPI / 长连接 evidence 证明。
- Feishu 表情包语义必须事实优先：`source=user` 的用户解释只能写入未核验 `userAnnotation` evidence，不能直接进入可发送的 `label/intent/usage` 主语义，也不能出现在 sticker prompt 候选或显式 `[表情包:别名]` 发送匹配里。用户解释表情包只允许两类入口：原生 reply 精确指向已记录的 sticker 原消息，或文本显式出现“表情包 / 表情 / sticker”并匹配同群最近未标注 sticker；回复机器人卡片、普通文本任务、历史上下文里的“这个/刚才/上一个/这个群是...”不得退回最近 sticker 兜底学习。当用户回复表情包解释含义且本地已有 media 时，必须把图片附件和用户说法一起交给 agent 交叉核验，图片文字/图案/上下文与用户说法冲突时以图片事实为准。只有视觉模型基于真实图片返回的 `source=vision` 标注或人工审核的 `source=manual` 才能作为后续自动发送候选。
- 表情包语义进化的机器事实源只能由 runtime revision store 写入：delivery 必须来自真实发送成功的 `messageId + fileKey + semanticRevisionId + contextHash`，reply/reaction 必须绑定同 chat 的已记录 outbound delivery，沉默和无人反驳只能记为 neutral，不能直接确认 revision。`trial / confirmed / regressed / rejected`、结构化 `avoidRules`、版本、feedback ledger、`表情包语义档案.md`、`记忆总索引.md` 和 `记忆库说明.md` 必须在同一写锁事务中更新；任一人类可读投影失败时机器 mutation 必须回滚。控制面板和 C# 只能通过 runtime CLI/Gateway 修改，禁止恢复直接写 `stickers.json` 的第二事实源。
- Feishu 历史同步和短上下文中的 `sticker` 消息必须按 `file_key` 进入表情包库，但媒体采用最小留存策略：只有记忆仓库 `data/im/feishu/stickers/media` 尚无该键时才从当前消息资源下载一次真实图片并按文件头保存为真实扩展，后续同键只复用；历史同步只登记 key、消息来源和水位，不批量下载、不按旧历史全量回捞。禁止扫描、迁入或写入工作区 `.codepilot-uploads`。如果旧本地历史索引里只有 `[sticker]` 且没有 `file_key`，不得凭空恢复图片。
- 入站 sticker 标注回合不得被解释成出站 sticker 请求：收到表情包后只能把图片作为语气/语义证据交给 agent，provider prompt 中的 `cti-sticker-annotation` 必须放在可保留前缀并明确禁止 imagegen、生成图和快捷发送。若 provider 主回复漏写隐藏标注，bridge 只能在本轮真实附加同 `file_key` 图片时做一次隐藏、只读的视觉标注补写；该补写只落 `source=vision` 语义，不改变用户可见回复，不批量补旧数据，不触发表情包发送。可见回复里的 `[表情包]` / `[表情包:file_key]` 在入站 sticker 场景必须剥离，防止上下文突然注入表情包后走死回复。
- 用户要求发表情包时只能复用已有可信视觉/人工语义；如可信候选缺少媒体，最多下载一个已验证候选，绝不能批量回捞，也绝不能用 imagegen 或其他生成图工具替代。候选图片进入 agent 后，应通过隐藏 `cti-sticker-candidate-analysis` 写回看图语义；bridge 只接受本轮真实附加过的候选 `fileKey`，写入 `source=vision`、带有效置信度且达到阈值、并包含具体画面/情绪/用途/语气语义时，才可用精确 `[表情包:file_key]` 发送。对于“发个/来个/随机一个表情包”这类单个通用请求，adapter 可提供可信 `preferredFileKey` 作为候选 evidence，但不得在 provider 前直接投递；只有 AI/provider 明确输出 `[表情包]` 或精确候选动作后，bridge 才能用本轮可信候选补成真实 sticker 交付，禁止进入 imagegen 或生成新图路径。视觉分析约束必须放在 provider 可保留的系统提示前缀，不能因提示截断而失效。低置信或缺置信度视觉读图、不可读图片、泛泛“这是表情包/用于聊天”语义、未核验用户解释、source-less 旧语义和看起来像平台资源 key 的裸 `file_key` 都只能作为 evidence，不能绕过表情包库的可信语义门禁直接发送。裸 `[表情包]` 不是强制发送：如果回复文本有明确夸赞、安慰、吐槽、疑惑等语义约束但没有可靠匹配，应降级为自然文字或合适 reaction，禁止只因为库里只有一个旧候选就硬发错图。
- Feishu 私发给成员必须走 `cti-direct-message` 受控动作，不允许模型口头声称已私发或手写平台 API。用户原文里的明确授权必须与动作目标一致；“给/向某人发送表情包、图片、文件、消息”等当前命令本身就是授权，不得误判后直接退缩。目标可以是明确显示名、原生 mention evidence、历史/群成员唯一候选，或本轮当前发送者（如“我 / 本人 / 发起人 / 发送者”）；群聊成员列表不可用时仍可用本轮 sender open_id/user_id 给当前发送者私发，但不能把群名误当发送者姓名，其他模糊目标必须要求用户提供准确对象。name-only `targetType=user` 只是人员类型提示，仍走当前群 evidence 唯一解析；只有目标 ID 或 `targetType=chat` 才属于跨会话 Owner 确认。私发表情包必须消费本轮真实候选附件和模型精确选择共同签发的 `VerifiedMediaAction`，未验证 file_key 不得作为文字或贴纸发送。
- Feishu 跨群、跨会话或按 `chat_id/session_id/targetId` 发送消息必须仍走 `cti-direct-message` 受控动作，但属于 owner-only 操作。bridge 必须先通过 adapter resolver 得到唯一目标，向发起 owner 展示目标名称、类型和平台 ID 并要求确认；确认回调必须来自同一源会话、同一 owner，确认后才调用 adapter 发送。确认卡和源会话结果不得回显待发送正文；目标不唯一、权限不足、确认过期或 resolver 不支持时必须返回未完成，不得让模型口头声称已跨会话发送。
- Feishu @ 投递、事件订阅、回调、入站、通知送达等诊断文本，以及引用他人消息或规则说明里出现的 `@名字`，只能作为 evidence prompt 交给 agent 判断；不得触发出站原生 mention 补全、resolver 检索或假 @ 安全拦截。真实当前命令式请求（例如“请艾特某人让他看一下”）也必须先进入 agent，由 agent 基于本轮原生 mention evidence 和完整上下文判断是否输出结构化 `cti-final.mentions`，bridge 只负责校验和投递结构化真实 ID，不得在 provider 前快捷执行。
- Feishu 出站 mention 的目标必须是明确飞书显示名、原生 mention evidence 或结构化 mention；“你自己的主人 / 开发者 / 维护者 / 某个成员 / 相关机器人”这类关系描述和泛称不是可执行目标，不得补 `@目标`、不得触发 resolver/inspector 机械 blocker。若模型输出 `@关系描述`，发送前应移除裸 `@` 并保留文字语义。
- Feishu 出站不得把裸 `@显示名`、普通显示名或用户文本中的名字交给 resolver 作快捷补全；bridge-manager 只透传 AI/provider 产出的结构化 `mentions`（优先 `cti-final.mentions`）或已受控校验的结构化动作。当前消息即使同时原生 @ 了机器人和目标，也只能作为 agent evidence，不得在 provider 前直接投递；AI 未输出结构化真实 ID 时，后置安全层只能自然说明缺少可投递目标或追问最小缺口，不能查询成员/机器人/历史来补全，也不能覆盖其他正常回复。
- Feishu 结构化 mention 的 ID 字段必须统一兼容 `userId/user_id/openId/open_id`（保留 `unionId/union_id` 兼容），但字段归一化不代表可信：普通回复和 streaming card 收尾必须共用同一投递前门禁，只有该 ID 与本轮原生 mention evidence 中任一平台 ID 精确一致时才允许发送。模型生成、历史猜测或显示名补全出的任意 ID 一律拒绝；被拒绝后要移除对应裸 `@` 并保留文字语义，若用户本轮明确要求艾特，则必须明确说明未投递或要求用户原生 @ 目标，不能展示成看似成功。广播 `atAll/at_all` 没有单一用户 ID，不能复用普通 mention 门禁；在存在独立 Owner 广播动作和确认协议前一律拒绝。
- 显示名解析汇总本轮原生 @、当前群成员/群机器人、当前发送者和历史候选时，必须保留来源等级：本轮原生与当前群平台证据优先，历史只作当前证据缺失时的回退；同一最高等级命中多个不同 ID 才算歧义。禁止让已过期的历史同名记录压制当前群的唯一可原生 @ 身份，也不能为了绕过歧义写死某个机器人名。
- 对单个通用表情包请求，若本轮确实已向模型附加候选图片、模型只唯一输出其中一个精确 `[表情包:file_key]`，但完全漏写隐藏 `cti-sticker-candidate-analysis` 块，bridge 可一次性投递该真实 sticker；此兜底只证明本轮选择，不得写入长期可信语义或降低后续视觉置信度门槛。
- 这种一次性表情包许可必须作为 bridge 结构化的 per-turn media action 同时传入普通投递和 streaming card 收尾；adapter 只在动作类型、来源和精确 `file_key` 都与可见 hint 一致时发送，禁止从模型正文、用户文本或不匹配 key 自行推导许可。
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
- MCP 的 `cwd` 必须命中本轮 `TurnWorkspacePlan` 的主工作区或临时挂载；允许根目录只证明路径可授权，不能单独证明本轮已经挂载。
- Unity 项目目标必须由当前 `CTI_UNITY_PROJECT_PATH`、MCP manifest `cwd`、允许根目录和项目事实记忆共同确定；不要把历史 `C:\unity\ST3\Game` 当成固定默认项目。执行 Unity MCP 前必须确认当前 Editor `Application.dataPath` 推导出的项目根与配置一致。
- Ignis 生成能力通过 `config/mcp.d/ignis-mcp.json` 和 `packages/mcp-ignis` 维护，config/token 只允许放在 `C:\Users\admin\.ignis\config.json`，不得写入仓库、release 包或日志。
- 没有授权时，不要操作其他 Unity 工程或外部项目。
- 截图、运行游戏、导入资源这类任务不能被降级成“只检查 MCP 在线”。

## 10. 提交与发布

- 不要自动提交或推送，除非用户明确要求。
- 发布前先运行发布脚本的语法预检和变更摘要。
- 一键发布应同步开发版、构建、打包、生成摘要、提交并推送。
- 发布摘要必须说明 MCP、skill、面板、bridge/runtime 的相关变更。
