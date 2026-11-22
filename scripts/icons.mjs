import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';

// Renders the extension's toolbar/store PNGs from the single SVG source.
const svg = await readFile('extension/icons/icon.svg');
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(`extension/icons/icon-${size}.png`, png);
  console.log(`extension/icons/icon-${size}.png`);
}
