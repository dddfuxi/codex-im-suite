export type ScheduledTaskCardSummary = {
  taskId: string;
  name: string;
  actionKind: 'notify' | 'agent_turn' | 'controlled_tool';
  scheduleKind: 'at' | 'every' | 'cron';
  timezone?: string;
  nextRunAt?: string;
  enabled: boolean;
};

export type ScheduledTaskFailureCardSummary = {
  taskId: string;
  runId: string;
  name: string;
  error: string;
  executionStatus: string;
  deliveryStatus: string;
};

function actionLabel(kind: ScheduledTaskCardSummary['actionKind']): string {
  if (kind === 'agent_turn') return '动态 Agent 任务';
  if (kind === 'controlled_tool') return '受控工具任务';
  return '固定通知';
}

function button(text: string, callbackData: string, type: 'default' | 'primary' | 'danger' = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    size: 'small',
    value: { callback_data: callbackData },
  };
}

/** 只消费脱敏任务摘要，避免把工具输入、日志或正文写进飞书卡片。 */
export function buildScheduledTaskCard(summary: ScheduledTaskCardSummary): string {
  const stateAction = summary.enabled ? 'pause' : 'resume';
  const stateText = summary.enabled ? '暂停' : '恢复';
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: summary.enabled ? 'blue' : 'grey', title: { tag: 'plain_text', content: '统一计划任务' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${summary.name}**`,
            `类型：${actionLabel(summary.actionKind)}`,
            `计划：${summary.scheduleKind}`,
            `时区：${summary.timezone || '不适用'}`,
            `下次运行：${summary.nextRunAt || '待计算'}`,
          ].join('\n'),
        },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            { tag: 'column', width: 'auto', elements: [button(stateText, `scheduled-task:${stateAction}:${summary.taskId}`)] },
            { tag: 'column', width: 'auto', elements: [button('立即运行', `scheduled-task:run:${summary.taskId}`, 'primary')] },
            { tag: 'column', width: 'auto', elements: [button('历史', `scheduled-task:history:${summary.taskId}`)] },
            { tag: 'column', width: 'auto', elements: [button('删除', `scheduled-task:delete:${summary.taskId}`, 'danger')] },
          ],
        },
      ],
    },
  });
}

export function buildScheduledTaskFailureCard(summary: ScheduledTaskFailureCardSummary): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: '计划任务投递失败' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${summary.name}**`,
            `执行：${summary.executionStatus}`,
            `投递：${summary.deliveryStatus}`,
            `原因：${summary.error.slice(0, 500)}`,
          ].join('\n'),
        },
        button('只重试投递', `scheduled-task:retry-delivery:${summary.runId}`, 'primary'),
      ],
    },
  });
}
