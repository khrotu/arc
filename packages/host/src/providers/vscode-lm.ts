import type { ChatMessage } from "../protocol/protocol.js";
import type { ToolSpec } from "./transport.js";
import { toApiToolName } from "./transport.js";
export type VscodeLmRole = "user" | "assistant";
export interface VscodeLmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface VscodeLmToolResult {
  callId: string;
  content: string;
}
export interface VscodeLmImage {
  mimeType: string;
  base64: string;
}
export interface VscodeLmMessage {
  role: VscodeLmRole;
  text: string;
  toolCalls?: VscodeLmToolCall[];
  toolResults?: VscodeLmToolResult[];
  images?: VscodeLmImage[];
}
export const VSCODE_LM_JUSTIFICATION =
  "Arc uses the selected VS Code language model to answer your coding request.";
const DATA_URL_IMAGE_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;
export function imagesOf(message: ChatMessage): VscodeLmImage[] {
  const out: VscodeLmImage[] = [];
  for (const img of message.images ?? []) {
    const url = img?.image_url?.url;
    if (typeof url !== "string") continue;
    const match = url.match(DATA_URL_IMAGE_RE);
    if (!match) continue;
    out.push({ mimeType: match[1].toLowerCase(), base64: match[2].replace(/\s+/g, "") });
  }
  return out;
}
export function toVscodeLmMessages(messages: ChatMessage[]): VscodeLmMessage[] {
  const out: VscodeLmMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "user", text: m.content });
      continue;
    }
    if (m.role === "user") {
      const images = imagesOf(m);
      out.push({ role: "user", text: m.content, ...(images.length ? { images } : {}) });
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls = (m.toolCalls ?? []).map((t) => ({ id: t.id, name: t.name, args: t.args }));
      if (!m.content && !toolCalls.length) continue;
      out.push({
        role: "assistant",
        text: m.content,
        ...(toolCalls.length ? { toolCalls } : {}),
      });
      continue;
    }
    if (m.role === "tool") {
      const callId = (m.toolCallId ?? "").trim();
      if (!callId) {
        out.push({ role: "user", text: `Tool output (without tool_call_id):\n${m.content}` });
        continue;
      }
      out.push({ role: "user", text: "", toolResults: [{ callId, content: m.content }] });
      continue;
    }
    out.push({ role: "user", text: (m as ChatMessage).content ?? "" });
  }
  const grouped: VscodeLmMessage[] = [];
  for (const m of out) {
    const prev = grouped[grouped.length - 1];
    if (
      prev &&
      prev.role === "user" &&
      m.role === "user" &&
      (prev.toolResults?.length ?? 0) > 0 &&
      (m.toolResults?.length ?? 0) > 0 &&
      !prev.text &&
      !m.text
    ) {
      prev.toolResults = [...(prev.toolResults ?? []), ...(m.toolResults ?? [])];
      continue;
    }
    grouped.push(m.toolResults ? { ...m, toolResults: [...m.toolResults] } : { ...m });
  }
  return grouped.filter((m) => m.text || (m.toolCalls?.length ?? 0) > 0 || (m.toolResults?.length ?? 0) > 0 || (m.images?.length ?? 0) > 0);
}
export interface VscodeLmTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}
export function toVscodeLmTools(tools?: ToolSpec[]): VscodeLmTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: toApiToolName(t.name),
    description: t.description,
    ...(t.parameters && Object.keys(t.parameters).length ? { inputSchema: t.parameters as Record<string, unknown> } : {}),
  }));
}
export interface VscodeLmSelector {
  vendor?: string;
  family?: string;
  version?: string;
  id?: string;
}
export function selectorForVscodeLm(remoteModel?: string): VscodeLmSelector {
  const slug = (remoteModel ?? "").trim();
  if (!slug) return {};
  if (!slug.includes("/")) return { id: slug };
  const [vendor, ...rest] = slug.split("/");
  const family = rest.join("/");
  if (!vendor || !family) return { id: slug };
  return { id: slug, vendor, family };
}
export interface VscodeLmModelRef {
  id: string;
  vendor: string;
  family: string;
}
export function findVscodeLmModel<T extends VscodeLmModelRef>(models: T[], remoteModel?: string): T | undefined {
  if (!models.length) return undefined;
  const slug = (remoteModel ?? "").trim();
  if (!slug) return models[0];
  const exact = models.find((m) => m.id === slug);
  if (exact) return exact;
  if (slug.includes("/")) {
    const [vendor, ...rest] = slug.split("/");
    const family = rest.join("/");
    const byParts = models.find((m) => m.vendor === vendor && m.family === family);
    if (byParts) return byParts;
  }
  return models.find((m) => m.family === slug);
}
export type VscodeLmErrorCode = "NoPermissions" | "Blocked" | "NotFound" | "Unknown";
export function classifyVscodeLmError(err: unknown): { code: VscodeLmErrorCode; message: string } {
  const raw = (err as { code?: unknown })?.code;
  const code = typeof raw === "string" ? raw : "";
  const fallback = (err as Error)?.message ?? String(err);
  if (code === "NoPermissions") {
    return {
      code,
      message:
        "VS Code denied language-model access (consent not given). Run the request as a user action, accept the VS Code consent prompt, and make sure the GitHub Copilot Chat extension is installed, enabled, and signed in.",
    };
  }
  if (code === "Blocked") {
    return {
      code,
      message:
        "VS Code language-model request was blocked (quota exceeded or policy). Wait before retrying or pick a different model.",
    };
  }
  if (code === "NotFound") {
    return {
      code,
      message:
        "The selected VS Code language model no longer exists. Refresh the model catalog (Settings > Models) and rebind the model.",
    };
  }
  return { code: "Unknown", message: fallback };
}