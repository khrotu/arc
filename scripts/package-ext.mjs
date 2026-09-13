import { readFileSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARC_DIR = resolve(ROOT, "packages", "arc");
execSync("pnpm build:ext", { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, NODE_ENV: "production" } });
for (const name of readdirSync(join(ARC_DIR, "dist"))) {
  if (name.endsWith(".map") || name.endsWith(".tmp") || name.startsWith("meta")) rmSync(join(ARC_DIR, "dist", name), { force: true });
}
for (const name of readdirSync(ARC_DIR)) {
  if (name.endsWith(".vsix")) rmSync(join(ARC_DIR, name), { force: true });
}
const pkgPath = join(ARC_DIR, "package.json");
const backupPath = `${pkgPath}.bak`;
let original;
if (existsSync(backupPath)) {
  original = readFileSync(backupPath, "utf-8");
  writeFileSync(pkgPath, original, "utf-8");
} else {
  original = readFileSync(pkgPath, "utf-8");
}
writeFileSync(backupPath, original, "utf-8");
try {
  const pkg = JSON.parse(original);
  delete pkg.scripts;
  delete pkg.devDependencies;
  if (pkg.dependencies && pkg.dependencies["@arc/host"]) delete pkg.dependencies["@arc/host"];
  if (pkg.dependencies && Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies;
  writeFileSync(pkgPath, JSON.stringify(pkg), "utf-8");
  execFileSync(process.execPath, [join(ARC_DIR, "node_modules", "@vscode", "vsce", "vsce"), "package", "--no-dependencies"], { cwd: ARC_DIR, stdio: "inherit" });
} finally {
  writeFileSync(pkgPath, original, "utf-8");
  rmSync(backupPath, { force: true });
}
const shippedVersion = JSON.parse(original).version;
const expectedName = `arc-code-${shippedVersion}.vsix`;
let vsix = join(ARC_DIR, expectedName);
try {
  statSync(vsix);
} catch {
  vsix = readdirSync(ARC_DIR)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => join(ARC_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!vsix) throw new Error("vsce produced no .vsix");
}
execFileSync(process.execPath, [join(ROOT, "scripts", "repack-vsix.mjs"), vsix], { stdio: "inherit" });