暂未开发完成
# 🖼️ AI图片标注 MCP 服务
# MCP-for-Picture

纯图片理解与标注 MCP，不再包含 Unity prefab 专用能力。

当前支持：

- 图片转文字描述
- 主体标注图生成
- 多目标标注图生成
- 基于图片指纹的轻量记忆

## CLI

```bash
npm install
npm run cli -- describe --image input/demo.png
npm run cli -- subject --image input/demo.png --output output/demo-subject.png
npm run cli -- objects --image input/demo.png --category buildings --style numbered --output output/demo-objects.png
npm run cli -- remember --image input/demo.png --note "入口在左下角"
npm run cli -- recall --image input/demo.png
```

## MCP

```bash
npm run mcp
```

暴露工具：

- `annotate_image`
- `annotate_image_subject`
- `annotate_image_objects`
- `remember_image_layout`
- `recall_image_layout`

## Provider Notes

- Default provider is now `codex` (`MODEL_PROVIDER=codex`).
- `codex` provider reuses local Codex login state and does not require extra OpenAI/Anthropic API keys.
- If needed, you can still switch provider with:
  - `MODEL_PROVIDER=openai`
  - `MODEL_PROVIDER=anthropic`
  - `MODEL_PROVIDER=custom_http`

## Memory Token Budget

To avoid prompt/token explosion, memory and context are trimmed before prompt injection.

- `IMAGE_MEMORY_MAX_STORED_CHARS` (default `4000`)
- `IMAGE_MEMORY_MAX_PROMPT_CHARS` (default `900`)
- `IMAGE_CONTEXT_MAX_PROMPT_CHARS` (default `1200`)
