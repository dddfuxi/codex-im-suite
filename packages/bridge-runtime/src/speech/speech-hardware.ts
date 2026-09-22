import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export interface SpeechHardwareIdentity {
  id: string;
  gpuName?: string;
  gpuMemoryMiB?: number;
  driverVersion?: string;
}

function inspectNvidiaGpu(): Omit<SpeechHardwareIdentity, 'id'> {
  try {
    const result = spawnSync('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000 });
    if (result.status !== 0) return {};
    const [gpuName, memory, driverVersion] = String(result.stdout || '').split(/\r?\n/, 1)[0]?.split(',').map((item) => item.trim()) || [];
    const gpuMemoryMiB = Number.parseInt(memory || '', 10);
    return {
      ...(gpuName ? { gpuName } : {}),
      ...(Number.isFinite(gpuMemoryMiB) && gpuMemoryMiB > 0 ? { gpuMemoryMiB } : {}),
      ...(driverVersion ? { driverVersion } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * benchmark 期间只读取驱动公开的显存占用摘要。返回 undefined 时必须让
 * 性能门禁失败关闭，不能用 0 或模型估算值冒充真实峰值。
 */
export function readNvidiaUsedMemoryMiB(): number | undefined {
  try {
    const result = spawnSync('nvidia-smi', [
      '--query-gpu=memory.used',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000 });
    if (result.status !== 0) return undefined;
    const values = String(result.stdout || '').split(/\r?\n/u)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return values.length > 0 ? Math.max(...values) : undefined;
  } catch {
    return undefined;
  }
}

/** 只持久化不可逆硬件身份；设备名称仅用于当前面板状态，不写入模型目录。 */
export function getSpeechHardwareIdentity(): SpeechHardwareIdentity {
  const gpu = inspectNvidiaGpu();
  const stable = JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model || '',
    memory: os.totalmem(),
    gpuName: gpu.gpuName || '',
    gpuMemoryMiB: gpu.gpuMemoryMiB || 0,
    driverVersion: gpu.driverVersion || '',
  });
  return {
    id: crypto.createHash('sha256').update(stable, 'utf8').digest('hex'),
    ...gpu,
  };
}
