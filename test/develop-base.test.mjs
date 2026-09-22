import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../src/workspaces.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

test('fetch latest develop, not feature HEAD or stale tracking ref; all three worktrees share pinned SHA', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-develop-base-')), origin = join(root, 'origin.git'), seed = join(root, 'seed'), project = join(root, 'project');
  mkdirSync(seed); git(root, ['init', '--bare', origin]); git(seed, ['init', '-b', 'develop']);
  writeFileSync(join(seed, 'base.txt'), 'old develop'); git(seed, ['add', '.']); git(seed, ['commit', '-m', 'old']); git(seed, ['remote', 'add', 'origin', origin]); git(seed, ['push', 'origin', 'develop']);
  git(root, ['clone', '-b', 'develop', origin, project]);
  const stale = git(project, ['rev-parse', 'origin/develop']);
  git(project, ['checkout', '-b', 'feature/dirty']); writeFileSync(join(project, 'feature.txt'), 'feature only'); git(project, ['add', '.']); git(project, ['commit', '-m', 'feature']); writeFileSync(join(project, 'dirty.txt'), 'preserve me');
  writeFileSync(join(seed, 'base.txt'), 'fresh develop'); git(seed, ['add', '.']); git(seed, ['commit', '-m', 'fresh']); git(seed, ['push', 'origin', 'develop']); const latest = git(seed, ['rev-parse', 'HEAD']);
  assert.notEqual(stale, latest); const featureHead = git(project, ['rev-parse', 'HEAD']);
  const run = { id: 'base-test', cwd: project, paired: { base: { ref: 'develop', remote: 'origin', refresh: true } }, assignments: ['frontend', 'backend'].map(id => ({ id, role: 'developer', allowedPaths: [id + '/'] })) };
  new WorkspaceManager(join(root, 'state')).provision(run);
  assert.equal(run.baseCommit, latest); assert.equal(run.baseRef, 'refs/remotes/origin/develop'); assert.ok(run.baseFetchedAt);
  for (const cwd of [...run.assignments.map(a => a.workspace), run.integrationCwd]) { assert.equal(git(cwd, ['rev-parse', 'HEAD']), latest); assert.equal(git(cwd, ['status', '--porcelain']), ''); assert.equal(readFileSync(join(cwd, 'base.txt'), 'utf8'), 'fresh develop'); }
  assert.equal(git(project, ['rev-parse', 'HEAD']), featureHead); assert.equal(readFileSync(join(project, 'dirty.txt'), 'utf8'), 'preserve me');
  git(project, ['remote', 'set-url', 'origin', join(root, 'missing-remote')]);
  assert.throws(() => new WorkspaceManager(join(root, 'state2')).provision({ ...run, id: 'offline', baseCommit: undefined }), /fetch|repository/);
});
