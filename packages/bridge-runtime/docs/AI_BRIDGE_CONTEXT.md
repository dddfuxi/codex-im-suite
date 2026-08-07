# AI Bridge Context

本文档是 `codex-im-suite` 项目内的 Bridge 上下文入口，仅跟随开发版仓库维护。完整架构单一事实源是 [`docs/PROJECT-ARCHITECTURE.md`](../../../docs/PROJECT-ARCHITECTURE.md)，阶段结果与未验收风险记录在 [`docs/DEVELOPMENT-LOG.md`](../../../docs/DEVELOPMENT-LOG.md)。

## 本地语音边界（开发版 0.3.0）

- 首期只接入飞书，语音输入和语音输出均默认关闭，不改变其他渠道和普通文字 Bridge。
- 无会话覆盖时，真实飞书语音经本地 ASR 转写后交给 Primary Agent，并默认回复语音；普通文字默认回复文字。`/voice off` 是硬禁用，直到再次发送 `/voice on` 前都只返回文字；完整优先级为：明确文字 → `/voice off` → 明确语音 → `/voice on` → Runtime 策略 → 入站语音 / 模型提示。
- 语音成功只保留一个飞书原生 Opus 语音终态；转写、合成、校验、进度卡替换或上传失败时，只收口一次完整文字错误或结果，不并行补发第二个终态。
- `bridge-core` 负责当前消息语音证据、会话策略和唯一终态；`bridge-runtime` 负责配置、依赖解析、Sidecar、媒体校验、ASR/TTS 和音色注册表；Control Panel 只通过共享 Contract 读取状态和发起 Runtime 动作，不复制业务规则。
- Runtime 状态固定为 `ready / optional_missing / blocked / error`。可选模型、FFmpeg、Python 和二进制不随 npm、live skill 或 release 包安装，也不在首条语音消息到达时偷偷下载；必须由用户显式配置或在面板执行受管安装。
- 受管依赖位于 `CTI_HOME\runtime-deps\speech`，音色注册表和授权参考音频位于 `CTI_HOME\runtime\speech\voices`，请求临时文件和默认输出位于 `CTI_HOME\runtime\speech`；这些都不是项目工作区。
- 不读取、迁移或依赖 `F:\unity\ST4\.cti-audio`，也不把 ST4 等外部项目的音频缓存提升为 Bridge 运行时数据。

截至 2026-08-07，尚未执行 live 同步/重启、RTX 性能与显存验收，以及重启后真实飞书新语音端到端验收；不得把开发版代码或本地测试通过表述为现场已生效。
