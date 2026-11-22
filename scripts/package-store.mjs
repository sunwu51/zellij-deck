import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';

// Builds the extension and zips dist/ (without sourcemaps) for upload to the Chrome Web Store.
const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const files = {};
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (!entry.name.endsWith('.map')) files[path.relative('dist', full).split(path.sep).join('/')] = new Uint8Array(await readFile(full));
  }
}
await walk('dist');
const { version } = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
await mkdir('release', { recursive: true });
const target = `release/zellij-deck-${version}.zip`;
await writeFile(target, zipSync(files, { level: 9 }));
console.log(`${target} (${Object.keys(files).length} files)`);
