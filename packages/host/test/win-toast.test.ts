import { describe, it, expect } from "vitest";
import { buildWinToast, escapePsXml, resolveHostAppId } from "../src/log/win-toast";
describe("resolveHostAppId", () => {
  it("defaults to stable VS Code", () => {
    expect(resolveHostAppId()).toBe("Microsoft.VisualStudioCode");
    expect(resolveHostAppId("Cursor", "cursor")).toBe("Microsoft.VisualStudioCode");
    expect(resolveHostAppId("Visual Studio Code", "vscode")).toBe("Microsoft.VisualStudioCode");
  });
  it("covers Insiders", () => {
    expect(resolveHostAppId("Visual Studio Code - Insiders", "vscode-insiders")).toBe("Microsoft.VisualStudioCodeInsiders");
    expect(resolveHostAppId("Visual Studio Code - Insiders")).toBe("Microsoft.VisualStudioCodeInsiders");
    expect(resolveHostAppId(undefined, "vscode-insiders")).toBe("Microsoft.VisualStudioCodeInsiders");
  });
  it("covers VSCodium", () => {
    expect(resolveHostAppId("VSCodium", "vscodium")).toBe("VSCodium.VSCodium");
    expect(resolveHostAppId("VSCodium - Insiders", "vscodium-insiders")).toBe("VSCodium.VSCodiumInsiders");
  });
  it("covers OSS", () => {
    expect(resolveHostAppId("Code - OSS", "code-oss")).toBe("Microsoft.CodeOSS");
  });
});
describe("escapePsXml", () => {
  it("escapes markup and quotes", () => {
    expect(escapePsXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});
describe("buildWinToast", () => {
  it("targets the host flavor AppID with Arc body branding", () => {
    const ps = buildWinToast("Arc", "Task complete", "C:\\icons\\arc.png", "Microsoft.VisualStudioCode");
    expect(ps).toContain("CreateToastNotifier('Microsoft.VisualStudioCode')");
    expect(ps).toContain('<image placement="appLogoOverride" src="C:\\icons\\arc.png" />');
    expect(ps).toContain("<text>Arc</text><text>Task complete</text>");
  });
  it("omits the image element without a logo", () => {
    expect(buildWinToast("Arc", "hi", undefined, "Microsoft.VisualStudioCode")).not.toContain("<image");
  });
});