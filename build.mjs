// Esbuild build pipeline for Flash Code.
// Bundles two targets:
//   1. Extension host  : src/extension.ts -> out/extension.js   (node/cjs, vscode external)
//   2. Webview UI       : webview/app.tsx  -> media/dist/app.js   (browser/esm, Preact)
//
// Usage:
//   node build.mjs              one-off dev build
//   node build.mjs --watch      rebuild on change
//   node build.mjs --production minified, no sourcemaps

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

const hostConfig = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // vscode is provided by the runtime; never bundle it.
  external: ['vscode'],
};

// The webview UI is the original self-contained HTML in media/ (no bundling).

async function run() {
  if (watch) {
    const hostCtx = await esbuild.context(hostConfig);
    await hostCtx.watch();
    console.log('[flash-code] watching host for changes…');
  } else {
    await esbuild.build(hostConfig);
    console.log('[flash-code] build complete.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
