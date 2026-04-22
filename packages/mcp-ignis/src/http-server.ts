import crypto from "node:crypto";
import http from "node:http";
import { callIgnisTool, formatToolText, IGNIS_TOOLS } from "./mcp-tools";

const port = Number(process.env.IGNIS_MCP_PORT || "8787");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown, sessionId?: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
  res.end(JSON.stringify(payload));
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const id = payload.id;
  const method = String(payload.method || "");
  const params = (payload.params ?? {}) as Record<string, unknown>;

  if (!id && method.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ignis-mcp", version: "1.0.0" },
    });
  }

  if (method === "ping") {
    return rpcResult(id, {});
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: IGNIS_TOOLS });
  }

  if (method === "tools/call") {
    const toolName = String(params.name || "");
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const payloadResult = await callIgnisTool(toolName, toolArgs);
    const text = formatToolText(payloadResult);
    return rpcResult(id, {
      content: [{ type: "text", text }],
      structuredContent: payloadResult,
    });
  }

  return rpcError(id, -32601, `Unknown method: ${method}`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,accept,mcp-session-id",
    });
    res.end();
    return;
  }

  if (req.url !== "/mcp") {
    writeJson(res, 404, { ok: false, error: "not found" });
    return;
  }

  if (req.method === "GET") {
    writeJson(res, 200, {
      ok: true,
      server: "ignis-mcp",
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  const sessionId = req.headers["mcp-session-id"]?.toString() || crypto.randomUUID();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as Record<string, unknown>;
    const result = await handleRpc(payload);
    if (!result) {
      res.writeHead(202, { "mcp-session-id": sessionId });
      res.end();
      return;
    }
    writeJson(res, 200, result, sessionId);
  } catch (error) {
    writeJson(res, 200, rpcError(null, -32000, error instanceof Error ? error.message : String(error)), sessionId);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[ignis-mcp] http://127.0.0.1:${port}/mcp`);
});
