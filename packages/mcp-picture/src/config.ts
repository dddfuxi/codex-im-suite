export type Language = "zh" | "en";
export type Detail = "brief" | "standard" | "rich";
export type Provider = "anthropic" | "openai" | "custom_http" | "codex";

/**
 * How objects are located in annotate_image_objects:
 * - "llm"          : ask LLM for raw 0-1 float coordinates (original)
 * - "grid_llm"     : overlay 10x10 grid, ask LLM for grid-cell ranges, then refine each crop (recommended)
 * - "grounding_dino": two-stage – LLM names labels, Grounding DINO locates them (Path B)
 */
export type AnnotationBackend = "auto" | "llm" | "grid_llm" | "grounding_dino";

const defaultPort = 3000;

export interface AppConfig {
  provider: Provider;
  model: string;
  maxTokens: number;
  port: number;
  jsonLimitMb: number;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  openaiBaseUrl: string | null;
  customHttpEndpoint: string | null;
  customHttpApiKey: string | null;
  customHttpHeadersJson: string | null;
  customHttpTimeoutMs: number;
  customHttpResponseField: string;
  /** Object-detection backend for annotate_image_objects */
  annotationBackend: AnnotationBackend;
  /** HuggingFace API key – required when annotationBackend=grounding_dino */
  hfApiKey: string | null;
  /** Grounding DINO model id on HuggingFace */
  groundingDinoModel: string;
  /** Local directory for image memory records */
  memoryDir: string;
  /** Upper bound for stored memory note size */
  memoryMaxStoredChars: number;
  /** Upper bound when injecting memory into prompts */
  memoryMaxPromptChars: number;
  /** Upper bound when injecting context into prompts */
  contextMaxPromptChars: number;
}

export function loadConfig(): AppConfig {
  const providerRaw = (process.env.MODEL_PROVIDER || "codex").trim().toLowerCase();
  const provider: Provider =
    providerRaw === "anthropic"
      ? "anthropic"
      : providerRaw === "custom_http"
        ? "custom_http"
      : providerRaw === "codex"
        ? "codex"
        : "openai";

  const anthropicModel =
    process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-20241022";
  const openaiModel = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
  const customHttpModel = process.env.CUSTOM_HTTP_MODEL?.trim() || "custom-http";
  const codexModel = process.env.CODEX_MODEL?.trim() || "gpt-5.4";

  const maxTokens = Math.min(
    4096,
    Math.max(128, parseInt(process.env.MODEL_MAX_TOKENS || "900", 10) || 900)
  );
  const port = parseInt(process.env.PORT || String(defaultPort), 10) || defaultPort;
  const jsonLimitMb = Math.min(
    50,
    Math.max(1, parseInt(process.env.JSON_BODY_LIMIT_MB || "20", 10) || 20)
  );

  const annotationBackendRaw = (process.env.ANNOTATION_BACKEND || "auto").trim().toLowerCase();
  const annotationBackend: AnnotationBackend =
    annotationBackendRaw === "grounding_dino"
      ? "grounding_dino"
      : annotationBackendRaw === "auto"
        ? "auto"
      : annotationBackendRaw === "grid_llm"
        ? "grid_llm"
        : "llm";

  return {
    provider,
    model:
      provider === "anthropic"
        ? anthropicModel
        : provider === "openai"
          ? openaiModel
        : provider === "codex"
          ? codexModel
          : customHttpModel,
    maxTokens,
    port,
    jsonLimitMb,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || null,
    openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || null,
    customHttpEndpoint: process.env.CUSTOM_HTTP_ENDPOINT?.trim() || null,
    customHttpApiKey: process.env.CUSTOM_HTTP_API_KEY?.trim() || null,
    customHttpHeadersJson: process.env.CUSTOM_HTTP_HEADERS_JSON?.trim() || null,
    customHttpTimeoutMs: Math.min(
      120000,
      Math.max(1000, parseInt(process.env.CUSTOM_HTTP_TIMEOUT_MS || "30000", 10) || 30000)
    ),
    customHttpResponseField: process.env.CUSTOM_HTTP_RESPONSE_FIELD?.trim() || "text",
    annotationBackend,
    hfApiKey: process.env.HF_API_KEY?.trim() || null,
    groundingDinoModel:
      process.env.GROUNDING_DINO_MODEL?.trim() || "IDEA-Research/grounding-dino-tiny",
    memoryDir: process.env.IMAGE_MEMORY_DIR?.trim() || ".picture-memory",
    memoryMaxStoredChars: Math.min(
      12000,
      Math.max(256, parseInt(process.env.IMAGE_MEMORY_MAX_STORED_CHARS || "4000", 10) || 4000)
    ),
    memoryMaxPromptChars: Math.min(
      3000,
      Math.max(128, parseInt(process.env.IMAGE_MEMORY_MAX_PROMPT_CHARS || "900", 10) || 900)
    ),
    contextMaxPromptChars: Math.min(
      4000,
      Math.max(128, parseInt(process.env.IMAGE_CONTEXT_MAX_PROMPT_CHARS || "1200", 10) || 1200)
    ),
  };
}

export function getMissingKeyMessage(cfg: AppConfig): string | null {
  if (cfg.provider === "anthropic" && !cfg.anthropicApiKey) {
    return "ANTHROPIC_API_KEY is not set (MODEL_PROVIDER=anthropic)";
  }
  if (cfg.provider === "openai" && !cfg.openaiApiKey) {
    return "OPENAI_API_KEY is not set (MODEL_PROVIDER=openai)";
  }
  if (cfg.provider === "custom_http" && !cfg.customHttpEndpoint) {
    return "CUSTOM_HTTP_ENDPOINT is not set (MODEL_PROVIDER=custom_http)";
  }
  if (cfg.provider === "codex") {
    return null;
  }
  return null;
}
