import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function pairedInput(cwd) {
  return {
    objective: 'Implement the hello service and its frontend consumer without modifying the acceptance harness.', cwd,
    roster: [
      { role: 'orchestrator', provider: 'codex', model: 'gpt-6-astra' },
      { role: 'orchestrator', provider: 'claude', model: 'opus' },
      { role: 'developer', provider: 'codex', model: 'gpt-5.6-terra' },
      { role: 'developer', provider: 'claude', model: 'sonnet' },
      { role: 'tester', provider: 'codex', model: 'gpt-5.6-sol' },
      { role: 'reviewer', provider: 'claude', model: 'opus' },
      { role: 'council', provider: 'codex', model: 'gpt-6-astra', count: 5 }
    ],
    paired: {
      base: { ref: 'develop', remote: null, refresh: false },
      frontendPaths: ['frontend/'], backendPaths: ['backend/'],
      protectedPaths: ['tests/'],
      contract: {
        endpoints: [
          { method: 'GET', path: '/api/hello', request: {}, response: { status: 200, contentType: 'application/json', body: { message: 'hello from the backend' } } },
          { method: 'GET', path: '/health', request: {}, response: { status: 200 } }
        ],
        acceptance: ['backend/handler.mjs exports handler(request,response); unknown paths return 404.', 'frontend/client.mjs exports async loadGreeting(base) and returns the backend message from GET /api/hello, without hard-coding it.', 'Network errors reject. Keep tests/ unchanged.']
      },
      gates: [{ command: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'], timeoutMs: 20000 }]
    }
  };
}

export function createPairedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-world-paired-fixture-'))), cwd = join(root, 'project');
  mkdirSync(cwd);
  cpSync(fileURLToPath(new URL('../examples/paired-smoke/', import.meta.url)), cwd, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Agent World Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', ...args], { cwd, stdio: 'pipe', env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  git(['init', '-b', 'develop']); git(['add', '--', 'frontend', 'backend', 'tests', 'docker']); git(['commit', '-m', 'Disposable paired acceptance fixture']);
  const input = pairedInput(cwd), config = join(root, 'paired-run.json');
  writeFileSync(config, JSON.stringify(input, null, 2), { mode: 0o600 });
  return { root, cwd, stateDir: join(root, 'state'), config, input };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = createPairedFixture();
  process.stdout.write(`Disposable fixture created. No model sessions launched.\nProject: ${fixture.cwd}\nRun configuration: ${fixture.config}\n\nStart the app in a separate terminal:\nnode bin/agent-world.mjs --state-dir ${fixture.stateDir} --claude-dir ${fixture.root}/empty-sessions --port 8792 --paired-config ${fixture.config}\n\nOpen the printed authenticated URL. In ORCHESTRATE, inspect the imported proposal, approve, then explicitly launch orchestrators when ready for a paid model trial. On later restarts omit --paired-config to reuse the existing run.\nOffline regression: npm run test:paired\n`);
}
