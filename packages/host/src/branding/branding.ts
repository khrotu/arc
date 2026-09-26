type LogoKind = "mono" | "pride";
interface LogoSelection {
  kind: LogoKind;
  file: "arc-logo-mono.svg" | "arc-logo-pride.svg";
  alt: string;
}
export type PrideMode = "always" | "june" | "never";
const ALT = {
  mono: "Arc",
  pride: "Arc",
} as const;
const FILE = {
  mono: "arc-logo-mono.svg",
  pride: "arc-logo-pride.svg",
} as const;
export function pickLogo(mode: PrideMode = "june", now: Date = new Date()): LogoSelection {
  let kind: LogoKind;
  if (mode === "never") kind = "mono";
  else if (mode === "always") kind = "pride";
  else kind = now.getUTCMonth() === 5 ? "pride" : "mono";
  return { kind, file: FILE[kind], alt: ALT[kind] };
}