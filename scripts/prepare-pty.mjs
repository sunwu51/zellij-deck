import { createRequire } from 'node:module';
import { stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node-pty's macOS fork implementation executes this bundled helper. Some
// package-manager/archive combinations install it without the executable bit.
export async function preparePty() {
  if (process.platform !== 'darwin') return;
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  // Match the directory actually selected by node-pty, not an unused prebuild.
  const { loadNativeModule } = require(path.join(root, 'lib', 'utils.js'));
  const native = loadNativeModule('pty');
  const helper = path.resolve(root, 'lib', native.dir, 'spawn-helper');
  const info = await stat(helper);
  if (!info.isFile()) throw new Error(`node-pty spawn helper is not a file: ${helper}`);
  if ((info.mode & 0o111) !== 0o111) {
    console.log(`Repairing node-pty spawn-helper executable mode: ${(info.mode & 0o777).toString(8)} -> ${((info.mode & 0o777) | 0o111).toString(8)}`);
    await chmod(helper, (info.mode & 0o777) | 0o111);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePty();
}
