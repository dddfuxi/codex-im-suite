# Workflow 失败反思与性能 Agent 修复实施计划

## 目标

把 Workflow 失败消息转成可去重、可追踪、不会重复分析的运行事实；Performance Agent 只输出优化建议，不自动改代码或自动 Git 存档。live Bridge 重启前必须避开仍在执行或重试的 Workflow，修复完成后通过正式同步入口部署并私聊 Owner 结果。

## 实施清单

- [x] 新增 Windows Workflow drain：重启前轮询 `workflow-runs.json`，活动任务未排空时等待，超时取消重启。
- [x] 控制面板所有 Bridge 重启统一走 `daemon.ps1 restart`，不再自行 stop/start。
- [x] drain 配置优先读取 `config.env`，提供有界超时、轮询间隔和显式 force 恢复逃生口。
- [x] live、portable、installer 复制链和发布指纹覆盖 `workflow-drain.ps1`；控制面板复制安装漂移探针同步覆盖。
- [x] Workflow Contract 增加稳定脱敏失败诊断，区分 Provider 与工具失败类别，失败事件只携带诊断码。
- [x] Computer Use 连锁失败根因收口：Bridge 默认隔离 Desktop 全局插件，保留显式兼容 opt-in，并禁止猜路径或手工执行插件缓存脚本。
- [x] Performance Agent 指标排除活动回合，分析输入使用冻结快照，建议记录证据引用、快照时间和分析水位。
- [x] 批次判断改为水位之后的新增已完成回合，并在重启后恢复上次建议时间，防止重复建议。
- [x] Runtime 定向测试、Runtime typecheck、Contracts 测试和 Workflow drain 专项测试。
- [x] Runtime、Core、Contracts、Web、Control Panel 全量测试与构建。
- [x] 依赖边界、静态边界、人类文档、UTF-8/乱码、diff 与发布专项门禁。
- [x] 同步 live skill 并通过 drain 重启 Bridge。
- [x] 核验新 Supervisor/Bridge/Worker PID、Feishu 长连接、runtime audit、health 和 suite/live SHA-256。
- [x] 使用重启后的真实私聊入口发送结果并记录现场证据。

### 2026-08-03 追加整改

- [x] 将普通 `stop / restart / uninstall-service` 收口到同一 Workflow drain，并保留显式 `-Force` 恢复入口。
- [x] 增加脱敏生命周期审计，记录来源、动作、活动数量、阶段和 drain 裁决。
- [x] 增加 `workflow-failure-ledger/v1` 单调失败水位和稳定指纹，不保存正文、身份或绝对路径。
- [x] 补齐 Hub Provider 主路径的 `workflowRunId` 协作关联。
- [x] 补齐 Contracts、Workflow status 与 drain 定向回归。
- [ ] 同步 live、重启 Bridge 并用重启后的新消息复测（本次未获“同步运行版/现场生效”的明确指令）。

## 验收口径

1. 活动 Workflow 存在时，普通 restart 不停止 live 进程；排空后才允许重启。
2. Workflow 失败记录包含稳定诊断码，不要求面板或自动化解析原始异常全文。
3. Performance 建议的 `runCount` 与冻结指标分母一致，当前活动回合不计入，水位未推进时不重复分析。
4. Bridge Codex Home 默认没有全局 `plugins` 共享入口，用户全局插件目录和缓存不被修改。
5. live 新 PID、Feishu `client ready / ws client ready`、`lastExitReason=null` 和关键文件哈希一致后，才可声明部署完成。

## 明确不做

- 不自动修改 Performance Agent 给出的建议。
- 不自动创建修改前/修改后的 Git 提交或 push。
- 不在 Workflow drain 超时时静默 force 重启。
- 不把 Codex Desktop 专用 helper 能力伪装成 Bridge CLI/SDK 可用能力。
