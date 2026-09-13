export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: "workspace" | "global";
  scripts: string[];
  references: string[];
  assets: string[];
}
export interface SkillsLockEntry {
  source: string;
  version: string;
  revision: string;
  hash?: string;
}
export type SkillsLock = Record<string, SkillsLockEntry>;