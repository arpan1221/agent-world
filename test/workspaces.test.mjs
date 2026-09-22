import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../src/workspaces.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'world-workspaces-test-')), repo = join(dir, 'repo'); mkdirSync(repo);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: 'pipe' });
  git(['init']); mkdirSync(join(repo, 'frontend')); mkdirSync(join(repo, 'backend'));
  writeFileSync(join(repo, 'frontend/app.js'), 'initial frontend'); writeFileSync(join(repo, 'backend/api.js'), 'initial backend');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture baseline']);
  const manager = new WorkspaceManager(join(dir, 'state'));
  const run = { id: 'fixture', cwd: repo, assignments: [{ id: 'front', role: 'developer', allowedPaths: ['frontend'] }, { id: 'back', role: 'developer', allowedPaths: ['backend'] }], submissions: [] };
  manager.provision(run); return { manager, run, repo, front: run.assignments[0], back: run.assignments[1] };
}
function submit(manager, run, assignment) { const snapshot = manager.capture(run, assignment), id = assignment.id + '-' + run.submissions.length; run.submissions.push({ id, snapshot }); assignment.submissionId = id; return snapshot; }

test('real detached worktrees capture edits, untracked files, deletions and integrate without changing original checkout', () => {
  const { manager, run, repo, front, back } = fixture(); assert.notEqual(front.workspace, back.workspace);
  writeFileSync(join(front.workspace, 'frontend/app.js'), 'new frontend'); writeFileSync(join(front.workspace, 'frontend/new.js'), 'new file'); unlinkSync(join(back.workspace, 'backend/api.js'));
  submit(manager, run, front); submit(manager, run, back); run.integration = manager.integrate(run);
  assert.equal(readFileSync(join(run.integrationCwd, 'frontend/app.js'), 'utf8'), 'new frontend');
  assert.equal(readFileSync(join(run.integrationCwd, 'frontend/new.js'), 'utf8'), 'new file');
  assert.throws(() => readFileSync(join(run.integrationCwd, 'backend/api.js')), /ENOENT/);
  assert.equal(readFileSync(join(repo, 'frontend/app.js'), 'utf8'), 'initial frontend'); assert.equal(readFileSync(join(repo, 'backend/api.js'), 'utf8'), 'initial backend');
  assert.equal(run.integration.hash, manager.treeHash(run)); writeFileSync(join(run.integrationCwd, 'frontend/app.js'), 'tampered'); assert.notEqual(run.integration.hash, manager.treeHash(run)); assert.throws(() => manager.integrate(run), /workspace changed/);
});
test('ownership and symbolic-link escapes are rejected', () => {
  const { manager, run, front } = fixture(); writeFileSync(join(front.workspace, 'backend/api.js'), 'forbidden'); assert.throws(() => manager.capture(run, front), /Ownership violation/);
  writeFileSync(join(front.workspace, 'backend/api.js'), 'initial backend'); symlinkSync('/does-not-exist', join(front.workspace, 'frontend/link')); assert.throws(() => manager.capture(run, front), /Symbolic links/);
});
test('captured content stays stable after developer edits and blob tampering blocks integration', () => {
  const { manager, run, front, back } = fixture(); writeFileSync(join(front.workspace, 'frontend/app.js'), 'submitted'); const snapshot = submit(manager, run, front); submit(manager, run, back);
  writeFileSync(join(front.workspace, 'frontend/app.js'), 'later edits'); run.integration = manager.integrate(run); assert.equal(readFileSync(join(run.integrationCwd, 'frontend/app.js'), 'utf8'), 'submitted');
  writeFileSync(snapshot.files[0].blob, 'corrupted'); assert.throws(() => manager.integrate(run), /integrity/);
});
test('overlapping captures conflict and unapproved integration edits are preserved', () => {
  const { manager, run, front, back } = fixture(); back.allowedPaths = ['frontend']; writeFileSync(join(front.workspace, 'frontend/app.js'), 'one'); writeFileSync(join(back.workspace, 'frontend/app.js'), 'two'); submit(manager, run, front); submit(manager, run, back); assert.throws(() => manager.integrate(run), /Integration conflict/);
  writeFileSync(join(run.integrationCwd, 'manual.txt'), 'preserve me'); assert.throws(() => manager.integrate(run), /workspace changed/); assert.equal(readFileSync(join(run.integrationCwd, 'manual.txt'), 'utf8'), 'preserve me');
});
test('replacement snapshots remove only prior managed additions and restore omitted baseline changes', () => {
  const { manager, run, front, back } = fixture(); writeFileSync(join(front.workspace, 'frontend/app.js'), 'first'); writeFileSync(join(front.workspace, 'frontend/new.js'), 'new'); submit(manager, run, front); submit(manager, run, back); run.integration = manager.integrate(run);
  writeFileSync(join(front.workspace, 'frontend/app.js'), 'initial frontend'); unlinkSync(join(front.workspace, 'frontend/new.js')); submit(manager, run, front); run.integration = manager.integrate(run);
  assert.equal(readFileSync(join(run.integrationCwd, 'frontend/app.js'), 'utf8'), 'initial frontend'); assert.throws(() => readFileSync(join(run.integrationCwd, 'frontend/new.js')), /ENOENT/); assert.equal(manager.treeHash(run), run.integrationBaseHash);
});
