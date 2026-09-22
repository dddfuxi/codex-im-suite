import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFeishuMemberProfileEvidencePrompt,
  isFeishuMemberProfileEvidenceRequest,
  parseFeishuMemberProfileRequest,
  selectFeishuMemberProfileFieldScope,
  selectNextFeishuMemberProfileScope,
} from '../../lib/bridge/channels/feishu/members/member-profile-policy';

describe('Feishu member profile policy', () => {
  it('recognizes explicit current-group identity reads but not tutorial questions', () => {
    assert.equal(isFeishuMemberProfileEvidenceRequest('查一下群成员的身份，不能查告诉我你需要什么'), true);
    assert.equal(isFeishuMemberProfileEvidenceRequest('帮我列出群里成员的部门、职位和激活状态'), true);
    assert.equal(isFeishuMemberProfileEvidenceRequest('具体职位该怎么查'), false);
    assert.equal(isFeishuMemberProfileEvidenceRequest('机器人能不能查群成员身份'), false);
  });

  it('parses only explicitly requested fields instead of expanding identity into employee data', () => {
    assert.deepEqual(parseFeishuMemberProfileRequest('查一下群成员分别是用户还是机器人'), {
      requestedFields: ['identity'],
    });
    assert.deepEqual(parseFeishuMemberProfileRequest('列出大家的岗位和启用状态'), {
      requestedFields: ['job_title', 'activation_status'],
    });
    assert.deepEqual(parseFeishuMemberProfileRequest('查看群友所属团队'), {
      requestedFields: ['department_name'],
    });
    assert.deepEqual(parseFeishuMemberProfileRequest('群成员的部门都是什么'), {
      requestedFields: ['department_name'],
    });
    assert.deepEqual(parseFeishuMemberProfileRequest('群成员部门情况'), {
      requestedFields: ['department_name'],
    });
    assert.equal(parseFeishuMemberProfileRequest('查看群成员资料'), null);
  });

  it('keeps bot identity and one minimal app scope in the bounded prompt', () => {
    const prompt = buildFeishuMemberProfileEvidencePrompt({
      requestedFields: ['identity', 'job_title', 'activation_status', 'department_name'],
      requestedCount: 3,
      successfulCount: 2,
      failedCount: 1,
      truncated: false,
      items: [
        {
          actorType: 'user',
          displayName: '刘丹',
          status: 'resolved',
          jobTitle: '美术外包',
          departmentNames: ['GOG Global 外包'],
          activationStatus: 'active',
          userOAuthRequired: false,
        },
        {
          actorType: 'bot',
          displayName: '小虾米',
          status: 'resolved',
          activationStatus: 'unknown',
          userOAuthRequired: false,
        },
        {
          actorType: 'user',
          displayName: '小明',
          status: 'blocked',
          reasonCode: 'missing_app_scope',
          reason: '缺少应用权限',
          scopeAlternatives: ['contact:contact.base:readonly', 'contact:contact:readonly'],
          recommendedScope: 'contact:contact.base:readonly',
          userOAuthRequired: false,
        },
      ],
      blockers: [],
    });
    assert.match(prompt, /GOG Global 外包/);
    assert.match(prompt, /职位=美术外包/);
    assert.match(prompt, /小虾米.*机器人/);
    assert.match(prompt, /当前唯一下一项权限动作.*contact:contact\.base:readonly/);
    assert.doesNotMatch(prompt, /当前唯一下一项权限动作.*contact:contact:readonly/u);
    assert.match(prompt, /禁止.*user OAuth/);
  });

  it('maps missing fields to one progressive minimum scope', () => {
    assert.equal(
      selectFeishuMemberProfileFieldScope(['job_title', 'activation_status', 'department_ids']),
      'contact:user.employee:readonly',
    );
    assert.equal(
      selectFeishuMemberProfileFieldScope(['department_ids']),
      'contact:user.department:readonly',
    );
    assert.equal(
      selectFeishuMemberProfileFieldScope(['department_name']),
      'contact:department.base:readonly',
    );
  });

  it('prioritizes employee fields across members and keeps empty values distinct from missing permissions', () => {
    const context = {
      items: [
        {
          actorType: 'user' as const,
          displayName: '刘丹',
          status: 'resolved' as const,
          missingFields: ['department_ids' as const],
          recommendedScope: 'contact:user.department:readonly',
          userOAuthRequired: false as const,
        },
        {
          actorType: 'user' as const,
          displayName: '小明',
          status: 'resolved' as const,
          emptyFields: ['job_title' as const],
          missingFields: ['activation_status' as const],
          recommendedScope: 'contact:user.employee:readonly',
          userOAuthRequired: false as const,
        },
      ],
      blockers: [],
    };
    assert.equal(selectNextFeishuMemberProfileScope(context), 'contact:user.employee:readonly');
    const prompt = buildFeishuMemberProfileEvidencePrompt({
      requestedFields: ['job_title', 'activation_status', 'department_name'],
      requestedCount: 2,
      successfulCount: 2,
      failedCount: 0,
      truncated: false,
      ...context,
    });
    assert.match(prompt, /小明.*职位=未填写；状态=未授权/u);
    assert.match(prompt, /当前唯一下一项权限动作.*contact:user\.employee:readonly/u);
    assert.doesNotMatch(prompt, /当前唯一下一项权限动作.*contact:user\.department:readonly/u);
  });
});
