import type { ModelDescriptor, ProviderConfig } from "../protocol/protocol.js";
import type { ToolSpec } from "./transport.js";
import { isOpencodeEndpoint } from "./attribution.js";
import { debugOverrideActive } from "../runtime-prefs.js";
export const COMPAT_TOOL_ALIASES: Record<string, string> = { read: "file.read", shell: "shell.run" };
export function compatSlug(remoteModel: string | undefined, modelId: string): string {
  return (remoteModel ?? modelId ?? "").toLowerCase();
}
export function isCompatTarget(provider: Pick<ProviderConfig, "kind" | "baseUrl">, remoteModel: string | undefined, modelId: string): boolean {
  if (!isOpencodeEndpoint(provider.baseUrl, provider.kind)) return false;
  return compatSlug(remoteModel, modelId).endsWith("-free");
}
export function compatAliasReverse(
  model: ModelDescriptor,
  providers: ProviderConfig[],
  enabledTools: Set<string>,
): Map<string, string> | undefined {
  if (!debugOverrideActive()) return undefined;
  if (!model.providers.length) return undefined;
  const byId = new Map(providers.map((p) => [p.id, p]));
  for (const ref of model.providers) {
    const provider = byId.get(ref.id);
    if (!provider || !provider.enabled || !isCompatTarget(provider, ref.remoteModel, model.id)) return undefined;
  }
  const reverse = new Map<string, string>();
  for (const alias of Object.keys(COMPAT_TOOL_ALIASES)) {
    const real = COMPAT_TOOL_ALIASES[alias];
    if (!enabledTools.has(real)) return undefined;
    reverse.set(alias, real);
  }
  return reverse;
}
export function applyCompatAliases(specs: ToolSpec[], reverse: Map<string, string>): ToolSpec[] {
  if (!reverse.size) return specs;
  const taken = new Set(specs.map((s) => s.name));
  const out: ToolSpec[] = [];
  for (const s of specs) {
    const aliasFor = [...reverse.entries()].find(([, real]) => real === s.name)?.[0];
    if (aliasFor && !taken.has(aliasFor)) {
      taken.add(aliasFor);
      out.push({ ...s, name: aliasFor });
      continue;
    }
    out.push(s);
  }
  return out;
}