import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const file of ['manifest.json', 'sidepanel.html', 'sidepanel.css', 'dashboard.html', 'dashboard.css']) {
  await copyFile(`extension/${file}`, `dist/${file}`);
}
await copyFile('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css');
await cp('extension/fonts', 'dist/fonts', { recursive: true });
await build({
  entryPoints: ['extension/background.ts', 'extension/sidepanel.ts', 'extension/dashboard.ts'],
  outdir: 'dist', bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome116', sourcemap: true, logLevel: 'info',
});
console.log('Load the dist folder as an unpacked extension in chrome://extensions.');
