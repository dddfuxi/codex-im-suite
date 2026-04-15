import type { AppConfig, Detail, Language } from "../config";

export interface CustomHttpPayload {
  image_url?: string;
  image_base64?: string;
  image_path?: string;
  language: Language;
  detail: Detail;
  context?: string;
}

function readTextByPath(data: unknown, path: string): string | null {
  if (!path || !data || typeof data !== "object") return null;
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : null;
}

function parseExtraHeaders(headersJson: string | null): Record<string, string> {
  if (!headersJson) return {};
  try {
    const data = JSON.parse(headersJson) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function callCustomHttpProvider(
  cfg: AppConfig,
  payload: CustomHttpPayload
): Promise<{ text: string } | { error: string }> {
  if (!cfg.customHttpEndpoint) return { error: "CUSTOM_HTTP_ENDPOINT is not set" };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...parseExtraHeaders(cfg.customHttpHeadersJson),
  };
  if (cfg.customHttpApiKey) {
    headers.Authorization = `Bearer ${cfg.customHttpApiKey}`;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), cfg.customHttpTimeoutMs);
  try {
    const resp = await fetch(cfg.customHttpEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    const json = (await resp.json().catch(() => null)) as unknown;
    if (!resp.ok) {
      const msg = readTextByPath(json, "error") || readTextByPath(json, "message");
      return { error: msg ? `custom_http ${resp.status}: ${msg}` : `custom_http ${resp.status}` };
    }

    const text =
      readTextByPath(json, cfg.customHttpResponseField) ||
      readTextByPath(json, "text") ||
      readTextByPath(json, "annotation") ||
      readTextByPath(json, "result.text") ||
      null;
    if (!text) return { error: "custom_http response has no text field" };
    return { text: text.trim() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
