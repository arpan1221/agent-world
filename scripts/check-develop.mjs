import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceManager } from '../src/workspaces.mjs';

if (!process.argv[2]) throw Error('Usage: node scripts/check-develop.mjs /absolute/path/to/repository');
const cwd = realpathSync(process.argv[2]), stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'aw-develop-check-')));
const git = (path, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: path, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const before = { head: git(cwd, ['rev-parse', 'HEAD']), status: git(cwd, ['status', '--porcelain']) };
const run = { id: randomUUID(), cwd, paired: { base: { ref: 'develop', remote: 'origin', refresh: true } }, assignments: [{ id: randomUUID(), role: 'developer', lane: 'frontend', provider: 'codex', allowedPaths: ['frontend/'] }, { id: randomUUID(), role: 'developer', lane: 'backend', provider: 'claude', allowedPaths: ['backend/'] }] };
new WorkspaceManager(stateDir).provision(run);
const worktrees = [...run.assignments.map(a => ({ lane: a.lane, provider: a.provider, path: a.workspace })), { lane: 'integration', path: run.integrationCwd }];
for (const entry of worktrees) { entry.commit = git(entry.path, ['rev-parse', 'HEAD']); assert.equal(entry.commit, run.baseCommit); assert.equal(git(entry.path, ['status', '--porcelain']), ''); }
assert.equal(run.baseCommit, git(cwd, ['rev-parse', 'origin/develop']));
assert.equal(before.head, git(cwd, ['rev-parse', 'HEAD'])); assert.equal(before.status, git(cwd, ['status', '--porcelain']));
const report = { ok: true, repository: cwd, baseRef: run.baseRef, baseCommit: run.baseCommit, fetchedAt: run.baseFetchedAt, originalCheckoutUnchanged: true, modelSessionsLaunched: 0, worktrees };
const file = join(stateDir, 'develop-check.json'); writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, report: file }, null, 2));
