// @ts-check
/**
 * Generates icon PNG files at 16/32/48/128px from icons/icon.svg using sharp.
 * Run via: npm run icons
 */
const path = require('path');
const fs = require('fs');

let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('Error: sharp is not installed. Run `npm install` first.');
  process.exit(1);
}

const svgPath = path.join(__dirname, '..', 'icons', 'icon.svg');
if (!fs.existsSync(svgPath)) {
  console.error(`Error: SVG source not found at ${svgPath}`);
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'icons');
const sizes = [16, 32, 48, 128];

Promise.all(
  sizes.map(size =>
    sharp(svgPath)
      .resize(size, size)
      .png()
      .toFile(path.join(outDir, `icon${size}.png`))
      .then(() => console.log(`  Generated icon${size}.png`))
  )
)
  .then(() => console.log('Icons generated successfully.'))
  .catch(err => {
    console.error('Icon generation failed:', err.message);
    process.exit(1);
  });
