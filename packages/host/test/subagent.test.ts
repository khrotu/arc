import { describe, it, expect } from "vitest";
import { baseCommand, commandChain } from "../src/agent/subagent";
describe("baseCommand", () => {
  it("extracts the executable name", () => {
    expect(baseCommand("git status")).toBe("git");
    expect(baseCommand("  npm  run build")).toBe("npm");
  });
  it("strips env assignments, paths, quotes, and extensions", () => {
    expect(baseCommand("FOO=1 BAR=x node server.js")).toBe("node");
    expect(baseCommand('FOO="a b" rm -rf x')).toBe("rm");
    expect(baseCommand("/usr/bin/git status")).toBe("git");
    expect(baseCommand("C:\\Windows\\System32\\cmd.exe /c dir")).toBe("dir");
    expect(baseCommand('"my tool" --flag')).toBe("my tool");
  });
  it("unwraps privilege wrappers to the real command", () => {
    expect(baseCommand("sudo rm -rf /")).toBe("rm");
    expect(baseCommand("env FOO=1 rm x")).toBe("rm");
    expect(baseCommand("timeout 10 rm x")).toBe("rm");
    expect(baseCommand("sh -c 'rm -rf x'")).toBe("rm");
  });
  it("stops at shell operators", () => {
    expect(baseCommand("echo hi; rm -rf /")).toBe("echo");
    expect(baseCommand("a && b")).toBe("a");
  });
  it("commandChain exposes every wrapper layer", () => {
    expect(commandChain("sudo rm -rf /")).toEqual(["sudo", "rm"]);
    expect(commandChain("env FOO=1 timeout 10 sh -c 'rm x'")).toEqual(["env", "timeout", "sh", "rm"]);
    expect(commandChain("git status")).toEqual(["git"]);
    expect(commandChain("npx -y evil-pkg")).toEqual(["npx", "evil-pkg"]);
  });
});