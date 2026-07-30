export type FeishuMemberProfileField =
  | 'job_title'
  | 'activation_status'
  | 'department_ids'
  | 'department_name';

export type FeishuMemberProfileRequestedField =
  | 'identity'
  | 'job_title'
  | 'activation_status'
  | 'department_name';

export interface FeishuMemberProfileRequestPlan {
  requestedFields: FeishuMemberProfileRequestedField[];
}

export interface FeishuMemberProfileEvidenceItem {
  actorType: 'user' | 'bot';
  displayName: string;
  status: 'resolved' | 'blocked';
  jobTitle?: string;
  departmentNames?: string[];
  activationStatus?: 'active' | 'inactive' | 'unknown';
  missingFields?: FeishuMemberProfileField[];
  emptyFields?: FeishuMemberProfileField[];
  permissionReason?: string;
  reasonCode?: string;
  reason?: string;
  scopeAlternatives?: string[];
  recommendedScope?: string;
  consoleUrl?: string;
  userOAuthRequired: false;
}

const PROFILE_FIELD_LABELS: Record<FeishuMemberProfileField, string> = {
  job_title: '职位',
  activation_status: '激活状态',
  department_ids: '所属部门',
  department_name: '部门名称',
};

const PROFILE_SCOPE_PRIORITY = new Map<string, number>([
  ['contact:contact.base:readonly', 0],
  ['contact:user.employee:readonly', 10],
  ['contact:user.department:readonly', 20],
  ['contact:department.base:readonly', 30],
]);

/**
 * 字段权限按当前可见收益逐级申请：职位与状态共用一个 scope，优先级最高；
 * 只有拿到部门 ID 后，才需要继续申请部门名称字段权限。
 */
export function selectFeishuMemberProfileFieldScope(
  missingFields: readonly FeishuMemberProfileField[],
): string | undefined {
  if (missingFields.includes('job_title') || missingFields.includes('activation_status')) {
    return 'contact:user.employee:readonly';
  }
  if (missingFields.includes('department_ids')) {
    return 'contact:user.department:readonly';
  }
  if (missingFields.includes('department_name')) {
    return 'contact:department.base:readonly';
  }
  return undefined;
}

export function selectNextFeishuMemberProfileScope(
  context: Pick<FeishuMemberProfileEvidenceContext, 'items' | 'blockers'>,
): string | undefined {
  const scopes = [
    ...context.items.map((item) => item.recommendedScope),
    ...context.blockers.map((blocker) => blocker.recommendedScope),
  ].filter((scope): scope is string => Boolean(scope));
  return Array.from(new Set(scopes)).sort((left, right) => (
    (PROFILE_SCOPE_PRIORITY.get(left) ?? 1_000) - (PROFILE_SCOPE_PRIORITY.get(right) ?? 1_000)
    || left.localeCompare(right)
  ))[0];
}

function fieldValueLabel(
  item: FeishuMemberProfileEvidenceItem,
  field: FeishuMemberProfileField,
  resolvedValue: string,
): string {
  if (item.missingFields?.includes(field)) return '未授权';
  if (item.emptyFields?.includes(field)) return '未填写';
  return resolvedValue;
}

export interface FeishuMemberProfileEvidenceContext {
  prompt: string;
  requestedFields: FeishuMemberProfileRequestedField[];
  requestedCount: number;
  successfulCount: number;
  failedCount: number;
  truncated: boolean;
  items: FeishuMemberProfileEvidenceItem[];
  blockers: Array<{
    reasonCode: string;
    reason: string;
    scopeAlternatives?: string[];
    recommendedScope?: string;
    consoleUrl?: string;
    userOAuthRequired: false;
  }>;
}

const PROFILE_REQUEST_FIELD_MATCHERS: ReadonlyArray<{
  field: FeishuMemberProfileRequestedField;
  pattern: RegExp;
}> = [
  {
    field: 'identity',
    pattern: /(?:身份|成员类型|成员类别|账号类型|帳號類型|账户类型|真人|自然人|用户(?:还是|或|和)机器人|user\s*(?:or|vs\.?|and)\s*bot|member\s*type|identity)/iu,
  },
  {
    field: 'job_title',
    pattern: /(?:职位|職位|职务|職務|岗位|崗位|头衔|頭銜|job\s*title|position|role\s*title)/iu,
  },
  {
    field: 'activation_status',
    pattern: /(?:激活状态|啟用狀態|启用状态|帳號狀態|账号状态|员工状态|員工狀態|在职|在職|离职|離職|是否激活|is[_\s-]*activated|activation\s*status|employment\s*status)/iu,
  },
  {
    field: 'department_name',
    pattern: /(?:部门|部門|组织|組織|所属团队|所屬團隊|department|org(?:anization)?(?:al)?\s*unit|team)/iu,
  },
];

/**
 * 把自然语言请求收敛成显式字段计划。后续 API、缺权判断和 Prompt 只能消费
 * 该计划，不能因为 Contact 响应存在其他可选字段就扩大查询范围。
 */
export function parseFeishuMemberProfileRequest(text: string): FeishuMemberProfileRequestPlan | null {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  const memberTarget = /(?:群(?:里|內|内|中|聊)?).{0,16}(?:成员|成員|群友|用户|用戶|机器人|機器人|大家)|群成员|群成員|群友|所有成员|所有成員|大家|你们|你們|他们|他們|她们|她們|它们|它們/iu.test(normalized);
  const actionIntent = /(?:查|查询|查詢|看|看看|看下|查看|获取|獲取|列出|告诉我|告訴我|核对|核對|确认|確認|检查|檢查|读取|讀取|describe|inspect|list|show|check|get|query)/iu.test(normalized);
  const questionIntent = /(?:是(?:什么|什麼|哪些)|有哪些|都有(?:什么|什麼|哪些|谁|誰)|分别(?:是|属于|屬於)|分別(?:是|属于|屬於)|各自?(?:是|属于|屬於)|属于(?:哪个|哪個|什么|什麼)|屬於(?:哪个|哪個|什么|什麼)|在哪(?:个|個)?|what\s+(?:is|are)|which\s+(?:department|team|role|position|status|type))/iu.test(normalized);
  const metaOnly = /(?:怎么查|怎麼查|如何查|怎样查|怎樣查|为什么查不到|為什麼查不到|需要什么权限|需要什麼權限|要开什么权限|要開什麼權限|是否支持|能不能查|可不可以查)/iu.test(normalized)
    && !/(?:直接|现在|現在|立即|马上|馬上|帮我|幫我|替我|实际|實際)/u.test(normalized);
  const requestedFields = PROFILE_REQUEST_FIELD_MATCHERS
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ field }) => field);
  // 飞书聊天里常见“群成员部门情况”这类省略谓语的短请求。字段与当前群目标都
  // 明确时将其视为低风险读取，避免因缺少固定动词把任务推给 Primary 自行摸索。
  const terseFieldReadIntent = normalized.length <= 96 && requestedFields.length > 0;
  if (!memberTarget || (!actionIntent && !questionIntent && !terseFieldReadIntent) || metaOnly) return null;
  return requestedFields.length > 0 ? { requestedFields } : null;
}

export function isFeishuMemberProfileEvidenceRequest(text: string): boolean {
  return parseFeishuMemberProfileRequest(text) !== null;
}

function requestedEvidenceFields(
  requestedFields: readonly FeishuMemberProfileRequestedField[],
): FeishuMemberProfileField[] {
  const fields: FeishuMemberProfileField[] = [];
  if (requestedFields.includes('job_title')) fields.push('job_title');
  if (requestedFields.includes('activation_status')) fields.push('activation_status');
  if (requestedFields.includes('department_name')) fields.push('department_ids', 'department_name');
  return fields;
}

export function buildFeishuMemberProfileEvidencePrompt(
  context: Omit<FeishuMemberProfileEvidenceContext, 'prompt'>,
): string {
  const lines = [
    'Feishu group member profile evidence (official APIs, current turn):',
    '- These facts came from the current chat roster and, only for explicitly requested employee fields, Contact v3 using the application bot identity.',
    '- Do not expose platform IDs, raw API payloads, access tokens, or local commands.',
    `- 本轮明确请求字段：${context.requestedFields.map((field) => field === 'identity'
      ? '成员类型'
      : PROFILE_FIELD_LABELS[field]).join(' / ')}。只回答这些字段，禁止补查或展示未请求字段。`,
    '- 群成员身份与明确请求的员工字段优先使用应用 bot 身份；禁止为此向普通用户发起 user OAuth。',
    '- Missing scopes returned together by Feishu are compatible alternatives, not a batch request. Mention only recommendedScope as the next minimal permission.',
    '- 字段未出现在官方响应中表示“未授权”；字段已出现但值为空表示“未填写”，不得混写成“未返回”。',
    '- 单个成员或单个部门查询失败时继续处理其余目标和已验证字段；只有所有有界兼容尝试都失败后才报告未完成。',
    '- If an app scope or contact data range is missing, show facts already resolved, then present only the single prioritized next action and ask before the administrator applies it. Do not claim that permission was requested or approved.',
  ];
  const requestedFieldSet = new Set(context.requestedFields);
  const evidenceFieldSet = new Set(requestedEvidenceFields(context.requestedFields));
  for (const item of context.items) {
    if (item.status === 'resolved') {
      if (item.actorType === 'bot') {
        const suffix = context.requestedFields.some((field) => field !== 'identity')
          ? '；员工资料字段不适用，不进入员工通讯录查询'
          : '';
        lines.push(`- 机器人“${item.displayName}”：成员类型=机器人${suffix}。`);
        continue;
      }
      const facts: string[] = [];
      if (requestedFieldSet.has('identity')) facts.push('成员类型=用户');
      if (requestedFieldSet.has('department_name')) {
        facts.push(`部门=${fieldValueLabel(
          item,
          item.missingFields?.includes('department_ids') ? 'department_ids' : 'department_name',
          item.departmentNames?.length ? item.departmentNames.join(' / ') : '未填写',
        )}`);
      }
      if (requestedFieldSet.has('job_title')) {
        facts.push(`职位=${fieldValueLabel(item, 'job_title', item.jobTitle || '未填写')}`);
      }
      if (requestedFieldSet.has('activation_status')) {
        facts.push(`状态=${fieldValueLabel(item, 'activation_status', item.activationStatus === 'active'
          ? '已激活'
          : item.activationStatus === 'inactive'
            ? '未激活'
            : '未填写')}`);
      }
      const missingLabels = Array.from(new Set(
        (item.missingFields || [])
          .filter((field) => evidenceFieldSet.has(field))
          .map((field) => field === 'department_ids' ? '所属部门' : PROFILE_FIELD_LABELS[field]),
      ));
      const missingFieldText = missingLabels.length
        ? `；未授权字段=${missingLabels.join(' / ')}`
        : '';
      lines.push(`- 用户“${item.displayName}”：${facts.join('；')}${missingFieldText}。`);
      continue;
    }
    lines.push(`- “${item.displayName}”资料不可用：${item.reason || item.reasonCode || '未知原因'}。`);
  }
  for (const blocker of context.blockers) {
    lines.push(`- 群级阻塞：${blocker.reason}。`);
  }
  const nextScope = selectNextFeishuMemberProfileScope(context);
  if (nextScope) {
    lines.push(`- 当前唯一下一项权限动作：先询问管理员是否开通应用权限 ${nextScope}；本轮不得同时申请其他 scope 或扩大通讯录数据权限范围。`);
  } else {
    const dataScopeItem = context.items.find((item) => item.reasonCode === 'contact_data_scope_denied');
    if (dataScopeItem) {
      lines.push(`- 当前唯一下一项权限动作：先询问管理员是否将“${dataScopeItem.displayName}”纳入应用通讯录数据权限范围；本轮不得同时申请字段 scope。`);
    }
  }
  if (context.truncated) lines.push('- 群成员数量超过单轮安全上限；明确说明只检查了有界子集。');
  return lines.join('\n');
}
