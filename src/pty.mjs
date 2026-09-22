import { createRequire } from 'node:module';
import { chmodSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as pty from 'node-pty';

const require = createRequire(import.meta.url);
let prepared = false;
export function spawnPty(file, args, options) {
  if (!prepared && process.platform === 'darwin') {
    // node-pty 1.1.0's npm tarball omits its helper's execute bit (upstream #850).
    // Resolve the exact loaded native helper, including hoisted dependency layouts.
    const entry = require.resolve('node-pty');
    const native = require('node-pty/lib/utils.js').loadNativeModule('pty');
    const helper = resolve(dirname(entry), native.dir, 'spawn-helper');
    const mode = statSync(helper).mode;
    if (!(mode & 0o100)) {
      try { chmodSync(helper, mode | 0o100); }
      catch { throw Error(`The node-pty helper is not executable. Grant owner execute permission to ${helper}, then retry.`); }
    }
  }
  prepared = true;
  return pty.spawn(file, args, options);
}
