# MCP-for-Unity-Prefab

独立的 Unity prefab MCP，上层复用已有 `unity-mcp` HTTP 服务，不再和 `MCP-for-Picture` 混在一起。

它做三件事：

1. 扫描指定 `Assets/...` 文件夹下的全部 `.prefab`
2. 读取每个 prefab 的名称、路径、GUID、root object、子节点数量和预览图
3. 把结果存成记忆，并生成一张带名称标注的 prefab 预览总览图

## 依赖

- Unity 侧已经启动 `unity-mcp`
- 默认连接地址：`http://127.0.0.1:8080`

## 环境变量

```powershell
$env:UNITY_MCP_HOST = "127.0.0.1"
$env:UNITY_MCP_HTTP_PORT = "8080"
$env:UNITY_MCP_TIMEOUT_MS = "30000"
# 可选
$env:UNITY_MCP_INSTANCE = "YourProject@hash"
```

## CLI

```bash
npm install
npm run cli -- prefab-scan --folder Assets/Prefabs
npm run cli -- prefab-annotate --folder Assets/Prefabs --output output/prefabs.png
npm run cli -- prefab-recall --folder Assets/Prefabs
```

返回内容包含：

- `prefabs`: 结构化 prefab 列表
- `memory`: 本地记忆文件内容
- `output_path`: 标注总览图路径，仅 `prefab-annotate` 返回

## MCP 工具

启动：

```bash
npm run mcp
```

暴露工具：

- `scan_unity_prefab_folder`
- `recall_unity_prefab_folder`
- `annotate_unity_prefab_folder`

## 记忆与输出

- 记忆目录默认：`.unity-prefab-memory`
- 标注图目录默认：`output`

记忆按 `host + port + unity instance + folder path` 做哈希隔离，避免不同 Unity 工程串数据。
