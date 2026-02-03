#!/usr/bin/env node
/**
 * 仅用于开发环境的窗口图标生成：
 * - 输入：一个 SVG 文件
 * - 输出：`src-tauri/icons-dev/` 下的多尺寸 PNG（以及 `icon.png` 作为默认 256px）
 *
 * 注意：这不会影响 build（打包）图标。build 图标仍由 `src-tauri/icons/` 与 tauri.conf.json 控制。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Resvg } from '@resvg/resvg-js';

const sizes = [16, 32, 64, 128, 256, 512];

const args = process.argv.slice(2);
const inputSvg = args[0];
if (!inputSvg) {
  console.error('用法：node scripts/gen-dev-icon.mjs path/to/icon.svg');
  process.exit(1);
}

const inputPath = path.resolve(process.cwd(), inputSvg);
if (!fs.existsSync(inputPath)) {
  console.error(`找不到 SVG：${inputPath}`);
  process.exit(1);
}

const svg = fs.readFileSync(inputPath);

const outDir = path.resolve(process.cwd(), 'src-tauri/icons-dev');
fs.mkdirSync(outDir, { recursive: true });

for (const s of sizes) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: s },
    font: { loadSystemFonts: true },
  });
  const pngData = resvg.render().asPng();
  const outPath = path.join(outDir, `icon-${s}.png`);
  fs.writeFileSync(outPath, pngData);
  console.log(`已生成 ${outPath}`);
}

// 默认图标：256px
fs.copyFileSync(path.join(outDir, 'icon-256.png'), path.join(outDir, 'icon.png'));
console.log(`已生成 ${path.join(outDir, 'icon.png')}`);

