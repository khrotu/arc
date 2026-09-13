import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { SkillsLock } from "./types.js";
import { getWorkspaceArcDir } from "../arc-dir.js";
export async function loadSkillsLock(workspaceRoot: string): Promise<SkillsLock> {
  try {
    const p = path.join(getWorkspaceArcDir(workspaceRoot), "skills-lock.json");
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
export async function saveSkillsLock(workspaceRoot: string, lock: SkillsLock): Promise<void> {
  const dir = getWorkspaceArcDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, "skills-lock.json");
  await fs.writeFile(p, JSON.stringify(lock, null, 2), "utf-8");
}
export async function pinSkill(
  workspaceRoot: string,
  name: string,
  source: string,
  version: string,
  revision: string,
): Promise<void> {
  const lock = await loadSkillsLock(workspaceRoot);
  let hash: string | undefined;
  try {
    const skillMd = path.join(getWorkspaceArcDir(workspaceRoot), "skills", name, "SKILL.md");
    const raw = await fs.readFile(skillMd, "utf-8");
    hash = createHash("sha256").update(raw).digest("hex");
  } catch {}
  lock[name] = hash ? { source, version, revision, hash } : { source, version, revision };
  await saveSkillsLock(workspaceRoot, lock);
}
export async function verifySkillHash(workspaceRoot: string, name: string, content: string): Promise<boolean> {
  const lock = await loadSkillsLock(workspaceRoot);
  const entry = lock[name];
  if (!entry?.hash) return true;
  return createHash("sha256").update(content).digest("hex") === entry.hash;
}