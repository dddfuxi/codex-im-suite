import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const sharedExternals = [
  // SDKs must stay external because they resolve their own CLI/runtime files.
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
  'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
  'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
  'node:*',
];

const sharedBanner = { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" };

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/agent-workers/worker-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/agent-worker.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/memory-optimizer-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/memory-optimizer-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/skill-lifecycle-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/skill-lifecycle-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/memory-layout-migration-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/memory-layout-migration-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/scheduled-task-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/scheduled-task-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/memory-item-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/memory-item-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/sticker-semantic-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/sticker-semantic-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/cleanup-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cleanup-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/active-reply-control-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/active-reply-control-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: ['src/speech/speech-control-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/speech-control-cli.mjs',
  external: sharedExternals,
  banner: sharedBanner,
});

// Python Sidecar 只发布白名单源码；先清理旧目录，避免本机 __pycache__/.pyc 或历史文件残留进 dist/live。
const speechSidecarSource = 'src/speech/sidecar';
const speechSidecarTarget = 'dist/speech-sidecar';
const speechSidecarFiles = ['runtime_server.py', 'backends.py', 'requirements.txt'];
fs.rmSync(speechSidecarTarget, { recursive: true, force: true });
fs.mkdirSync(speechSidecarTarget, { recursive: true });
for (const fileName of speechSidecarFiles) {
  const sourcePath = `${speechSidecarSource}/${fileName}`;
  const targetPath = `${speechSidecarTarget}/${fileName}`;
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe speech sidecar resource: ${fileName}`);
  fs.copyFileSync(sourcePath, targetPath);
}
const publishedSpeechFiles = fs.readdirSync(speechSidecarTarget, { recursive: true, withFileTypes: true });
if (publishedSpeechFiles.some((entry) => entry.name === '__pycache__' || entry.name.endsWith('.pyc'))) {
  throw new Error('Speech sidecar build contains forbidden Python cache files');
}
fs.copyFileSync('src/speech/managed-dependencies.json', 'dist/speech-managed-dependencies.json');

// esbuild 能生成包含重复顶层标识符的 ESM 文本，但不会执行 Node 的最终语法解析。
// 对所有运行入口补一次 `node --check`，避免 bundle 构建成功、live 重启后才暴露语法错误。
for (const bundle of [
  'dist/daemon.mjs',
  'dist/agent-worker.mjs',
  'dist/memory-optimizer-cli.mjs',
  'dist/skill-lifecycle-cli.mjs',
  'dist/memory-layout-migration-cli.mjs',
  'dist/scheduled-task-cli.mjs',
  'dist/active-reply-control-cli.mjs',
  'dist/memory-item-cli.mjs',
  'dist/sticker-semantic-cli.mjs',
  'dist/cleanup-cli.mjs',
  'dist/speech-control-cli.mjs',
]) {
  const checked = spawnSync(process.execPath, ['--check', bundle], { stdio: 'inherit' });
  if (checked.status !== 0) {
    throw new Error(`Bundle syntax check failed: ${bundle}`);
  }
}

console.log('Built daemon, agent worker, speech control, memory optimizer, memory item, sticker semantic, memory layout migration, workspace cleanup, skill lifecycle, scheduled task, and active reply control CLI bundles');
