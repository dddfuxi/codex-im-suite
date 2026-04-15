import process from "node:process";
import { loadConfig } from "./config";
import {
  annotateUnityPrefabFolder,
  recallUnityPrefabFolder,
  scanUnityPrefabFolder,
} from "./prefab-folder";

type Command =
  | "prefab-scan"
  | "prefab-annotate"
  | "prefab-recall";

interface ParsedArgs {
  command: Command;
  folderPath: string;
  outputPath?: string;
  forceRefresh: boolean;
  pageSize?: number;
  columns?: number;
}

function printHelp(): void {
  console.log(`
MCP-for-Unity-Prefab CLI

Usage:
  npm run cli -- prefab-scan --folder Assets/Prefabs [--page-size 100] [--force-refresh]
  npm run cli -- prefab-annotate --folder Assets/Prefabs [--output output/prefabs.png] [--columns 4] [--page-size 100] [--force-refresh]
  npm run cli -- prefab-recall --folder Assets/Prefabs
`.trim());
}

function parseBooleanFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["true", "1", "yes"].includes(raw.trim().toLowerCase());
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const [commandRaw, ...rest] = argv;
  if (!commandRaw || commandRaw === "--help" || commandRaw === "-h") {
    return { error: "help" };
  }

  const commands: Command[] = ["prefab-scan", "prefab-annotate", "prefab-recall"];
  if (!commands.includes(commandRaw as Command)) {
    return { error: `Unknown command: ${commandRaw}` };
  }

  const args = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = rest[index + 1] && !rest[index + 1].startsWith("--") ? rest[++index] : "true";
    args.set(key, value);
  }

  const folderPath = args.get("folder")?.trim();
  if (!folderPath) return { error: "--folder is required" };

  return {
    command: commandRaw as Command,
    folderPath,
    outputPath: args.get("output")?.trim(),
    forceRefresh: parseBooleanFlag(args.get("force-refresh")),
    pageSize: parsePositiveInt(args.get("page-size")),
    columns: parsePositiveInt(args.get("columns")),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    if (parsed.error === "help") {
      printHelp();
      process.exit(0);
    }
    console.error(parsed.error);
    printHelp();
    process.exit(1);
  }

  const cfg = loadConfig();

  if (parsed.command === "prefab-recall") {
    const memory = await recallUnityPrefabFolder(cfg, { folder_path: parsed.folderPath });
    if (!memory) {
      console.error("No Unity prefab memory found for this folder");
      process.exit(4);
    }
    console.log(JSON.stringify({ ok: true, count: memory.prefabs.length, memory, prefabs: memory.prefabs }, null, 2));
    return;
  }

  if (parsed.command === "prefab-scan") {
    const result = await scanUnityPrefabFolder(cfg, {
      folder_path: parsed.folderPath,
      page_size: parsed.pageSize,
      force_refresh: parsed.forceRefresh,
    });
    console.log(JSON.stringify({
      ok: true,
      count: result.count,
      prefabs: result.prefabs,
      memory: result.memory,
      from_memory: result.fromMemory,
    }, null, 2));
    return;
  }

  const result = await annotateUnityPrefabFolder(cfg, {
    folder_path: parsed.folderPath,
    output_path: parsed.outputPath,
    columns: parsed.columns,
    page_size: parsed.pageSize,
    force_refresh: parsed.forceRefresh,
  });
  console.log(JSON.stringify({
    ok: true,
    output_path: result.outputPath,
    count: result.count,
    prefabs: result.prefabs,
    memory: result.memory,
    from_memory: result.fromMemory,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(10);
});
