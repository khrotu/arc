import * as vscode from "vscode";
import {
  chargeStreamContent,
  fromApiToolName,
  toApiToolName,
  toVscodeLmMessages,
  toVscodeLmTools,
  findVscodeLmModel,
  classifyVscodeLmError,
  VSCODE_LM_JUSTIFICATION,
  type StreamEvent,
  type StreamHandle,
  type StreamRequest,
  type Transport,
  type VscodeLmMessage,
} from "@arc/host";
export interface VscodeLmModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens: number;
}
export async function listVscodeLmModels(): Promise<VscodeLmModelInfo[]> {
  const models = await selectVscodeLmModels();
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    family: m.family,
    maxInputTokens: m.maxInputTokens,
  }));
}
async function selectVscodeLmModels(opts: { signal?: AbortSignal; warmupMs?: number } = {}): Promise<vscode.LanguageModelChat[]> {
  const warmupMs = opts.warmupMs ?? 4000;
  let first: readonly vscode.LanguageModelChat[];
  try {
    first = await vscode.lm.selectChatModels();
  } catch (e) {
    throw new Error(`VS Code language models are unavailable: ${(e as Error)?.message ?? e}`);
  }
  if (first.length || opts.signal?.aborted || warmupMs <= 0) return [...first];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (models: readonly vscode.LanguageModelChat[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      sub.dispose();
      resolve([...models]);
    };
    const onAbort = (): void => {
      void vscode.lm.selectChatModels().then(finish, () => finish([]));
    };
    const timer = setTimeout(() => {
      void vscode.lm.selectChatModels().then(finish, () => finish([]));
    }, warmupMs);
    const sub = vscode.lm.onDidChangeChatModels(() => {
      void vscode.lm.selectChatModels().then((models) => {
        if (models.length) finish(models);
      }, () => {});
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
export function createVscodeLmTransport(opts: { warmupMs?: number } = {}): Transport {
  return { kind: "vscode-lm", stream: (req) => streamViaVscodeLm(req, opts) };
}
interface LmDataPartFactory {
  image(data: Uint8Array, mime: string): unknown;
}
interface LmCapabilities {
  imageInput?: boolean;
  toolCalling?: boolean | number;
}
function dataPartFactory(): LmDataPartFactory | undefined {
  const api = vscode as unknown as { LanguageModelDataPart?: LmDataPartFactory };
  return typeof api.LanguageModelDataPart?.image === "function" ? api.LanguageModelDataPart : undefined;
}
function modelImageInput(model: vscode.LanguageModelChat): boolean | undefined {
  return (model as unknown as { capabilities?: LmCapabilities }).capabilities?.imageInput;
}
export async function getVscodeLmVisionSupport(
  model: import("@arc/host").ModelDescriptor,
  providerId: string,
  opts: { warmupMs?: number } = {},
): Promise<boolean> {
  const factory = dataPartFactory();
  if (!factory) return false;
  let pool: vscode.LanguageModelChat[];
  try {
    pool = await selectVscodeLmModels(opts);
  } catch {
    return false;
  }
  const remoteModel = model.providers.find((p) => p.id === providerId)?.remoteModel ?? model.id;
  const selected = findVscodeLmModel(pool, remoteModel);
  if (!selected) return false;
  return modelImageInput(selected) !== false;
}
function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}
function toApiMessages(
  msgs: VscodeLmMessage[],
  opts: { sendImages: boolean; dataParts: LmDataPartFactory | undefined },
): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  type UserContent = Parameters<typeof vscode.LanguageModelChatMessage.User>[0];
  for (const m of msgs) {
    if (m.role === "user") {
      if (m.toolResults?.length) {
        out.push(
          vscode.LanguageModelChatMessage.User(
            m.toolResults.map(
              (r) => new vscode.LanguageModelToolResultPart(r.callId, [new vscode.LanguageModelTextPart(r.content)]),
            ),
          ),
        );
      } else if (opts.sendImages && opts.dataParts && m.images?.length) {
        const parts: unknown[] = [];
        if (m.text) parts.push(new vscode.LanguageModelTextPart(m.text));
        for (const img of m.images) {
          try {
            parts.push(opts.dataParts.image(Buffer.from(img.base64, "base64"), img.mimeType));
          } catch {}
        }
        if (!parts.length) continue;
        out.push(vscode.LanguageModelChatMessage.User(parts as UserContent));
      } else {
        out.push(vscode.LanguageModelChatMessage.User(m.text));
      }
      continue;
    }
    const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
    if (m.text) parts.push(new vscode.LanguageModelTextPart(m.text));
    for (const tc of m.toolCalls ?? []) {
      parts.push(new vscode.LanguageModelToolCallPart(tc.id, toApiToolName(tc.name), tc.args));
    }
    if (!parts.length) continue;
    out.push(
      parts.length === 1 && parts[0] instanceof vscode.LanguageModelTextPart
        ? vscode.LanguageModelChatMessage.Assistant(m.text)
        : vscode.LanguageModelChatMessage.Assistant(parts),
    );
  }
  return out;
}
async function streamViaVscodeLm(req: StreamRequest, opts: { warmupMs?: number } = {}): Promise<StreamHandle> {
  const remoteModel = req.model.providers.find((p) => p.id === req.provider.id)?.remoteModel ?? req.model.id;
  const pool = await selectVscodeLmModels({ signal: req.signal ?? undefined, warmupMs: opts.warmupMs });
  if (req.signal?.aborted) throw abortError();
  if (!pool.length) {
    throw new Error(
      "No VS Code language models available. Install and enable the GitHub Copilot Chat extension " +
        "(chat models come from Copilot Chat, not the inline-suggestions extension), sign in with an active " +
        "Copilot subscription, then retry.",
    );
  }
  const model = findVscodeLmModel(pool, remoteModel);
  if (!model) {
    const available = pool.map((m) => m.id).slice(0, 8).join(", ") + (pool.length > 8 ? ", ..." : "");
    throw new Error(
      `VS Code language model '${remoteModel}' was not found. Available: ${available}. ` +
        "Refresh the model catalog (Settings > Models) and rebind the model.",
    );
  }
  const dataParts = dataPartFactory();
  const apiMessages = toApiMessages(toVscodeLmMessages(req.messages), {
    sendImages: dataParts !== undefined && modelImageInput(model) !== false,
    dataParts,
  });
  if (!apiMessages.length) throw new Error("No VS Code language model prompt to send: the message history is empty.");
  const tools = toVscodeLmTools(req.tools)?.map((t) => ({
    name: t.name,
    description: t.description,
    ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
  }));
  const cts = new vscode.CancellationTokenSource();
  const onAbort = (): void => {
    try {
      cts.cancel();
    } catch {}
  };
  req.signal?.addEventListener("abort", onAbort, { once: true });
  let response: vscode.LanguageModelChatResponse;
  try {
    response = await model.sendRequest(
      apiMessages,
      { justification: VSCODE_LM_JUSTIFICATION, ...(tools?.length ? { tools } : {}) },
      cts.token,
    );
  } catch (e) {
    req.signal?.removeEventListener("abort", onAbort);
    try {
      cts.dispose();
    } catch {}
    throw new Error(classifyVscodeLmError(e).message);
  }
  let aborted = false;
  const events = (async function* (): AsyncGenerator<StreamEvent> {
    const budget = { bytes: 0 };
    let text = "";
    try {
      for await (const part of response.stream) {
        if (aborted) return;
        if (part instanceof vscode.LanguageModelTextPart) {
          if (!part.value) continue;
          chargeStreamContent(budget, part.value);
          text += part.value;
          yield { type: "text", delta: part.value };
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          yield {
            type: "tool_call",
            id: part.callId,
            name: fromApiToolName(part.name),
            args: (part.input ?? {}) as Record<string, unknown>,
          };
        }
      }
    } catch (e) {
      if (!aborted) yield { type: "error", message: classifyVscodeLmError(e).message };
      return;
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      try {
        cts.dispose();
      } catch {}
    }
    let prompt = 0;
    let completion = 0;
    for (const m of apiMessages) {
      try {
        prompt += await model.countTokens(m);
      } catch {}
    }
    if (text) {
      try {
        completion = await model.countTokens(text);
      } catch {}
    }
    yield { type: "usage", usage: { prompt, completion, thinking: 0, cost: 0 } };
    yield { type: "done" };
  })();
  return {
    events,
    abort: () => {
      aborted = true;
      onAbort();
    },
  };
}