---
name: feishu-document-generation
description: Generate or update Feishu/Lark Docx documents from chat summaries, execution results, Unity scene work, screenshots, or bridge history. Use when the user asks to create, rewrite, polish, summarize into, or update a Feishu document, especially when they mention title, columns/sections, body, images, appendices, or avoiding raw chat logs.
---

# Feishu Document Generation

Use this skill whenever a task writes or rewrites a Feishu Docx document.

## Output Contract

1. The document title must be a content title, derived from the actual topic or first H1. Do not use generic titles such as "group chat summary", "recent messages", "conversation cleanup", or timestamp-only titles.
2. The first block must be an H1 that matches the document title.
3. Use structured sections by default: conclusion summary, key facts, execution results, problems and risks, follow-up tasks.
4. For Unity scene documents, include scene names, common names, camera/source, short explanation, and relevant images. If an appendix is needed, prefer scene file locations over screenshot file paths.
5. Do not paste raw chat transcripts, long execution logs, terminal dumps, or local screenshot path lists into the body unless the user explicitly asks for raw records.
6. If screenshots or generated images are included, verify that they are non-empty and match the requested source, camera, and aspect ratio. A Scene View crop is not a valid substitute for a requested camera or Game View screenshot.
7. For Timeline scene screenshots, do not capture immediately after loading the scene. Load the scene, activate the intended Timeline object, set the PlayableDirector time to the requested frame (usually `0` for first frame), call `Evaluate()`, then render from the bound camera. Treat a blank frame as failure and retry after explicitly evaluating the Timeline.

## Encoding Rules

1. Preserve UTF-8 end to end.
2. Do not pass Chinese Markdown or JSON through PowerShell command strings, PowerShell stdin pipes, or console-codepage dependent paths.
3. Use a UTF-8 file, Node Buffer/string loaded from disk, or direct in-process API calls for Chinese document content.
4. Before writing, reject text containing long `????` runs or mojibake markers such as `鈥`, `涓`, `鎬`, `鉁`.
5. After writing, read the document back through the API and verify the first text block plus a whole-document sample for encoding corruption.

## Existing Document Update Flow

1. Parse the document ID from the Feishu Docx URL. Never echo disposable login tokens.
2. Fetch the existing document and current child blocks.
3. Delete or replace stale body blocks only after the new structured content is ready.
4. Write blocks in batches under Feishu's per-request block limit.
5. For images in Docx: create empty image blocks, upload media with `parent_type=docx_image` and `parent_node=<image_block_id>`, then patch each image block with `replace_image`.
6. Try to update the real document/file title through the available Feishu API. If the current app cannot update the file title, keep the H1 correct and report the exact API blocker.

## Bridge Behavior

Use this skill when the user asks to generate, rewrite, update, or organize content into a Feishu document. The bridge must apply these rules before calling the Feishu Docx API.

## Document Memory

1. After every successful bot-created or bot-updated Feishu document, write a compact index entry to the configured memory repo, default `E:\cli-md\data\documents\index.json`.
2. Also regenerate the local guide Markdown at `E:\cli-md\data\documents\DOCUMENT_GUIDE.md` so the bridge can answer "有哪些文档" from the index instead of injecting full chat history.
3. Index entries should include title, URL, document ID, requester, chat, workspace, short source summary, tags, image count, related `.unity` scene paths, and permission status.
4. When listing documents, only return the index summary and links. Do not load or send full document bodies unless the user explicitly asks for one specific document.

## Permission Rules

1. Dangerous document operations, including delete, permanent delete, permission changes, or rewriting existing documents, require the configured Feishu owner ID.
2. The owner ID is configured through `CTI_FEISHU_OWNER_USERS`; if it is missing, the bridge should show `/whoami` sender IDs and refuse dangerous operations.
3. Generated documents should grant the owner edit access best-effort. If the Feishu API keeps the app as creator, record that status instead of claiming ownership was transferred.

When the user asks to "生成飞书文档", "整理成飞书文档", "重新修改文档", or similar, the bridge should use this skill's rules before calling the Feishu Docx API.
