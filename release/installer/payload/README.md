# codex-im-suite

`codex-im-suite` 是飞书桥接、Codex 执行层、本地辅助模型、MCP、Skill、控制面板和 Windows 打包流程的统一开发与发布目录。

当前目标很明确：

- 开发入口收口到本仓库，不再依赖散落在外部目录的历史副本。
- 运行版 live skill 可以从本仓库同步生成。
- 发布时先同步、构建、打包，再提交和推送，保证 GitHub 备份与可运行产物一致。

## 快速入口

- Agent 维护规则：[AGENTS.md](./AGENTS.md)
- 架构说明：[docs/PROJECT-ARCHITECTURE.md](./docs/PROJECT-ARCHITECTURE.md)
- 开发记录：[docs/DEVELOPMENT-LOG.md](./docs/DEVELOPMENT-LOG.md)
- 目标目录检查：`scripts/doctor-suite-targets.ps1`
- 架构文档检查：`scripts/update-architecture-docs.ps1`
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

开发版面板入口是 `release\artifacts\control-panel\CodexImSuiteControlPanel.exe`。主窗口只保留日常运维；路径和回复风格在“设置”，历史索引在“查看会话”里的“历史索引”页签。

## 目录结构

- `packages/bridge-core`：IM 桥接核心库，包含 Feishu 适配器、消息路由、权限、审计、发送收口。
- `packages/bridge-runtime`：运行时壳层，包含配置、daemon、provider、Codex、本地模型、本地执行器、MCP 桥接。
- `packages/mcp-picture`：图片能力 MCP。
- `packages/mcp-unity-prefab`：Unity Prefab MCP。
- `apps/control-panel`：Windows 中控面板。
- `apps/installer`：Windows 安装器。
- `config/mcp.d`：MCP manifest，面板和注册脚本都从这里发现 MCP。
- `config/skills.d`：随项目备份的 skill manifest。
- `config/plugins.d`：随项目备份的 plugin manifest。
- `extensions/skills`：自定义 skill 的项目内副本。
- `scripts`：启动、注册、构建、打包、发布、同步脚本。
- `release`：portable、installer、zip 等发布产物。

## 当前运行模型

默认是 `Codex 主脑 + 本地辅助执行器`：

- 普通对话、复杂判断、Unity/Blender/MCP 多步任务默认走 Codex。
- 本地模型只处理明确的小活，例如简单命令、git 状态、文件读取、MCP 状态检查。
- Codex 不可用时，本地模型做兜底，并会先检索本地记忆后再回答记忆类问题。
- 本地执行器不能伪造完成结果，不能绕过权限和工作区限制。

## 关键命令

构建全部 package 和面板：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-packages.ps1
```

打包 portable 和 installer：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

发布到 GitHub：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-backup.ps1
```

同步项目内 skills 到本机 Codex：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-suite-skills.ps1
```

注册 MCP 到 Codex：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-external-mcps.ps1
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

发布脚本会先构建开发版，再同步 live、组装 portable 和 installer，避免“开发版”“运行版”和“打包版”漂移。

## GitHub

仓库地址：[dddfuxi/codex-im-suite](https://github.com/dddfuxi/codex-im-suite)
