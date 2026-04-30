// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');
const outDir = 'dist';

// Ensure output directories exist
['dist', 'dist/popup', 'dist/options', 'dist/icons'].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// Copy static assets
function copyStatic() {
  const copies = [
    ['manifest.json',             'dist/manifest.json'],
    ['src/popup/popup.html',      'dist/popup/popup.html'],
    ['src/popup/popup.css',       'dist/popup/popup.css'],
    ['src/options/options.html',  'dist/options/options.html'],
    ['src/options/options.css',   'dist/options/options.css'],
  ];
  [16, 32, 48, 128].forEach(size => {
    copies.push([`icons/icon${size}.png`, `dist/icons/icon${size}.png`]);
  });
  copies.forEach(([src, dest]) => {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      console.warn(`Warning: ${src} not found, skipping copy.`);
    }
  });
  console.log('Static assets copied.');
}

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: [
    { in: 'src/background/service_worker.ts', out: 'service_worker' },
    { in: 'src/popup/popup.ts',               out: 'popup/popup' },
    { in: 'src/options/options.ts',           out: 'options/options' },
  ],
  bundle: true,
  outdir: outDir,
  format: 'esm',
  target: 'chrome120',
  sourcemap: false,
  logLevel: 'info',
};

copyStatic();

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch();
    console.log('Watching for changes… (Ctrl+C to stop)');
  });
} else {
  esbuild.build(buildOptions)
    .then(() => console.log('\nBuild complete! Load the "dist/" folder in Chrome.'))
    .catch(() => process.exit(1));
}
