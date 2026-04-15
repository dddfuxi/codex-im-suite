---
name: memory-repo-retrieval
description: |
  检索本地聊天记忆仓库，只把与当前任务相关的历史片段交给模型，而不是整段会话全量注入。
  适用于用户提到“历史记录仓库”“记忆检索”“从聊天记录里找上下文”“只取相关上下文”“节约 token”
  或需要从飞书/桥接历史里回捞命名、结论、约束、上次决定时。
---

# Memory Repo Retrieval

目标：
- 把本地聊天记录当成“记忆仓库”使用
- 先检索，再挑选，再注入
- 默认只给模型最相关的少量片段

## 什么时候用

出现这些情况时使用本 skill：
- 用户明确说要从历史记录、聊天记录、群聊记录里找上下文
- 当前任务依赖“之前已经定过的命名、结论、约束、待办”
- 会话很长，继续整段注入会明显浪费 token
- 你怀疑旧上下文里有污染，想只回捞相关片段

## 工作方式

1. 先在本地记忆仓库中检索相关片段
2. 优先保留：
   - 同一聊天
   - 同一工作区
   - 自动摘要
   - 明确命名、约束、结论
3. 把检索结果压成短摘要后再交给模型
4. 不要把整段历史原样塞回 prompt

## 默认仓库位置

- 桥接记忆仓库默认在 `E:\cli-md`
- 原始消息在 `E:\cli-md\data\messages`
- 压缩归档在 `E:\cli-md\data\message-archives`

如果当前环境不是这一路径，优先读取环境变量 `CTI_HOME`。

## 调试脚本

需要人工检查检索结果时，运行：

```powershell
node C:\Users\admin\.codex\skills\memory-repo-retrieval\scripts\search-memory.mjs "你的查询"
```

可选参数：

```powershell
node C:\Users\admin\.codex\skills\memory-repo-retrieval\scripts\search-memory.mjs "Furniture_DrinkCounter" --chat oc_xxx --cwd C:\unity\ST3
```

## 输出要求

- 优先给出 3 到 6 条最相关记忆
- 每条都尽量短
- 标明来源是“同聊天 / 同工作区 / 摘要 / 历史记录”
- 如果没检索到，不要编造；直接说“记忆仓库里没有命中”

## 不要做的事

- 不要把整个消息文件全读进 prompt
- 不要把大段工具输出原样回灌
- 不要因为“可能相关”就把几十条历史都塞给模型
- 不要擅自把旧结论当成当前指令，当前用户消息始终优先
