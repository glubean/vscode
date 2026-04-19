/**
 * Vendor @glubean/runner into dist/node_modules/ so the vsix is self-contained.
 *
 * Runner is published to npm, so we just `npm install` it in a temp dir
 * and copy the resolved node_modules. Clean and simple.
 */
import { cpSync, rmSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
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

// esbuild uses optionalDependencies per platform. npm's --os/--cpu flags
// don't reliably cross-install them on a different host OS (e.g. linux CI
// building for darwin). Force-install the correct platform package and
// remove any wrong-platform ones.
if (targetOs && targetCpu) {
  const wantedPkg = `@esbuild/${targetOs}-${targetCpu}`;

  // Pin to the resolved host esbuild version. esbuild's JS host and native
  // binary must be the exact same version; `npm install --force <pkg>`
  // without a version always pulls latest, and when esbuild publishes a
  // new minor between the main install and this force-install the two
  // diverge — producing vsixs that throw
  //   "Host version X does not match binary version Y"
  // at runtime. (Reproduced as 0.17.30–0.17.34 with host 0.27.7 /
  // binary 0.28.0 after esbuild 0.28 shipped.)
  const esbuildPkgJson = JSON.parse(
    readFileSync(join(tmp, "node_modules/esbuild/package.json"), "utf8"),
  );
  const esbuildVersion = esbuildPkgJson.version;

  console.log(
    `Force-installing ${wantedPkg}@${esbuildVersion} for cross-platform build...`,
  );
  execSync(`npm install --force ${wantedPkg}@${esbuildVersion}`, {
    cwd: tmp,
    stdio: "inherit",
  });

  // Remove any other @esbuild/* platform packages
  const esbuildDir = join(tmp, "node_modules", "@esbuild");
  const wanted = `${targetOs}-${targetCpu}`;
  try {
    for (const entry of readdirSync(esbuildDir)) {
      if (entry !== wanted) {
        console.log(`  Removing wrong-platform @esbuild/${entry}`);
        rmSync(join(esbuildDir, entry), { recursive: true, force: true });
      }
    }
  } catch {}
}

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

// Safety net: assert esbuild host and all @esbuild/* binaries agree on
// version. Any mismatch here would ship a broken vsix — fail the build
// instead of paging users.
try {
  const hostVer = JSON.parse(
    readFileSync(join(vendorRoot, "esbuild/package.json"), "utf8"),
  ).version;
  const esbuildPlatformsDir = join(vendorRoot, "@esbuild");
  for (const entry of readdirSync(esbuildPlatformsDir)) {
    const binVer = JSON.parse(
      readFileSync(join(esbuildPlatformsDir, entry, "package.json"), "utf8"),
    ).version;
    if (binVer !== hostVer) {
      throw new Error(
        `esbuild vendor mismatch: host=${hostVer} but @esbuild/${entry}=${binVer}`,
      );
    }
  }
} catch (err) {
  if (err && err.code === "ENOENT") {
    // No @esbuild platform dir (e.g. runner stopped depending on esbuild).
    // Nothing to check.
  } else {
    throw err;
  }
}

// Report
const size = execSync(`du -sh "${vendorRoot}"`).toString().trim().split("\t")[0];
console.log(`✓ Vendored @glubean/runner → dist/node_modules/ (${size})`);
