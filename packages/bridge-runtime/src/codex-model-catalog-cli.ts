#!/usr/bin/env node
import { discoverCodexModelCatalog } from './codex-model-catalog.js';
import { hydrateProcessEnvironmentFromConfigFile } from './config.js';

function decodeInput(argv: string[]): Record<string, unknown> {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== '--input-json') throw new Error('模型目录参数无效');
  const decoded = Buffer.from(argv[1], 'base64url').toString('utf8');
  const value = JSON.parse(decoded) as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main(): Promise<void> {
  hydrateProcessEnvironmentFromConfigFile();
  const input = decodeInput(process.argv.slice(2));
  const request = input.request && typeof input.request === 'object' && !Array.isArray(input.request)
    ? input.request as Record<string, unknown>
    : input;
  const source = input.source === 'local_api' || input.source === 'external_api' || input.source === 'official'
    ? input.source
    : request.source === 'local_api' || request.source === 'external_api' || request.source === 'official'
      ? request.source
      : undefined;
  const configuredModel = typeof input.configuredModel === 'string'
    ? input.configuredModel
    : typeof request.configuredModel === 'string' ? request.configuredModel : undefined;
  const result = await discoverCodexModelCatalog({
    source,
    configuredModel,
    localKind: typeof request.localKind === 'string' ? request.localKind : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    protocol: 'cti-codex-model-catalog/v1',
    generatedAt: new Date().toISOString(),
    status: 'error',
    source: 'codex_app_server',
    models: [],
    configuredModel: '',
    error: '读取 Codex 模型目录失败，请检查 Codex 登录态和 app-server。',
  })}\n`);
  process.exitCode = 1;
});
