import fs from 'node:fs';
import path from 'node:path';

import type { StreamChatParams } from 'claude-to-im/host';

export interface ResolvedProviderWorkspace {
  workingDirectory?: string;
  additionalDirectories: string[];
  allowedRoots: string[];
  source: 'workspace_plan' | 'legacy_params';
}

function existingDirectory(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const resolved = path.resolve(value.trim());
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function resolvedPath(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return path.resolve(value.trim());
}

function uniqueResolvedPaths(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const resolved = resolvedPath(value);
    if (!resolved) continue;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function uniqueExistingDirectories(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const resolved = existingDirectory(value);
    if (!resolved) continue;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/**
 * workspacePlan 一旦存在就是本轮唯一事实源。旧参数只在兼容旧调用方时使用，
 * 防止全局 additionalDirectories 重新污染已经解析好的回合边界。
 */
export function resolveProviderWorkspace(
  params: Pick<StreamChatParams, 'workingDirectory' | 'additionalDirectories' | 'workspacePlan'>,
): ResolvedProviderWorkspace {
  if (params.workspacePlan) {
    // 主工作区是本轮强边界，路径无效时必须交给 Provider 明确拒绝，不能静默回退默认目录。
    const workingDirectory = resolvedPath(params.workspacePlan.primaryWorkspace.path);
    const additionalDirectories = uniqueExistingDirectories(
      params.workspacePlan.temporaryMounts.map((item) => item.path),
    ).filter((item) => item !== workingDirectory);
    return {
      workingDirectory,
      additionalDirectories,
      allowedRoots: uniqueResolvedPaths([workingDirectory, ...additionalDirectories]),
      source: 'workspace_plan',
    };
  }

  const workingDirectory = resolvedPath(params.workingDirectory);
  const additionalDirectories = uniqueExistingDirectories(params.additionalDirectories || [])
    .filter((item) => item !== workingDirectory);
  return {
    workingDirectory,
    additionalDirectories,
    allowedRoots: uniqueResolvedPaths([workingDirectory, ...additionalDirectories]),
    source: 'legacy_params',
  };
}
