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
- 控制面板重做：面板升级为 `WinForms + WebView2 + React/Vite`，支持服务总览、扩展管理、发布预检、统一日志，以及白天 / 夜晚主题和自适应布局。
- Ignis / MCP 能力并入套件：新增 `packages/mcp-ignis`、Ignis manifest、生成结果回传和 GLB 资产后处理链路，MCP 注册和状态发现也统一收口。
- 本地辅助执行器收紧：本地快路径改为统一意图判定，中文只读仓库查询如“帮我看看 git 状态”“当前分支是什么”“最近几条提交”会稳定命中本地 repo fast-path。
- 打包链路补齐：portable / installer / live skill 同步都按 suite 目录生成，控制面板 Web 前端和 `wwwroot` 资源会一并进入发布产物。

## 快速入口

- Agent 维护规则：[AGENTS.md](./AGENTS.md)
- 架构说明：[docs/PROJECT-ARCHITECTURE.md](./docs/PROJECT-ARCHITECTURE.md)
- 开发记录：[docs/DEVELOPMENT-LOG.md](./docs/DEVELOPMENT-LOG.md)
- 目标目录检查：`scripts/doctor-suite-targets.ps1`
- 架构文档检查：`scripts/update-architecture-docs.ps1`
- 扩展协议校验：`scripts/validate-extension-manifests.ps1`
- 主干发布预检：`scripts/prepare-main-release.ps1`
- 主干发行标签：`scripts/create-main-release-tag.ps1`
- 控制面板前端源码：`apps/control-panel/web`
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
- `packages/mcp-ignis`：Ignis CLI MCP，负责原画、图片、视频、3D 模型生成和结果查询。
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
- 原画、生成图、视频、模型等 Ignis 生成请求可走 Ignis MCP 快路径；`local_only` 模式下也允许提交和查询 Ignis 任务。
- Ignis 模型请求如果明确要求拆成 FBX/贴图，会在下载 GLB 后调用 Blender 导出脚本，并通过 `cti-final.files` 回传可上传文件。
- Codex 不可用时，本地模型做兜底，并会先检索本地记忆后再回答记忆类问题。
- 本地执行器不能伪造完成结果，不能绕过权限和工作区限制。

## 关键命令

校验 MCP / Skill / Plugin 扩展 manifest：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\validate-extension-manifests.ps1
```

构建全部 package 和面板：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-packages.ps1
```

控制面板采用 WinForms 宿主 + WebView2 + React/Vite 前端。`build-packages.ps1` 会先构建 `apps/control-panel/web`，再发布桌面壳；如果本机缺少 WebView2 Runtime，面板启动时会显示安装提示。当前主界面支持白天 / 夜晚主题切换，并随窗口宽度自动重排导航、卡片和详情区。

打包 portable 和 installer：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

本机备份发布到当前分支：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-backup.ps1
```

该入口会构建开发版、同步 live skill、组装 release、生成摘要、提交并推送当前分支。它用于个人运行副本备份，不作为 `main` 主干门禁。

主干发布预检：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-main-release.ps1
```

该入口会校验扩展协议、检查架构文档、构建、打包并生成发布摘要；不会同步 live skill，也不会自动 `git commit`、`git push` 或打 tag。确认 release notes 后再手动提交，并用 `v0.2.0` 这类 tag 标记稳定发行。

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

发布脚本会先构建开发版，再同步 live、组装 portable 和 installer，避免“开发版”“运行版”和“打包版”漂移。

## GitHub

仓库地址：[dddfuxi/codex-im-suite](https://github.com/dddfuxi/codex-im-suite)

分支定位：

- `main`：稳定产品主干，只保留可复现源码、通用扩展协议、默认示例和文档。
- `codex/dev`：日常集成分支。
- `codex/<topic>`：功能分支前缀。

合入 `main` 前应完成构建、测试、扩展 manifest 校验、架构文档检查、发布摘要和疑似密钥扫描。个人 live skill 更新可以更频繁，但只从已验证的开发版同步，不反向覆盖主干。
