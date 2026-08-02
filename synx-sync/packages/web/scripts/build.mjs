// 笔记应用构建：将 assets/notes.js 及其依赖（markdown-it、DOMPurify、CodeMirror）
// 打包为单个浏览器脚本 assets/dist/notes.bundle.js；其他页面脚本保持语法检查。
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const distDir = new URL('assets/dist/', root);
mkdirSync(fileURLToPath(distDir), { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL('assets/notes.js', root))],
  bundle: true,
  outfile: fileURLToPath(new URL('assets/dist/notes.bundle.js', root)),
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'firefox100', 'safari15'],
  minify: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
});

// 其余页面仍为纯静态脚本，仅做语法校验
execSync('node --check assets/app.js', { stdio: 'inherit' });
execSync('node --check assets/storage.js', { stdio: 'inherit' });
execSync('node --check assets/notes.js', { stdio: 'inherit', cwd: fileURLToPath(root) });
console.log('built assets/dist/notes.bundle.js');
