# codex-im-suite 开发记录
- 2026-07-07 Feishu 群机器人 mention 候选补全：继续复盘“群机器人面板里有乔治，但 `小虾米，艾特乔治` 仍回没能确认”的根因，确认上一轮已解决 `_user_N` 占位符泄漏，但 FeishuAdapter 出站 resolver 仍只依赖旧 `im/v1/chats/{chat_id}/members` 普通成员列表、本轮入站 mention、历史 `<at>` 映射和 sender 上下文；群机器人没有出现在普通成员列表里时就完全进不了候选。现新增通用 `members/list` 候选补充：解析返回里的 `users[]/bots[]/items[]/members[]`，统一抽取显示名、app/bot 名称别名和可发送的 `open_id/user_id/union_id` 或明确类型 `member_id`；只有 `app_id/bot_id/cli_` 等非 mention ID 时继续跳过，不伪造原生 @。新增回归覆盖 `bots[]` 返回 `open_id=ou_george_bot,name=乔治` 时裸 `@乔治` 可解析，以及仅暴露 `app_id/bot_id` 时不会误发。
- 2026-07-07 Feishu mention 占位符漏目标修复：定位到“`小虾米，艾特乔治`”这类明确目标请求中，模型可能受历史上下文影响输出 `@_user_1` 且把 `cti-final.mentions` 写成字符串数组 `["_user_1"]`，bridge-core 只接受结构化 `{ userId, name }` mention，导致真实目标“乔治”被占位符抢走并外显“没能确认 _user_1”。现对 `cti-final.mentions` 做结构校验，丢弃裸字符串/飞书占位符；当用户本轮有明确 mention 目标而模型正文只含单个 `@_user_N` 时，先用用户目标显示名替换占位符，再交给同一 Feishu resolver 校验真实 ID。若最终仍无法解析，阻塞提示优先显示用户说的目标名，不再把 `_user_N` 泄漏给用户。`conversation-engine` 同步提示模型只有掌握真实 ID 才能写结构化 mentions，否则用可见 `@显示名`。新增回归覆盖占位符被替换为 `@乔治` 后解析，以及未解析时错误提示不泄漏 `_user_1`。
- 2026-07-07 Feishu mention 意图误判修复：定位到“你是怎么做到 at 乔治这个机器人的 / 怎么做到 at 乔治的”这类解释型问题被 mention 安全层误当成执行型“去 @ 乔治”，最终把正文中的示例 `@乔治` 强制交给 resolver，解析不到就改写成“没能确认成员”。现新增 Feishu mention intent 区分：how-to / 为什么不行 / 没反应 / 不回复等诊断型问题只解释结果，不触发裸 `@名字` 原生解析或假 @ 拦截；“请艾特 / 艾特 X 让他……”这类执行型请求继续走 resolver。目标名清洗同时把“这个机器人 / 智能体 / bot / agent / 应用”等尾部类型说明剥离，避免把“乔治这个机器人”整段当显示名。新增回归覆盖解释型 `@乔治` 示例不调用 resolver，以及执行型“艾特乔治这个机器人”只用“乔治”解析。
- 2026-07-07 Feishu 私发动作收口：定位到“在群里让机器人给某人私发消息”时，旧链路没有 bridge 原生私发能力，模型会尝试 Bash/临时脚本/内部工具转发，被安全闸门拦截后只能在群里报未完成。现新增通用 `cti-direct-message` 动作协议：模型只声明 `target/text`，`bridge-manager` 校验用户原文存在明确私发授权并拦截口头假完成，FeishuAdapter 复用入站 mention、历史 `<at>` 映射、群成员列表和 sender 上下文解析唯一真实用户 ID，再用 `im.message.create` 按 `open_id/user_id/union_id` 发送一对一消息；源群只回“已私发给 X”或未完成原因，不回显私信正文。`conversation-engine` 同步禁止 Bash/PowerShell/手写 API 假私发，runtime answer review 和本地工具终答清理也把 `cti-direct-message` 纳入协议泄漏过滤。新增回归覆盖成功私发不泄露正文、目标无法确认不发送、Feishu adapter 不使用当前群 `chat_id` 代发以及重名目标拒绝。

- 2026-07-07 Feishu 显式艾特目标抽取去硬编码修复：定位到“艾特 X 让他/她/TA 做某事”这类无逗号口语会被旧正则把“X 让他……”整段当成飞书显示名，导致 resolver 无法唯一命中成员，最终回成“没能确认目标”。现把显式 mention 目标清洗改为通用边界识别：候选目标后若紧接“让/叫/喊/通知/请/要 + 代词/对方/成员”、“跟/和 + 人称”或“去/来/帮 + 看/处理/回复/聊天/确认”等后续动作从句，会在从句前截断；真正能否发送原生 @ 仍由 FeishuAdapter 的群成员、入站 mention 和历史 `<at>` 映射 resolver 校验，未命中仍不发送假 @。新增回归覆盖“艾特苏木让他跟你聊天”会补成 `@苏木` 并走原生 mention 解析，避免针对具体姓名写死。
- 2026-07-07 控制面板撤回按钮静默失败修复：定位到会话详情里“旧历史消息没有 `outbound-refs.json` 但 `senderId` 命中当前 bot app id”时会显示撤回按钮，但 `history.recallBotMessage` 执行阶段只查 outbound refs，导致点击后被后端拒绝；前端又未把该命令纳入可见状态横幅，也没有 catch 失败，所以看起来像“按了没反应”。现在 `ConversationHistoryDisplay.ResolveRecallTarget()` 统一按钮资格和执行资格：已知出站 ref 继续直接撤回；旧历史当前 bot app 消息会创建一条 `history` 追踪记录后调用 Feishu 删除接口，成功写 `recalledAt`，失败写 `recallError` 并在会话详情显示。前端撤回命令新增“撤回消息”状态横幅，失败也会刷新详情，不再静默吞错。新增回归覆盖无 outbound ref 的当前 bot app 历史消息可解析为撤回目标。
- 2026-07-07 Feishu 明确艾特请求执行收口：针对“用户明确要求机器人去艾特某人时不应继续犹豫”的反馈，`bridge-manager` 新增通用出站补全步骤：当 Feishu 用户文本包含明确 mention 动作和具体目标，而模型最终回复没有结构化 `mentions` 也没有可见 `@显示名` 时，会先把回复补成 `@目标` 前缀，再交给现有 `BaseChannelAdapter.resolveOutboundMentions()` 解析为平台原生 mention。若 resolver 能唯一解析到 Feishu mention ID，则正常发送蓝色原生 @，包括可解析的机器人/智能体；若解析不到，则改为可见阻塞提示，要求用户直接点选 TA 或提供准确显示名，不发送普通文本假 @。`conversation-engine` 同步提示：用户明确要求 mention 时只要目标明确且可解析就发一次，不因目标是 bot/app agent 或不确定对方是否会响应而拒绝。新增回归覆盖明确目标补全、解析失败不发假 @ 和提示词规则。
- 2026-07-07 Feishu 原生 @ 与名字提及意图过滤补强：继续复盘发现 `require_mention=true` 下原生 `@机器人` 会直接通过 `isBotMentionedFromMessage()` 入队，绕过上一轮名字唤醒的 `chat / investigate / need_info / done` 分类；同时“@其他人 你能 at 机器人吗”这类句子里机器人名只是动作宾语，也会被名字唤醒误判为机器人需要回复。现把原生 @ 也接入非响应过滤：纠错、抱怨、明确要求别回复、说明“你自己就是某机器人 / 不是让你”的消息只写过滤审计；名字唤醒新增“机器人名作为 at/喷/叫/问等动作对象”判断，不再让被提到的机器人抢答。新增回归覆盖原生 @ 的纠错反馈不入队，以及 `@别人 你能 at 小虾米吗` 不唤醒小虾米。
- 2026-07-07 Feishu 机器人/智能体原生 mention 复盘修复：用户截图反证了“机器人完全不能被 @”的判断，真正问题是当前群成员 API 只返回普通成员，人工 @ 机器人时消息接口也可能只给 `key/name` 而不公开 ID；但历史中已存在应用成功发送的 `<at user_id=ou_...>乔治</at>` 可验证映射。FeishuAdapter 出站 resolver 现在会在本轮入站 mention、群成员列表、sender 上下文之外，额外从本地 `data/feishu-history/*.json` 的 `text` 字段提取已验证 `<at user_id/id=...>显示名</at>` 候选，并按目录 mtime/size 缓存；只有唯一命中且 ID 不是明显 `cli_` / app / bot 标识时才生成结构化 `OutboundMention`。`conversation-engine` 同步改为“机器人/智能体可在桥接层解析到有效 Feishu mention ID 时原生 @，否则说明无法确认目标”，不再直接拒绝机器人 mention。新增回归覆盖群成员列表缺失但历史有 `ou_...` 映射时裸 `@乔治` 可解析，以及只有 `cli_` 应用成员 ID 时仍不伪造原生 mention。
- 2026-07-07 Feishu 群聊历史意图与卡片展示修复：定位到“看看群里都在聊什么”没有读更多历史，是因为 `parseHistoryIntentV2()` 只把“群聊 / 聊天 / 消息 / 记录”等识别为历史范围词，漏掉“群里 / 群内 / 本群 / 这个群”，导致请求落入 `light_chat` 近邻上下文，只看到少量 `Feishu recent conversation context`。现把群位置词纳入通用历史范围识别，命中后走 Feishu 历史同步与检索增强 prompt；进度卡恢复展示安全的用户可见处理思路/依据，同时继续过滤路径、命令、工具名、MCP/JsonTool 协议和 `agent` 内部结果块；final card 标题只在负向词位于标题开头时归为“未完成”，避免成功摘要转述“报错”被误判。新增回归覆盖群位置词历史意图、成功卡正文转述报错、进度卡安全思路保留与内部细节脱敏。
- 2026-07-07 控制面板会话卡片展示与撤回收口：会话详情现在通过 `ConversationHistoryDisplay.ResolveMessageDisplay()` 统一解析 Feishu `interactive` 卡片，递归提取 header、markdown/plain_text、按钮文案和 summary 等用户可见字段，并把 `cardContent/rawContentPreview` 返回给 WebView，以“卡片内容”块展示，避免只看到 `[卡片消息]` 或客户端升级占位。继续补强卡片附件链路：`ResolveCardResourceReferences()` 会递归提取卡片内嵌 `image_key/file_key`，复用消息资源下载和缓存，把表情回复等卡片里的图片显示为附件缩略图。撤回资格继续优先匹配 `outbound-refs.json` 的 channel/chat/messageId；旧历史消息没有出站引用时，只允许 `senderId` 命中 `CTI_FEISHU_APP_ID` 或 `CTI_FEISHU_BOT_APP_IDS` 的当前 bot app id 后显示撤回按钮，避免误撤其他应用卡片。新增控制面板单测覆盖卡片正文解析、卡片内嵌图片资源、跨 chat 出站引用拒绝、当前 bot 历史消息撤回放行和其他 app 拒绝。
- 2026-07-07 Feishu 通用 mention resolver 修复：复盘发现“飞书 CLI”在本仓库当前形态只是控制面板/运行时 service 单元，不是 provider 可调用的 Feishu 成员查询工具；真正已有的官方能力在 FeishuAdapter 内部，包括消息发送、Markdown/Post 原生 mention 渲染和 `im/v1/chats/{chat_id}/members` 群成员查询，但出站链路没有把裸 `@显示名` 解析成结构化 `mentions`。修复：新增通用 `BaseChannelAdapter.resolveOutboundMentions()` 钩子，`bridge-manager` 在最终发送前统一调用；FeishuAdapter 会基于本轮入站原生 mention、当前群成员列表和 sender 上下文解析最终正文里的裸 `@显示名`，唯一命中时补入 `OutboundMention`，同名多候选或未命中不伪造艾特。继续按飞书平台语义收紧：明显的 `cli_` / app / bot 标识不会作为可发送 mention 候选；机器人/智能体如果能从结构化结果或已验证历史映射解析到有效 `ou_` 等 Feishu mention ID，则可以原生 @，解析不到时才说明目标无法确认。新增回归覆盖任意回复场景中的裸 `@刘丹` 会通过 channel resolver 变成结构化 mention、同名多候选不会瞎猜、app/bot 成员 ID 不会被解析成原生 mention，以及 Feishu prompt 里的 mention ID 边界。
- 2026-07-06 Feishu 原生 mention 出站修复：针对“让机器人艾特群里另一个人”时误把发起人写成裸 `@名字`、且卡片里不是可点击原生艾特的问题，收紧出站 mention 契约。`cti-final.mentions` 会沿 `bridge-manager -> FeishuAdapter` 透传到普通发送和 streaming card finalization；`markdown/feishu.ts` 在 Markdown card 中渲染 `<at id="..."></at>`，在 post 中渲染原生 `tag=at` 节点，纯文本只接受显式 `mentions` 生成 `<at user_id="...">`，不再因为 `replyToMessageId` 自动艾特发起人。对于“另一个人 / 别人 / 其他成员”这类目标不明确的请求，`bridge-manager` 会拦截没有结构化 mention 的任何裸 `@名字`，不再依赖真实入站 `displayName` 是否等于发送人名；`conversation-engine.ts` 同步提示模型不要用裸 `@name` 执行可操作艾特。同步补强 Feishu 表情包 prompt：当前 chat 没有语义标注但存在真实可复用 sticker 时，`getStickerPresentationPrompt()` 会说明只能用裸 `[表情包]` 触发通用轮换，不能编造别名或 `file_key`。新增回归覆盖 Markdown card、post fallback、plain text 显式 mention、群回复不推断 sender、final card mention、真实群 `displayName` 下模糊目标不放行裸 `@名字`，以及无语义标注时的通用表情包提示。
- 2026-07-06 证据驱动主动性与 Feishu 进度收敛：针对机器人在有上下文/文件/manifest 等明确对象时仍频繁追问、以及飞书进度卡过度暴露“正在调用工具/读取文件/agent 阶段”的问题，新增低风险主动探查策略。`execution-requirement.ts` 会把当前工作区、明确路径、文件名、MCP manifest、`config/mcp.d` 等可读对象识别为 `local_read_required`，不再依赖 `CTI_STRICT_TOOL_ROUTING` 才要求真实读取证据；泛泛时效问题仍保持普通回答，命令行调用继续走 `tool_required`，避免误触。`local-llm-router.ts` 让带 URL、路径、工作区、仓库、manifest 等对象的短句退出 Feishu `light_chat` fast path。`conversation-engine.ts` 注入统一 provider guardrail：已有上下文对象先做 bounded low-risk read/list/check，不能让用户重复提供；`bridge-manager.ts` 将 streaming card 更新收敛为高层状态，过滤工具名、路径、命令、agent 阶段和原始工具事件。新增/更新回归覆盖主动探查、轻聊天排除、provider prompt 和进度卡脱敏。
- 2026-07-02 Mavis timeout 循环与 Feishu 自消息补捞修复：定位到图片/表情任务超时后，`streamUntilFinish` 已向 Mavis 发送 abort，但 `MAVIS_TERMINAL_AUTO_RETRYABLE.timeout=true` 又把同一 workflow 排入自动断点续跑，导致 Mavis 侧重复出现会话并最终把“断点续跑重试结果”回发飞书。现改为 `timeout=false`，timeout 只记录 workflow failed，不进入 auto retry；用户需要时再手动 retry。同时补强 Feishu p2p 历史补捞自消息过滤：除 `sender_type=app/bot` 外，还按已解析 bot 身份 ID 跳过 `sender_type` 缺失但 sender id 属于机器人的消息，避免机器人自己的图片占位/回复被当成新用户输入。新增回归覆盖 Mavis timeout 不进入 `auto_pending`、Feishu 历史补捞 bot id 自消息不入队。
- 2026-07-01 Mavis 可见进度与来源会话连续性修复：针对飞书卡片只显示“正在回复...”、MiniMax Code 已经在思考但用户侧看不到过程，以及每轮消息疑似新建 Mavis 对话导致上下文不连贯的问题，补齐外部 executor 的通用流式语义。根因是 Mavis provider 之前只在最终阶段把 `thinking_content` 作为 `status` 上报，而 bridge-core 进度卡只消费 `progress/text`；最终正文又一次性发出，无法形成飞书打字机效果。同时 binding 只按 bridge 内部 session id 查找，live 同步或会话重绑后容易丢失原 Mavis session。修复：`mavis-executor-provider.ts` 把 Mavis 工具阶段和可展示处理思路转换为脱敏 `progress` SSE，最终正文按小块 `text` SSE 输出；`bridge-manager` 在 workflow 步骤旁保留 provider 细节，不再被固定“正在回复”文案遮住；`mavis-session-store.ts` 新增来源通道 / chat / thread 维度查找，`preDispatch` 先按精确 binding，再按来源会话续接并迁移到新的 bridge session id。新增回归覆盖 source chat 续接、Mavis thinking/progress 外显、最终文本分块、进度卡步骤与 provider 细节并存。

- 2026-07-01 Mavis 图片/表情附件桥接修复：追查飞书图片或表情包进入 MiniMax Code 后只显示“用户发送了一个飞书表情包、file_key=...”这类文字提示，Mavis 未拿到真实图片的问题。根因是 `mavis-executor-provider.ts` 只把 `StreamChatParams.prompt` 交给 `mavis session new` / `mavis communication send`，忽略了桥接层已经传入的 `params.files`；而当前 Mavis CLI 这两条命令没有原生附件参数，导致外部 agent 只能凭文本猜图。修复：Mavis provider 在 pre-dispatch 阶段把 `image/*` 附件物化为工作区 `.codepilot-uploads/mavis-input` 下的本地文件，工作区内已有 `filePath` 直接复用，工作区外可读文件先复制回工作区，再把绝对路径和视觉工具提示附加到本轮 prompt；新建 session 与续聊 `communicationSend` 两条路径共用同一逻辑。新增回归测试覆盖 base64 图片落盘、工作区已有图片路径复用、工作区外路径复制以及 resume path 传图，避免以后退回只传 file_key 文本。

- 2026-07-01 Mavis Windows shim 多行 prompt 修复：追查飞书图片/表情消息明明默认 `mavis-agent`，最终卡片却显示 `来源：Codex CLI / SDK (codex)` 的问题，确认 workflow 先选中了 `mavis-agent`，但 pre-dispatch 阶段 Mavis CLI 返回 `missing required argument 'agent'`，随后按设计回落 Codex。根因是 live `CTI_MAVIS_CLI_PATH` 指向 `C:\Users\admin\.mavis\bin\mavis.cmd`，该 shim 用 `%*` 原样转发参数；飞书图片/表情 prompt 带换行或附件描述时会被 batch 二次解析，导致 `session new [options] <agent>` 的最后位置参数丢失。修复：`mavis-cli-client.ts:buildMavisSpawnSpec` 在 Windows 上读取可解析 `.cmd/.bat` shim，保留 `set KEY=VALUE` 环境变量并直接 spawn 真实 executable/script；不可解析自定义 shim 仍走旧 `ComSpec` fallback。新增单测覆盖多行 prompt argv 保真、未知 shim fallback 和普通可执行文件直连。

- 2026-07-01 Mavis 归档 sender 防护：继续追查 Feishu 表情/短消息由 Mavis 执行但 1-4 分钟才回、且 MiniMax Code 端仍在“优化表达/回报”的问题，确认 live 配置里的 `CTI_MAVIS_BRIDGE_SESSION_ID=mvs_7f88609f66904cb28ab6e7a0b818a20b` 已被 Mavis 标记 `compressed: true`（归档），resume path 仍把它作为 `communication send --from` 传给目标 session，导致目标 agent 试图把结果回报给已归档源 session，最终产出“session 已归档、发不出去”的元信息而不是用户答案。修复：`mavis-cli-client.ts` 保留 `session.info/create` 返回的 `compressed` 字段；`mavis-executor-provider.ts` 在复用旧 binding 前校验配置 sender 形态和归档状态，发现 invalid / unavailable / archived 时删除旧 binding 并走新的 `session new --from root`，不再调用 `communicationSend`。新增回归测试覆盖归档 sender 必须新建 Mavis session、不得使用坏 `from`；`mavis-cli-client.test.ts` 增加 `compressed` 归一化测试。

- 2026-07-01 Mavis SSE 收口修复：继续追查 Feishu `hi` 卡片仍显示“未完成：模型没有返回可展示结果”，确认真实 Mavis session `mvs_ca4a5e05e20e435a96c894401e03611a` 已有 assistant `msg_content = Hey！👋 在的，今天想搞点啥？`，`mavis-session-bindings.json.lastFinalText` 也已写入该文本；根因不是 MiniMax 未返回，而是 `mavis-executor-provider.ts` 手写了非 bridge 标准 SSE（`event: text` + `data: {"text":...}`），bridge-core `consumeStream` 只读取 `data: {"type":"text","data":"..."}` envelope，导致最终 `responseText` 为空并被替换成未完成卡片。修复：Mavis provider 的 `sse(event, data)` 统一代理到 `sse-utils.ts:sseEvent`，最终正文以字符串 data 发出；新增回归测试断言 Mavis 成功文本必须解析为 bridge 标准 `text` event。

- 2026-07-01 Mavis communication 出站回复采集修复：定位到 Feishu `hl` 卡片显示“未完成：模型没有返回可展示结果”，但 MiniMax Code 窗口已经作答并提示源 session `cti-bridge-warmup` archived、`communication send` 报 `cannot receive messages`。根因不是 MiniMax 输出格式错误，而是 resume path 用 `mavis communication send` 后，Mavis 把本轮答复写到了 `communication messages --from <目标 Mavis session> --to <bridge sender session>` 的出站记录；旧 provider 只读目标 session 的普通 assistant messages，漏掉这类出站 content，并且 quiet timeout 90s 会提前 abort。修复：`mavis-cli-client.ts` 增加 `communicationMessages` 封装；`mavis-executor-provider.ts` 在 post-dispatch 轮询中按方向、command、dispatch 时间和独立 communication cursor 采集出站 prompt content，failed delivery 也可作为 Feishu 最终文本由 bridge 自行投递；`mavis-session-bindings.json` 新增 `lastSeenCommunicationId/lastSeenCommunicationTimestamp`；quiet timeout 改为软退避，hard timeout 才 best-effort abort。新增单测覆盖 outbound communication content 收口、quiet 后迟到回复完成、CLI 参数构造和 binding 游标持久化。

- 2026-06-30 Mavis 完成证据与续聊 sender 修复：定位到 Feishu 同一条 `1` 先回“未完成：模型没有返回可展示结果”、随后又回 Codex 风格短答，并非 MiniMax 输出格式错误。真实 Mavis session `mvs_7f6baad62f3f4aa0a417c794f3767b78` 已收到用户消息并写入 assistant `msg_type=1` 文本，但 `session.status/updatedAt` 晚于 assistant message 落库，旧 `streamUntilFinish` 只等 status 翻 `finished`，且活动时间优先取停在用户消息时间的 `lastActiveAt`，导致 quiet timeout 先触发。随后 retry/resume 走 `communication send` 时又依赖 `$__MAVIS_PARENT_SESSION_ID`，live daemon 环境没有该变量，被新版 Mavis CLI 拒绝 `Session ID required`，于是 pre-dispatch 回落 Codex。修复：轮询阶段 best-effort 拉取 messages，cursor 后出现 assistant text 即缓存为完成证据；活动时间取 `lastActiveAt/updatedAt` 较新值；resume 前读取当前 Mavis 消息尾部并把 `lastSeenMessageId/lastSeenMessageTimestamp/lastUserMessageTimestamp` 作为游标基线，避免上一轮 timeout 后迟到的旧 assistant 文本被下一轮复用；新增 `CTI_MAVIS_BRIDGE_SESSION_ID` / `MAVIS_BRIDGE_SESSION_ID`（load alias only，save 只写主命名）并在续聊时作为 Mavis sender 传入。新增单测覆盖“assistant text 早于 status finished”、“resume path 带 configured sender”和“旧 assistant 不得作为下一轮结果复用”。

- 2026-06-30 Mavis CLI status 解析修复：真实 `mavis session info/list` 返回的 `status` 是对象形态（如 `{ "type": "started" }` / `{ "type": "finished" }`），`lastActiveAt` / `updatedAt` 是毫秒时间戳。旧封装只按字符串解析，导致 `finished` 被误读为 `idle`、时间戳丢失，`streamUntilFinish` 可能轮询到 hard timeout，哪怕 MiniMax 已经返回文本。`mavis-cli-client.ts` 新增通用 `asMavisStatus` 与 `asTimestampString`，session summary、`createSession()`、`info()`、`communicationPeers()` 统一使用该解析；`mavis-executor-provider.ts` 清理重复 finished 判断。新增单测覆盖 `status.type` 和毫秒时间戳，真实验证 `mvs_78b771870ca8450abef5eb4b8bf31379` 可被解析为 `status: "started"` 且时间可被 `Date.parse` 使用。

- 2026-06-30 Mavis CLI 新版参数修复：继续追查“面板默认 Mavis，但 Feishu 卡片显示 Codex”的 live 现象，确认选择器已正确选中 `mavis-agent`，第一次回落来自 `spawn EINVAL`；修复 Windows `.cmd` shim 后，真实 CLI 又暴露新版协议差异：`mavis session new` / `session list` 的 agent 是位置参数（`new [options] <agent>` / `list [agentId]`），旧封装继续拼 `--agent` 会被 CLI 直接拒绝。`mavis-cli-client.ts` 新增 `buildMavisListSessionsArgs` 与 `buildMavisCreateSessionArgs`，统一生成位置参数，避免 list/new 两条命令各自漂移；单测锁住“不再生成 `--agent`”。用源码封装真实验证：`listSessions('mavis')` 能读到 11 个会话，`createSession({ agent:'mavis', from:'root', ... })` 成功创建 `mvs_8db2f60c6b6c47b18c593da3e5941420`，随后 `messages()` 读到 MiniMax-M3 返回 `PONG`。这说明 MiniMax/Mavis agent 已接入并可执行；Feishu 14:14 那条显示 Codex 是因为 pre-dispatch 失败后的诚实回落。

- 2026-06-30 Mavis CLI Windows shim 修复：定位到 live 已把 `CTI_DEFAULT_EXECUTOR_ID=mavis-agent` 写入配置，`executor-status.json.lastSelection` 也显示选中 `mavis-agent`，但 Feishu 14:14 的 workflow 事件记录 `外部 executor pre-dispatch 失败，回落 Codex：spawn EINVAL`，最终卡片因此正确显示 `来源：Codex CLI / SDK (codex)`。根因是 Windows live 配置使用 `C:\Users\admin\.mavis\bin\mavis.cmd`，`mavis-cli-client.ts` 直接 `spawn(cliPath, args)` 启动 `.cmd` shim 会在 Node/Windows 下同步抛 `spawn EINVAL`。修复为通用 `buildMavisSpawnSpec`：仅在 Windows 且 CLI 路径为 `.cmd/.bat` 时通过 `ComSpec` 执行 `cmd.exe /d /s /c <cliPath> ...args`，普通可执行文件仍直接 spawn；同步抛出的 spawn 错误也包装为 `MavisClientError('spawn_failed')`。新增单测覆盖 `.cmd` shim 包装与普通可执行文件直启，并用真实 `createMavisClient(...).status()` 验证本机 `.mavis\bin\mavis.cmd` 可返回 running 状态。

- 2026-06-29 执行器来源可观测与面板默认来源切换：新增通用 `CTI_DEFAULT_EXECUTOR_ID` 全局默认 executor 配置，控制面板“执行器”页可对已启用 executor 执行“设为默认 / 恢复自动”，设置页收口为“AI 执行与模型来源”，同页区分 executor 来源与 Codex 模型来源。runtime 统一通过 `resolveRequestedExecutorId(config, prompt, sessionDefaultId)` 解析请求来源，优先级为显式 `@hint > CTI_DEFAULT_EXECUTOR_ID > 兼容 session default > 自动选择`；旧 `mavisDefaultExecutor` 和 `executor.setSessionDefault` 只作为兼容来源保留。external dispatch 会发送包含 `executorId/executorName/executorKind` 的 `status` SSE，pre-dispatch 回落 Codex 时补发 Codex 来源状态；workflow evidence、`workflow-runs.json.execution` 和 Feishu `RunSummary` 同步保留 executor 字段。Feishu final card 底部新增“来源：executorName (executorId)”，并把“模型”限定为真实模型字段，避免把 `mavis-agent` 当模型名展示。控制面板最近 workflow、执行器状态和设置快照同步显示默认 executor，Control API 通过 `settings.save` 写回该配置。

- 2026-06-27 首个外部 Agent Executor：Mavis / MiniMax Code 通过本地 `mavis` CLI 接入 codex-im-suite。设计稿走 v1 → v3.4 共 6 轮 codex 评审（解决 lastIndexOf 越界、构造期替换 fallbackProvider、续聊不发本轮 prompt、配置 11 字段缺 `mavisDefaultExecutor`、`runtime.d` ≠ registry 来源、ExecutorRequest 形状、`from` 省略、`sessionDefaultId` 折进 `requestedExecutorId`、`@hint` 优先于 `sessionDefault` 等阻断点）。实现新增 7 个源文件（`mavis-cli-client.ts` / `mavis-session-store.ts` / `mavis-session-title.ts` / `mavis-failure-summarizer.ts` / `executor-provider-registry.ts` / `mavis-executor-provider.ts` + `config/runtime.d/executor.mavis-agent.json`）和 7 个单测文件，修改 `Config`（11 字段 + env 主命名 `CTI_MAVIS_*` 与 alias `MAVIS_*` 兼容解析 + `saveConfig` 只写主命名）、`executor-registry.ts`（追加 `mavis-agent` manifest + `@mavis/@minimax/@minimax-code` 显式 hint）、`main.ts`（注入 `ExecutorProviderRegistry` + 覆盖 `startObservedWorkflow` 与 `ObservedLLMProvider` 两个 `selectExecutor` 入口）。两阶段错误处理：pre-dispatch（probe + `session new` / `communication send`）失败 → 允许回落 Codex；post-dispatch（poll + messages + diff + 终态解析）失败 → **禁止**回落，判据 = `binding.mvsSessionId` 非空 + `lastDispatchAt` 已写入。`mavis-session-bindings.json` 仅保存 `bridgeSessionId → mvsSessionId` 续聊映射，**绝不**记录 secret / token / 原始 diff，写盘走 `tmp + rename`。bridge-runtime 414 个单测全绿、typecheck 通过。本次**不**改 `suite.manifest.json`、`live skill`、`release/`、`apps/installer/`、`AGENTS.md`（executor 命名规则已在 v1 中），仅在 docs 增 §"外部 Agent Executor" 段。已知风险：`--command abort` 是 best-effort 弱保证；24 小时续聊窗口靠 `info()` 探活兜底，server 端 GC 触发后 binding 自动 drop；本地模型作为 Codex 模型来源时**不**作为 mavis-agent 兜底，工具证据失败仍按真未完成上报。

- 2026-06-11 Feishu 轻聊天 token 优化：新增通用 `light_chat` 路由和轻量 prompt profile。短问候、确认、表情包接话、轻量状态回复在无附件、无工具证据需求、无文件/MCP/Unity/文档/图片理解/发布/排障意图时，优先走本地或低成本 provider；本地不可用时回退 official Codex，但仍只携带 assistant 身份、Feishu emoji/sticker 策略、轻量回复契约和最近 0-2 条历史，避免把 workspace、MCP、Unity、文件产物和长历史塞进 3 万 token 级完整上下文。运行摘要新增 `promptProfile=light_chat`，控制面板会话运行卡展示 profile，Feishu final card token footer 拆分显示输入 / 输出 / cache 读写。新增配置 `CTI_LIGHT_CHAT_FAST_PATH_ENABLED`、`CTI_LIGHT_CHAT_HISTORY_LIMIT`、`CTI_LIGHT_CHAT_MAX_INPUT_CHARS`，默认启用且保持复杂任务走原 Codex / JSON 工具证据链。

- 2026-06-11 Feishu 表情表达策略与表情包库：轻量聊天、问候、确认、调侃、感谢和表情包接话现在优先使用已学习且未禁用的语义匹配表情包；裸 `[表情包]` 会结合剩余回复文本与 `label/aliases/intent/tone/usage/examples/avoidWhen/annotationConfidence/chatId/useCount/lastUsedAt` 做通用评分，不再默认最近或高频项。Reaction profile 的出站成功次数降为弱信号，`SMILE` 不会因历史成功多而默认排前；`[微笑]`、`[赞]`、`[OK]` 仍会转成 Feishu reaction，失败时剥离 hint 并用 Unicode 兜底。控制面板“记忆”页新增“Feishu 表情包库”，通过 `memory.feishuStickers`、`memory.updateFeishuSticker`、`memory.mergeFeishuStickerAliases` 管理 `CTI_HOME\data\feishu-stickers.json`，支持查看、搜索、编辑语义、合并别名、禁用/恢复误学语义，并保持 UTF-8 no-BOM 可读中文写盘。
- 2026-06-11 Feishu streaming card 运行摘要：bridge-core 从 provider `status` / `result` SSE 中收集通用 `RunSummary`，把 provider、模型来源、模型名和 token usage 随 `onStreamEnd` 传给 Feishu adapter；最终卡片底部在状态、工具轨迹和耗时旁显示当前模型以及输入 / 输出 token。该链路复用已有 `execution/tokenUsage` 语义，不按具体模型名、provider 或请求文本写特例；缺少字段时保持不展示或未知。
- 2026-06-09 manifest 无序关键词匹配：为 `config/local-agent-tools.d` 的工具匹配增加 `keywordGroups`，表示任一关键词组全部出现在用户文本中即可命中，且不要求顺序。Unity Game View 截图 manifest 使用该通用能力覆盖 `unitygame视角截个图` 这类短句，避免因为 “game” 出现在“截图”前而漏判成普通聊天，再进入官方 Codex/agentcli 自由探索。该能力适用于所有 manifest-driven MCP、Unity MCP 和产物工具，不把匹配逻辑写死在 provider 代码里。
- 2026-06-09 manifest 工具任务瘦身：Codex runtime 在进入官方 Codex 主链路前，会先用 `config/local-agent-tools.d` 的 `mcp_tool_call`、`unity_mcp_execute_code` 和 `shell_artifact` manifest 做确定性匹配；命中后不切换到本地 fallback，也不要求官方 Codex 直接调用内部 `mcp_call` 句柄，而是把同一个 Codex 主脑的输入压缩成 manifest-constrained task：空历史、新线程、严格 `ExecutionRequirement`、选中的 JSON 工具请求和最小工作区摘要。Codex 负责输出标准 `tool_request` JSON，runtime 作为工具宿主校验并执行该请求，再用 `cti-final` 附件契约发送图片/文件；如果 Codex 未输出可解析 JSON，只能在已选 manifest 边界内使用同一个请求兜底，不进入自由探索。这样 Codex 仍负责规划，但不会先读 skill、全盘扫文件或手写 MCP HTTP。`McpBridge` 同步增加 HTTP MCP session 复用和短 TTL `tools/list` 缓存，session 失效时清缓存重握手一次，减少 Unity、web-search 等所有 HTTP MCP 的重复 initialize / discovery 往返，不针对单个 MCP 写特例。
- 2026-06-09 live 同步补齐控制面板构建：定位到 `sync-live-skill.ps1` 同步 bridge runtime 后仍复制旧 `release/artifacts/control-panel`，导致控制面板前端改动构建成功但 live 面板继续加载旧 `wwwroot`。同步脚本现会在复制 live 面板前先构建 `apps/control-panel/web` 并发布 `apps/control-panel/CodexImSuite.ControlPanel.csproj` 到控制面板 artifact，再同步到 live `dist/control-panel`；避免以后依赖陈旧 release 目录。
- 2026-06-09 控制面板会话详情归并运行历程：会话详情页不再把 workflow run 固定堆在消息流上方，而是优先按 `recovery.input.messageId` 精确挂到触发消息下；旧记录缺少消息 ID 时，按同一会话内时间窗口和文本重合度做兜底匹配，并把匹配来源显示为“消息 ID 匹配”或“按时间匹配”。无法归并的 run 仍保留在“未归并到具体消息的运行记录”区，避免丢失审计线索。该改动只复用既有 `workflowRuns` 详情数据，不为某个工具、请求文案或 MCP 名称写特例。
- 2026-06-08 Feishu final card 展示收口：runtime 终答归一化和 bridge-core 卡片收尾统一清理内部协议名与旧式模板段落，保留用户可见结果和必要处理依据；相关回归覆盖 `local-agent-tool-protocol` 与 Feishu Markdown/card 链路，避免 final card 泄漏工具协议或出现乱码占位。

- 2026-06-08 项目内 Git 会话存档安装：新增 `config/git-session-archive.json`、`.githooks/`、`scripts/install-git-session-archive.ps1` 和 `scripts/complete-git-session-archive.ps1`，把 `entireio/cli` 固定版本构建到当前仓库 `.codex-tools\bin`，并通过 `git config --local core.hooksPath .githooks` 只在本项目启用 hooks。策略保持 `manual-commit`，关闭 telemetry、自动 session push、自动 commit、自动合并到 `codex/dev` 和自动 push；其他项目需要时必须在对应项目重新安装。
- 2026-06-08 一键发布补齐 Git LFS 预同步：定位到控制面板“本机备份发布”在打包出 `release/*.zip` 后只执行普通 `git push`，远端缺少对应 LFS blob 时会被 GitHub `GH008 unknown Git LFS object` 拒绝。`scripts/publish-backup.ps1` 现已在推送前通用检查仓库是否启用 Git LFS，并按上游 remote 自动执行 `git lfs push <remote> --all`；不再依赖某个固定 zip 名称或手工补传步骤。

更新时间：2026-06-08

本文记录当前项目已经完成的主要改造和后续维护注意事项。详细架构见 [PROJECT-ARCHITECTURE.md](./PROJECT-ARCHITECTURE.md)。

- 2026-06-08 本地模型语义收口：本地模型 / 外部 API 统一作为 Codex agent 的模型来源，不再作为独立本地 agent 兜底。执行器目录移除 `local-tool-agent` 用户可选入口，控制面板统一展示为“本地模型 API”，且仅在手动选择 `local_api` 或自动切换链包含 `local_api` 时检查该服务；旧 `CTI_CODEX_LOCAL_FALLBACK_*`、`CTI_CODEX_FAILURE_FALLBACK_MODE`、`CTI_LOCAL_AGENT_MODE`、`CTI_LOCAL_TOOL_CALL_REQUIRED` 和 `CTI_EXECUTION_REQUIRED_ROUTE` 不再作为主策略入口或设置项。

- 2026-06-08 Unity MCP 健康检查收口：控制面板和 bridge-runtime 的 HTTP MCP 健康判断统一按 manifest 执行。`healthCheck.kind=mcp-http-resource` 会先完成 MCP initialize，再读取声明的 `resourceUri` 并按 `successRegex/failureRegex` 判定；普通 `healthCheck.kind=http` 只证明 endpoint 或 MCP protocol 可达，不会再因为 manifest 名称、显示名或 `/mcp` URL 像 Unity 就隐式读取 `mcpforunity://instances`。Unity MCP 当前通过 manifest 声明读取 `mcpforunity://instances`，只有 `instance_count > 0` 才算真正健康；新增 runtime 和控制面板回归测试覆盖资源成功、资源为 0、以及未声明资源检查时不做 Unity 特例。

- 2026-06-08 Feishu 进度卡自然文案回归：本地 JSON 工具协议不再向 `progress` SSE 固定输出 `处理思路 / 执行结果` 分节，也不再依赖“正在组织上下文”式等待模板；runtime 会按 `ExecutionRequirement`、工具族、MCP schema 参数和真实 `tool_result` 生成当前任务相关的自然阶段文案。联网搜索请求会显示“实时网页或新闻证据”“调用搜索工具”和实际 query，Feishu workflow card 在已有 provider 细节时不会再被泛化 `JsonTool:mcp_call` 工具事件覆盖。终答整理层也会在封装 `cti-final` 前剥离模型偶发的旧式“处理思路 / 执行结果”模板，只保留可展示结果。新增回归覆盖 shell、本地读取、Unity MCP 多步、artifact 和 `web-search` MCP 搜索链路，继续通过 UTF-8/mojibake 扫描。

- 2026-06-06 Unity MCP 健康检查去虚报：定位到 CLI 侧无法使用 Unity MCP 时，控制面板仍显示正常的原因是只验证 HTTP/MCP initialize 或响应里存在 `instances/contents/text` 字段，没有要求真实 Unity Editor session。现在 MCP manifest 支持通用 `mcp-http-resource` 健康检查，控制面板和 runtime 会按 manifest 声明读取 MCP resource 并校验成功/失败条件；Unity MCP 改为读取 `mcpforunity://instances`，`instance_count=0` 会显示为未连接而不是正常。根 launcher 也改为 initialize 后继续读取 instances，且不再回退到固定 Unity 工程路径。

## 1. 项目收口

- 2026-06-06 Feishu 表情包通用轮换：定位到裸 `[表情包]` hint 被解析成“最近”，再叠加 `useCount` 降序，导致越发越偏同一个表情包；同时模型生成的未知具体别名会被适配器兜底到任意表情包，造成“说换了但仍发旧图”。现在裸 `[表情包]` 走通用轮换，优先同 chat、已标注语义、低使用次数和更久未发的候选；只有显式 `[表情包:最近]` 才固定选择最近收到的表情包；具体 `[表情包:别名]` 必须命中已记录 alias，否则只剥离 hint 并发送剩余文本，不再 fallback 到任意表情包。发送记录新增 `lastUsedAt`，与 `lastSeenAt` 分开，避免“收到”和“发出”互相污染排序。

- 2026-06-06 Feishu 表情包-only 状态卡收口：定位到模型已返回 `cti-final`，但正文只有 `[表情包]` hint，bridge 在末尾追加的完成标记 `✅` 被表情包发送后残留为唯一正文；最终卡片渲染会剥离独立完成标记，于是误判成“模型没有返回可展示结果”。现在 Feishu adapter 在 sticker/reaction hint 已成功执行且剩余文本只有状态标记时，会把卡片收口为通用动作结果（如“表情包已发送。”或“已回应。”），普通消息发送路径也不会再额外发送单独的 `✅` 文本。

- 2026-06-06 Feishu workflow 进度卡改为事件驱动：撤回 UI 层“进度展示用执行意图”预分类，不再因为用户文字像 Unity/MCP、截图、本地文件或命令就预先创建 workflow card。默认先走轻量状态；只有桥接前置检查、provider `progress` SSE、真实 `tool_use/tool_result`、权限等待或已有 workflow 检查点出现时，才自动升级为 workflow card，并继续用同一张卡收口。正文 token 流不再触发 workflow，表情包结构化消息也不会被误升级。

- 2026-06-06 SearXNG 扩展目录项撤回：`mcp-searxng` 依赖用户自备 SearXNG 服务和 JSON API，无法做到“安装即用”，且在默认路由收回给 AgentCLI 后不应作为面板推荐入口误导用户。在线扩展目录已移除该 seed；`web-search` 仅保留为兼容的通用 MCP family，不会在默认模式下由 bridge-core 预先触发。

- 2026-06-06 工具失败证据可见性修复：定位到外部工具连接失败时，Feishu 最终卡片只显示 `成功结果=0`，没有展示 MCP 返回的真实网络或配置阻塞原因，容易和后续兜底回答混淆。现在 `bridge-core` 和 `bridge-runtime` 会从通用 `tool_result` 错误内容提取最多 3 条 `failedToolErrors`，写入 ConversationResult 和 workflow execution 摘要；no-evidence 拦截、出站假完成拦截和控制面板运行记录都能显示具体失败原因。该修复不针对单个 MCP 写特例，适用于任意 shell、MCP 或 JSON 工具协议失败。

- 2026-06-06 MCP 调用结果质量修复：`McpBridge.callTool()` 不再把 MCP `tools/call` 响应压平成普通字符串，而是保留 `{ ok, content, error }`；HTTP 和 stdio MCP 返回标准 `isError=true` 或结构化错误字段时，JSON 工具协议会得到 `ok=false`，Feishu 工具轨迹显示失败，`successfulToolResultCount` 不会增加。该判断来自 MCP 协议和结构化结果字段，不按用户请求、工具名或具体错误文案写特例。

- 2026-06-06 AgentCLI 工具路由默认权交还模型：默认关闭 bridge-core 对 MCP、本地文件、Unity/Blender、新闻/时效信息等请求的自动 `tool_required/local_read_required/artifact_required` 强制分类，改由 Codex CLI / agentcli 自己判断是否调用工具。桥接层保留出站真实性收口：声明的本地产物路径必须真实存在；没有成功工具记录时不能声称已经执行、创建、修改或完成。旧的强制工具门槛仅作为兼容开关 `CTI_STRICT_TOOL_ROUTING=true` 保留。

- 2026-06-06 执行证据门槛通用化：`ExecutionRequirement` 新增 `strictToolEvidence`，由工具族是否涉及本地状态、shell、文件、产物、Unity/Blender 等可验证执行面决定是否硬性要求成功 `tool_result`。非严格工具族仍会优先尝试 manifest/MCP 工具，但工具不可用时允许官方/外部模型基于自身能力回答，且不能声称工具成功。`codex-local-cli-provider` 的 MCP discovery fallback 改为读取 `requiredToolFamilies`，不再在 provider 层维护另一套“网页/新闻/头条”句式判断。

- 2026-06-05 联网搜索执行链路修复：定位到外部时效信息请求没有被 `ExecutionRequirement` 映射到可用工具族，官方 Codex 又默认隔离全局 MCP，最终被出站审查替换成 `tool_use=0` 的未完成卡片。现在新增通用 `web-search` 工具族，相关请求会进入本地 JSON 工具协议；`mcp-bridge` 补齐 stdio MCP 的 `tools/list` / `tools/call` JSON-RPC 调用，provider 会按 MCP manifest 的 category/aliases/schema 发现搜索工具，不针对单个 MCP 或具体中文句式写死。若底层搜索服务未启动或 JSON API 不可用，飞书会得到真实 MCP 调用失败原因，而不是假完成或空工具证据。

- 2026-06-05 群聊首醒排队反馈与本地 API 重启链路修复：定位到群聊共享 session lock，上一条消息卡在 provider 冷启动或本地模型失败时，下一条群消息会先排队而未进入 `handleMessage`，导致长时间无可见反馈；bridge-manager 现在在同一 session 已有未完成任务时先回复“已收到，按顺序处理”，最终回复仍按原执行顺序生成。控制面板 `settings.saveAndRestartBridge` 现在在目标路由包含 `local_api` 时先准备本地 API 后端再重启 Bridge；Ollama 通过既有启动脚本复用/启动服务并继承模型目录，避免只写配置但 `127.0.0.1:11434` 没有服务导致飞书仍报 `No running Ollama server detected`。

- 2026-06-05 Feishu Emoji 学习与表达增强：新增 `config/feishu-emoji.d` 数据驱动 reaction catalog，并在 `suite.manifest.json` 和 live 同步脚本中声明/复制该目录；Feishu adapter 的 `[微笑]`、`[赞]`、`[火]` 等 reaction hint 现在通过 catalog 解析，未知但合法的 `emoji_type` 仍可透传，失败时保持可见正文或 Unicode fallback，不吞消息。新增 `CTI_HOME\data\feishu-emoji-profile.json` 记录入站 reaction、出站 reaction 成功/失败和 chat/user 偏好，bridge-manager 会把 catalog 示例和已学习偏好注入轻量聊天 prompt；真实表情包仍只复用已记录 `file_key`，不伪造资源。
- 2026-06-05 Feishu reaction 默认微笑收口：定位到 bridge-manager 身份 prompt、conversation-engine 展示契约和 catalog 示例都把 `[微笑]` 放在首位，模型会照抄成固定微笑回复。现在 prompt 明确要求按实际意图选择 reaction，不能默认 `SMILE`，中性、正式、阻塞或不明确时不加表情；catalog 示例改为 `emojiType + intent + aliases`，不再输出可直接复制的 `[微笑]` 模板。新增单测覆盖 adapter prompt 和 provider system prompt，避免默认微笑回归。
- 2026-06-05 Feishu 表情包语义用法增强：`CTI_HOME\data\feishu-stickers.json` 的真实表情包资源簿扩展 `usage/avoidWhen/examples`，用户回复表情包说明“叫什么、表示什么、适合什么时候用”时会结构化写回同一 `file_key`。bridge-manager 会把已学习的表情包名称、含义、语气和适用场景通过 `getStickerPresentationPrompt()` 注入轻量聊天 prompt，鼓励模型使用 `[表情包:别名]` 做精确选择；裸 `[表情包]` 现在优先选择有语义标注的候选，不再因为最近收到一个未知表情包就机械发送。
- 2026-06-05 Feishu 普通图片-only 意图推断：修复用户只发图片时 provider prompt 固定为 `Describe this image.`，导致图片消息被回复成看图识字/图片描述的问题。现在普通图片-only 消息会以通用方式提示模型把图片当作对话消息载体，先结合图片内容和聊天上下文推断沟通意图与期望动作，再回应这个意图；只有用户明确要求描述或转写时才做纯 OCR。新增 bridge-manager 单测覆盖图片-only prompt，避免回退到图片描述默认值。
- 2026-06-05 Feishu P2P 回复图片上下文修复：定位到私聊历史轮询补捞会把 `parent_id/upper_message_id/root_id/thread_id` 丢掉，导致“回复上一张图继续分析”只能看到当前文本，看不到被回复图片。现在轮询恢复消息会保留这些 reply 元数据，沿用既有被回复消息附件补取链路，把原图作为本轮 provider attachment 传入模型；新增 Feishu adapter 单测覆盖历史轮询恢复的文本回复能自动带入上文图片。
- 2026-06-05 控制面板会话列表远端历史计数修复：确认 `feishu-history-index.json` 已包含远端同步记录，但 WebView 会话列表只展示本地 session 消息数，导致私聊/群聊看起来“条数变少”或误标为“仅本地”。现在列表和详情同时返回 `localMessageCount` 与 `remoteMessageCount`，来源标签按“当前远端可见 / 本地绑定 / 已同步远端历史”统一推导；前端优先展示远端历史条数，并在本地消息数不同时同时显示本地条数。
- 2026-06-05 Feishu 近期媒体上下文回捞：针对“继续分析 / 一步一步讲 / 这题怎么解”等无附件跟进消息，bridge-manager 会先判断当前短句是否引用上文媒体，再从同一会话本地历史的 `<!--files:...-->` 附件记录中回捞最近图片作为本轮 provider attachment，并注入 `Recent conversation media context`。这样用户不必每次显式回复原图；如果历史里没有可用图片，仍由模型明确说明缺少上下文。

- 2026-06-05 Feishu 流式卡片视觉强化：按“精致渐进”方向优化 CardKit streaming card 的通用展示，不针对具体请求写死。等待态仍只显示当前一步用户可见动作，但标题改为紫色强调，并追加“依据确认 / 工具完成 / 结果生成”阶段轨迹；完成态卡片 header 改用回答正文标题或首行摘要，不再显示固定“处理完成 / 最终结果”，正文直接呈现结果，工具轨迹作为辅助区，底部只用 `✅` / `×` 加耗时表达完成状态。最终正文会清理模型自己独立成行输出的 `✅`、`✔`、`☑`、`❌` 或 `×`，避免正文和底部重复显示状态；只有清理状态符后仍存在正文内容时，首行才会被提取为标题，轻量表情回复会保留正文并生成短摘要标题。出站仍剥离等待态“处理思路”和内部工具协议，工具名继续转为通用可见标签。

- 2026-06-05 截图类 artifact 证据兜底修复：定位到 `截个图给我`、`刚刚摆的 prefab 摆截图给我` 这类请求会被正确判为 `artifact_required`，但 official Codex 因额度/登录失败或没有调用工具时，最终被出站证据闸门替换成 `tool_use=0` 的通用未完成文案。`config/local-agent-tools.d` 的工具匹配现在支持 `contextualRegex + contextRegex`，Unity Game View 截图 manifest 可在 Unity 工作区语境中识别短句截图，也可直接识别 prefab/场景截图请求；Codex 主模型失败后，如果 runtime 已能从 manifest 得出确定性 JSON 工具计划，会直接用本地受控工具协议执行该产物工具，不再依赖模型重新猜工具，也不把 provider 失败包装成内部证据计数。
- 2026-06-04 Feishu 身份注入与回复风格保存入口修复：渠道助手身份 prompt 现在放在 system prompt 最前部，避免后续 provider 截断长系统提示时丢失飞书应用名，导致自我介绍重新自称 Codex；已有飞书应用名时，模型回答“你是谁 / 自我介绍 / 你叫什么”必须优先使用该渠道名，只有用户询问底层引擎时才说明 Codex。控制面板“回复风格快捷设置”和“自定义整理”卡片内新增明确保存按钮，“本地 AI 整理”成功后同步清除前端未保存状态，避免用户找不到自定义保存入口。
- 2026-06-04 记忆与短期历史改为按需参与：定位到普通聊天会先跑一次 `MemoryIntentHost.classifyMemoryWrite`，再进入真正 provider 回复，且两次调用都携带较长历史上下文，导致“自我介绍一下”等轻量消息明显变慢。bridge-core 现在只在显式“记住 / 记录 / 这个表示...”类写入请求时调用记忆写入分类器，只在明确“记得 / 回忆 / 搜索记忆”类请求时走 `MemoryReplyDecision`，工具、Unity/MCP、文件等执行类任务按 `memoryMode=augment` 少量补充上下文；普通聊天默认 `memoryMode=off`，仍走正常 API 模型生成但不预跑记忆工具。bridge-runtime 同步收紧短期历史保留窗口和归档读取上限，避免每轮都把过长历史塞进思考前上下文。
- 2026-06-04 Feishu 自然聊天与 reaction hint 收口：移除 bridge-core 对问候、自我介绍等普通聊天的本地硬编码秒答，轻量消息仍可使用 `ReplySurfaceMode=light_status` 的等待表面，但最终内容统一由配置的 provider/API 模型生成。Feishu 出站的 `[微笑]`、`[赞]`、`[OK]`、`[BULL]` 等已知 reaction hint 现在覆盖普通文本、Markdown card 和 streaming final card；adapter 会先尝试添加原生 reaction，失败或缺少可回复源消息时剥离 hint 并用对应 Unicode emoji 兜底，避免把 `[微笑]` 这类发送指令展示给用户。
- 2026-06-04 Feishu 机器人身份与原生表情表达优化：Feishu adapter 启动时从 `/bot/v3/info` 提取机器人 `name/app_name/i18n_name`，bridge-core 将其作为通道助手身份注入 provider；用户问“你是谁 / 自我介绍”时优先使用飞书应用名，不再默认自称 Codex。轻量聊天和表情包接话的 system prompt 也明确允许模型偶尔使用 `[微笑]`、`[赞]`、`[OK]`、`[BULL]` 或 `[表情包]` hint，adapter 命中后转成飞书原生 reaction 或已收到过的真实 sticker，正式工具结果和阻塞不主动加表情。
- 2026-06-04 Feishu 表情包轻量聊天收口：`sticker` 入站即使通过 `file_key` 下载到了表情包图片，也默认按聊天语气事件处理，不进入 workflow card 或工具证据链；下载到的图片可作为 provider 视觉语气参考，让模型判断表情包情绪和玩笑意味后自然接话，但最终回复不能写成图片说明报告。`messageKind=feishu_sticker_image` 作为结构化路由信号，避免附件存在导致误入 `artifact_required`。
- 2026-06-04 Feishu 表情包出站证据拦截修复：表情包轻量聊天回复不再被“无真实工具证据”硬拦截。出站假完成拦截现在以本轮 `ExecutionRequirement` 为边界，只有 `local_read_required/tool_required/artifact_required` 任务才要求成功 `tool_result`；`feishu_sticker_*` 消息即使 adapter 原始说明或模型轻聊回复里出现“图片 / 已收到”，也会按聊天回复发送，不替换成 `tool_use=0` 的未完成卡片。
- 2026-06-04 Feishu 表情包语义与轻量回复收口：`sticker` 入站新增 `messageKind=feishu_sticker_unknown|feishu_sticker_known`，并把 `feishu-stickers.json` 里的 `label/description/intent/tone/aliases` 语义档案作为 agent 上下文注入。`ExecutionRequirement` 现在优先识别结构化 sticker 事件，未知或已标注表情包都不会因为平台说明里的“图片 / 图案 / 下载”误判为 `artifact_required`；真正图片附件、截图、Unity/MCP 和文件产物请求仍保留工具证据门槛。Feishu 展示新增 `ReplySurfaceMode`：工具链继续走完整 workflow card，表情包和普通轻量消息改为延迟极短“正在回复…”状态，快速完成时不建卡，避免每次都显示工具选择和证据判断。
- 2026-06-04 Feishu 表情包语义识别修复：确认飞书官方 `sticker` 入站只返回 `file_key`，且不支持机器人下载表情包图片；未知表情包不再让 agent 误以为已看到图案，而是明确注入“未标注语义、不能凭 file_key 猜图案/意图”的上下文。`feishu-stickers.json` 扩展 `label/description/intent/tone/annotationConfidence` 语义档案，用户回复表情包或紧接着说明“这个表情包表示/叫/意思是...”时会写回同一 `file_key`，后续再次收到该表情包时把已学图案和意图交给 agent。新增单测覆盖未知表情包防幻觉、已学语义注入、用户解释后学习。
- 2026-06-04 Feishu 真实表情包出站：在入站 `sticker` 表情包解析基础上新增 `CTI_HOME\data\feishu-stickers.json` 通用资源簿，按 `file_key`、chat、user、message 和别名记录最近可复用表情包。模型最终回复可用 `[表情包]`、`[表情包:别名]` 或 `[sticker:file_key]` 作为用户不可见 hint，Feishu adapter 在命中真实资源时先发送原生 `msg_type=sticker`，再发送或渲染剥离 hint 的正文；未命中时保留普通文本，避免模型编造表情包资源。新增 adapter 单测覆盖 final card sticker、普通文本 sticker 和入站 sticker 记录。
- 2026-06-03 Feishu 打字机与表情包修复：streaming card 的当前思考动作改为 adapter 侧增量刷新，题头立即出现，灰色正文按小步补齐；新步骤到来会取消上一轮打字并刷新为新标题/正文。`[微笑]` 等 reaction hint 不再只处理 plain text，final streaming card 也会先给原用户消息添加飞书原生 reaction，再从最终卡正文剥离 hint；新增 `微笑 -> SMILE` 等常见映射。入站 `sticker` 表情包不再被 `Unsupported message type: sticker` 丢弃，会转成“用户发送了一个飞书表情包，file_key=...”的可见文本和 raw metadata 交给 agent。
- 2026-06-03 Feishu 思考卡片单步刷新与表情 reaction：等待态 streaming card 从“思考路径列表 / 工具轨迹”改为单步刷新，卡片只显示当前思考动作的简短标题和灰色小字正文，新的 provider progress、记忆证据、工具事件或收口阶段会替换上一条内容，不再累计固定流程文案。普通文本出站新增通用 reaction hint，模型可用 `[牛] 收到~` 这类开头提示让 Feishu adapter 先给被回复消息添加原生 reaction，再发送剥离 hint 的正文；reaction 失败时保留原文发送，避免吞结果。
- 2026-06-03 控制面板系统蓝图遮挡修复：系统蓝图的处理面板不再作为右侧小窗占用第二列，改为蓝图下方的行内处理区；蓝图链路区域增加横向滚动保护，避免在窄窗口或中等宽度下挤压到操作按钮和后续面板。
- 2026-06-03 Feishu 流式卡片视觉与思考路径优化：去掉 bridge-core 在每轮开始时无条件推送的“已收到请求 / 正在判断 / 会话权限 / 读取工具目录”固定流程，改为“思考路径”卡片，展示模型/provider progress、记忆证据、工具事件和 agent 收口这些用户可见阶段；CardKit 首卡 skeleton 也改为更简洁的“正在思考”。最终卡不再额外加“最终结果”标题，正文直接呈现结果，工具轨迹、状态和耗时统一放到底部小字号辅助栏，继续剥离等待态思路和内部协议名。
- 2026-06-03 控制面板系统蓝图交互重构：总览页蓝图从纵向展示卡片改为“主链路 / 辅助能力 / 处理面板”的两段式导航，节点卡片只负责快速识别状态与入口，选中节点后的处理面板统一承载主动作、跳转入口和不可用原因；同步补充桌面布局与窄屏折叠样式，并更新架构文档，保持蓝图仍只复用现有运行单元动作，不引入新的运行时链路。
- 2026-06-03 遗留编码与临时分支清理：删除 `bridge-manager` 中三个 `if (false && ...)` 临时禁用分支，记忆写入继续只走模型意图分类后的可见记忆仓库落库，飞书文档继续走 agent rewrite + 文档生成链路，Unity MCP 前置诊断只注入 agent 上下文、不再保留早停直答。新增 `source-encoding` 源码扫描器并接入 runtime 测试与 `scripts/update-architecture-docs.ps1`，覆盖 bridge-core、bridge-runtime、控制面板和脚本中的 BOM、`U+FFFD`、典型 mojibake、长问号串和临时死分支；检测器样本需放入 `cti-encoding-allow-start/end`。同时移除 `Program.cs`、`feishu-cloud-documents.ts`、`store.ts` 和两个脚本的 UTF-8 BOM。历史乱码修复入口保留 `dry-run / -Apply / -Restore`，并补齐文件级 `unresolved/error` 报告，遇到 Windows 锁定或备份失败不会中断整轮修复。
- 2026-06-03 Feishu 重复执行与单卡片出站修复：定位到切换 Codex / bridge 重启后，Feishu p2p 历史补捞可能把同一条图片说明恢复成新 `messageId`，再加上同一 `messageId` 的重复事件，导致一条用户消息进入多轮 workflow 并生成多张卡片。`bridge-manager` 现在在执行链入口做持久入站去重，同一 channel/chat/messageId 只执行一次；带附件的媒体说明文字会额外写入短期文本指纹，挡住 caption 被补捞为新消息的重复执行。支持 Feishu streaming card 的请求也不再同时启用旧 preview 出站，最终只保留同一张 streaming card 的完成态结果。
- 2026-06-03 记忆写入改为模型计划落库：修复 Feishu 中“记一下 / 重新记一下 / 这个是……”这类记忆写入只收到“记住了”但控制面板记忆页不可见的问题。bridge-core 现在通过 `MemoryIntentHost` 让模型结合当前消息和最近上下文输出结构化 `MemoryWriteCandidate`，再由 runtime store 写入 `data/explicit-memories/*.md` 并重建 `knowledge.json` / 关系图；模型未给出可落库候选时不会假装成功。显式写入也会走 Feishu streaming card 的用户可见处理进度，最终卡只展示写入结果。store 侧保留表格/键值解析作为保守兜底，并把项目别名提取限制在首行说明，避免把结构化表格里的 prefab、scene id 或路径片段误当作项目别名。
- 2026-06-03 记忆回忆证据门槛修复：线上复现“所有的常用场景名发给我”进入 agent 后被 `tool_required` 拦截，原因是 `ExecutionRequirement` 只看用户文本，看到“场景”就误判为 Unity/MCP 工具任务。现在 `MemoryQueryPlan` 会从 `bridge-manager` 传入 `conversation-engine`，显式记忆回忆直接按记忆证据链处理，不再触发工具证据重试或“本轮没有检测到真实工具执行成功记录”；进度卡片也不会把记忆查询标成工具任务。

- 2026-06-03 本地 Codex agent 卡死收口：定位到 live 请求停在 `engine_started/executing` 的根因是 `codex exec --oss --local-provider ollama` 子进程无硬超时，Windows 下还会形成 `cmd -> node -> codex.exe` 进程树；当 Codex CLI 插件同步或本地模型过程不退出时，Feishu streaming card 会一直停在处理中。`codex-local-cli-provider` 现在给普通本地 turn 和工具后终答整理都加整轮超时，默认 5 分钟，可由 `CTI_BRIDGE_PROCESSING_TIMEOUT_MS` 覆盖；超时或 abort 时 Windows 使用进程树终止。同时 local primary / fallback 的 `CODEX_HOME` 不再共享全局 `plugins`，生成本地 `config.toml` 时剥离插件、marketplace、desktop、memories、personality 和 notify 配置，并清理旧 local HOME 的插件同步状态，避免桌面插件市场缓存、坏 manifest 或桌面 profile 配置拖住本地 agent。
- 2026-06-03 记忆检索改为 agent 路由：高置信结构化记忆命中不再由 bridge-core 快捷直答，统一转成 agent system prompt，经 `conversation-engine` 和 provider 生成最终回复，再走出站 review。记忆终答会按用户真实询问意图整理：问“所有 / 全部 / 列表 / 对应表”时保留命中的完整结构化项，单项查询才收窄到匹配项，避免“所有常用场景名”只回一个键值。Feishu streaming card 现在会在默认处理路线中展示“判断证据/工具/记忆上下文”，并在记忆命中或未命中时展示“交给 agent 整理/收口”的用户可见阶段；这不是隐藏思考链，不写入最终回复或会话历史。
- 2026-06-03 MCP 终答防幻觉收口：确认 `find_gameobjects` 只返回 `instanceIDs` 时，工具成功不等于已经拿到节点名称。JSON 工具协议现在会按用户请求的信息粒度校验 MCP 结果；当用户要求名称、路径或对象详情，但工具结果只有对象 ID、分页和计数时，不允许终答整理模型把 ID 猜成对象详情，必须继续读取详情或以“未完成：具体阻塞”收口。新增本地 API 回归测试覆盖“模型声称 Main Camera、真实工具历史只有 instanceIDs”的场景，并把同类 ID-only 规则收敛为通用 MCP 结果结构校验。
- 2026-06-02 Windows 状态文件与 CardKit 兼容加固：`workflow-runs.json` 写入改为唯一临时文件，并对 Windows 常见 `EBUSY/EPERM/EACCES` 短暂锁做统一重试，避免面板、bridge 和重试服务读写交错时因为资源忙导致请求中断。Feishu streaming card 不再固定访问 SDK 的 `cardkit.v2`，而是按已安装 SDK 暴露的 CardKit v2/v1 能力选择创建、内容流式更新、关闭 streaming 和最终卡更新接口；当前 `@larksuiteoapi/node-sdk` 只有 `cardkit.v1` 时会走 `card.create`、`cardElement.content`、`card.settings` 和 `card.update`。
- 2026-06-02 Unity/MCP 证据分类与空结果收口：`ExecutionRequirement` 的命名查询豁免不再覆盖“Unity/MCP/场景/节点/组件/物体 + 查找/列出/统计/总结/读取”等当前状态检查请求，这类请求会进入 `tool_required` 并要求真实工具结果；单纯询问记忆里的场景名称仍可保持 `none`。provider 流结束但没有任何可见最终文本时，bridge-core 会返回“未完成：模型没有返回可展示结果。”并把 streaming card 收成带正文的失败结果卡，避免再次出现“状态已完成但结果为空”。
- 2026-06-02 回复风格与 Feishu 卡片收口：`CTI_REPLY_STYLE_HINT` 现在会进入 bridge store，并通过 `replyPresentation.replyStyleHint` 显式传给普通 Codex、Codex CLI 本地 API 和工具后终答整理层。JSON 工具完成后的最终回复不再强制固定“处理思路 / 执行结果”模板，而是按设置里的语气生成结果优先的用户可见 Markdown；等待态 CardKit streaming card 仍可展示用户可见处理依据和阶段结果，最终同一张卡会替换为结果正文优先、底部附状态 / 工具轨迹 / 耗时的结构化卡片。新增源码级 UTF-8/mojibake 回归扫描，覆盖 bridge-core、bridge-runtime 和控制面板关键用户可见回复链路。
- 2026-06-02 本地 API artifact 工具协议补齐：`artifact_required` 现在和 `tool_required/local_read_required` 一样进入 JSON 工具协议，`requiredToolFamilies=artifact` 会暴露 MCP/Unity MCP 产物动作和新增 `shell_artifact` 工具族。`config/local-agent-tools.d/*.json` 支持 `shellArtifact` manifest，声明安全命令、工作目录、超时、产物路径和验证规则；内置 Windows 桌面截图 manifest 通过 runtime 脚本生成真实 PNG，并由 `cti-final.images` 交给 Feishu 附件链路发送。Unity Game View 截图仍优先命中 `mcp_tool_call` manifest，不被桌面截图命令抢走。
- 2026-06-02 Feishu 进度卡片改为 workflow 驱动：bridge-core 在 workflow 授权后立即使用 CardKit JSON 2.0 streaming card 展示“收到请求、识别证据、选择工具、执行中、整理结果”等用户可见工作轨迹，provider `progress` 和工具事件只作为内容补充；最终仍关闭同一张卡的 streaming mode 并替换为最终结果。卡片工具名会映射为“桌面截图 / Unity MCP 截图 / 文件读取”等通用标签，不显示 `JsonTool`、`shell_artifact` 等内部协议名。
- 2026-06-02 JSON 工具产物抽取收窄：`shell_artifact` 只信任工具结果里的显式 `artifacts/artifactPaths/images/files` 字段，不再递归扫描 `command` 文本，避免把 `node.exe`、PowerShell 脚本路径等命令依赖误当作用户附件。Workflow schema 预留 `progressCardCreated/progressCardFinalized/progressCardFallbackReason`，Feishu adapter 记录 card create、stream update、finalize 和 fallback 日志。
- 2026-06-01 本地 API 等待态进度卡片：JSON 工具协议执行 `tool_required` / `local_read_required` 时会发出 `progress` SSE 事件，bridge-core 将其用于 Feishu streaming card 的持续 Markdown 更新，展示用户可见的“处理思路 / 阶段结果”。`progress` 不写入最终回复正文或会话历史；最终结果仍由本地模型基于真实工具历史生成 Markdown/`cti-final`，出站层继续校验真实 `tool_result` 与附件路径。
- 2026-06-01 Feishu streaming card 默认启用：`CTI_FEISHU_STREAMING_CARD_ENABLED` 现在默认开启，live 配置已改为 `true`。处理中的卡片会先显示等待态和 progress，完成后同一卡片关闭 streaming mode 并更新为最终结果；若终答包含“处理思路 / 执行结果”，最终卡片只保留“执行结果”后的内容，避免把等待态思路跟最终回复重复发送。
- 2026-06-01 live 同步构建闭环：`scripts/sync-live-skill.ps1` 在复制 live skill 前会先构建 `packages/bridge-core` 和 `packages/bridge-runtime`，避免源码已同步但 live `dist/daemon.mjs` 仍停在旧 bundle，导致 Feishu streaming card 等运行行为没有真实生效。
- 2026-06-01 本地 API 工具族约束：JSON 工具协议会把 `requiredToolFamilies` 映射为允许工具目录，并在模型输出后再次校验工具名。MCP / Unity MCP 任务不能再被本地模型改写成 `shell` 命令假完成；如果模型请求的工具族不符合本轮要求，会要求重试或返回明确未完成阻塞。终答整理层同时清理“未完成：无具体 blocker”这类自相矛盾尾句。
- 2026-05-30 本地 API 工具回归修正：`local_api` 的 `tool_required` / `local_read_required` 不再把所有工具请求都先交给本地模型生成 JSON。runtime 会先按用户原文、允许工作区和 `config/local-agent-tools.d` manifest 生成可验证的确定性工具计划；只有模糊请求才让模型输出 JSON。Workflow 顶层 `execution` 同步记录 `toolUseCount`、`toolResultCount`、`successfulToolResultCount`、`failedToolResultCount` 和 `toolNames`，控制面板证据摘要显示工具计数，便于确认 `tool_required` 是否真的出现成功 `tool_result`。
- 2026-06-01 本地 API MCP 动作 manifest 化：JSON 工具协议新增 `mcp_call`，`config/local-agent-tools.d/*.json` 可声明任意 MCP manifest、tool 和参数模板。`Unitymcp截一个game图` 这类自然语言请求不再依赖本地模型临场写 JSON，而是由 manifest 匹配到 Unity MCP `manage_camera` Game view 截图动作，workflow 会出现 `JsonTool:mcp_call` 和成功 `tool_result`。该机制可继续扩展到其他 MCP 动作，不在 provider 里写死单条中文请求。
- 2026-06-01 本地 API MCP schema 多步规划补齐：模糊 MCP 任务不再停留在单步 JSON 请求或 manifest 快捷命中。runtime 会从 MCP `tools/list` 读取工具说明和输入 schema，按用户请求挑选相关工具注入本地模型，让模型先搜索/读取真实 path、id 或 name，再基于 `tool_result` 继续规划下一次 `tool_request`，最多执行受控多步工具循环。该修复用于 `unitymcp切换hsscene场景` 这类需要先解析资产再执行动作的任务，不在 provider 中写死场景名、中文请求或具体路径。
- 2026-06-01 本地 API 工具后终答生成：JSON 工具协议完成真实工具动作后，不再把原始 MCP JSON 或运行时验证摘要直接发给用户。runtime 会把用户原文和真实工具历史交给本地模型生成面向飞书卡片的 Markdown/`cti-final` 终答，可展示简短“处理思路 / 执行结果”，但不暴露内部推理链、`JsonTool` 协议或原始 `tool_result` JSON。工具证据仍完整保留在 workflow 事件里，用于审计和控制面板复核。
- 2026-06-01 本地 API 工具产物回传收口：JSON 工具协议成功后会从 `JsonToolResult` 递归提取真实存在的本地图片和文件路径，并优先生成 `cti-final.images/files` 结果块。明确工具、MCP、文件、命令、截图或生成物任务禁止降级成快问快答；没有真实工具证据时继续按“未完成”阻塞，成功截图/导出则走 Feishu 图片或文件附件发送链路。
- 2026-05-30 出站限流配置化：delivery layer 的每聊天发送限流改为读取 `bridge_delivery_rate_limit_max_messages` / `bridge_delivery_rate_limit_window_ms`，默认仍为 20 条/分钟，`max_messages<=0` 可禁用本地限流。单测显式关闭该限流，避免全量测试因同一 mock chat 连续发消息而被生产限流睡眠阻塞。
- 2026-05-29 本地 agent 执行证据误判修正：`ExecutionRequirement` 现在以用户原文而不是注入后的 provider prompt 做分类，避免飞书云文档上下文里的“不要截图/导出”等安全提示把普通总结误判成 `artifact_required`；`pve关卡场景叫啥` 这类名字/记忆查询不再因“场景”二字强制工具证据，仍由记忆/主模型正常回答。`cti-final` 结果块会先进入出站路径校验，再决定是否拦截缺失本地文件，避免通用 no-evidence 文案覆盖更具体的“路径不存在”阻塞。
- 2026-05-29 记忆直答和内部工具泄漏兜底：结构化记忆表现在支持按 value/描述反查 key，类似 `pve关卡场景叫啥` 会从“`pve_gunship` == pve场景”这类高置信表项直接回复，不再退给本地模型自由生成。出站答案审查新增 `internal_tool_leakage`，如果本地模型泄漏内部工具协议错误，发送前会先用本轮 `memoryPlan + memoryHits` 重新组织高置信记忆答案；没有可重组答案时才替换成不含内部工具名的短阻塞，避免把执行器内部状态暴露给飞书用户。
- 2026-05-22 通用自更新协议第一版：新增 `runtime-manifest/v1` 和 `config/runtime.d`，把 `service.bridge`、`service.codex`、`service.feishuCli`、`service.localLlm` 收口成声明式运行单元。控制面板不再只对 Codex CLI 写死更新逻辑，服务页与扩展页统一改走 `update` 块解析、来源判定、白名单模板执行和 post-check 刷新。
- 2026-05-22 live 面板更新体验修正：`suite_live_sync` 在 live 控制面板内触发时，宿主会先安排当前面板退出后的自动重开，避免同步脚本替换 `dist/control-panel` 时把面板直接关掉后没有新窗口；服务页同时补齐运行单元动态版本显示，Bridge / 飞书 CLI / 本地 Agent API 读取 live `package.json`，Codex CLI 读取 npm 全局 `@openai/codex` 版本。
- 2026-05-22 运行单元状态口径修正：飞书 CLI / Codex CLI 这类可更新工具在“已同步 / 已是最新版本 / 无需更新”时改显示为正常，不再因为“当前没有可更新动作”被误标成待处理；只有来源未知、无法判断最新版本或确实有待处理更新时才显示待处理。
- 2026-05-22 飞书 CLI 更新来源诊断落地：`packages/bridge-runtime/scripts/install-codex.sh` 在复制安装时写入 `.cti-install.json`，记录 `installKind`、`installedAt`、`sourceRoot`、`installScript`。面板优先用元数据判断 `skill_codex_copy`，历史安装再按 live 路径、`.git` 仓库和 `sourceRootHint` 回退推断；仍无法确认时禁用自动更新并显示“来源未知”。
- 2026-05-22 manifest 校验扩展到 runtime：`scripts/validate-extension-manifests.ps1` 现在同时校验 `extension-manifest/v1`、`runtime-manifest/v1` 和可选 `update` 块，约束 `npm_global_package`、`skill_git_repo`、`skill_codex_copy`、`suite_live_sync` 四种更新模板，避免面板或脚本绕过白名单执行任意命令。
- 2026-05-22 本地 JSON 工具失败回传修正：`local_api` 通过 JSON 工具协议真实执行 shell/list_dir 但返回失败时，bridge-core 不再把 provider 给出的 stderr、exitCode 或路径阻塞原因覆盖成笼统“没有工具证据”；只有完全没有成功工具证据且模型仍假完成时才使用通用拦截文本。
- 2026-05-22 本地 JSON 工具协议接入 Unity MCP：`tool_required` 且需要 Unity MCP 时，工具目录会优先暴露 `unity_mcp_execute_code`，runtime 通过 `McpBridge.callHttpTool(unityMCP, "execute_code", ...)` 在 Unity Editor 内执行 C#。具体工具别名改由 `config/local-agent-tools.d/*.json` 声明匹配规则和 C# 模板，provider 主逻辑不写死某个工具名；当前仅用 manifest 注册 FXTools Doctor 作为一个普通别名。
- 2026-05-22 在线扩展目录三层化：控制面板目录页从“本地种子 + 远端精选 URL”升级为“静态种子 + 动态排行榜源 + 用户自定义 URL”。动态层默认定期抓取 `npm / PyPI / GitHub / Hugging Face / Ollama Library / Official MCP Registry` 各自 Top 5，缓存到 `runtime/extension-catalog-dynamic-cache.json`，并在条目上展示来源层、抓取时间、排行依据和名次。相同 `type + id` 冲突时按 `custom_url > seed > dynamic` 覆盖，动态刷新失败时回退最近缓存。
- 2026-05-22 Qwen 本地模型目录更新：扩展目录补入 `qwen3-coder-next:latest`、`qwen3-coder-next:q4_K_M`、`qwen3-coder-next:q8_0`、`qwen3-coder-next:cloud`、`qwen3-coder:30b`、`qwen3-coder:30b-a3b-q4_K_M`、`qwen3-coder:30b-a3b-q8_0`、`qwen3-coder:480b-cloud` 和 `qwen3-coder:480b-a35b-q4_K_M`，设置页“本地 API -> 模型”改为读取在线目录生成候选列表，同时保留手动输入任意 Ollama 模型名。`local-model-capabilities.json` 的推荐列表同步把 Qwen3 Coder Next 和 Qwen3 Coder 30B 放到本地代码 agent 候选前列；live 同步脚本现在同步 `config/extension-catalog.json`，避免运行版面板缺少目录种子。
- 2026-05-22 Ollama 模型安装管理补齐：控制面板新增异步模型安装 job，在线目录里的 Ollama 模型安装会显示进度、支持暂停、配置 `CTI_OLLAMA_MODELS_DIR` / `OLLAMA_MODELS` 安装目录、完成后自动设为本地 API 模型并重启 Bridge；已安装模型可在扩展页直接使用或卸载。设置页新增“已安装模型”下拉，读取在线目录和 Ollama `/api/tags`，不再只靠手动输入模型名。
- 2026-05-19 优化直接提醒自然语言解析：`五点半提醒我替换pve场景的背景图`、`下午五点半提醒我...`、`明天上午九点提醒我...`、`晚上8点15分提醒我...` 这类请求会走可复用时间短语解析层，命中 bridge-core 的高置信 reminder fast-path，创建 `data/todos/direct-reminders/*.md` 并重建 `.cti-index/reminders.json`，避免 Codex 文本回复“收到”但面板没有待办记录。
- 2026-05-11 修正 Feishu 入站权限模型：`bridge_feishu_allowed_users` 不再作为 adapter 层会话白名单，任何用户都可以进入普通会话；兼容配置里的 allowed users 只再映射为 `Viewer` 角色，危险动作继续由 `Viewer / Operator / Owner` 门禁控制。
- 2026-05-11 重整记忆召回链路：移除 `常用场景名称` 这类单词条快路径，改为 `MemoryQueryPlan -> RetrievedMemoryHit 元数据 -> MemoryReplyDecision`。明确回忆类请求只有高置信结构化命中才直答；模糊召回受限交给 Codex；普通任务只注入记忆上下文。`audit.json` 已发结果、profile、知识索引和会话历史统一带来源、置信度、可回答性和质量标记，错误兜底不再写入或召回为有效记忆。
- 2026-05-11 补齐显式记忆写入可见性：用户发送“记住 / 记一下 / 保存记忆”时，运行时除了更新 `memory-profiles.json`，还会把原始内容写入 Markdown 知识库 `data/explicit-memories/*.md` 并重建索引，避免机器人说“记住了”但控制面板“记忆”页看不到。
- 2026-05-12 新增记忆答案审查层：`bridge-core` 在 direct memory reply 和 Codex 最终回复发送前调用 runtime/store 的 `reviewOutboundAnswer`，v1 规则先检查乱码、协议残留、低价值兜底、工具假完成和记忆 key 不匹配；默认 `observe` 只写 `answer-review-audit.json`，配置 `bridge_answer_review_mode=block_or_replace` 后才替换或拦截用户可见回复。
- 2026-05-12 新增显式记忆关系图：知识索引重建后同步生成 `.cti-index/memory-graph.json`，从结构化 key/value、同文件上下文和冲突标记建立 `maps_to`、`reverse_lookup`、`related_to` 等可解释边；检索会同时提供正向和反向候选，例如“雷霆龙”可关联回“第十三条龙”、展示 prefab 和 UIScene 路径。
- 2026-05-12 显式记忆写入收口到可见知识库：`memory_write` 意图会先落 `data/explicit-memories/*.md` 并重建知识/关系索引，成功后才返回“记住了”；写入失败会直接说明阻塞，不再让模型假装已记住。控制面板“记忆”页显示关系图规模、节点/边预览、知识单元关联节点和最近答案审查 warning；关系图候选只做上下文增强，不参与直接记忆回答。
- 2026-05-14 显式记忆分类和网格可视化收口：Markdown 表格行不再固定归为资源，而是按路径/链接/文件扩展名/Prefab/UIScene/预制体/路径、决策规则词、待办风险词等保守推断为事实、结论、待办或资源；单纯的 Scene 标识到常用名映射按事实处理，并记录分类原因；控制面板“记忆”页改为 TanStack Table 网格，可切换知识单元、关系节点、关系边视图。
- 2026-05-16 平台化第一阶段打底：新增 `packages/contracts` 共享契约包，集中维护 Control API、workflow run、node agent heartbeat 和 extension trust policy schema；bridge-runtime 增加 workflow contract adapter，把现有 `workflow-runs.json` 映射为 checkpoint/trace event 契约；控制面板新增节点快照和“节点”页，先展示本机 node 与 fake remote node 的能力清单，为后续多 runtime 控制面预留边界。
- 2026-05-16 控制面板蓝图化降门槛：总览页新增系统蓝图，用普通用户路径解释飞书入口、Bridge、AI 执行、辅助能力和最终回复；“记忆”页新增关系树，把结构化记忆展开为对应内容、相关对象、待办提醒、可能冲突和来源文件，原始知识单元、相关对象、联系权重、索引路径和需要检查的回复默认折叠到高级诊断。
- 2026-05-16 系统蓝图可操作化：总览页蓝图节点从只读状态升级为点击后打开处理面板，入口、Bridge、AI、MCP、记忆、提醒和回复链路均可复用现有运行单元动作或跳转到服务、扩展、记忆、设置页处理。
- 2026-05-16 系统蓝图 MCP 状态口径修正：MCP 子节点改用扩展页同一套 `runtime.listUnits` 健康结果判断可用性，不再用托管进程 `running/total` 把按需 stdio 或外部 HTTP MCP 误显示为“需要处理”。
- 2026-05-16 记忆一键整理与 Codex CLI 模型来源优化：运行时新增 `.cti-index/memory-optimization-drafts` 草稿和 `.cti-index/memory-optimizer-state.json` 定期状态，Control API 增加 `memory.optimizePreview/apply/discard/schedule/status`；面板“记忆”页支持生成整理草稿、逐项取消、确认覆盖和丢弃，定期模式只生成待确认草稿。设置页从“AI API / 本地兜底”改为“Codex CLI 模型来源”，官方 Codex、本地 API、外部 API 都可作为主模型，`CTI_CODEX_FAILURE_FALLBACK_MODE` 默认 `none`，只有显式开启备用模型才切到本地 Agent API。
- 2026-05-18 Codex CLI 本地 API 假完成拦截：ConversationResult 记录本轮 `tool_use/tool_result` 执行证据；CodexProvider 在 status 事件中写入 `codexProfile/modelSource/model/baseUrl`；workflow run 追加 `execution.evidence` 事件。出站前会验证 `cti-final.images/files` 本地路径存在，并在“创建/生成/写入/执行”等回复缺少成功工具证据时改写为“未完成”，避免本地 API 主模型或备用模型编造成果。
- 2026-05-19 本地 / 外部模型执行路由优化：新增 `local-model-capabilities.json` 工具调用探测，Control API 增加 `localLlm.probeTools` / `settings.testLocalTools`；设置页新增“本地执行模式、执行类任务必须通过工具调用探测、本地工具未验证时如何处理”。当 `CTI_CODEX_MODEL_SOURCE=local_api` 但模型没有真实 `tool_calls` 证据时，执行类任务默认改交官方 Codex / 外部 API 或按配置拒绝，不再让本地文本模型伪装工具执行。Codex 失败后，`git status`、当前分支、最近提交、暂存区内容、读文件和搜文本这类只读固定动作可由 runtime 受控工具兜底，仍不让本地模型直答。扩展目录补入 `qwen3:14b`、`qwen3:30b`、`qwen3:32b`、`qwen2.5:32b` 工具候选模型，`qwen2.5-coder:7b` 继续定位为文本/总结兜底。
- 2026-05-20 Codex bridge 配置隔离：CodexProvider 生成 bridge 专用 `CODEX_HOME` 时默认剔除全局 `mcp_servers.*`，只同步认证、skills/plugins/vendor/rules 等共享资源，避免桌面 Codex 配置里的 Unity MCP、Blender MCP 或其他外部 MCP 未启动时导致飞书 bridge 的 Codex 主模型直接退出。需要继承桌面 MCP 时必须显式设置 `CTI_CODEX_INHERIT_GLOBAL_MCP=true`。
- 2026-05-20 Codex SDK 版本跟进：`@openai/codex-sdk` 升级到 `0.132.0`，修复 live bridge 仍使用 `0.110.0` SDK 读取新版 `CODEX_HOME` 状态库时反复 `Codex Exec exited with code 1` 的问题；`scripts/sync-live-skill.ps1` 同步后会校验并安装 live runtime 所需 SDK 版本，避免 package 与 `node_modules` 脱节。
- 2026-05-20 断点续跑图片回传收口：workflow retry 如果得到 `cti-final` 结果块，不再给用户发送“断点续跑重试结果”包装文本或原始 JSON，而是复用 bridge-core 出站收口解析最终文本、图片和文件；Unity Game 视角截图这类重试结果会按 reply 关系发送干净文本和本地图片附件。
- 2026-05-20 记忆整理透明化与安全归档优化：控制面板“记忆”页新增索引来源总览、来源分组筛选和分页搜索，明确面板默认显示不是全部 `knowledge.json`；整理草稿按显式记忆、直接提醒、生成摘要、文档/根目录笔记等来源分层，文档和索引类来源默认不勾选。`memory.optimizeApply` 改为只执行 `selectedActionIds`，旧草稿会按 `sourceIndexGeneratedAt` 拒绝应用；新增 `memory.restoreArchive` 和 `memory.optimizeUndo`，归档恢复限定在 `E:\cli-md\archive\knowledge-units` 内并校验源文件仍在记忆仓库。
- 2026-05-20 记忆页入口降噪：控制面板“记忆”页把“记忆关系树”提升到第一屏，并在树内新增“整理记忆从这里开始”行动区；“生成整理草稿”改为主按钮，草稿确认区文案改为“确认应用所选”。索引来源总览降级为默认折叠的来源解释，只在用户追查“草稿为什么包含当前列表没显示的来源”时展开。
- 2026-05-20 记忆关系树全量化：关系树左侧不再只截取前 8 条结果，默认请求最多 200 条并列出当前检索命中的全部记忆；右侧继续围绕选中记忆展开关系，结果超过上限时提示用搜索或来源筛选缩小范围。
- 2026-05-20 记忆来源分组降噪：关系树左侧不再把 `AI_BRIDGE_CONTEXT.md`、生成摘要、根目录笔记和显式记忆混成一个平铺列表；普通记忆默认展开，生成摘要和上下文/索引资料默认折叠，避免系统工程上下文被误解为用户显式记忆。

已完成：

- 建立 `codex-im-suite` 作为统一开发和发布目录。
- 安装 `project-architecture-diagram` 到项目内扩展目录，并加入 `config/skills.d`。
- 新增 `scripts/update-architecture-docs.ps1`，用于发布前或架构变更后检查架构文档维护状态。
- 将原先分散的桥接核心、运行时、MCP、控制面板、安装器收口到 `packages` 和 `apps`。
- 建立 `suite.manifest.json` 作为发行层总清单。
- 新增 `packages/contracts`，作为 Control API DTO、workflow schema、node agent schema 和 extension capability schema 的共享事实来源。
- 建立 `publish-backup.ps1`，发布前自动同步、打包、生成摘要、提交并推送。
- 建立 `publish-summary.md` 和 `release-notes.md`。
- 新增 `scripts/doctor-suite-targets.ps1`，用于检查开发版、live skill、portable、installer 和面板 exe 的职责与漂移情况。
- 新增 `scripts/test-release-fork-health.ps1`，发布前比较开发版、live skill、portable、installer payload 的关键文件 hash、manifest、构建时间、commit 和 `.suite-release.json` 指纹；发现分叉时中止发布。
- 将 `scripts/sync-live-skill.ps1` 收口为“开发版 suite -> live skill”方向，避免 live 反向覆盖开发版。
- 新增 `scripts/import-live-to-suite.ps1` 作为手动救回 live 改动入口，默认 dry-run，不进入发布流程。
- 移除 `packages/bridge-runtime/tools/ControlPanel` 和 `packages/bridge-runtime/tools/Installer` 旧副本，避免面板和安装器源码入口混淆。
- 将 suite 版本提升到 `0.2.0`，并在 `suite.manifest.json` 中声明 `extension-manifest/v1`。
- 给 `config/mcp.d`、`config/skills.d`、`config/plugins.d` 补齐统一扩展字段：`version`、`compatibility`、`category`、`optional`、`installState`、`source` 和 `aliases`。
- 新增 `scripts/validate-extension-manifests.ps1`，构建和 MCP 注册前都会先校验扩展 manifest；截至 2026-05-22 该脚本也同时校验 `config/runtime.d` 和 `update` 协议。
- 新增在线扩展目录 v1：`config/extension-catalog.json` 作为本地种子，`CTI_EXTENSION_CATALOG_URLS` 可追加远端精选目录；控制面板“扩展”页支持目录搜索、HTTPS URL 预览、本机安装和移除记录。
- 扩展安装内容固定落在 `C:\Users\admin\.claude-to-im\extensions`，并生成用户 manifest overlay；`mcp-bridge`、控制面板、`install-suite-skills.ps1` 和 `register-external-mcps.ps1` 已合并读取 suite manifest 与用户 overlay。
- 在线安装 handler 收口为 `skill.copy`、`mcp.npm`、`mcp.uvx`、`mcp.zip`、`ollama.pull`、`manifest.record`、`codex-plugin.record`；无 `sha256` 的 URL 预览会标记为不可信，远程 Control API 安装和移除要求 Owner。
- 在线目录种子已加入常用 Ollama 模型、无需密钥的常用 MCP、suite 已维护 skill 和 Browser 插件记录项；Browser 记录为 OpenAI bundled 插件，移除时只删除 suite 记录，不删除插件缓存。
- 控制面板在线目录会读取 Ollama `/api/tags`、内置 manifest、用户 overlay manifest 和安装锁；已存在模型或内置 config 记录显示为“已安装”，只有用户 overlay 或安装锁记录才显示“移除记录”，避免把不可删除的源配置当成可卸载内容。
- 飞书新增 `/ext search`、`/ext install`、`/ext remove` 和自然语言触发入口；安装/移除默认发 Owner 确认卡片，待确认动作写入 `C:\Users\admin\.claude-to-im\data\extension-install-actions.json`，确认后统一调用控制面板 Control API。
- 新增 `scripts/package-main-release.ps1` 和 `scripts/prepare-main-release.ps1`，主干发布预检不再同步 live skill，也不自动提交、推送或打 tag。
- 新增 `scripts/create-main-release-tag.ps1`，打 tag 从预检流程拆出，只允许在干净工作区和稳定分支上执行。
- 控制面板升级为 WinForms 宿主 + WebView2 + React/Vite 前端；旧 WinForms 控件退为宿主状态层，前端通过白名单命令协议调用本机脚本和状态读取。
- 控制面板新增 `apps/control-panel/web` 前端源码、GPT 生成的无文字 PNG 氛围素材和 WebView2 Runtime 降级提示。
- 控制面板新增 Control API 宿主：桌面壳启动本机 HTTP API 并加载同一套 React 页面；普通浏览器可通过 HTTP/SSE 查看状态、会话详情、图片、workflow 和权限数据。
- 新增 `scripts/start-control-api.ps1`，用于本机或服务器启动 API-only 模式。默认只监听 `127.0.0.1`，远程监听必须配置 token，远程高危命令需要额外显式开启。
- 桌面面板的 Control API 启动已补端口冲突保护：本机 loopback 模式下如果默认 `8788` 被占用，会自动尝试后续端口，避免多开面板时直接弹未处理异常；远程显式监听仍保持严格失败。
- `build-packages.ps1` 会先构建控制面板 Web 前端，`assemble-portable.ps1` 会复制完整控制面板发布目录，确保 `wwwroot` 和 WebView2 运行依赖进入 portable/installer。
- `build-packages.ps1`、`assemble-portable.ps1`、`build-installer.ps1` 和 `sync-live-skill.ps1` 在覆盖运行副本或发布产物前会检查目录下是否有运行进程占用；默认只结束目标目录内的进程后继续更新，传 `-NoForceUpdate` 或设置 `CTI_RELEASE_FORCE_UPDATE=false` 时恢复只报告 PID 并停止。
- 发布便携包 `release\codex-im-suite-portable.zip` 改为通过 Git LFS 跟踪 `release/*.zip`，避免 GitHub 普通 Git 单文件 100MB 限制阻断备份发布。
- 控制面板把发布入口拆成“本机备份发布”和“主干发布预检”，版本卡片显示 suite 版本、扩展协议、启用扩展数量、缺失依赖和本机配置覆盖数量。
- 控制面板顶部新增 live skill 同步状态：启动和刷新状态时读取 live `.suite-release.json.generatedAt`、commit 与关键内容 hash，显示“Live 已同步 / 落后 / 未记录同步时间 / 读取失败”，并在需要时提供只执行 `scripts/sync-live-skill.ps1` 的“一键同步”按钮；该按钮不会打包、提交、推送或重启 bridge。
- 控制面板对 Live 同步、一键发布和主干发布预检新增顶部任务反馈条：点击后立即显示执行中，结束后显示成功 / 失败和用时；Live 已同步时也保留“重新同步”入口，方便手动强制同步。
- 控制面板 exe 入口已收口：`CodexImSuiteControlPanel.exe` 是唯一正式入口，live 同步不再生成 `ClaudeToImControlPanel.exe`，doctor、liveSync hash 和 release fingerprint 也统一只检查正式入口。
- 控制面板清理 PowerShell 子进程的 CLIXML 输出：Live 同步、一键发布和主干发布预检失败时会显示可读脚本日志和错误原因，不再把 `#< CLIXML` 原始片段截断给用户。
- 控制面板发布产物目录在 `build-packages.ps1` 中改为发布前先检查运行进程并清空输出目录，避免 Vite hash 资源旧文件残留导致主干发布预检的 `panel.wwwroot` fork health 误报不一致。
- 控制面板主界面已切到无底图运营台样式，支持白天 / 夜晚主题切换，并按窗口宽度自适应切换侧栏、顶部工具条、概览卡片和详情区布局。
- 控制面板第二轮改造已完成：服务、Codex CLI、本地辅助执行器、MCP、扩展 manifest 统一抽象成运行单元卡片，WebView 通过 `runtime.listUnits` / `runtime.invokeAction` 渲染和执行动作。
- 控制面板“执行器”页已和“服务”页区分：服务页继续承载运行单元生命周期操作；执行器页的 Executor Registry 改为可选中的只读路由目录，右侧展示选中 executor 的能力、风险、优先级和最近路由，不暴露默认执行器写入入口。
- 控制面板新增“节点”页和 `nodes.list` 命令，基于共享 node agent 契约展示本机 runtime node、fake remote node、heartbeat、能力清单和可管理状态；当前只读，不执行远端动作。
- 控制面板总览页新增可点击处理的系统蓝图，“记忆”页新增关系树视图；面向普通用户默认展示业务联系、状态和推荐操作，高级诊断仍保留索引状态、网格、关系缓存和答案审查细节。
- 会话页新增详情抽屉，支持直接查看完整消息流、复制摘要和复制消息文本，不再强依赖旧 WinForms 会话查看器。
- 会话详情抽屉补齐图片和附件查看：宿主会读取 Feishu 原始消息资源键，下载图片/文件到本机 `runtime/control-panel-media` 缓存，并通过 WebView2 虚拟域 `control-panel-media.local` 给前端加载。前端展示图片缩略图、附件名称、大小、MIME、路径和下载状态，不再把图片简单显示成占位文本。
- 会话详情新增“刷新详情”，会绕过宿主详情缓存重新读取历史和附件；旧索引只要图片/文件消息缺少资源键，也会触发会话级远端重同步，避免长期停留在 `[图片]` 占位。
- 会话详情对旧本地消息增加只读显示修复：检测到典型 UTF-8 被 GBK 错读的 mojibake 特征时，使用 Windows 936 代码页还原后展示，不改写原始历史 JSON。
- 会话详情新增运行历程回溯：按 `sessionId` / `chatId` 关联 workflow run，展示 executor、阶段、状态、prompt 摘要和事件时间线，便于排查一次请求是否卡在授权、路由、执行、收尾或回传阶段。
- 飞书图片出站收紧：不再从最近 assistant 历史消息里自动捞旧图片随新回答发送；只有当前 `cti-final.images` 或当前回复文本明确出现的本地图片路径会被发送，避免 Unity 截图任务失败时重复发旧截图。
- 回复风格快捷预设改为点击即保存到 `CTI_REPLY_STYLE_HINT`，避免前端临时状态被后续 `state.refresh` 用旧配置覆盖。
- 设置页恢复目录选择和回复风格快捷设置：路径字段支持拖拽、目录选择、快速打开；回复风格支持预设、当前摘要和本地 AI 整理入口。
- bridge-core 新增纯闲聊短路：问候、感谢、确认等不含任务意图的消息直接自然回复并记录会话，不再启动 Codex/本地模型执行链。
- bridge-runtime 新增 `memory-profiles.json` 轻量记忆画像：按用户 ID、聊天和全局 scope 汇总事实/偏好、近期主题和待跟进项；普通消息和 Feishu 历史同步都会增量更新。
- Codex 上下文记忆注入改为“Markdown 知识库 + 会话摘要 + profile 命中 + Feishu 历史命中”的检索式组合，继续受字符预算限制，避免把全部记忆一次性注入导致 token 膨胀。
- 本地模型后端从旧 `llama.cpp` 迁移到 Ollama：新增 `CTI_OLLAMA_ENABLED`、`CTI_OLLAMA_BASE_URL`、`CTI_OLLAMA_MODEL`、`CTI_OLLAMA_TIMEOUT_MS`，默认 `http://127.0.0.1:11434` 和 `qwen2.5-coder:7b`。
- 本地辅助 AI 从固定 Ollama 扩展为 OpenAI-compatible Chat Completions 配置：新增 `CTI_LOCAL_AI_KIND`、`CTI_LOCAL_AI_BASE_URL`、`CTI_LOCAL_AI_MODEL`、`CTI_LOCAL_AI_API_KEY`、`CTI_LOCAL_AI_TIMEOUT_MS`，继续兼容 `CTI_OLLAMA_*` 默认值。
- Codex API 配置正式纳入面板和运行时配置：支持 `CTI_CODEX_BASE_URL`、`CTI_CODEX_API_KEY`、`CTI_CODEX_MODEL`、`CTI_CODEX_PASS_MODEL`、`CTI_CODEX_REASONING_EFFORT`，API key 在 Web 状态里只显示掩码。
- 控制面板设置页新增模型来源区域，可测试本地 AI 和 Codex API 配置，并提供“保存并重启 Bridge”让飞书运行时加载全局执行链配置；本地 AI 类型不是 Ollama 时，执行器目录不再把 `codex-oss-ollama` 显示为可用。
- `hybrid` / `codex_only` 模式下停止在 Codex 前执行 MCP/本地工具快路径；“Fetch MCP 能用吗”等 MCP 状态问题默认先进入 Codex，Codex 不可用时才读取合并 manifest 与 `codex mcp list` 做动态兜底，避免返回硬编码 MCP 入口列表。
- 本地模型直答兜底已改为 Codex CLI profile：主模型来源可用官方 Codex、本地 API 或外部 API；备用本地 Agent API 读取 `CTI_LOCAL_AI_*`，强制传本地模型，并使用独立 `CODEX_HOME`。
- 新增 `CTI_CODEX_MODEL_SOURCE`、`CTI_CODEX_FAILURE_FALLBACK_MODE`、`CTI_CODEX_LOCAL_FALLBACK_ENABLED` 和 `CTI_CODEX_LOCAL_FALLBACK_REASONING_EFFORT`；主模型失败默认不自动降级，备用本地 Agent API 只在显式开启时生效。
- 面板模型来源区域默认只展示“官方 Codex / 本地 API 作为主模型 / 外部 API 作为主模型”、当前策略摘要和必要字段，高级 Base URL、API key、reasoning、pass model 等仍保留在折叠区。
- 面板“AI API”改名为“Codex CLI 模型来源”：官方 Codex、本地 API 和外部 API 都是主模型来源；本地 API 复用 `CTI_LOCAL_AI_*`，外部 API 复用 `CTI_CODEX_*`，失败后默认不自动降级，备用本地 Agent API 只在用户明确开启时生效。
- Executor registry 新增 `codex-local-fallback`，`@local` / `@本地` 指向该执行器；`local-tool-agent` 仅保留历史兼容，普通消息不再使用本地模型直接生成最终回复。
- `scripts/local-llm` 改为 Ollama 安装提示、启动、停止和 `/api/tags` 健康检查；旧 `llama-server.exe`、GGUF 路径和 server args 不再作为运行来源。
- 新增 Markdown 知识索引：默认监听 `E:\cli-md`，生成 `E:\cli-md\.cti-index\knowledge.json`，知识单元分为 `事实 / 结论 / 待办 / 资源`。
- 知识索引 watcher 新增实时状态文件 `E:\cli-md\.cti-index\status.json`：记录监听心跳、最近事件、最近索引、watcher PID 和错误；控制面板“记忆”页改为读取该状态判断真实监听。
- 修复记忆关键词误触发：运行时停用“命中 Markdown 就直答”的快答逻辑，明确回忆/搜索类问题才检索记忆；其他请求只把相关记忆注入主执行链。
- 新增历史乱码修复入口 v1：`scripts/repair-history-mojibake.ps1` 默认扫描 `CTI_HOME\data` 历史、Feishu 历史索引、记忆 Markdown 和 `.cti-index`，`-Apply` 会为改写文件写入可回滚 manifest，并触发 `knowledge.json` / `reminders.json` 重建；`-Restore <manifest>` 可按备份回滚。
- Feishu 历史同步、记忆 profile 入库、Markdown 知识索引和待办提醒派生加入 mojibake 防护：能识别并修复典型 UTF-8 错读文本，仍无法确认的文本不再进入记忆检索摘要或待办提醒标题。
- 控制面板服务卡从“本地辅助执行器”改为“Ollama”，并新增“记忆”页展示索引状态、监听状态、类型筛选、关键词搜索和来源片段。
- 新增待办主动提醒 v1：运行时从 Markdown 知识索引里的 `kind=todo` 派生 `.cti-index\reminders.json`，解析提醒时间、状态和来源会话，并用 `.cti-index\reminder-state.json` 记录已发送、失败和跳过原因。
- 新增多渠道 PushProvider 抽象：飞书 provider 复用 bridge-core 出站收口、去重和审计；微信 provider 暂返回 `unsupported`，面板显示未接入，不伪装发送成功。
- 控制面板“记忆”页新增“待办提醒”区域，展示待发送、已发送、跳过、失败、来源片段和最近推送结果，并提供检查提醒和飞书测试发送入口。
- 待办主动推送默认关闭，通过 `CTI_TODO_PUSH_ENABLED`、`CTI_TODO_PUSH_POLL_MS`、`CTI_TODO_PUSH_WINDOW_MS`、`CTI_TODO_PUSH_CHANNELS` 启用；来源无法确认、状态非未完成或缺少提醒时间的待办只标注原因，不推送。
- 新增直接提醒动作协议 `cti-reminder`：普通“任务 / 待办 / 提醒”讨论不再被关键词硬拦截，只有 Codex 明确输出动作块或用户使用 `/remind` 时，bridge 才会创建统一 reminder 记录。
- 直接提醒补高置信自然语言快路径：同时命中创建意图、未来时间和提醒内容时，bridge 直接创建统一 reminder，不再让这类简单提醒进入完整 Codex workflow；“任务为什么卡住”“写计划任务脚本”“今天有什么待办”等仍不会触发。
- bridge-runtime 新增直接提醒创建链路：写入 `E:\cli-md\data\todos\direct-reminders`，重建 `knowledge.json` / `reminders.json`，并在 `reminder-state.json` 写入 `pending`，后续到点仍走统一飞书 PushProvider。
- bridge-core 新增提醒伪完成拦截：如果模型声称“已创建系统计划任务 / 已实际发送”但没有 `cti-reminder` 执行记录，会先尝试从原始请求补建真实 reminder；不可解析时才拦截原回复并提示未进入统一提醒系统。提示词也禁止使用 `schtasks`、`Register-ScheduledTask` 或临时 PowerShell 脚本完成提醒。
- 控制面板“记忆”页的待办提醒区域新增直接提醒来源展示，区分 `sourceType=direct` 和普通记忆待办，并显示直接提醒启用 / 推送状态。
- 飞书待办提醒升级为互动卡片：到点推送优先发带“完成”按钮的卡片，点击后通过 `card.action.trigger` 回调直接调用 reminder host，不进入 Codex 普通对话。
- reminder 完成闭环已接入：`completeReminder()` 会更新直接提醒 Markdown、重建索引，并在 `reminder-state.json` 写入 `completedAt`、`completedByUserId`、`completionSource` 和 `completionError`；普通记忆待办无法精确匹配源行时只记录状态并提示源文件需手动确认。
- 控制面板“记忆”页的待办提醒区域新增“完成”按钮、已完成统计和完成来源显示，面板操作与飞书卡片共用同一套本地状态文件。
- 新增 `scripts/memory/archive-legacy-rules.ps1`，默认 dry-run，显式 `-Apply` 时把疑似旧规则 Markdown 移到 `archive\legacy-rules` 并生成 `AUTHORITATIVE-RULES.md`。

当前约定：

- 以后开发优先改 suite 目录。
- live skill 通过同步脚本生成。
- 完成发布脚本改动后，同步当前使用版本时仍只允许执行 `scripts/sync-live-skill.ps1`，方向固定为开发版 suite -> live skill。
- `scripts/sync-live-skill.ps1` 复制控制面板发布目录时会排除 `CodexImSuiteControlPanel.exe.WebView2` 用户数据目录，避免 WebView2 Cookie/Cache 临时文件导致 robocopy 误报失败。
- 本机备份发布可以同步 live skill 并推送当前分支；合入 `main` 前必须走主干发布预检。
- `main` 是稳定产品主干，`codex/dev` 是日常集成分支，功能分支使用 `codex/<topic>`。
- 面板源码唯一入口是 `apps/control-panel`；安装器源码唯一入口是 `apps/installer`。

## 2. Feishu 桥接

已完成：

- Feishu 文本、Markdown card、图片发送、群聊 reply 支持。
- Feishu 云文档读取 v1：支持 Docx、Sheets、Base/多维表格链接解析；bridge-core 通过 host interface 调用 runtime，runtime 先用应用 `tenant_access_token` 读取，应用无权时再使用发起人 OAuth 用户 token 读取内容并注入 Codex 上下文。
- Feishu OAuth 登录授权 v1：缺少用户 token 时发送登录卡片，回调 state 绑定发起人、chat、message 和链接 hash；支持公网 callback 模式和无公网 manual code/state 回传模式；用户 token 存到 `C:\Users\admin\.claude-to-im\data\feishu-oauth-tokens.json`，Windows 下使用 DPAPI 加密。
- Feishu 开放平台能力诊断 v1：新增 Owner 命令 `/feishu`，按消息收发、资源、历史、reaction、CardKit、Docx、Sheets、Base 等能力列出所需 scope，并和 `CTI_FEISHU_GRANTED_SCOPES` 声明的已开通权限做差异检查。
- Feishu 云文档权限错误提示补强：Docx / Sheets / Base 读取遇到 401/403 或飞书权限错误码时，会同时提示用户文档访问权限和对应接口所需 scope，避免把缺少开放平台权限误判成文档内容为空。
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
- 2026-05-08 修复 live 桥接配置被截断后无法启动的问题：恢复完整 `config.env`，并加固 `bridge-runtime-audit.json` 写入，避免 Windows 下并发 rename 报 `EPERM` 导致面板误报未运行。
- 2026-05-09 修复 Windows supervisor 停止 / 重启时的 stale PID 竞态：live 同步后如果 bridge 或 supervisor 进程已自行退出，`daemon.ps1 restart` 不再因为 `Stop-Process` 找不到旧 PID 而中断。
- 2026-05-09 加固 live 同步脚本的单文件覆盖：控制面板 exe 刚退出或被短暂扫描占用时，`sync-live-skill.ps1` 会短重试，避免 core/runtime 已复制但最终指纹未写入的半同步状态。
- 2026-05-09 新增飞书云文档权限读取链路：收到私有 Docx / Sheets / Base 链接时不再让 Codex 直接公网抓取，而是先按发起人飞书账号读取；登录后仍无权限会提示让文档所有者分享或导出，不自动绕过权限。
- 2026-05-09 修复飞书云文档断点续跑绕过预读取的问题：workflow retry 现在会先执行云文档解析，优先应用 token、再发起人 user token，缺授权时回发登录/权限阻断，不再把飞书登录页交给 Codex 总结。
- 2026-05-09 新增飞书 OAuth manual 模式：不暴露公网时，授权卡片打开飞书官方 `authen/v1/authorize` 页面，用户授权后把浏览器地址栏里的 `code/state` 回调 URL 发回飞书，bridge 校验 state 后换取并保存 user token。
- 2026-05-09 修复飞书群聊 @bot 漏判：`require_mention=true` 时不再只依赖事件 `message.mentions`，如果飞书长连事件没带 mentions 数组，会继续解析正文里的 `<at ...>` 和富文本 `tag=at`，避免真实艾特被误记成 `[FILTERED] Group message dropped: bot not @mentioned`，同时恢复会话入库和机器人回复。

## 3. Codex 与本地模型策略

当前策略：

- Codex 是主脑。
- 本地模型是 Codex agent 的本地 API 后端和少数内部整理/测试工具。
- 本地模型不再作为普通飞书消息的直接最终回复器。

已完成：

- Ollama 本地后端接入。
- 本地执行器支持 shell、git、文件读写、文本搜索。
- `hybrid / local_only / codex_only` 三种模式。
- Codex CLI 主模型来源可配置为官方 Codex、本地 API 或外部 API；主模型失败默认返回明确阻塞，不再自动切到弱兜底。
- 本地 API 作为主模型或备用模型时，执行类任务必须先通过 OpenAI-compatible `tools` 探测；未通过时默认交给官方 / 外部 Codex profile 或拒绝，避免“没调用工具却声称已执行”。
- 只有用户显式开启备用本地 Agent API 时才切 `codex_local_fallback`，主模型和备用模型都不可用时返回明确阻塞，不生成教程式或静态 canned 回复。
- 本地模型不能伪造“已执行 / 已修改 / 已导入 / 已创建”结果。
- `codex-oss-ollama` 实验执行器已登记到 executor registry，声明 `codex exec --oss --local-provider ollama`，能力限制为只读问题和记忆检索兜底。
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
- 2026-05-15 补齐 Unity/Prefab 工具任务的入口伪澄清拦截：如果用户已经提出 `unitymcp`、Prefab、场景或对象结构查看请求，Codex 或本地 Agent 失败后的回复不能再要求用户“指定 MCP 入口”或返回 MCP 入口列表；出站收口会改写成“未完成 + 需要真实 Unity/MCP 执行结果”的阻塞说明，并新增 `STH_AreaView` prefab 回归测试。
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

截至 2026-04-29 已完成：

- 运行中 workflow run 会持久化第一版最小恢复信息：prompt、工作目录、模型、system prompt、权限模式、渠道和 chatId；长文本按上限截断，避免状态文件无限膨胀。
- bridge-runtime 启动时会扫描 `workflow-runs.json` 中遗留的 `running` run：有恢复输入且未耗尽次数的标为 `retry_pending`，缺少恢复输入的标为不可恢复失败。
- provider 执行失败时会在可恢复 run 上排队一次自动重试；后台 retry worker 会领取 `auto_pending` / `manual_pending` run，重新流式执行并把结果写回会话历史。
- 2026-05-15 新增自动重试新鲜度窗口：`auto_pending` 只会在 `CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS` 窗口内被后台 retry worker 领取，默认 6 小时；手动重试不受该窗口影响。
- 2026-05-15 新增长时间空闲 fresh session 保护：同一 chat 绑定超过 `CTI_SESSION_IDLE_FRESH_MS`（默认 12 小时）后，下次消息会重绑到新 session 并清空 `sdkSessionId`，避免长时间断线后继续复用旧 Codex thread 和旧上下文。
- 2026-05-15 Codex provider 新增失效工作区兜底：`workingDirectory` 或 `additionalDirectories` 命中不存在的路径时，不再原样传给 Codex CLI；会优先回退到有效的 `CTI_DEFAULT_WORKDIR`，并过滤掉不存在的附加目录，避免 workflow retry 或旧绑定因为失效路径直接触发 `Error: 系统找不到指定的文件 (os error 2)`。
- retry 结果如果保留了渠道和 chatId，会通过 bridge proactive message 回发“断点续跑重试结果”，避免 bridge 重启后只在本地状态里完成。
- 控制面板执行器页和会话详情能显示 recovery / retry 状态，并通过 `workflow.retryRun` 对失败且有恢复输入的 run 发起手动重试。
- workflow status 单测补齐恢复信息持久化、重启后可恢复/不可恢复分类、手动 retry 请求和 runtime 领取顺序。
- 修复 live skill 同步脚本的扩展清单来源：`mcp.d`、`skills.d`、`plugins.d` 现在从 `config/*.d` 唯一来源同步到运行版，避免同步后 live 面板看不到新版 MCP 或扩展服务入口。

当前限制：

- 这一阶段是 strangler migration 的外壳层：真实执行仍复用现有 provider / local agent 实现，尚未把每个执行器拆成独立 adapter 文件。
- 断点续跑第一版只保存重跑所需的最小输入，不恢复原 Codex 进程、权限等待上下文或半截流式输出；后台 retry 遇到新的权限请求会失败并留给用户手动处理。
- `cti-final` 解析、Markdown card、图片/文件、大文件交付和 owner 二次确认仍在旧链路内，后续需要逐步挂到 workflow event。
- 本地模型 agent 已有 sandbox policy 声明，但工具执行层仍需继续从 `local-agent-provider.ts` 拆出独立 tool sandbox。
- retry worker 复用现有 provider 执行层，因此一次断点重试会生成一个新的可观察 workflow run；原 run 负责记录 retry 结果，后续应把 retry 执行 run 与原 run 显式关联。
- `codex_only` 或部分早退路径仍可能只有 provider 级执行，没有完整业务阶段细分；后续应把权限等待、finalizing、delivered 结果和 retry 回传事件继续收口。

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
- `runtime-manifest/v1` 由 `suite.manifest.json` 声明，内建服务 manifest 存放在 `config/runtime.d`。
- `update` 块当前只允许 `npm_global_package`、`skill_git_repo`、`skill_codex_copy`、`suite_live_sync` 四种模板；宿主负责把模板映射成固定命令。
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
- 权限文件并发访问已收口：控制面板读取 `permissions.json` 使用共享读、短重试和原子写，状态刷新不再在无权限变化时反复写文件；运行时临时授权链接迁移到 `permission-links.json`，避免与三档角色权限协议共用同一个 JSON。
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
- WebView 顶部工具区新增“重启面板”入口，调用宿主白名单命令 `panel.restart` 启动同路径的新面板进程，再延迟关闭当前面板，避免更新后仍停留在旧宿主。
- 记忆仓库路径已加门禁：`CTI_MEMORY_REPO_DIR` 不允许落在默认工作目录、Unity 项目目录或它们的子目录下；命中时自动回退到 `CTI_HOME\\memory-repo`，避免把记忆文件写进工程目录。
- 运行时已取消“本地记忆笔记快答”：像“常用场景名称你还记得吗”这类问题会走记忆检索和主执行链，不再因为关键词命中就绕过 Codex。
- 会话历史里飞书 `interactive` 卡片消息现在会尽量解析正文文本；对旧的 `[卡片消息]` 占位记录，控制面板会优先按 `messageId` 从 `audit.json` 回填摘要，只有 audit 里也缺内容时才需要重新同步飞书历史。
- Bridge 结果块协议已补回归测试：覆盖 `cti-final` 文本/Markdown 经 Feishu 出站、 malformed `cti-final` 可读兜底、`cti-reminder` 进入统一提醒 host，以及拦截伪提醒完成，避免原始 JSON 或协议残片发给用户。
- 直接提醒自然语言快路径补齐“发消息提示我/通知我”句式：例如“一分钟后发消息提示我看一下unity”现在会直接创建 bridge 统一提醒，不再进入 Codex 普通回复后被伪完成拦截。
- 直接提醒自然语言快路径补齐通用时间解析：支持相对时间、当天/明天/后天时刻和年月日时刻，提醒内容可出现在时间前或时间后；未带日期且时间已过时按次日同一时间处理，避免明确提醒请求落入普通 Codex 回复。

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
- Markdown 知识库索引默认位于 `E:\cli-md\.cti-index\knowledge.json`，保留来源路径和片段，面板可按类型搜索。
- 控制面板“记忆”页新增知识单元归档：点击归档会从源 Markdown 精确移除该知识单元行，并写入 `E:\cli-md\archive\knowledge-units\*.md`；归档目录不会进入索引，归档列表支持打开和永久删除。
- 待办提醒索引默认位于 `E:\cli-md\.cti-index\reminders.json`，推送状态位于 `E:\cli-md\.cti-index\reminder-state.json`；普通记忆待办只针对带来源会话和提醒时间的未完成待办，默认关闭主动推送。
- 直接提醒源文件默认写入 `E:\cli-md\data\todos\direct-reminders`，由 `cti-reminder` 动作或 `/remind` 显式入口创建，默认通过 bridge 统一推送链路到点发回当前会话。
- 记忆整理草稿默认写入 `E:\cli-md\.cti-index\memory-optimization-drafts`，只在用户确认后修改 Markdown；归档动作进入既有归档目录，定期模式只生成待确认草稿。
- 查看器优先使用远端 / 本地索引组合。
- 本地历史检索支持群名、关键词、发言人、时间段。
- Codex CLI 主模型不可用时默认报告真实阻塞；只有用户显式开启备用本地 Agent API 时才切换备用 profile。工具链、写文件、发布和 Unity/Blender/MCP 任务必须报告真实阻塞。

当前原则：

- Feishu 远端记录是主事实来源。
- 本地索引用于检索、摘要、节省 token 和容灾。
- 记忆只按查询相关性少量注入，不允许把所有用户画像或全部历史塞进模型上下文。
- 记忆类回复不能只给概括，命中结构化键值时应保留原始键和值。
- 2026-05-11 记忆回忆路由补齐 Feishu 群聊 @ 噪声剥离和短问句键值识别：类似“第十三条龙叫啥@机器人”会按“第十三条龙”检索结构化知识，但“场景名称是什么”这类抽象普通问句仍不触发直答。
- 2026-05-11 继续加固记忆直答排序：结构化直答必须匹配结构化 key 或明确表标题，不能因为聊天记录里包含用户问题就用不相关表格抢答；知识库精确 key 命中会优先于同群噪声历史。

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
- 正在处理的消息如果 bridge 被强制重启，当前只支持基于最小恢复输入的重跑；无法恢复原进程内的未完成工具授权或半截模型输出。
- Feishu 私聊 WS 漏事件已补捞，但如果历史接口也异常，仍可能延迟。
- Feishu OAuth 回调依赖 `CTI_FEISHU_OAUTH_PUBLIC_BASE_URL` 和反向代理配置；公网回调不可达时只能提示用户配置授权入口，不能读取私有云文档。
- `packages/bridge-runtime/scripts/build-control-panel.ps1` 和 `package-release.ps1` 仍作为兼容入口存在，但不再承载旧源码。

建议下一步：

- 把 workflow retry 执行 run 与原始 run 建立显式 parent/child 关联，并把权限等待、finalizing、结果回传细化成 workflow event。
- 给 Feishu 历史索引增加编码修复工具。
- 控制面板增加“当前消息是否从 WS 收到还是轮询补捞”的可视标签。
- Unity MCP 进一步强制匹配 `CTI_UNITY_PROJECT_PATH`，不只依赖 allowed roots。
- 给结果块协议增加单元测试，避免 JSON 裸漏和 Markdown card 回归。

## 9. 当前未发布改动提示

- 2026-05-20 workflow 运行记录新增任务级 `execution` / `tokenUsage` 摘要：runtime 会从流式 `status/result` 事件汇总模型来源、模型名和 token 用量写回 `workflow-runs.json` 顶层；控制面板在“执行器 -> 最近 Workflow”和“会话详情 -> 运行历程”同步展示模型、来源、总 token、输入/输出 token，并在有值时显示 cache token。
- 2026-05-21 针对 live workflow 自旋补了两层防护：一是 `workflow-runs.json` 在 Windows 上被占用时，runtime 不再只依赖 `renameSync` 覆盖文件，而是回退为直接写目标文件；二是对 `usage limit`、鉴权失效、`405 Method Not Allowed`、`/v1/responses` 这类确定性失败，workflow 不再自动排 `auto_retry`，避免一条消息失败后持续自旋重跑。
- 2026-05-21 workflow 面板补齐时间与可视范围：执行器页“最近 Workflow”从最近 12 条扩大到最近 40 条，并直接显示开始时间和耗时；会话详情“运行历程”新增开始、结束和耗时字段，方便区分短失败、长执行和断点续跑中的 run。
- 2026-05-21 修复 workflow 单测污染 live 运行记录：`workflow-status` 状态文件路径改为按调用时读取 `CTI_HOME`，单测每次运行都切到临时目录，避免 `session-stale-auto-retry`、`session-recoverable` 这类测试 run 再写进 `C:\Users\admin\.claude-to-im\runtime\workflow-runs.json` 干扰真实面板。
- 2026-05-21 Codex CLI 模型来源改为“Codex agent + API 来源链”：新增 `CTI_CODEX_ROUTING_MODE=manual|auto_failover` 与 `CTI_CODEX_API_FALLBACK_CHAIN`；手动本地 API 模式只使用 `local_primary` profile，清理 `OPENAI_API_KEY` / `CODEX_API_KEY` / `CTI_CODEX_API_KEY` 等付费侧环境变量，不再因工具探测或旧安全兜底键自动转官方 Codex。`codex-local-fallback` 从用户可选执行器移除，`@local` / `@本地` 改为选择 `codex` 的本地模型来源；自动切换只在模型/API 层失败后按链尝试，默认链为 `local_api,external_api`，官方 Codex 必须显式加入才会被调用。控制面板“运行策略”新增“自动切换”与可排序来源链，并隐藏旧本地 Agent API 兜底控件。
- 2026-05-21 Codex API 自动切换修复：Codex provider 如果把 `/v1/responses`、405、鉴权或额度问题包装成 SSE `error` 事件，`CodexApiFailoverProvider` 现在也会识别为模型/API 层失败并继续尝试链内下一个已配置来源；未配置 `CTI_CODEX_BASE_URL` 的 `external_api` 会被跳过，避免把外部 API 空配置误当成官方 Codex。若链内只剩 Ollama，本地失败会明确提示“Ollama Chat Completions 不支持 Codex SDK 需要的 Responses/WebSocket `/v1/responses` 接口”。
- 2026-05-21 控制面板 live 产物同步修正：重新运行 `scripts/build-packages.ps1` 发布 `release\artifacts\control-panel`，再同步 live skill 并重启面板/Bridge；总览页系统蓝图的 AI 执行节点同步改为“Codex agent + 模型来源/自动切换链”口径，不再显示“本地兜底”作为备援。
- 2026-05-21 本地模型 provider registry 接入 Codex CLI：`local_api` 不再走 `@openai/codex-sdk` 的 `/v1/responses`，而是按 `CTI_LOCAL_AI_KIND` 选择 adapter；当前 `ollama` 和 `lmstudio` 生成 `codex exec --oss --local-provider <provider> --model <CTI_LOCAL_AI_MODEL>`，模型名来自配置，不写死 `qwen2.5-coder:7b`。`vllm`、`openai-compatible` 和 `custom` 当前标记为仅 Chat Completions，手动本地 API 会明确阻断，自动链只继续尝试链中后续已配置来源。Workflow 会记录实际 adapter、模型、来源和 Codex CLI JSONL token usage，控制面板本地 API 区显示 provider 是否支持 Codex agent。
- 2026-05-21 Agent 工具证据验收升级：`bridge-core` 新增 `ExecutionRequirement` 分类，本地目录/文件读取、Unity/MCP/Blender、截图和产物任务会在进入 provider 前注入明确工具规范。非 `none` 请求如果第一次没有成功 `tool_result`，同一模型来源自动重试一次；仍无证据时返回“未完成：本轮没有检测到真实工具执行成功记录”。Workflow 顶层记录证据要求、是否满足和是否已重试，控制面板“最近 Workflow”和“运行历程”同步显示证据状态。
- 2026-05-21 本地模型 JSON 工具协议落地：`local_api` 的本地读取类任务不再只依赖 Codex OSS 模型自发产生 `command_execution`，而是先让本地模型输出严格 `tool_request` JSON，runtime 校验并执行 `list_dir/read_file/search_files` 只读工具，再基于真实 `JsonToolResult` 做确定性最终化，避免只读任务再消耗一次本地模型总结调用。若本地模型两次都没有输出 JSON，runtime 仅对可保守推断的只读目标补全白名单工具请求。Workflow 新增 `evidenceProtocol=json_tool_request`、`requestedTool`、`executedTool`、`jsonToolRetryAttempted`、`jsonToolFallbackUsed`，面板同步显示 JSON 工具协议证据状态；该失败不触发切官方 Codex。
- 2026-05-22 本地模型 JSON 工具协议扩展到 shell：`local_api` 的 `tool_required` 请求也进入 JSON 工具协议，支持模型或 runtime 保守补全 `{"tool":"shell"}` 请求。runtime 会校验 shell `cwd` 在允许根内，执行用户明确要求的命令，记录 stdout/stderr/exitCode/duration，并把 `shellExitCode` / `shellDurationMs` 写入 workflow 摘要和控制面板证据展示。命令失败、路径不唯一或协议失败仍属于工具失败，不触发官方 Codex 自动切换。

截至本记录生成时，工作区仍有以下近期代码改动，发布前应按目标分支选择发布入口：

- 如果只是更新本机运行副本，使用 `publish-backup.ps1`。
- 如果准备合入 `main`，先使用 `prepare-main-release.ps1` 完成主干发布预检。
- 当前重点改动是扩展 manifest v1、主干发布预检脚本、版本治理说明和控制面板运营信息展示。

- 2026-05-26 控制面板模型安装交互补齐：修复 WebView/Control API 的目录选择弹窗没有绑定宿主窗口导致“选择目录”无响应或弹到背后的问题；设置页增加本地草稿保护，后台 `state` 推送不再覆盖尚未保存的模型来源、路径和 API 配置；在线目录的 Ollama 安装任务不再只显示 `running` 状态，失败、暂停、完成都会保留任务摘要、进度和最近输出，避免安装失败后一秒钟看起来又变回“未安装”。
- 2026-05-26 控制面板 Ollama CLI 路径解析补齐：在线目录安装/卸载 Ollama 模型不再直接依赖面板进程 PATH 中存在 `ollama`，会优先读取 `CTI_OLLAMA_EXE` / `OLLAMA_EXE`，再查 PATH 和常见 Windows 安装目录；找不到时返回明确的“未找到 Ollama CLI”阻塞提示，避免底层 `系统找不到指定的文件` 泄漏到用户侧。

- 2026-06-12 Feishu 群聊轻量上下文：被 @ 或回复触发的短接话现在会补入被回复消息和最近少量同群消息作为 `Feishu recent conversation context`，用于理解“刚刚 / 上面 / 你怎么看 / 怎么起名”等邻近语义；该上下文通过 `extraSystemPrompt` 进入 provider，并被 `light_chat` prompt profile 保留，不再把上下文塞进用户 prompt 导致超过轻聊天长度上限。默认只补 6 条、最多 12 条，可通过 `CTI_FEISHU_LIGHT_CONTEXT_LIMIT` 或 `bridge_feishu_light_context_limit` 调整；这不是全量历史检索，正式“查聊天记录 / 总结群聊”仍走显式历史检索链路。
- 2026-06-12 Feishu 群聊暴走与撤回能力修复：provider 错误外发新增安全摘要和同 chat 短窗口熔断，拦截 `tool_result` SSE、本地路径、转义 JSON、`tool_use_id` 和高乱码密度内容，错误记忆也只记录可读摘要；Feishu 入站统一忽略 system、interactive、app/bot 和邀请类非人类事件，防止机器人卡片、出站消息或入群事件再次触发 LLM；“看一下今天群聊天记录在说什么 / 在聊什么 / 说什么”命中受控历史意图，只用 Feishu 历史索引与格式化片段生成摘要，不再让 Codex 用 Bash/MCP 读取本地历史 JSON；`outbound-refs.json` 现在持久化机器人出站 messageId，控制面板会话详情仅对已记录的 Feishu 机器人消息显示“撤回”，通过 `history.recallBotMessage` 调用 Feishu 消息删除接口并标记已撤回或失败原因。
- 2026-07-07 Feishu 名字唤醒与回复状态：群聊 `require_mention=true` 下，没有原生 @ 时会使用 bot displayName、`bridge_feishu_bot_name`、`bridge_feishu_app_name`、`bridge_feishu_bot_aliases` 或 `CTI_FEISHU_BOT_ALIASES` 形成别名，先分类 `chat / investigate / need_info / done` 再决定是否入队；“小桥 帮我看看”这类明确请求会写入 `raw.feishuBotWake` 并进入执行链，“刚才小桥说的那个方案挺好”这类第三人称提及只写过滤审计。`conversation-engine` 的回复契约同步要求 Feishu turn 先判 intent/state，查完只回结果，缺信息才问最小澄清，艾特人必须基于明确姓名、被回复消息或唯一群成员匹配，不再把工具流水、路径、命令或内部协议倒给用户。
