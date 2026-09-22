import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { spawnPty } from '../src/pty.mjs';

test('native PTY supports real input/output without launching Claude', { skip: process.platform === 'win32', timeout: 6000 }, async () => {
  const child = spawnPty('/bin/sh', ['-c', 'printf "PTY_READY\\n"; IFS= read -r reply; printf "PTY_REPLY:%s\\n" "$reply"'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: tmpdir(), env: process.env });
  let output = '', sent = false;
  await new Promise((yes, no) => {
    const timer = setTimeout(() => { child.kill(); no(Error('Native PTY timed out')); }, 4000);
    child.onData(chunk => { output += chunk; if (!sent && output.includes('PTY_READY')) { sent = true; child.write('fixture-input\r'); } });
    child.onExit(({ exitCode }) => { clearTimeout(timer); if (exitCode === 0) yes(); else no(Error('PTY exited ' + exitCode)); });
  });
  assert.match(output, /PTY_REPLY:fixture-input/);
});
