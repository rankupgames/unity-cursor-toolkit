/*
 Simple esbuild bundler for extension and view modules.
 This does not replace the tsc build; it's an optional bundling step.
*/

const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

async function bundle() {
  await esbuild.build({
    entryPoints: [
      path.join(__dirname, '..', 'src', 'extension.ts'),
      path.join(__dirname, '..', 'src', 'panels', 'plasticTimelineViewProvider.ts'),
      path.join(__dirname, '..', 'src', 'services', 'plasticCli.ts')
    ],
    outdir: path.join(__dirname, '..', 'out-bundle'),
    platform: 'node',
    format: 'cjs',
    bundle: true,
    sourcemap: true,
    external: ['vscode'],
    logLevel: 'info',
    watch: watch ? {
      onRebuild(error) {
        if (error) console.error('watch build failed:', error)
        else console.log('watch build succeeded')
      }
    } : false
  });
}

bundle().catch((e) => { console.error(e); process.exit(1); });


