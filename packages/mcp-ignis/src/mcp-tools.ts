import {
  ignisAsk,
  ignisHistory,
  ignisResult,
  ignisResume,
  ignisSkills,
  ignisUpload,
  ignisWait,
  type IgnisAskInput,
  type IgnisHistoryInput,
  type IgnisResultInput,
  type IgnisResumeInput,
  type IgnisSkillsInput,
  type IgnisUploadInput,
  type IgnisWaitInput,
} from "./ignis";

export const IGNIS_TOOLS = [
  {
    name: "ignis_ask",
    description: "Submit a creative Ignis request. Asset generation should normally use async=true and return turn/session/canvas/file ids.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        async: { type: "boolean", default: true },
        new_session: { type: "boolean" },
        session_id: { type: "string" },
        canvas_id: { type: "string" },
        agent: { type: "string" },
        file_ids: { type: "array", items: { type: "string" } },
        attachments: { type: "array", items: { type: "string" } },
        wait_ms: { type: "integer" },
        timeout_ms: { type: "integer" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "ignis_result",
    description: "Fetch the current result snapshot by turn_id or session_id.",
    inputSchema: {
      type: "object",
      properties: {
        turn_id: { type: "string" },
        session_id: { type: "string" }
      }
    }
  },
  {
    name: "ignis_wait",
    description: "Wait for a turn or session latest turn to reach a terminal state.",
    inputSchema: {
      type: "object",
      properties: {
        turn_id: { type: "string" },
        session_id: { type: "string" },
        timeout_ms: { type: "integer" }
      }
    }
  },
  {
    name: "ignis_upload",
    description: "Upload a local file and return Ignis file_id.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  },
  {
    name: "ignis_history",
    description: "Read Ignis session history.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        messages: { type: "boolean" },
        all: { type: "boolean" }
      }
    }
  },
  {
    name: "ignis_skills",
    description: "List or search visible Ignis internal skills.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" }
      }
    }
  },
  {
    name: "ignis_resume",
    description: "Resume or cancel an interrupted Ignis turn.",
    inputSchema: {
      type: "object",
      properties: {
        turn_id: { type: "string" },
        answers: { type: "array", items: { type: "string" } },
        payload: { type: "string" },
        cancel: { type: "boolean" },
        async: { type: "boolean" },
        wait_ms: { type: "integer" },
        timeout_ms: { type: "integer" }
      },
      required: ["turn_id"]
    }
  }
];

export async function callIgnisTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (name) {
    case "ignis_ask":
      return ignisAsk(args as IgnisAskInput);
    case "ignis_result":
      return ignisResult(args as IgnisResultInput);
    case "ignis_wait":
      return ignisWait(args as IgnisWaitInput);
    case "ignis_upload":
      return ignisUpload(args as IgnisUploadInput);
    case "ignis_history":
      return ignisHistory(args as IgnisHistoryInput);
    case "ignis_skills":
      return ignisSkills(args as IgnisSkillsInput);
    case "ignis_resume":
      return ignisResume(args as IgnisResumeInput);
    default:
      throw new Error(`Unknown Ignis tool: ${name}`);
  }
}

export function formatToolText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
