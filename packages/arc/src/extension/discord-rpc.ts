import * as vscode from "vscode";
const MIN_DISPLAY_MS = 3000;
const ARC_SCHEME = "arc-agent";
let enabled = false;
let textProvider: vscode.Disposable | undefined;
let currentFile: string | undefined;
let lastEditTime = 0;
let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
let prevEditor: vscode.TextEditor | undefined;
let providerPushed = false;
export function deactivateDiscordRpcSpoof(): void {
  if (cooldownTimer) clearTimeout(cooldownTimer);
  cooldownTimer = undefined;
  enabled = false;
  if (textProvider) {
    try { textProvider.dispose(); } catch {}
    textProvider = undefined;
  }
  providerPushed = false;
  currentFile = undefined;
  prevEditor = undefined;
}
export function initDiscordRpcSpoof(context: vscode.ExtensionContext): void {
  const sync = (): void => {
    const next = vscode.workspace.getConfiguration().get<boolean>("arc.discord.spoofRpc", false);
    if (next === enabled) return;
    enabled = next;
    if (enabled) register(context);
    else if (textProvider) {
      if (cooldownTimer) clearTimeout(cooldownTimer);
      cooldownTimer = undefined;
      try { textProvider.dispose(); } catch {}
      textProvider = undefined;
      providerPushed = false;
      currentFile = undefined;
      prevEditor = undefined;
    }
  };
  enabled = vscode.workspace.getConfiguration().get<boolean>("arc.discord.spoofRpc", false);
  if (enabled) register(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("arc.discord.spoofRpc")) sync();
  }));
}
function register(context: vscode.ExtensionContext): void {
  if (textProvider) return;
  textProvider = vscode.workspace.registerTextDocumentContentProvider(ARC_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const rel = decodeURIComponent(uri.path).replace(/^\//, "").replace(/\\/g, "/");
      return `# ${rel}\n\nArc agent is working with this file.`;
    },
  });
  if (!providerPushed) {
    context.subscriptions.push(textProvider);
    providerPushed = true;
  }
}
export function reportAgentActivity(type: "edit" | "think", filePath?: string): void {
  if (!enabled || !textProvider) return;
  if (type === "edit" && filePath) {
    lastEditTime = Date.now();
    if (currentFile !== filePath) {
      currentFile = filePath;
      showFile(filePath);
    }
  } else if (type === "think") {
    const elapsed = Date.now() - lastEditTime;
    if (elapsed < MIN_DISPLAY_MS) {
      if (cooldownTimer) clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(() => showFile(currentFile), MIN_DISPLAY_MS - elapsed);
    } else {
      showFile(currentFile);
    }
  }
}
export function reportAgentIdle(): void {
  if (!enabled) return;
  currentFile = undefined;
  showFile(undefined);
}
async function showFile(filePath?: string): Promise<void> {
  const rel = filePath ? filePath.replace(/\\/g, "/") : "idle";
  const uri = vscode.Uri.from({ scheme: ARC_SCHEME, path: `/${rel}` });
  try {
    if (prevEditor && prevEditor.document.uri.toString() !== uri.toString()) {
      const tab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => (t.input as { uri?: vscode.Uri })?.uri?.toString() === prevEditor!.document.uri.toString());
      if (tab) await vscode.window.tabGroups.close(tab, true);
      prevEditor = undefined;
    }
    if (!prevEditor) {
      const doc = await vscode.workspace.openTextDocument(uri);
      prevEditor = await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  } catch {
  }
}