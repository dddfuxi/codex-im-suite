import path from "node:path";
import process from "node:process";
import { getMissingKeyMessage, loadConfig, type Detail, type Language } from "./config";
import { createObjectsAnnotatedImage, createSubjectAnnotatedImage, type AnnotationStyle } from "./annotate";
import { createModelClients, translateImage } from "./translate";
import { loadImageMemory, saveImageMemory } from "./memory";

type Command =
  | "describe"
  | "subject"
  | "objects"
  | "remember"
  | "recall";

interface ParsedArgs {
  command: Command;
  imagePath: string;
  outputPath?: string;
  language: Language;
  detail: Detail;
  context?: string;
  note?: string;
  category: string;
  style: AnnotationStyle;
}

function printHelp(): void {
  console.log(`
MCP-for-Picture CLI

Usage:
  npm run cli -- describe --image <path> [--language zh|en] [--detail brief|standard|rich] [--context "..."]
  npm run cli -- subject --image <path> [--output <path>] [--language zh|en] [--detail brief|standard|rich] [--context "..."]
  npm run cli -- objects --image <path> [--output <path>] [--category <name>] [--style arrow|numbered] [--language zh|en]
  npm run cli -- remember --image <path> [--note "..."] [--context "..."]
  npm run cli -- recall --image <path>
`.trim());
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const [commandRaw, ...rest] = argv;
  if (!commandRaw || commandRaw === "--help" || commandRaw === "-h") {
    return { error: "help" };
  }

  const commands: Command[] = ["describe", "subject", "objects", "remember", "recall"];
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

  const imagePath = args.get("image")?.trim();
  if (!imagePath) return { error: "--image is required" };

  const detailRaw = args.get("detail")?.trim();
  const detail: Detail =
    detailRaw === "brief" || detailRaw === "rich" ? detailRaw : "standard";
  const styleRaw = args.get("style")?.trim();
  const style: AnnotationStyle = styleRaw === "numbered" ? "numbered" : "arrow";

  return {
    command: commandRaw as Command,
    imagePath,
    outputPath: args.get("output")?.trim(),
    language: args.get("language") === "en" ? "en" : "zh",
    detail,
    context: args.get("context")?.trim(),
    note: args.get("note")?.trim(),
    category: args.get("category")?.trim() || "buildings",
    style,
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
  const clients = createModelClients(cfg);
  const imagePath = path.resolve(process.cwd(), parsed.imagePath);

  if (parsed.command === "describe") {
    const keyError = getMissingKeyMessage(cfg);
    if (keyError) {
      console.error(keyError);
      process.exit(2);
    }
    const result = await translateImage(cfg, clients, {
      image_path: imagePath,
      language: parsed.language,
      detail: parsed.detail,
      context: parsed.context,
    });
    if ("error" in result) {
      console.error(result.error);
      process.exit(3);
    }
    console.log(result.text);
    return;
  }

  if (parsed.command === "remember") {
    let note = parsed.note;
    if (!note) {
      const keyError = getMissingKeyMessage(cfg);
      if (keyError) {
        console.error(`--note is required when no model provider is configured: ${keyError}`);
        process.exit(2);
      }
      const generated = await translateImage(cfg, clients, {
        image_path: imagePath,
        language: parsed.language,
        detail: "rich",
        context: parsed.context || "Summarize the reusable layout and key regions in this image.",
      });
      if ("error" in generated) {
        console.error(generated.error);
        process.exit(3);
      }
      note = generated.text;
    }

    const saved = await saveImageMemory(cfg, { image_path: imagePath }, note, "cli");
    if ("error" in saved) {
      console.error(saved.error);
      process.exit(3);
    }
    console.log(JSON.stringify({ ok: true, memory: saved }, null, 2));
    return;
  }

  if (parsed.command === "recall") {
    const memory = await loadImageMemory(cfg, { image_path: imagePath });
    if (!memory) {
      console.error("No memory found for this image");
      process.exit(4);
    }
    console.log(JSON.stringify({ ok: true, memory }, null, 2));
    return;
  }

  if (parsed.command === "subject") {
    const result = await createSubjectAnnotatedImage(cfg, clients, {
      image_path: imagePath,
      language: parsed.language,
      detail: parsed.detail,
      context: parsed.context,
      output_path: parsed.outputPath,
    });
    if ("error" in result) {
      console.error(result.error);
      process.exit(3);
    }
    console.log(JSON.stringify({
      ok: true,
      output_path: result.outputPath,
      subject_box: result.subjectBox,
      routing: result.routing,
    }, null, 2));
    return;
  }

  const keyError = getMissingKeyMessage(cfg);
  if (keyError) {
    console.error(keyError);
    process.exit(2);
  }

  const result = await createObjectsAnnotatedImage(cfg, clients, {
    image_path: imagePath,
    language: parsed.language,
    category: parsed.category,
    context: parsed.context,
    style: parsed.style,
    output_path: parsed.outputPath,
  });
  if ("error" in result) {
    console.error(result.error);
    process.exit(3);
  }
  console.log(JSON.stringify({
    ok: true,
    output_path: result.outputPath,
    count: result.objects.length,
    objects: result.objects,
    routing: result.routing,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(10);
});
