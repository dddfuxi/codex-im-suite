import express from "express";
import { getMissingKeyMessage, loadConfig } from "./config";
import { createModelClients, translateImage } from "./translate";
import type { Detail, Language } from "./config";
import { createSubjectAnnotatedImage, createObjectsAnnotatedImage } from "./annotate";
import type { AnnotationStyle } from "./annotate";
import { loadImageMemory, saveImageMemory } from "./memory";

const cfg = loadConfig();
const clients = createModelClients(cfg);
const app = express();
app.use(express.json({ limit: `${cfg.jsonLimitMb}mb` }));

function mapLegacyAnnotationType(t?: string): Detail {
  switch (t) {
    case "description":
      return "brief";
    case "analysis":
      return "standard";
    case "summary":
    case "detailed":
      return "rich";
    default:
      return "standard";
  }
}

async function handleAnnotate(
  res: express.Response,
  body: {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
    language?: Language;
    detail?: Detail;
    context?: string;
  }
) {
  const keyError = getMissingKeyMessage(cfg);
  if (keyError) return res.status(503).json({ ok: false, error: keyError });

  const result = await translateImage(cfg, clients, body);
  if ("error" in result) {
    const msg = result.error;
    const clientErr =
      msg.includes("image_url") ||
      msg.includes("image_base64") ||
      msg.includes("http") ||
      msg.includes("Provide only one");
    return res.status(clientErr ? 400 : 502).json({ ok: false, error: msg });
  }

  return res.json({
    ok: true,
    text: result.text,
    annotation: result.text,
    provider: cfg.provider,
    model: cfg.model,
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    role: "image-to-text for agents",
    provider: cfg.provider,
    hasApiKey: !getMissingKeyMessage(cfg),
    model: cfg.model,
    time: new Date().toISOString(),
  });
});

app.post("/v1/annotate", async (req, res) => {
  const body = req.body as {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
    language?: Language;
    detail?: Detail;
    context?: string;
  };
  return handleAnnotate(res, {
    image_url: body.image_url,
    image_base64: body.image_base64,
    image_path: body.image_path,
    language: body.language === "en" ? "en" : "zh",
    detail: body.detail ?? "standard",
    context: body.context,
  });
});

app.post("/api/annotate", async (req, res) => {
  const b = req.body as {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
    annotation_type?: string;
    language?: string;
    context?: string;
  };
  return handleAnnotate(res, {
    image_url: b.image_url,
    image_base64: b.image_base64,
    image_path: b.image_path,
    language: b.language === "en" ? "en" : "zh",
    detail: mapLegacyAnnotationType(b.annotation_type),
    context: b.context,
  });
});

app.post("/v1/annotate-subject", async (req, res) => {
  const body = req.body as {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
    language?: Language;
    detail?: Detail;
    context?: string;
    output_path?: string;
  };
  const result = await createSubjectAnnotatedImage(cfg, clients, {
    image_url: body.image_url,
    image_base64: body.image_base64,
    image_path: body.image_path,
    language: body.language === "en" ? "en" : "zh",
    detail: body.detail ?? "standard",
    context: body.context,
    output_path: body.output_path,
  });
  if ("error" in result) return res.status(502).json({ ok: false, error: result.error });
  return res.json({
    ok: true,
    output_path: result.outputPath,
    subject_box: result.subjectBox,
    routing: result.routing,
    provider: cfg.provider,
    model: cfg.model,
  });
});

app.post("/v1/annotate-objects", async (req, res) => {
  const body = req.body as {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
    language?: Language;
    category?: string;
    style?: string;
    context?: string;
    output_path?: string;
  };
  const keyError = getMissingKeyMessage(cfg);
  if (keyError) return res.status(503).json({ ok: false, error: keyError });
  const result = await createObjectsAnnotatedImage(cfg, clients, {
    image_url: body.image_url,
    image_base64: body.image_base64,
    image_path: body.image_path,
    language: body.language === "en" ? "en" : "zh",
    category: body.category || "buildings",
    style: (body.style === "numbered" ? "numbered" : "arrow") as AnnotationStyle,
    context: body.context,
    output_path: body.output_path,
  });
  if ("error" in result) return res.status(502).json({ ok: false, error: result.error });
  return res.json({
    ok: true,
    output_path: result.outputPath,
    count: result.objects.length,
    objects: result.objects,
    routing: result.routing,
    provider: cfg.provider,
    model: cfg.model,
  });
});

app.post("/v1/memory/remember", async (req, res) => {
  const body = req.body as {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
    note?: string;
    language?: Language;
    context?: string;
  };

  let note = body.note?.trim();
  if (!note) {
    const keyError = getMissingKeyMessage(cfg);
    if (keyError) return res.status(503).json({ ok: false, error: keyError });
    const generated = await translateImage(cfg, clients, {
      image_url: body.image_url,
      image_base64: body.image_base64,
      image_path: body.image_path,
      language: body.language === "en" ? "en" : "zh",
      detail: "rich",
      context: body.context || "请总结这张图的布局、关键区域和可复用标记，作为后续识图记忆。",
    });
    if ("error" in generated) return res.status(502).json({ ok: false, error: generated.error });
    note = generated.text;
  }

  const saved = await saveImageMemory(cfg, {
    image_url: body.image_url,
    image_base64: body.image_base64,
    image_path: body.image_path,
  }, note, "http");
  if ("error" in saved) return res.status(400).json({ ok: false, error: saved.error });
  return res.json({ ok: true, memory: saved });
});

app.post("/v1/memory/recall", async (req, res) => {
  const body = req.body as {
    image_url?: string;
    image_base64?: string;
    image_path?: string;
  };
  const memory = await loadImageMemory(cfg, {
    image_url: body.image_url,
    image_base64: body.image_base64,
    image_path: body.image_path,
  });
  if (!memory) return res.status(404).json({ ok: false, error: "No memory found for this image" });
  return res.json({ ok: true, memory });
});

app.listen(cfg.port, () => {
  console.log(`[picture-translator] http://127.0.0.1:${cfg.port}`);
  console.log(`  provider=${cfg.provider}`);
  console.log(`  POST /v1/annotate`);
  console.log(`  POST /v1/annotate-subject`);
  console.log(`  POST /v1/annotate-objects`);
  console.log(`  POST /v1/memory/remember`);
  console.log(`  POST /v1/memory/recall`);
  console.log(`  POST /api/annotate (legacy)`);
  console.log(`  GET  /health`);
  const keyError = getMissingKeyMessage(cfg);
  if (keyError) console.warn(`[picture-translator] ${keyError}`);
});
