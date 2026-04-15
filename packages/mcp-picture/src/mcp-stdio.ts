import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getMissingKeyMessage, loadConfig } from "./config";
import { createModelClients, translateImage } from "./translate";
import type { Detail, Language } from "./config";
import { createSubjectAnnotatedImage, createObjectsAnnotatedImage } from "./annotate";
import type { AnnotationStyle } from "./annotate";
import { loadImageMemory, saveImageMemory } from "./memory";

const cfg = loadConfig();
const clients = createModelClients(cfg);

const server = new Server(
  {
    name: "picture-translator-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "annotate_image",
      description:
        "Translate image input into concise objective text for agent context.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "HTTP/HTTPS image URL" },
          image_base64: { type: "string", description: "Base64 or Data URL" },
          image_path: { type: "string", description: "Local image file path (absolute or relative)" },
          language: {
            type: "string",
            enum: ["zh", "en"],
            default: "zh",
          },
          detail: {
            type: "string",
            enum: ["brief", "standard", "rich"],
            default: "standard",
          },
          context: {
            type: "string",
            description: "Optional task context from agent",
          },
        },
      },
    },
    {
      name: "annotate_image_objects",
      description:
        "Detect multiple named objects in image and generate annotated PNG. The service first routes by image type, then chooses a localization strategy.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "HTTP/HTTPS image URL" },
          image_base64: { type: "string", description: "Base64 or Data URL" },
          image_path: { type: "string", description: "Local image file path" },
          category: { type: "string", description: "Object category to detect, e.g. 'buildings', 'characters', 'UI elements'. Default: buildings" },
          language: { type: "string", enum: ["zh", "en"], default: "zh" },
          context: { type: "string", description: "Optional task context or remembered guidance" },
          style: {
            type: "string",
            enum: ["arrow", "numbered"],
            description: "Rendering style: 'arrow' draws arrows+labels (default); 'numbered' draws numbered badges with a side legend panel (cleaner for dense scenes)",
          },
          output_path: { type: "string", description: "Optional output PNG path relative to project cwd" },
        },
      },
    },
    {
      name: "annotate_image_subject",
      description:
        "Analyze image, route by scene type, and generate a local annotated PNG for the main subject.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "HTTP/HTTPS image URL" },
          image_base64: { type: "string", description: "Base64 or Data URL" },
          image_path: { type: "string", description: "Local image file path (absolute or relative)" },
          language: { type: "string", enum: ["zh", "en"], default: "zh" },
          detail: { type: "string", enum: ["brief", "standard", "rich"], default: "standard" },
          context: { type: "string", description: "Optional task context from agent" },
          output_path: { type: "string", description: "Optional output PNG path, relative to project cwd" },
        },
      },
    },
    {
      name: "remember_image_layout",
      description:
        "Remember this exact image locally by fingerprint. If note is omitted, auto-generate a reusable layout memory.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "HTTP/HTTPS image URL" },
          image_base64: { type: "string", description: "Base64 or Data URL" },
          image_path: { type: "string", description: "Local image file path (absolute or relative)" },
          note: { type: "string", description: "Optional memory note" },
          language: { type: "string", enum: ["zh", "en"], default: "zh" },
          context: { type: "string", description: "Optional memory-generation context" },
        },
      },
    },
    {
      name: "recall_image_layout",
      description:
        "Recall previously remembered layout note for the same image fingerprint.",
      inputSchema: {
        type: "object",
        properties: {
          image_url: { type: "string", description: "HTTP/HTTPS image URL" },
          image_base64: { type: "string", description: "Base64 or Data URL" },
          image_path: { type: "string", description: "Local image file path (absolute or relative)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (
    name !== "annotate_image" &&
    name !== "annotate_image_subject" &&
    name !== "annotate_image_objects" &&
    name !== "remember_image_layout" &&
    name !== "recall_image_layout"
  ) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const a = (args || {}) as Record<string, unknown>;

  if (name === "recall_image_layout") {
    const memory = await loadImageMemory(cfg, {
      image_url: typeof a.image_url === "string" ? a.image_url : undefined,
      image_base64: typeof a.image_base64 === "string" ? a.image_base64 : undefined,
      image_path: typeof a.image_path === "string" ? a.image_path : undefined,
    });
    if (!memory) {
      return { content: [{ type: "text", text: "No memory found for this image" }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ memory }, null, 2) }],
    };
  }

  if (name === "remember_image_layout") {
    let note = typeof a.note === "string" ? a.note.trim() : "";
    if (!note) {
      const keyError = getMissingKeyMessage(cfg);
      if (keyError) return { content: [{ type: "text", text: keyError }], isError: true };
      const generated = await translateImage(cfg, clients, {
        image_url: typeof a.image_url === "string" ? a.image_url : undefined,
        image_base64: typeof a.image_base64 === "string" ? a.image_base64 : undefined,
        image_path: typeof a.image_path === "string" ? a.image_path : undefined,
        language: a.language === "en" ? "en" : ("zh" as Language),
        detail: "rich",
        context: typeof a.context === "string" ? a.context : "请总结这张图的布局、关键区域和可复用标记，作为后续识图记忆。",
      });
      if ("error" in generated) {
        return { content: [{ type: "text", text: generated.error }], isError: true };
      }
      note = generated.text;
    }

    const saved = await saveImageMemory(cfg, {
      image_url: typeof a.image_url === "string" ? a.image_url : undefined,
      image_base64: typeof a.image_base64 === "string" ? a.image_base64 : undefined,
      image_path: typeof a.image_path === "string" ? a.image_path : undefined,
    }, note, "mcp");
    if ("error" in saved) {
      return { content: [{ type: "text", text: saved.error }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ memory: saved }, null, 2) }],
    };
  }

  if (name === "annotate_image_objects") {
    const keyError = getMissingKeyMessage(cfg);
    if (keyError) return { content: [{ type: "text", text: keyError }], isError: true };
    const res = await createObjectsAnnotatedImage(cfg, clients, {
      image_url: typeof a.image_url === "string" ? a.image_url : undefined,
      image_base64: typeof a.image_base64 === "string" ? a.image_base64 : undefined,
      image_path: typeof a.image_path === "string" ? a.image_path : undefined,
      language: a.language === "en" ? "en" : ("zh" as Language),
      category: typeof a.category === "string" ? a.category : "buildings",
      context: typeof a.context === "string" ? a.context : undefined,
      style: (a.style === "numbered" ? "numbered" : "arrow") as AnnotationStyle,
      output_path: typeof a.output_path === "string" ? a.output_path : undefined,
    });
    if ("error" in res) return { content: [{ type: "text", text: res.error }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify({ output_path: res.outputPath, count: res.objects.length, objects: res.objects, routing: res.routing }, null, 2) }],
    };
  }

  if (name === "annotate_image_subject") {
    const subject = await createSubjectAnnotatedImage(cfg, clients, {
      image_url: typeof a.image_url === "string" ? a.image_url : undefined,
      image_base64: typeof a.image_base64 === "string" ? a.image_base64 : undefined,
      image_path: typeof a.image_path === "string" ? a.image_path : undefined,
      language: a.language === "en" ? "en" : ("zh" as Language),
      detail:
        a.detail === "brief" || a.detail === "rich"
          ? (a.detail as Detail)
          : ("standard" as Detail),
      context: typeof a.context === "string" ? a.context : undefined,
      output_path: typeof a.output_path === "string" ? a.output_path : undefined,
    });
    if ("error" in subject) {
      return {
        content: [{ type: "text", text: subject.error }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              output_path: subject.outputPath,
              subject_box: subject.subjectBox,
              routing: subject.routing,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const keyError = getMissingKeyMessage(cfg);
  if (keyError) {
    return { content: [{ type: "text", text: keyError }], isError: true };
  }

  const result = await translateImage(cfg, clients, {
    image_url: typeof a.image_url === "string" ? a.image_url : undefined,
    image_base64: typeof a.image_base64 === "string" ? a.image_base64 : undefined,
    image_path: typeof a.image_path === "string" ? a.image_path : undefined,
    language: a.language === "en" ? "en" : ("zh" as Language),
    detail:
      a.detail === "brief" || a.detail === "rich"
        ? (a.detail as Detail)
        : ("standard" as Detail),
    context: typeof a.context === "string" ? a.context : undefined,
  });

  if ("error" in result) {
    return {
      content: [{ type: "text", text: result.error }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: result.text }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  // stderr is safe for MCP boot diagnostics
  console.error("MCP server failed:", e);
  process.exit(1);
});
