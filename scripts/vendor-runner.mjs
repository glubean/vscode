/**
 * Vendor @glubean/runner into dist/node_modules/ so the vsix is self-contained.
 *
 * Runner is published to npm, so we just `npm install` it in a temp dir
 * and copy the resolved node_modules. Clean and simple.
 */
import { cpSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const vendorRoot = resolve(root, "dist/node_modules");

// Clean previous vendor
rmSync(vendorRoot, { recursive: true, force: true });

// Install runner in a temp dir to get a complete dependency tree
const tmp = mkdtempSync(join(tmpdir(), "glubean-vendor-"));
writeFileSync(
  join(tmp, "package.json"),
  JSON.stringify({ name: "glubean-vendor", private: true })
);

// Parse --os and --cpu flags for cross-platform builds
const args = process.argv.slice(2);
const getFlag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const targetOs = getFlag("os");
const targetCpu = getFlag("cpu");

const platformFlags = [
  targetOs && `--os=${targetOs}`,
  targetCpu && `--cpu=${targetCpu}`,
].filter(Boolean).join(" ");

const target = platformFlags ? ` (${targetOs}-${targetCpu})` : "";
console.log(`Installing @glubean/runner from npm...${target}`);
execSync(`npm install --omit=dev @glubean/runner ${platformFlags}`, {
  cwd: tmp,
  stdio: "inherit",
});

// Copy resolved node_modules to dist/
cpSync(join(tmp, "node_modules"), vendorRoot, { recursive: true });

// Cleanup temp
rmSync(tmp, { recursive: true, force: true });

// Remove unnecessary files to reduce size
const removePatterns = [
  ".package-lock.json",
  ".bin",
];
for (const p of removePatterns) {
  try { rmSync(resolve(vendorRoot, p), { recursive: true, force: true }); } catch {}
}

// Report
const size = execSync(`du -sh "${vendorRoot}"`).toString().trim().split("\t")[0];
console.log(`✓ Vendored @glubean/runner → dist/node_modules/ (${size})`);
