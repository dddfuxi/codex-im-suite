# 控制面板 AIBridge 与 Unity MCP 暂停实施计划

## 目标

- 在控制面板统一服务页展示 Unity 工程内的 AIBridge 能力。
- 保持 AIBridge 与 Unity MCP 分层，避免把编辑器 CLI 伪装成 MCP。
- 允许 Unity MCP 显式暂停/恢复；暂停后不自动启动、不参与工具路由。

## 已完成

- [x] 新增 `config/runtime.d/tool.aibridge.json`，以项目注册表为唯一发现入口。
- [x] Runtime Unit 显示启用 Unity 工程数量和可用 CLI 数量。
- [x] `check/status` 使用真实 AIBridge `harness status` 回执，并有界超时。
- [x] Unity MCP 增加暂停/恢复动作；暂停时停止托管 helper 并持久化 `enabled=false`。
- [x] 开发版 Unity MCP 已暂停；live 未同步，避免未经现场确认改变运行版。

## 验收与后续

- [x] Control Panel C# 构建通过。
- [x] `npm run test:boundaries` 通过。
- [x] `npm run check:human-docs` 通过。
- [ ] 在面板服务页点击 AIBridge“检查”，逐个确认真实 Unity 工程回执。
- [ ] 如需恢复 Unity MCP，使用面板“恢复”并重新检查 Unity session；不得仅凭配置写入宣称可用。
