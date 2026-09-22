# Ollama 本地辅助后端

这套脚本用于在 Windows 本机启动、停止和检查 Ollama，给 `codex-im-suite` 提供只读问题、记忆检索兜底和轻量总结能力。

默认模型：

- `qwen2.5-coder:7b`

## 配置

配置文件：

- `%USERPROFILE%\.claude-to-im\config.env`

关键项：

```env
CTI_OLLAMA_ENABLED=true
CTI_OLLAMA_BASE_URL=http://127.0.0.1:11434
CTI_OLLAMA_MODEL=qwen2.5-coder:7b
CTI_OLLAMA_TIMEOUT_MS=45000
CTI_LOCAL_LLM_ROUTER_ENABLED=true
CTI_LOCAL_LLM_ROUTER_MODE=hybrid
CTI_LOCAL_LLM_FORCE_HUB=true
CTI_LOCAL_LLM_MAX_INPUT_CHARS=6000
CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS=768
CTI_LOCAL_LLM_COMPLEXITY_MODE=conservative
```

`CTI_LOCAL_LLM_*` 中的路由项暂时保留为兼容键。旧 `CTI_LOCAL_LLM_SERVER_EXE`、`CTI_LOCAL_LLM_MODEL_PATH`、`CTI_LOCAL_LLM_SERVER_ARGS` 已废弃，不再启动 `llama-server.exe`，也不再依赖 GGUF 路径。

## 首次准备

安装 Ollama 后拉取默认模型：

```powershell
ollama pull qwen2.5-coder:7b
```

如果需要换模型，只改 `CTI_OLLAMA_MODEL`，再拉取对应模型。

## 脚本

- `setup-ollama.ps1`
  - 做 Ollama CLI、服务地址和模型提示检查。
- `start-local-llm.ps1`
  - 使用 `ollama serve` 启动受本仓库管理的 Ollama 进程；如果系统已有 Ollama 服务，会直接复用。
- `stop-local-llm.ps1`
  - 只停止本脚本启动的托管进程，不强杀桌面版或系统服务。
- `healthcheck-local-llm.ps1`
  - 通过 `GET /api/tags` 检查服务和模型是否可用。

## 运行时文件

- PID 文件：
  - `%USERPROFILE%\.claude-to-im\runtime\ollama-server.pid`
- 路由状态：
  - `%USERPROFILE%\.claude-to-im\runtime\local-llm-status.json`

## 边界

- Ollama 只做明确小活、只读问题和 Codex 不可用时的保守兜底。
- Unity、Blender、MCP、文件写入、发布、真实截图或仓库修改请求必须走 Codex/工具链；本地模型不能伪装完成。
