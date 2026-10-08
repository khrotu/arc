import { TOOL_PRESETS } from "../modes/tool-presets.js";
export const SEARCH_TOOL_NAME = "tool.search";
export const DISCOVERY_EXCLUDED = new Set(["subagent.askParent", SEARCH_TOOL_NAME]);
export function coreToolNames(): Set<string> {
  return new Set(TOOL_PRESETS.find((p) => p.id === "balanced")?.enabled ?? []);
}
export interface DiscoverableTool {
  name: string;
  description: string;
  params: { names: string[]; text: string };
}
export interface DiscoveryMatch {
  name: string;
  score: number;
}
export function scoreDiscoveryPool(query: string, pool: DiscoverableTool[], limit = 5): DiscoveryMatch[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const scored: DiscoveryMatch[] = [];
  for (const tool of pool) {
    const nameLower = tool.name.toLowerCase();
    const nameParts = nameLower.split(/[^a-z0-9]+/);
    const descLower = tool.description.toLowerCase();
    const paramsLower = tool.params.text.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (nameParts.includes(t)) {
        score += 3;
        continue;
      }
      if (t.length < 3) continue;
      if (nameLower.includes(t)) score += 3;
      else if (nameParts.some((p) => p.startsWith(t) || t.startsWith(p))) score += 2;
      if (descLower.includes(t)) score += 2;
      if (tool.params.names.some((n) => n.toLowerCase().includes(t))) score += 1;
      else if (paramsLower.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ name: tool.name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, Math.min(limit, 8)));
}