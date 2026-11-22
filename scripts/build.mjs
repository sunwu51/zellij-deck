import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
// Remove only the obsolete generated launcher assets from pre-dashboard builds.
for (const file of ['sidepanel.html', 'sidepanel.css', 'sidepanel.js', 'sidepanel.js.map']) {
  await rm(`dist/${file}`, { force: true });
}
for (const file of ['manifest.json', 'terminal.html', 'terminal.css', 'dashboard.html', 'dashboard.css']) {
  await copyFile(`extension/${file}`, `dist/${file}`);
}
await copyFile('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css');
await cp('extension/fonts', 'dist/fonts', { recursive: true });
await cp('extension/icons', 'dist/icons', { recursive: true, filter: source => !source.endsWith('.svg') });
await build({
  entryPoints: ['extension/background.ts', 'extension/terminal.ts', 'extension/dashboard.ts'],
  outdir: 'dist', bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome116', sourcemap: true, logLevel: 'info',
});
console.log('Load the dist folder as an unpacked extension in chrome://extensions.');
