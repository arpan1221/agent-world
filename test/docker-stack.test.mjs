import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPairedFixture } from '../scripts/paired-fixture.mjs';
import { WorkspaceManager } from '../src/workspaces.mjs';
import { prepareDockerStack } from '../src/docker-stack.mjs';

function fixture() {
  const f = createPairedFixture();
  const extra = { 'frontend/Dockerfile.dev': 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n', 'backend/apps/api/Dockerfile.dev': 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n', 'frontend/public/icon.svg': '<svg/>', 'backend/apps/api/src/example.spec.ts': 'test preserved', 'frontend/.env.local': 'SECRET=not-for-build', 'backend/key.pem': 'not-for-build', 'frontend/.dockerignore': 'public\n', 'backend/.dockerignore': '**/*.spec.ts\n' };
  for (const [path, text] of Object.entries(extra)) { mkdirSync(dirname(join(f.cwd, path)), { recursive: true }); writeFileSync(join(f.cwd, path), text); }
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', ...args], { cwd: f.cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git(['add', '--all']); git(['commit', '-m', 'Docker fixture tracked assets and excluded test credentials']);
  const run = { id: randomUUID(), cwd: f.cwd, assignments: [], paired: { base: { ref: 'develop', remote: null, refresh: false }, approvedAt: new Date().toISOString(), approvalHash: 'approved-contract' } };
  const workspaces = new WorkspaceManager(f.stateDir); workspaces.provision(run);
  run.integration = { id: randomUUID(), contractHash: run.paired.approvalHash, treeHash: workspaces.treeHash(run), managedPaths: [] };
  return { ...f, run, workspaces };
}

test('Docker export isolates resources, preserves tests/public, excludes credentials and mutable mounts', () => {
  const f = fixture(), result = prepareDockerStack({ stateDir: f.stateDir, run: f.run });
  const compose = JSON.parse(readFileSync(result.composeFile));
  assert.deepEqual(Object.keys(compose.services), ['redis', 'api', 'frontend']);
  assert.equal(compose.services.frontend.environment.API_PROXY_TARGET, 'http://api:3001');
  assert.equal(compose.services.frontend.ports[0].host_ip, '127.0.0.1');
  assert.equal(compose.services.frontend.ports[0].published, undefined);
  assert.deepEqual(compose.services.api.env_file, ['./backend.test.env']);
  assert.deepEqual(compose.services.frontend.env_file, ['./frontend.test.env']);
  assert.equal(existsSync(join(result.directory, 'backend.test.env')), false);
  assert.equal(existsSync(join(result.directory, 'context/frontend/.env.local')), false);
  assert.equal(existsSync(join(result.directory, 'context/backend/key.pem')), false);
  assert.equal(existsSync(join(result.directory, 'context/frontend/public/icon.svg')), true);
  assert.equal(existsSync(join(result.directory, 'context/backend/apps/api/src/example.spec.ts')), true);
  for (const service of Object.values(compose.services)) { assert.equal(service.container_name, undefined); assert.equal(service.volumes, undefined); }
  assert.equal(compose.services.api.ports, undefined); assert.equal(compose.services.redis.ports, undefined);
  assert.deepEqual(result.commands.up.slice(0, 2), ['docker', 'compose']);
  assert.deepEqual(prepareDockerStack({ stateDir: f.stateDir, run: f.run }), result);
  writeFileSync(join(result.directory, 'backend.test.env'), 'DATABASE_URL=test-only');
  assert.deepEqual(prepareDockerStack({ stateDir: f.stateDir, run: f.run }), result, 'explicit runtime env is intentionally outside context integrity');
});

test('Docker preparation rejects stale, invalidated and tampered integration/export state', () => {
  const f = fixture();
  assert.throws(() => prepareDockerStack({ stateDir: f.stateDir, run: { ...f.run, integration: { ...f.run.integration, invalidatedAt: 'now' } } }), /current approved/);
  assert.throws(() => prepareDockerStack({ stateDir: f.stateDir, run: { ...f.run, integration: { ...f.run.integration, contractHash: 'other' } } }), /current approved/);
  const result = prepareDockerStack({ stateDir: f.stateDir, run: f.run });
  writeFileSync(result.composeFile, '{}');
  assert.throws(() => prepareDockerStack({ stateDir: f.stateDir, run: f.run }), /integrity failed/);
  writeFileSync(join(f.run.integrationCwd, 'frontend/client.mjs'), 'tampered');
  assert.throws(() => prepareDockerStack({ stateDir: f.stateDir, run: f.run }), /stale/);
});

test('Docker smoke recipes have independent names and an explicit acceptance service', () => {
  const a = fixture(), b = fixture();
  const first = prepareDockerStack({ stateDir: a.stateDir, run: a.run, profile: 'smoke' });
  const second = prepareDockerStack({ stateDir: b.stateDir, run: b.run, profile: 'smoke' });
  assert.notEqual(first.projectName, second.projectName);
  const compose = JSON.parse(readFileSync(first.composeFile));
  assert.deepEqual(compose.services.tests.profiles, ['test']);
  assert.deepEqual(compose.services.tests.command, ['node', '--test', 'docker/acceptance.test.mjs']);
  assert.equal(compose.services.tests.environment.FRONTEND_URL, 'http://frontend:3000');
  assert.ok(first.commands.test.includes('--rm'));
});

test('Docker export rejects symbolic-link storage and context tampering', () => {
  const f = fixture(); mkdirSync(join(f.root, 'elsewhere')); symlinkSync(join(f.root, 'elsewhere'), join(f.stateDir, 'docker'));
  assert.throws(() => prepareDockerStack({ stateDir: f.stateDir, run: f.run }), /symbolic links/);
  const g = fixture(), result = prepareDockerStack({ stateDir: g.stateDir, run: g.run });
  symlinkSync('/does-not-exist', join(result.directory, 'context', 'dangling-link'));
  assert.throws(() => prepareDockerStack({ stateDir: g.stateDir, run: g.run }), /symbolic links/);
});
