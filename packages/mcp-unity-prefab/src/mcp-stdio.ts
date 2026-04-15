import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config";
import {
  annotateUnityPrefabFolder,
  recallUnityPrefabFolder,
  scanUnityPrefabFolder,
} from "./prefab-folder";

const cfg = loadConfig();

const server = new Server(
  {
    name: "unity-prefab-folder-mcp",
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
      name: "scan_unity_prefab_folder",
      description:
        "Scan a Unity Assets folder for all prefab files via an existing unity-mcp server, fetch prefab info and preview thumbnails, and persist the result as local memory.",
      inputSchema: {
        type: "object",
        properties: {
          folder_path: {
            type: "string",
            description: "Unity asset folder path, for example Assets/Prefabs",
          },
          page_size: {
            type: "integer",
            description: "Page size for asset search. Default comes from environment or 100.",
          },
          force_refresh: {
            type: "boolean",
            description: "Ignore local memory and fetch from Unity again.",
          },
        },
        required: ["folder_path"],
      },
    },
    {
      name: "recall_unity_prefab_folder",
      description:
        "Read the stored prefab memory for a Unity Assets folder.",
      inputSchema: {
        type: "object",
        properties: {
          folder_path: {
            type: "string",
            description: "Unity asset folder path, for example Assets/Prefabs",
          },
        },
        required: ["folder_path"],
      },
    },
    {
      name: "annotate_unity_prefab_folder",
      description:
        "Closed loop for Unity prefab folders: scan the folder, persist memory, render a labeled preview sheet, and return the sheet path plus structured prefab data.",
      inputSchema: {
        type: "object",
        properties: {
          folder_path: {
            type: "string",
            description: "Unity asset folder path, for example Assets/Prefabs",
          },
          output_path: {
            type: "string",
            description: "Optional PNG output path relative to project cwd",
          },
          columns: {
            type: "integer",
            description: "Optional number of columns in the preview sheet",
          },
          page_size: {
            type: "integer",
            description: "Page size for asset search. Default comes from environment or 100.",
          },
          force_refresh: {
            type: "boolean",
            description: "Ignore local memory and fetch from Unity again.",
          },
        },
        required: ["folder_path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = (args ?? {}) as Record<string, unknown>;

  try {
    if (name === "scan_unity_prefab_folder") {
      const result = await scanUnityPrefabFolder(cfg, {
        folder_path: String(input.folder_path ?? ""),
        page_size: typeof input.page_size === "number" ? input.page_size : undefined,
        force_refresh: input.force_refresh === true,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: result.count,
            prefabs: result.prefabs,
            memory: result.memory,
            from_memory: result.fromMemory,
          }, null, 2),
        }],
      };
    }

    if (name === "recall_unity_prefab_folder") {
      const memory = await recallUnityPrefabFolder(cfg, {
        folder_path: String(input.folder_path ?? ""),
      });
      if (!memory) {
        return {
          content: [{ type: "text", text: "No Unity prefab memory found for this folder" }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: memory.prefabs.length,
            memory,
            prefabs: memory.prefabs,
          }, null, 2),
        }],
      };
    }

    if (name === "annotate_unity_prefab_folder") {
      const result = await annotateUnityPrefabFolder(cfg, {
        folder_path: String(input.folder_path ?? ""),
        output_path: typeof input.output_path === "string" ? input.output_path : undefined,
        columns: typeof input.columns === "number" ? input.columns : undefined,
        page_size: typeof input.page_size === "number" ? input.page_size : undefined,
        force_refresh: input.force_refresh === true,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            output_path: result.outputPath,
            count: result.count,
            prefabs: result.prefabs,
            memory: result.memory,
            from_memory: result.fromMemory,
          }, null, 2),
        }],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Unity prefab folder MCP server failed:", error);
  process.exit(1);
});
