export interface SuggestionItem {
  kind: "mcp" | "tool" | "skill" | "rule" | "memory";
  id: string;
  label: string;
  detail?: string;
  tokens: number;
  idleMs?: number;
  unload: { action: "disableMcp" | "disableTool" | "dismiss"; target: string };
}
export function estimateTokensForText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
export function mcpTokens(toolCount: number): number {
  return 150 + toolCount * 500;
}
export function idleSuggestions(
  items: SuggestionItem[],
  opts: { idleThresholdMs?: number; minTokens?: number } = {},
): SuggestionItem[] {
  const idleThresholdMs = opts.idleThresholdMs ?? 30 * 60 * 1000;
  const minTokens = opts.minTokens ?? 100;
  return items
    .filter((i) => i.tokens >= minTokens && (i.idleMs ?? Date.now() - sessionStart) >= idleThresholdMs)
    .sort((a, b) => b.tokens - a.tokens);
}
export function formatTokenSave(tokens: number): string {
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k tokens`;
  return `~${tokens} tokens`;
}
const lastUsed = new Map<string, number>();
const useCounts = new Map<string, number>();
const MAX_TRACKED_KEYS = 5000;
let sessionStart = Date.now();
export function markUsed(kind: string, id: string): void {
  const key = `${kind}:${id}`;
  lastUsed.set(key, Date.now());
  useCounts.set(key, (useCounts.get(key) ?? 0) + 1);
  if (lastUsed.size > MAX_TRACKED_KEYS) {
    const oldest = lastUsed.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      lastUsed.delete(oldest);
      useCounts.delete(oldest);
    }
  }
}
export function idleMsFor(kind: string, id: string): number | undefined {
  const t = lastUsed.get(`${kind}:${id}`);
  if (t === undefined) return undefined;
  return Date.now() - t;
}
export function useCountFor(kind: string, id: string): number {
  return useCounts.get(`${kind}:${id}`) ?? 0;
}
export function resetUsageTracking(): void {
  lastUsed.clear();
  useCounts.clear();
  sessionStart = Date.now();
}
export function sessionAgeMs(): number {
  return Date.now() - sessionStart;
}