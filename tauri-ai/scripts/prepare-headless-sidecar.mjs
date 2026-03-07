import { copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const manifestPath = join(projectRoot, 'src-tauri', 'Cargo.toml');
const binariesDir = join(projectRoot, 'src-tauri', 'binaries');
const cliArgs = process.argv.slice(2);

function parseProfileArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--release') {
      return 'release';
    }
    if (value === '--debug') {
      return 'debug';
    }
    if (value === '--profile') {
      const next = args[index + 1]?.trim().toLowerCase();
      if (next === 'release' || next === 'debug') {
        return next;
      }
    }
    if (value.startsWith('--profile=')) {
      const profile = value.slice('--profile='.length).trim().toLowerCase();
      if (profile === 'release' || profile === 'debug') {
        return profile;
      }
    }
  }
  return null;
}

const platform = String(process.env.TAURI_ENV_PLATFORM || process.platform || '')
  .trim()
  .toLowerCase();
const platformType = String(process.env.TAURI_ENV_PLATFORM_TYPE || '')
  .trim()
  .toLowerCase();

if (platformType === 'mobile' || platform === 'android' || platform === 'ios') {
  console.log('[prepare-headless] skip mobile target');
  process.exit(0);
}

function detectHostTargetTriple() {
  const result = spawnSync('rustc', ['-vV'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'rustc -vV failed');
  }
  const line = result.stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('host: '));
  const host = line?.slice('host: '.length).trim();
  if (!host) {
    throw new Error('cannot determine rust host target triple');
  }
  return host;
}

function parseExecutableFromCargoJson(stdoutText) {
  const lines = stdoutText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    try {
      const payload = JSON.parse(line);
      if (
        payload?.reason === 'compiler-artifact' &&
        payload?.target?.name === 'tauri-ai-headless' &&
        typeof payload?.executable === 'string' &&
        payload.executable.length > 0
      ) {
        return payload.executable;
      }
    } catch {
      continue;
    }
  }
  return null;
}

const targetTriple = String(process.env.TAURI_ENV_TARGET_TRIPLE || detectHostTargetTriple()).trim();
const explicitProfile = parseProfileArg(cliArgs);
const isRelease = explicitProfile
  ? explicitProfile === 'release'
  : String(process.env.TAURI_ENV_DEBUG || '')
      .trim()
      .toLowerCase() === 'false';

const cargoArgs = [
  'build',
  '--manifest-path',
  manifestPath,
  '--bin',
  'tauri-ai-headless',
  '--message-format=json-render-diagnostics',
];
if (process.env.TAURI_ENV_TARGET_TRIPLE) {
  cargoArgs.push('--target', targetTriple);
}
if (isRelease) {
  cargoArgs.push('--release');
}

console.log(`[prepare-headless] building tauri-ai-headless (${isRelease ? 'release' : 'debug'}) for ${targetTriple}`);
const cargo = spawnSync('cargo', cargoArgs, {
  cwd: projectRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({
      bundle: {
        externalBin: [],
      },
    }),
  },
});
if (cargo.status !== 0) {
  process.stdout.write(cargo.stdout || '');
  process.stderr.write(cargo.stderr || '');
  process.exit(cargo.status ?? 1);
}

const executable = parseExecutableFromCargoJson(cargo.stdout || '');
if (!executable) {
  process.stdout.write(cargo.stdout || '');
  throw new Error('cannot locate tauri-ai-headless executable from cargo output');
}

const executableSuffix = targetTriple.includes('windows') ? '.exe' : '';
const destination = join(
  binariesDir,
  `tauri-ai-headless-${targetTriple}${executableSuffix}`,
);
mkdirSync(binariesDir, { recursive: true });
copyFileSync(executable, destination);
if (!targetTriple.includes('windows')) {
  chmodSync(destination, 0o755);
}
console.log(`[prepare-headless] copied ${executable} -> ${destination}`);
