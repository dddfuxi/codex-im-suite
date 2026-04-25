import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessExecutorInteraction,
  assessIgnisInteraction,
  assessMcpInteraction,
  canExecuteMutatingFastPath,
  getExecutorCommandRisk,
  inferIgnisFastIntent,
  inferMcpFastIntent,
} from '../fast-path-intent.js';

describe('Ignis fast-path 判定', () => {
  it('把最近几次整理请求判为历史查询', () => {
    const prompt = '检查最近几次的Ignis，整理成列表发我';
    const assessment = assessIgnisInteraction(prompt, false);
    assert.equal(assessment.interactionIntent, 'query');
    assert.equal(inferIgnisFastIntent(prompt, false, assessment), 'history');
  });

  it('把安装可用性问题判为状态查询', () => {
    const prompt = 'Ignis安装好了吗';
    const assessment = assessIgnisInteraction(prompt, false);
    assert.equal(assessment.interactionIntent, 'query');
    assert.equal(inferIgnisFastIntent(prompt, false, assessment), 'status');
  });

  it('把重发上次模型判为结果回传', () => {
    const prompt = '再发我一下上次Ignis生成的模型文件';
    const assessment = assessIgnisInteraction(prompt, false);
    assert.equal(assessment.interactionIntent, 'query');
    assert.equal(inferIgnisFastIntent(prompt, false, assessment), 'result');
  });

  it('只在明确生成时返回 generate', () => {
    const prompt = '用 Ignis 生成一张写实桌子';
    const assessment = assessIgnisInteraction(prompt, false);
    assert.equal(assessment.interactionIntent, 'action');
    assert.equal(inferIgnisFastIntent(prompt, false, assessment), 'generate');
  });
});

describe('MCP fast-path 判定', () => {
  it('把状态请求留在只读查询', () => {
    const prompt = '检查一下 Unity MCP 状态';
    const assessment = assessMcpInteraction(prompt);
    assert.equal(assessment.interactionIntent, 'query');
    assert.equal(inferMcpFastIntent(prompt, assessment), 'status');
  });

  it('把启动请求判为 action', () => {
    const prompt = '把 Blender MCP 启动一下';
    const assessment = assessMcpInteraction(prompt);
    assert.equal(assessment.interactionIntent, 'action');
    assert.equal(inferMcpFastIntent(prompt, assessment), 'start');
  });

  it('泛指 MCP 时只给状态帮助，不视为启动', () => {
    const prompt = '看看 MCP';
    const assessment = assessMcpInteraction(prompt);
    assert.equal(assessment.interactionIntent, 'query');
    assert.equal(inferMcpFastIntent(prompt, assessment), 'status');
  });

  it('Unity 场景节点分析不走本地 MCP 状态快路径', () => {
    const prompt = '帮我用unitymcp看一眼unity里，HSScene的Furniture_前缀的家具节点都代表什么，分析一下整理一份列表发我';
    const assessment = assessMcpInteraction(prompt);
    assert.equal(inferMcpFastIntent(prompt, assessment), null);
  });
});

describe('本地执行器判定', () => {
  it('允许 git status 作为只读查询', () => {
    const prompt = '看看 git status';
    const assessment = assessExecutorInteraction(prompt);
    assert.equal(assessment.interactionIntent, 'query');
    assert.equal(assessment.executionRisk, 'read_only');
    assert.equal(getExecutorCommandRisk('git status -sb'), 'read_only');
    assert.equal(canExecuteMutatingFastPath(assessment), false);
  });

  it('只在明确动作下允许 pull', () => {
    const prompt = '帮我 pull';
    const assessment = assessExecutorInteraction(prompt);
    assert.equal(assessment.interactionIntent, 'action');
    assert.equal(assessment.executionRisk, 'mutating');
    assert.equal(canExecuteMutatingFastPath(assessment), true);
  });

  it('对要不要 pull 这种问句不直接执行', () => {
    const prompt = '检查一下要不要 pull';
    const assessment = assessExecutorInteraction(prompt);
    assert.equal(assessment.interactionIntent, 'query');
    assert.equal(assessment.executionRisk, 'mutating');
    assert.equal(canExecuteMutatingFastPath(assessment), false);
  });

  it('把中文 git 状态/分支/提交查询判为只读', () => {
    const statusAssessment = assessExecutorInteraction('帮我看看 git 状态');
    assert.equal(statusAssessment.interactionIntent, 'query');
    assert.equal(statusAssessment.executionRisk, 'read_only');

    const branchAssessment = assessExecutorInteraction('当前分支是什么');
    assert.equal(branchAssessment.interactionIntent, 'query');
    assert.equal(branchAssessment.executionRisk, 'read_only');

    const logAssessment = assessExecutorInteraction('最近几条提交');
    assert.equal(logAssessment.interactionIntent, 'query');
    assert.equal(logAssessment.executionRisk, 'read_only');
  });
});
