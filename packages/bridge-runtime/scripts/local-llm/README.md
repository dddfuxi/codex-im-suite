# 本地 `llama.cpp` 辅助模型

这套脚本用于在 Windows 本机上启动、停止和检查 `llama.cpp` server，给 `codex-im-suite` 提供低成本辅助模型。

首发建议模型：

- `Qwen2.5-Coder 7B`

## 需要的配置

这些配置写在：

- `%USERPROFILE%\\.claude-to-im\\config.env`

关键项：

```env
CTI_LOCAL_LLM_ENABLED=true
CTI_LOCAL_LLM_BASE_URL=http://127.0.0.1:8080
CTI_LOCAL_LLM_MODEL=qwen2.5-coder-7b-instruct
CTI_LOCAL_LLM_AUTO_ROUTE=true
CTI_LOCAL_LLM_TIMEOUT_MS=45000
CTI_LOCAL_LLM_MAX_INPUT_CHARS=6000
CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS=768
CTI_LOCAL_LLM_COMPLEXITY_MODE=conservative
CTI_LOCAL_LLM_SERVER_EXE=C:\tools\llama.cpp\llama-server.exe
CTI_LOCAL_LLM_MODEL_PATH=D:\models\Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf
CTI_LOCAL_LLM_SERVER_ARGS=--ctx-size 8192 --threads 8 --n-gpu-layers 99
```

说明：

- `CTI_LOCAL_LLM_SERVER_EXE`
  - `llama-server.exe` 路径
- `CTI_LOCAL_LLM_MODEL_PATH`
  - 本地 GGUF 模型文件路径
- `CTI_LOCAL_LLM_SERVER_ARGS`
  - 额外 server 参数，可选

## 脚本

- `setup-llama-cpp.ps1`
  - 做环境预检和说明，不下载模型
- `start-local-llm.ps1`
  - 启动 `llama.cpp` server
- `stop-local-llm.ps1`
  - 停止本地模型服务
- `healthcheck-local-llm.ps1`
  - 检查本地模型服务

## 运行时文件

- PID 文件：
  - `%USERPROFILE%\\.claude-to-im\\runtime\\local-llm-server.pid`
- 路由状态：
  - `%USERPROFILE%\\.claude-to-im\\runtime\\local-llm-status.json`

## 注意

- 不把模型权重放进仓库
- 不把本机模型路径写进发布说明
- 这套本地模型只做低复杂度代码杂活自动分流，不直接执行高危写操作
