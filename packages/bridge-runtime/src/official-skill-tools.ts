import { spawn } from 'node:child_process';
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
  const creatorScripts = path.join(codexHome, 'skills', '.system', 'skill-creator', 'scripts');
  const installerScripts = path.join(codexHome, 'skills', '.system', 'skill-installer', 'scripts');

  return {
    async createDraft(input) {
      const result = await run({
        file: pythonExe,
        args: [
          path.join(creatorScripts, 'init_skill.py'),
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
      const result = await run({
        file: pythonExe,
        args: [path.join(creatorScripts, 'quick_validate.py'), path.resolve(skillDir)],
        env: processEnv,
        shell: false,
      });
      return {
        ok: result.exitCode === 0,
        summary: (result.stdout || result.stderr || `exit code ${result.exitCode}`).trim(),
      };
    },

    async listCurated() {
      const result = requireSuccess(await run({
        file: pythonExe,
        args: [path.join(installerScripts, 'list-skills.py'), '--format', 'json'],
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
      const result = await run({
        file: pythonExe,
        args: [
          path.join(installerScripts, 'install-skill-from-github.py'),
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
