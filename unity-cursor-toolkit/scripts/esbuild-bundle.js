/*
 Bundles extension/view modules or the standalone test adapter.
 The compile script bundles the test parser after tsc; other targets are optional.
*/

const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

const testAdapter = process.argv.includes('--test-adapter');
const buildOptions = testAdapter ? {
  entryPoints: [path.join(__dirname, '..', 'src', 'core', 'unityCliTestAdapter.ts')],
  outfile: path.join(__dirname, '..', 'out', 'core', 'unityCliTestAdapter.js'),
  platform: 'node', format: 'cjs', bundle: true, sourcemap: true, logLevel: 'info'
} : {
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
