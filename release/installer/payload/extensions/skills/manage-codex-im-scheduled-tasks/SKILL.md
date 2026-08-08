---
name: manage-codex-im-scheduled-tasks
description: Use when a Feishu user asks to create, inspect, pause, resume, run, delete, migrate, or diagnose one-time or recurring scheduled tasks, reminders, check-ins, attendance buttons, cron jobs, agent jobs, delivery retries, or failures after Bridge restarts.
---

# 管理飞书计划任务

## 核心原则

把用户意图转换为统一计划任务动作，并只根据真实 Host 返回回复。计划任务定义、执行结果和飞书投递结果是三份事实；不得声称未被 Host 接受的任务已经创建、执行或发送。

## 选择动作

| 用户目标 | 动作 |
|---|---|
| 到点发送固定文字 | `notify` |
| 到点让创建者或当前群成员逐人打卡 | `check_in` |
| 到点重新查询、汇总、生成动态结果 | `agent_turn` |
| 到点调用具备副作用的受控工具 | `controlled_tool`，必须通过 Owner 门禁 |

- 周期任务必须输出 `cti-scheduled-task`，不要降级为单次 reminder。
- 用户明确要求“打卡 / 签到 / 点完成并统计人数”时使用 `check_in`，不要用普通 `notify` 后让 Agent 口头回复“打卡成功”，也不要借用通用投票或旧 reminder 完成按钮。
- 单次低风险固定通知可以输出 `cti-reminder`；Runtime 会兼容转换为单次 `notify` 计划任务。
- “工作日 10:30”使用 `30 10 * * 1-5` 和 `Asia/Shanghai`；这只表示周一至周五，法定节假日不会自动排除。
- 相对时间、绝对时间或时区不明确时，只追问最小缺口，不猜测。

## 创建协议

仅输出模型可决定的字段。`chatId`、`open_id`、Owner、角色、来源会话、工作目录和 delivery target 必须由本轮真实飞书消息、reply、mention、session evidence 及 Runtime 重建；不要把这些字段写进动作 JSON。

```cti-scheduled-task
{
  "action": "create",
  "name": "工作日每日单子",
  "schedule": {
    "kind": "cron",
    "expression": "30 10 * * 1-5",
    "timezone": "Asia/Shanghai"
  },
  "taskAction": {
    "kind": "agent_turn",
    "prompt": "查询当前会话要求的每日单子，并整理成适合飞书发送的 Markdown。",
    "sessionMode": "bound"
  },
  "deliveryMode": "result"
}
```

打卡示例：

```cti-scheduled-task
{
  "action": "create",
  "name": "工作日喝水打卡",
  "schedule": {
    "kind": "cron",
    "expression": "0 10 * * 1-5",
    "timezone": "Asia/Shanghai"
  },
  "taskAction": {
    "kind": "check_in",
    "text": "喝水后请点击按钮打卡。",
    "audience": "chat_members",
    "buttonText": "我喝水了",
    "successText": "喝水打卡成功。",
    "windowMs": 3600000
  },
  "deliveryMode": "result"
}
```

`audience` 只允许 `owner / chat_members`。每次运行独立统计，重复点击不重复计数；点击者、当前群和卡片 message ID 由 Bridge/Runtime 从真实回调重建，动作 JSON 不得携带用户 ID、群 ID 或 callback data。

时间类型：

- 单次：`{"kind":"at","at":"ISO-8601","timezone":"Asia/Shanghai"}`
- 固定间隔：`{"kind":"every","everyMs":60000,"anchorAt":"ISO-8601"}`
- Cron：`{"kind":"cron","expression":"30 10 * * 1-5","timezone":"Asia/Shanghai"}`

`agent_turn` 只有确实需要项目文件时才使用 `sessionMode: "bound"`。每次运行都必须让 Runtime 对绑定工作区重新解析；解析失败时失败关闭，不得回退到 cwd、记忆库、上传缓存或其他项目。无需项目文件时使用 `isolated`。

## 管理与诊断

1. 明确列表/查看请求优先使用 Bridge 注入的 `cti-scheduled-task-list-evidence/v1`；它已按当前真实 actor 通过统一 Scheduled Task Host 过滤。只能整理其中的受限任务与状态，不能直接读取 Store、工作区、记忆 Markdown 或无 actor 过滤的本机 CLI 来补数据。
2. Host evidence 的 `status=error` 表示读取失败，不等于任务为空；`status=ready + tasks=[]` 才能回答当前可见任务为零。
3. 详情、暂停、恢复、立即运行、历史、删除和仅重试投递都通过统一 Scheduled Task Host 或正式 Control API。
4. 诊断先读取任务状态和运行账本，分别报告 `executionStatus` 与 `deliveryStatus`；不要扫描工作区或记忆 Markdown 猜状态。
5. 执行与投递分离：Agent 已成功但飞书失败时，只重试投递，不重新执行 Agent。
6. Bridge 重启后，未知副作用运行不得自动重放；根据运行账本报告 `interrupted_by_restart` 或真实恢复结果。
7. `controlled_tool` 只接受 Runtime 工具注册表确认的幂等性，模型不得自行声明可信幂等。

## 回复规则

- 只有 Host 返回 `ok: true` 才说“已创建 / 已暂停 / 已恢复 / 已删除”。
- Host 失败时写“未完成”，附真实错误和最小下一步。
- 飞书目标证据缺失、角色不足、工作区不可用或工具未注册时一律失败关闭。
- 不外发 token、原始工具日志、未脱敏本机路径或内部审计内容。
- 明确区分：任务已保存、执行已成功、飞书已投递；任何一项都不能替另一项背书。

## 旧提醒迁移

旧 direct reminder Markdown 仅只读兼容。先运行 dry-run 并审核 create/skip/blocked；Apply 前停止 Bridge 和 watcher，校验 source hash、备份、冲突不覆盖，再写统一 Store。新提醒不得继续写入记忆 Markdown。
