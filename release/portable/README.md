# codex-im-suite

`codex-im-suite` 是飞书桥接、Codex 执行层、MCP、Skill、控制面板和打包流程的统一开发与发布目录。

现在这套目录的目标很明确：

- 以后开发主要在这个目录下进行，不再依赖外部散落仓库作为唯一入口。
- 当前运行版的重要源码已经备份进来。
- 需要上传 GitHub 备份时，先打包，再提交，再推送。

## 当前结构

### 1. packages

- `packages/bridge-core`
  - 桥接核心库
  - 来自原 `Claude-to-IM`
- `packages/bridge-runtime`
  - 当前运行版桥接壳层与脚本
  - 来自当前运行中的 `C:\Users\admin\.codex\skills\claude-to-im`
- `packages/mcp-picture`
  - 图片标注 / 布局记忆 MCP
- `packages/mcp-unity-prefab`
  - Unity Prefab 扫描 MCP

### 2. apps

- `apps/control-panel`
  - 中控面板源码
- `apps/installer`
  - Windows 安装器源码

### 3. config

- `config/mcp.d`
  - MCP 清单
- `config/skills.d`
  - Skill 清单
- `config/plugins.d`
  - Plugin 清单

### 4. extensions

- `extensions/skills`
  - 当前需要一起备份和迁移的自定义 skill 副本

### 5. scripts

- `bootstrap-suite.ps1`
  - 新机器初始化依赖
- `build-packages.ps1`
  - 构建 suite 内所有 package 和面板
- `assemble-portable.ps1`
  - 组装便携版
- `build-installer.ps1`
  - 组装安装器
- `package-release.ps1`
  - 一键打包
- `register-external-mcps.ps1`
  - 读取 manifest 并注册 stdio MCP
- `publish-backup.ps1`
  - 先打包，再提交，再推送 GitHub

## 开发规则

以后如果修改开发版，优先改这里：

- `packages/bridge-core`
- `packages/bridge-runtime`
- `packages/mcp-picture`
- `packages/mcp-unity-prefab`
- `apps/control-panel`

不要再把外部历史目录当成主开发目录。

## 打包规则

执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

会按顺序：

1. 构建所有 package
2. 构建中控面板
3. 组装 portable
4. 组装 installer

输出目录：

- `release/portable`
- `release/installer`
- `release/codex-im-suite-portable.zip`

## 上传规则

如果你要求“上传 GitHub 备份”，应该走：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-backup.ps1
```

这个脚本会：

1. 先重新打包，确保产物跟最新开发版一致
2. `git add .`
3. 自动提交
4. 推送到当前配置的远端

也就是说，后续你改了开发版，再要求上传时，打包版会先自动更新到最新再推送。

## 当前仓库地址

- GitHub: [dddfuxi/codex-im-suite](https://github.com/dddfuxi/codex-im-suite)
