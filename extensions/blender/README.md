# Blender MCP

这套 suite 已预留 Blender MCP 接入：

- MCP manifest: `config/mcp.d/blender-mcp.json`
- launcher: `scripts/launch-blender-mcp.ps1`
- addon download script: `scripts/setup-blender-mcp.ps1`

## 安装

先下载 Blender addon：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-blender-mcp.ps1
```

然后在 Blender 里：

1. `Edit > Preferences > Add-ons > Install...`
2. 选择下载到 `extensions/blender/addon.py` 的文件
3. 启用 `Interface: Blender MCP`
4. 在 3D View 侧边栏打开 `BlenderMCP`
5. 点击 `Connect to Claude`

## 注册到 Codex

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-external-mcps.ps1
```

注册后会出现：

- `blenderMCP`

## 说明

- 本地 MCP 服务使用 `uvx blender-mcp`
- 默认 Blender socket 地址：
  - `BLENDER_HOST=127.0.0.1`
  - `BLENDER_PORT=9876`
- 如果 Blender 插件没有连上，MCP 服务能启动，但会在调用时报连接失败
