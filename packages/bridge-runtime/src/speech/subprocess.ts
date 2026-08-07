import { spawn } from 'node:child_process';

export async function runNoShell(
  executable: string,
  argv: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const maxBytes = options.maxOutputBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('request_aborted'));
    const child = spawn(executable, [...argv], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    });
    // 新版 @types/node 会区分 Buffer 的 ArrayBuffer 泛型；使用默认宽类型兼容
    // alloc 与 concat 的合法返回值，同时继续执行有界截断。
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    const append = (current: Buffer, chunk: Buffer) => current.length >= maxBytes
      ? current
      : Buffer.concat([current, chunk.subarray(0, maxBytes - current.length)]);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      callback();
    };
    const stop = () => { if (!child.killed) child.kill('SIGKILL'); };
    const abort = () => {
      stop();
      finish(() => reject(new Error('request_aborted')));
    };
    const timeout = setTimeout(() => {
      stop();
      finish(() => reject(new Error('process_timeout')));
    }, options.timeoutMs);
    timeout.unref?.();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => resolve({
      code: code ?? -1,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
    })));
  });
}
