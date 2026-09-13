export type UiFontKey = "inter" | "atkinson" | "quicksand" | "geist-sans" | "custom";
export type MonoFontKey = "jetbrains-mono" | "ibm-plex-mono" | "fira-code" | "geist-mono" | "custom";
export const UI_FONT_OPTIONS: { value: UiFontKey; label: string; cssFamily: string }[] = [
  { value: "inter", label: "Inter", cssFamily: "Inter" },
  { value: "atkinson", label: "Atkinson Hyperlegible Next", cssFamily: "Atkinson Hyperlegible Next" },
  { value: "quicksand", label: "Quicksand", cssFamily: "Quicksand" },
  { value: "geist-sans", label: "Geist Sans", cssFamily: "Geist Sans" },
];
export const MONO_FONT_OPTIONS: { value: MonoFontKey; label: string; cssFamily: string }[] = [
  { value: "jetbrains-mono", label: "JetBrains Mono", cssFamily: "JetBrains Mono" },
  { value: "ibm-plex-mono", label: "IBM Plex Mono", cssFamily: "IBM Plex Mono" },
  { value: "fira-code", label: "Fira Code", cssFamily: "Fira Code" },
  { value: "geist-mono", label: "Geist Mono", cssFamily: "Geist Mono" },
];
const UI_FALLBACK = `var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)`;
const MONO_FALLBACK = `var(--vscode-editor-fontFamily, ui-monospace, "Cascadia Code", monospace)`;
function sanitizeFamily(custom: string, fallback: string): string {
  const clean = custom.replace(/["';\\]/g, "").replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean || fallback;
}
function familyFor(key: string, custom: string, options: { value: string; cssFamily: string }[], fallback: string): string {
  if (key === "custom") return sanitizeFamily(custom, fallback);
  return options.find((o) => o.value === key)?.cssFamily || fallback;
}
export function resolveUiFont(key: string, custom: string): string {
  const family = familyFor(key, custom, UI_FONT_OPTIONS, "Atkinson Hyperlegible Next");
  return `"${family}", ${UI_FALLBACK}`;
}
export function resolveMonoFont(key: string, custom: string): string {
  const family = familyFor(key, custom, MONO_FONT_OPTIONS, "IBM Plex Mono");
  return `"${family}", ${MONO_FALLBACK}`;
}
export function applyFonts(uiKey: string, customUi: string, monoKey: string, customMono: string): void {
  const root = document.documentElement;
  root.style.setProperty("--arc-font-ui", resolveUiFont(uiKey, customUi));
  root.style.setProperty("--arc-font-mono", resolveMonoFont(monoKey, customMono));
}