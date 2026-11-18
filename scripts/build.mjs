import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { notices } from './notices.mjs';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['web/app.js'], outfile: 'dist/app.js', bundle: true, minify: true, format: 'esm', target: ['chrome110', 'firefox115', 'safari16'], sourcemap: false });
for (const file of ['index.html', 'style.css', 'tokens.css', 'favicon.svg']) await copyFile(`web/${file}`, `dist/${file}`);
await notices();
console.log('网页生产构建已写入 dist/');
