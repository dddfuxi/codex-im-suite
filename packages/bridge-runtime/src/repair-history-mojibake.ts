import { loadConfig } from './config.js';
import {
  restoreHistoryMojibakeBackup,
  runHistoryMojibakeRepair,
} from './history-mojibake-repair.js';

interface CliOptions {
  ctiHome?: string;
  memoryRoot?: string;
  apply: boolean;
  json: boolean;
  restore?: string;
  channels?: string[];
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]): CliOptions {
  const channels = readOption(args, '--channels');
  return {
    ctiHome: readOption(args, '--cti-home'),
    memoryRoot: readOption(args, '--memory-root'),
    apply: args.includes('--apply'),
    json: args.includes('--json'),
    restore: readOption(args, '--restore'),
    channels: channels?.split(',').map((item) => item.trim()).filter(Boolean),
  };
}

function printTextReport(report: unknown): void {
  const data = report as Record<string, unknown>;
  const schema = String(data.schema || '');
  if (schema.endsWith('/history-mojibake-restore/v1')) {
    console.log(`历史乱码备份恢复完成：${data.restoredFileCount ?? 0} 个文件`);
    return;
  }
  console.log(`历史乱码${data.mode === 'apply' ? '修复' : '扫描'}：扫描 ${data.filesScanned ?? 0} 个文件，命中 ${data.filesWithHits ?? 0} 个文件 / ${data.hitCount ?? 0} 处`);
  console.log(`已改写文件：${data.repairedFileCount ?? 0}`);
  if (data.backupManifestPath) console.log(`回滚 manifest：${data.backupManifestPath}`);
  if (data.knowledgeRebuild) console.log('已触发知识索引重建。');
  if (data.reminderRebuild) console.log('已触发待办提醒索引重建。');
  if (typeof data.postRepairMojibakeCount === 'number') console.log(`重建后知识索引乱码分数：${data.postRepairMojibakeCount}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.restore) {
    const report = restoreHistoryMojibakeBackup(options.restore);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printTextReport(report);
    return;
  }

  const config = await loadConfig();
  const report = runHistoryMojibakeRepair({
    ctiHome: options.ctiHome,
    memoryRoot: options.memoryRoot || config.memoryRepoDir,
    apply: options.apply,
    enabledReminderChannels: options.channels || config.todoPushChannels,
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printTextReport(report);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
