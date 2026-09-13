import * as vscode from "vscode";
import * as path from "node:path";
export interface DiagnosticLite {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}
export class LspBridge {
  constructor(public root: string) {}
  async allProblems(): Promise<DiagnosticLite[]> {
    const out: DiagnosticLite[] = [];
    const MAX = 500;
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        out.push(toLite(uri, d));
        if (out.length >= MAX) break;
      }
      if (out.length >= MAX) break;
    }
    out.sort((a, b) => {
      const sev = severityRank(b.severity) - severityRank(a.severity);
      if (sev) return sev;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });
    return out;
  }
  async problemsFor(file: string): Promise<DiagnosticLite[]> {
    const abs = path.isAbsolute(file) ? path.normalize(file) : path.normalize(path.join(this.root, file));
    const rel = path.relative(this.root, abs);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return [];
    const uri = vscode.Uri.file(abs);
    const diags = vscode.languages.getDiagnostics(uri);
    return diags.map((d) => toLite(uri, d));
  }
  async summaryForFiles(files: string[]): Promise<{ hasErrors: boolean; hasWarnings: boolean; text: string }> {
    if (files.length === 0) return { hasErrors: false, hasWarnings: false, text: "" };
    const all: DiagnosticLite[] = [];
    for (const f of files) all.push(...(await this.problemsFor(f)));
    if (all.length === 0) return { hasErrors: false, hasWarnings: false, text: "" };
    const hasErrors = all.some((d) => d.severity === "error");
    const hasWarnings = all.some((d) => d.severity === "warning");
    const MAX_LINES = 200;
    const shown = all.slice(0, MAX_LINES);
    const lines = shown.map((d) => `  - [${d.severity}] ${d.file}:${d.line}:${d.column}  ${d.message}${d.source ? `  (${d.source})` : ""}`);
    if (all.length > shown.length) lines.push(`  ... and ${all.length - shown.length} more (truncated)`);
    const header = hasErrors
      ? `LSP reported ${all.length} problem(s) in the file(s) you just edited. Fix the errors before continuing:`
      : `LSP reported ${all.length} warning(s)/info in the file(s) you just edited. Review and address if relevant:`;
    return { hasErrors, hasWarnings, text: `${header}\n${lines.join("\n")}` };
  }
}
function toLite(uri: vscode.Uri, d: vscode.Diagnostic): DiagnosticLite {
  return {
    file: vscode.workspace.asRelativePath(uri),
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: severityName(d.severity),
    message: d.message,
    source: d.source,
    code: typeof d.code === "object" && d.code ? d.code.value : (d.code as string | number | undefined),
  };
}
function severityName(s: vscode.DiagnosticSeverity | undefined): DiagnosticLite["severity"] {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return "error";
    case vscode.DiagnosticSeverity.Warning: return "warning";
    case vscode.DiagnosticSeverity.Information: return "info";
    case vscode.DiagnosticSeverity.Hint: return "hint";
    default: return "info";
  }
}
function severityRank(s: DiagnosticLite["severity"]): number {
  return s === "error" ? 4 : s === "warning" ? 3 : s === "info" ? 2 : 1;
}