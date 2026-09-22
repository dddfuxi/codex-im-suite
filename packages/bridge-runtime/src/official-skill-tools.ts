import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { CODEX_HOME } from './config.js';

export interface ProcessCall {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell: false;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CreateOfficialSkillDraftInput {
  name: string;
  draftRoot: string;
  displayName: string;
  description: string;
  defaultPrompt: string;
}

export interface InstallOfficialSkillInput {
  url: string;
  destinationRoot: string;
  name: string;
}

export interface OfficialSkillListItem {
  name: string;
  installed: boolean;
}

export interface SkillValidationResult {
  ok: boolean;
  summary: string;
}

export interface OfficialSkillTools {
  createDraft(input: CreateOfficialSkillDraftInput): Promise<void>;
  validate(skillDir: string): Promise<SkillValidationResult>;
  listCurated(): Promise<OfficialSkillListItem[]>;
  installFromGithub(input: InstallOfficialSkillInput): Promise<void>;
}

export interface OfficialSkillToolsOptions {
  codexHome?: string;
  pythonExe?: string;
  run?: (call: ProcessCall) => Promise<ProcessResult>;
}

/**
 * 官方系统 Skill 不属于 suite 仓库，也不保证每个 Codex Home 都复制一份。
 * 运行版可能使用隔离 Home，因此只拼一个固定路径会把“当前 Home 没有脚本”
 * 误报成工具执行失败。按受控候选根解析，并在最终错误里指出缺失能力。
 */
function resolveOfficialScript(codexHome: string, skillId: 'skill-creator' | 'skill-installer', scriptName: string): string {
  const homes = [
    codexHome,
    process.env.CODEX_HOME || '',
    path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), '.claude-to-im', 'runtime', 'codex-home-official'),
    path.join(os.homedir(), '.claude-to-im', 'runtime', 'codex-home'),
  ];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const home of homes) {
    if (!home) continue;
    for (const relative of [
      path.join('skills', '.system', skillId, 'scripts', scriptName),
      path.join('skills', skillId, 'scripts', scriptName),
    ]) {
      const candidate = path.resolve(home, relative);
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`缺少官方 ${skillId} 脚本：${scriptName}。已检查受控 Codex skill 根：${candidates.join('；')}`);
}

async function runProcess(call: ProcessCall): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(call.file, call.args, {
      cwd: call.cwd,
      env: call.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function requireSuccess(result: ProcessResult, action: string): ProcessResult {
  if (result.exitCode !== 0) {
    const summary = (result.stderr || result.stdout || `exit code ${result.exitCode}`).trim();
    throw new Error(`${action}失败：${summary}`);
  }
  return result;
}

export function createOfficialSkillTools(options: OfficialSkillToolsOptions = {}): OfficialSkillTools {
  const codexHome = path.resolve(options.codexHome || CODEX_HOME);
  const pythonExe = options.pythonExe || process.env.CTI_PYTHON_EXE || 'python';
  const run = options.run || runProcess;
  const processEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  return {
    async createDraft(input) {
      const initSkillScript = resolveOfficialScript(codexHome, 'skill-creator', 'init_skill.py');
      const result = await run({
        file: pythonExe,
        args: [
          initSkillScript,
          input.name,
          '--path',
          path.resolve(input.draftRoot),
          '--interface',
          `display_name=${input.displayName}`,
          '--interface',
          `short_description=${input.description}`,
          '--interface',
          `default_prompt=${input.defaultPrompt}`,
        ],
        env: processEnv,
        shell: false,
      });
      requireSuccess(result, '创建 Skill 草稿');
    },

    async validate(skillDir) {
      const quickValidateScript = resolveOfficialScript(codexHome, 'skill-creator', 'quick_validate.py');
      const result = await run({
        file: pythonExe,
        args: [quickValidateScript, path.resolve(skillDir)],
        env: processEnv,
        shell: false,
      });
      return {
        ok: result.exitCode === 0,
        summary: (result.stdout || result.stderr || `exit code ${result.exitCode}`).trim(),
      };
    },

    async listCurated() {
      const listSkillsScript = resolveOfficialScript(codexHome, 'skill-installer', 'list-skills.py');
      const result = requireSuccess(await run({
        file: pythonExe,
        args: [listSkillsScript, '--format', 'json'],
        env: processEnv,
        shell: false,
      }), '读取官方精选 Skill');
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error('官方精选 Skill 返回格式无效。');
      return parsed.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const value = entry as { name?: unknown; installed?: unknown };
        return typeof value.name === 'string'
          ? [{ name: value.name, installed: value.installed === true }]
          : [];
      });
    },

    async installFromGithub(input) {
      const installScript = resolveOfficialScript(codexHome, 'skill-installer', 'install-skill-from-github.py');
      const result = await run({
        file: pythonExe,
        args: [
          installScript,
          '--url', input.url,
          '--dest', path.resolve(input.destinationRoot),
          '--name', input.name,
        ],
        env: processEnv,
        shell: false,
      });
      requireSuccess(result, '安装 Skill');
    },
  };
}
