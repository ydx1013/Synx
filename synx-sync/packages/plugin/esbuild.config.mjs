import esbuild from 'esbuild';
import builtinModules from 'builtin-modules';

const prod = process.argv.includes('--prod');

esbuild
  .build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    external: [
      'obsidian',
      'electron',
      '@codemirror/autocomplete',
      '@codemirror/collab',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/lint',
      '@codemirror/search',
      '@codemirror/state',
      '@codemirror/view',
      '@lezer/common',
      '@lezer/highlight',
      '@lezer/lr',
      ...builtinModules,
    ],
    format: 'cjs',
    target: 'es2022',
    logLevel: 'info',
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    outfile: 'main.js',
    minify: prod,
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
