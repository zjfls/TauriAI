import { copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const manifestPath = join(projectRoot, 'crates', 'headless-runner', 'Cargo.toml');
const binariesDir = join(projectRoot, 'src-tauri', 'binaries');
const cliArgs = process.argv.slice(2);

function parseProfileArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--release') return 'release';
    if (value === '--debug') return 'debug';

    if (value === '--profile') {
      const next = args[index + 1]?.trim().toLowerCase();
      if (next === 'release' || next === 'debug') return next;
    }

    if (value.startsWith('--profile=')) {
      const profile = value.slice('--profile='.length).trim().toLowerCase();
      if (profile === 'release' || profile === 'debug') return profile;
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
  const lines = stdoutText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

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

function createLineAccumulator(onLine) {
  let buffer = '';

  return {
    push(chunk) {
      buffer += chunk;
      let lineBreakIndex = buffer.indexOf('\n');
      while (lineBreakIndex >= 0) {
        const line = buffer.slice(0, lineBreakIndex).replace(/\r$/, '');
        buffer = buffer.slice(lineBreakIndex + 1);
        onLine(line);
        lineBreakIndex = buffer.indexOf('\n');
      }
    },
    flush() {
      const lastLine = buffer.replace(/\r$/, '');
      if (lastLine) {
        onLine(lastLine);
      }
      buffer = '';
    },
  };
}

async function runCargoBuildStreaming(cargoArgs, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('cargo', cargoArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutText = '';
    let stderrText = '';
    let executable = null;
    let artifactCount = 0;
    const startedAt = Date.now();

    const progressTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      const artifactText =
        artifactCount > 0 ? `, ${artifactCount} Rust artifacts completed` : '';
      console.log(
        `[prepare-headless] headless sidecar build still running; frontend dev server starts after this step (${elapsedSec}s elapsed${artifactText})`,
      );
    }, 10000);

    const cleanupTimer = () => {
      clearInterval(progressTimer);
    };

    const stdoutLines = createLineAccumulator((line) => {
      stdoutText += `${line}\n`;
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const payload = JSON.parse(trimmed);

        if (payload?.reason === 'compiler-artifact') {
          artifactCount += 1;
          if (
            payload?.target?.name === 'tauri-ai-headless' &&
            typeof payload?.executable === 'string' &&
            payload.executable.length > 0
          ) {
            executable = payload.executable;
          }
          return;
        }

        if (payload?.reason === 'compiler-message') {
          const rendered = payload?.message?.rendered;
          if (typeof rendered === 'string' && rendered.trim().length > 0) {
            process.stderr.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
          }
          return;
        }

        if (payload?.reason === 'build-finished') {
          const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
          console.log(
            `[prepare-headless] cargo build ${payload.success ? 'finished' : 'failed'} (${elapsedSec}s, ${artifactCount} artifacts)`,
          );
        }
      } catch {
        process.stdout.write(`${line}\n`);
      }
    });

    const stderrLines = createLineAccumulator((line) => {
      stderrText += `${line}\n`;
      if (!line) return;
      process.stderr.write(`${line}\n`);
    });

    child.stdout.on('data', (chunk) => {
      stdoutLines.push(chunk.toString('utf8'));
    });

    child.stderr.on('data', (chunk) => {
      stderrLines.push(chunk.toString('utf8'));
    });

    child.on('error', (error) => {
      cleanupTimer();
      rejectPromise(error);
    });

    child.on('close', (code) => {
      cleanupTimer();
      stdoutLines.flush();
      stderrLines.flush();
      resolvePromise({
        status: code ?? 1,
        stdout: stdoutText,
        stderr: stderrText,
        executable,
      });
    });
  });
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

async function main() {
  console.log(
    `[prepare-headless] building tauri-ai-headless (${isRelease ? 'release' : 'debug'}) for ${targetTriple}`,
  );
  console.log('[prepare-headless] frontend dev server will start after this sidecar build completes');

  const cargo = await runCargoBuildStreaming(cargoArgs, {
    cwd: projectRoot,
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
    process.exit(cargo.status ?? 1);
  }

  const executable = cargo.executable || parseExecutableFromCargoJson(cargo.stdout || '');
  if (!executable) {
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
}

await main();
