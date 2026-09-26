const STABLE_APP_ID = "Microsoft.VisualStudioCode";
const INSIDERS_APP_ID = "Microsoft.VisualStudioCodeInsiders";
const OSS_APP_ID = "Microsoft.CodeOSS";
const VSCODIUM_APP_ID = "VSCodium.VSCodium";
const VSCODIUM_INSIDERS_APP_ID = "VSCodium.VSCodiumInsiders";
export function resolveHostAppId(appName?: string, uriScheme?: string): string {
  const name = (appName ?? "").toLowerCase();
  const scheme = (uriScheme ?? "").toLowerCase();
  if (scheme === "vscode-insiders" || name === "visual studio code - insiders") return INSIDERS_APP_ID;
  if (scheme === "vscodium-insiders" || name === "vscodium - insiders") return VSCODIUM_INSIDERS_APP_ID;
  if (scheme === "vscodium" || name === "vscodium") return VSCODIUM_APP_ID;
  if (scheme === "code-oss" || name === "code - oss") return OSS_APP_ID;
  return STABLE_APP_ID;
}
export function escapePsXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
export function buildWinToast(title: string, body: string, logoPath: string | undefined, appId: string): string {
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
    `[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric">${logoPath ? `<image placement="appLogoOverride" src="${escapePsXml(logoPath)}" />` : ""}<text>${escapePsXml(title)}</text><text>${escapePsXml(body)}</text></binding></visual></toast>')`,
    `$n=[Windows.UI.Notifications.ToastNotification]::new($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(appId)}).Show($n)`,
  ].join("\n");
  return ps;
}