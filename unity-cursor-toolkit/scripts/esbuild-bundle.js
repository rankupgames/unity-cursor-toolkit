/*
 Simple esbuild bundler for extension and view modules.
 This does not replace the tsc build; it's an optional bundling step.
*/

const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [
    path.join(__dirname, '..', 'src', 'extension.ts'),
    path.join(__dirname, '..', 'src', 'console', 'consolePanel.ts')
  ],
  outdir: path.join(__dirname, '..', 'out-bundle'),
  platform: 'node',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info'
};

async function bundle() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('watching for changes...');
  } else {
    await esbuild.build(buildOptions);
  }
}

bundle().catch((e) => { console.error(e); process.exit(1); });
