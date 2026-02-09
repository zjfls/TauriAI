import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveAppRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function patchToolchainPaths(content) {
  let next = content;
  next = next.replaceAll(
    "$(TOOLCHAIN_DIR)/usr/lib/swift-5.0/$(PLATFORM_NAME)",
    "$(DT_TOOLCHAIN_DIR)/usr/lib/swift-5.0/$(PLATFORM_NAME)",
  );
  next = next.replaceAll(
    "$(TOOLCHAIN_DIR)/usr/lib/swift/$(PLATFORM_NAME)",
    "$(DT_TOOLCHAIN_DIR)/usr/lib/swift/$(PLATFORM_NAME)",
  );
  return next;
}

function detectPbxprojPath(appleGenDir) {
  const entries = fs.readdirSync(appleGenDir, { withFileTypes: true });
  const xcodeproj = entries.find((e) => e.isDirectory() && e.name.endsWith(".xcodeproj"));
  if (!xcodeproj) return null;
  return path.join(appleGenDir, xcodeproj.name, "project.pbxproj");
}

const appRoot = resolveAppRoot();
const appleGenDir = path.join(appRoot, "src-tauri", "gen", "apple");
const targets = [
  path.join(appleGenDir, "project.yml"),
  detectPbxprojPath(appleGenDir),
].filter(Boolean);

let changedFiles = 0;
let changedProjectYml = false;
let changedPbxproj = false;

for (const filePath of targets) {
  const before = readTextIfExists(filePath);
  if (before == null) {
    process.stdout.write(`[ios-gen] skip (missing): ${path.relative(appRoot, filePath)}\n`);
    continue;
  }

  const after = patchToolchainPaths(before);
  if (after === before) {
    process.stdout.write(`[ios-gen] ok (no change): ${path.relative(appRoot, filePath)}\n`);
    continue;
  }

  writeText(filePath, after);
  changedFiles += 1;
  if (filePath.endsWith(`${path.sep}project.yml`)) changedProjectYml = true;
  if (filePath.endsWith(`${path.sep}project.pbxproj`)) changedPbxproj = true;
  process.stdout.write(`[ios-gen] patched: ${path.relative(appRoot, filePath)}\n`);
}

if (changedFiles > 0 && changedProjectYml && !changedPbxproj) {
  process.stdout.write(
    "[ios-gen] note: Xcode project not patched; re-run `xcodegen` (or `npx tauri ios init`) to apply project.yml changes.\n",
  );
}
