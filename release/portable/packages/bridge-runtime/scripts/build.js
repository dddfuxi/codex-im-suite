import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromPackageRoot = (...segments) => path.join(packageRoot, ...segments);

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
  entryPoints: [fromPackageRoot('src', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'daemon.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'agent-workers', 'worker-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'agent-worker.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'memory-optimizer-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'memory-optimizer-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'skill-lifecycle-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'skill-lifecycle-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'memory-layout-migration-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'memory-layout-migration-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'scheduled-task-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'scheduled-task-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'memory-item-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'memory-item-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'sticker-semantic-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'sticker-semantic-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'cleanup-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'cleanup-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'active-reply-control-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'active-reply-control-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

await esbuild.build({
  entryPoints: [fromPackageRoot('src', 'speech', 'speech-control-cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: fromPackageRoot('dist', 'speech-control-cli.mjs'),
  external: sharedExternals,
  banner: sharedBanner,
});

// Python Sidecar 只发布白名单源码；先清理旧目录，避免本机 __pycache__/.pyc 或历史文件残留进 dist/live。
const speechSidecarSource = fromPackageRoot('src', 'speech', 'sidecar');
const speechSidecarTarget = fromPackageRoot('dist', 'speech-sidecar');
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
fs.copyFileSync(fromPackageRoot('src', 'speech', 'managed-dependencies.json'), fromPackageRoot('dist', 'speech-managed-dependencies.json'));
fs.mkdirSync(fromPackageRoot('dist', 'managed-locks'), { recursive: true });
fs.copyFileSync(fromPackageRoot('src', 'speech', 'managed-locks', 'qwen3-tts.requirements.lock'), fromPackageRoot('dist', 'managed-locks', 'qwen3-tts.requirements.lock'));

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
  const checked = spawnSync(process.execPath, ['--check', fromPackageRoot(bundle)], { stdio: 'inherit' });
  if (checked.status !== 0) {
    throw new Error(`Bundle syntax check failed: ${bundle}`);
  }
}

console.log('Built daemon, agent worker, speech control, memory optimizer, memory item, sticker semantic, memory layout migration, workspace cleanup, skill lifecycle, scheduled task, and active reply control CLI bundles');
