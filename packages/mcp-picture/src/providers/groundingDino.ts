/**
 * Grounding DINO provider (Path B)
 *
 * Calls the HuggingFace Inference API for zero-shot object detection.
 * The model accepts a list of candidate label names and returns precise
 * bounding boxes in pixel coordinates, which are then normalized to 0-1.
 *
 * Default model: IDEA-Research/grounding-dino-tiny
 * API docs: https://huggingface.co/IDEA-Research/grounding-dino-tiny
 */

interface HFDetectionItem {
  score: number;
  label: string;
  box: {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
}

export interface GroundingDinoObject {
  label: string;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Detect objects via HuggingFace Grounding DINO.
 *
 * @param imageDataUrl  - JPEG/PNG data URL of the image to analyse
 * @param imgW          - pixel width  (needed to normalise xmin/xmax)
 * @param imgH          - pixel height (needed to normalise ymin/ymax)
 * @param candidateLabels - array of label names to detect (e.g. ["lighthouse","hospital"])
 * @param hfApiKey      - HuggingFace API key (HF_API_KEY env var)
 * @param model         - HF model id (default GROUNDING_DINO_MODEL env var or tiny)
 * @param scoreThreshold - minimum confidence to keep a detection (default 0.2)
 */
export async function callGroundingDino(
  imageDataUrl: string,
  imgW: number,
  imgH: number,
  candidateLabels: string[],
  hfApiKey: string,
  model: string,
  scoreThreshold = 0.2
): Promise<GroundingDinoObject[]> {
  const base64Data = imageDataUrl.startsWith("data:")
    ? imageDataUrl.split(",")[1]
    : imageDataUrl;

  const resp = await fetch(
    `https://api-inference.huggingface.co/models/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hfApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: base64Data,
        parameters: { candidate_labels: candidateLabels },
      }),
      signal: AbortSignal.timeout(90_000),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(
      `Grounding DINO API ${resp.status}: ${errText.slice(0, 300)}`
    );
  }

  const data = (await resp.json()) as unknown;

  if (!Array.isArray(data)) {
    throw new Error(
      `Grounding DINO unexpected response (expected array, got ${typeof data})`
    );
  }

  return (data as HFDetectionItem[])
    .filter((item) => typeof item.score === "number" && item.score >= scoreThreshold)
    .map((item) => {
      const x = clamp01(item.box.xmin / imgW);
      const y = clamp01(item.box.ymin / imgH);
      const rawW = clamp01((item.box.xmax - item.box.xmin) / imgW);
      const rawH = clamp01((item.box.ymax - item.box.ymin) / imgH);
      return {
        label: String(item.label),
        box: {
          x,
          y,
          width: Math.min(rawW, 1 - x),
          height: Math.min(rawH, 1 - y),
        },
      };
    });
}
