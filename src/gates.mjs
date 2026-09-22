import { spawn } from 'node:child_process';

const safeExecutable = /^[a-zA-Z0-9@_./+:-]{1,200}$/;
export function runGate({ command, args = [], cwd, timeoutMs = 120000 }, spawnProcess = spawn) {
  if (!safeExecutable.test(command || '')) throw Error('Gate executable is invalid.');
  if (!Array.isArray(args) || args.length > 40 || args.some(a => typeof a !== 'string' || a.length > 1000)) throw Error('Gate arguments are invalid.');
  timeoutMs = Math.max(1000, Math.min(300000, Number(timeoutMs) || 120000));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AGENT_WORLD/i.test(key)) delete env[key];
  // A broker started under node:test must not make a nested --test silently skip.
  // Drop inherited runtime injection/runner context as well as named credentials.
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_TEST_CONTEXT|NODE_V8_COVERAGE|BASH_ENV|ENV|PYTHONPATH|RUBYOPT|LD_PRELOAD|DYLD_.*)$/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', done = false, timedOut = false;
    const collect = chunk => { output = (output + chunk.toString()).slice(-128 * 1024); };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => { if (!done) child.kill('SIGKILL'); }, 2000).unref(); }, timeoutMs);
    child.once('error', error => { if (done) return; done = true; clearTimeout(timer); reject(error); });
    child.once('exit', exitCode => { if (done) return; done = true; clearTimeout(timer); resolve({ command, args, exitCode: exitCode ?? -1, timedOut, output }); });
  });
}
