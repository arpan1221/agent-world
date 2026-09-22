import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const git = (cwd, args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Fetch must use the owner's configured credential helper; never extract/store tokens.
  // Local tree operations still ignore global configuration and all operations disable hooks.
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 30000, env: { ...env, GIT_CONFIG_COUNT: '0', ...(args[0] === 'fetch' ? {} : { GIT_CONFIG_GLOBAL: '/dev/null' }), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
};
const lines = bytes => bytes.toString().split('\0').filter(Boolean);
const cleanPath = path => {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw Error('Unsafe workspace path.');
  return path;
};
function safeFile(root, path) {
  cleanPath(path); let current = root;
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== resolve(root)) throw Error('Workspace root must not be a symbolic link.');
  for (const part of path.split('/')) { current = join(current, part); let stat; try { stat = lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (stat?.isSymbolicLink()) throw Error('Symbolic links are not supported in managed workspaces.'); }
  return current;
}
const manifestHash = snapshot => digest(JSON.stringify({ baseCommit: snapshot.baseCommit, files: snapshot.files.map(({ path, sha256, deleted, mode }) => ({ path, sha256, deleted, mode })) }));

export class WorkspaceManager {
  constructor(stateDir) { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); this.root = join(realpathSync(stateDir), 'workspaces'); this.blobs = join(realpathSync(stateDir), 'workspace-blobs'); mkdirSync(this.root, { recursive: true, mode: 0o700 }); mkdirSync(this.blobs, { recursive: true, mode: 0o700 }); if (lstatSync(this.root).isSymbolicLink() || lstatSync(this.blobs).isSymbolicLink()) throw Error('Managed storage must not use symbolic links.'); }
  provision(run) {
    const repository = realpathSync(run.cwd), root = realpathSync(git(repository, ['rev-parse', '--show-toplevel']).toString().trim());
    if (root !== repository) throw Error('Choose the repository root for paired worktrees.');
    const base = run.paired?.base;
    let ref = 'HEAD';
    if (base) {
      git(root, ['check-ref-format', `refs/heads/${base.ref}`]);
      ref = base.remote ? `refs/remotes/${base.remote}/${base.ref}` : `refs/heads/${base.ref}`;
      if (base.refresh) {
        git(root, ['fetch', '--no-tags', '--no-recurse-submodules', base.remote, `+refs/heads/${base.ref}:${ref}`]);
        run.baseFetchedAt = new Date().toISOString();
      }
    }
    const commit = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
    if (run.baseCommit && run.baseCommit !== commit) throw Error('Base branch changed after workspace provisioning; create a new approved run.');
    run.baseRef = ref;
    for (const item of lines(git(root, ['ls-tree', '-rz', commit]))) { const split = item.indexOf('\t'), info = item.slice(0, split), path = item.slice(split + 1); cleanPath(path); if (!info.startsWith('100644 ') && !info.startsWith('100755 ')) throw Error('Paired worktrees do not support baseline symlinks or submodules.'); }
    run.baseCommit = commit; run.repositoryRoot = root;
    const home = join(this.root, digest(run.id)); mkdirSync(home, { recursive: true, mode: 0o700 });
    const make = name => { const path = safeFile(this.root, `${digest(run.id)}/${name}`); if (!existsSync(path)) git(root, ['worktree', 'add', '--detach', path, commit]); else if (git(path, ['rev-parse', 'HEAD']).toString().trim() !== commit) throw Error('Managed workspace base changed.'); return path; };
    for (const assignment of run.assignments.filter(a => a.role === 'developer')) { if (!Array.isArray(assignment.allowedPaths) || !assignment.allowedPaths.length) throw Error('Developer ownership paths are required.'); assignment.allowedPaths.forEach(p => cleanPath(p.replace(/\/$/, ''))); assignment.workspace = make(digest(assignment.id)); }
    run.integrationCwd = make('integration'); run.integrationBaseHash ||= this.treeHash(run);
    return run;
  }
  validateWorkspace(run, cwd) {
    if (!cwd || !relative(this.root, cwd) || relative(this.root, cwd).startsWith('..') || isAbsolute(relative(this.root, cwd))) throw Error('Workspace is outside managed storage.');
    safeFile(this.root, relative(this.root, cwd));
    if (git(cwd, ['rev-parse', '--show-toplevel']).toString().trim() !== cwd) throw Error('Invalid managed worktree.');
    if (!/^[a-f0-9]{40,64}$/.test(run.baseCommit || '')) throw Error('Missing workspace base commit.');
  }
  changed(run, cwd) { this.validateWorkspace(run, cwd); return [...new Set([...lines(git(cwd, ['diff', '--no-renames', '--name-only', '-z', run.baseCommit, '--'])), ...lines(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))])].sort(); }
  capture(run, assignment) {
    const cwd = assignment.workspace, paths = this.changed(run, cwd); if (paths.length > 400) throw Error('Submission exceeds 400 changed files.');
    let total = 0; const files = paths.map(path => {
      cleanPath(path); if (!assignment.allowedPaths.some(prefix => { const p = cleanPath(prefix.replace(/\/$/, '')); return path === p || path.startsWith(p + '/'); })) throw Error(`Ownership violation: ${path}`);
      const file = safeFile(cwd, path);
      if (!existsSync(file)) return { path, sha256: null, deleted: true, mode: null };
      const stat = lstatSync(file); if (!stat.isFile()) throw Error('Only regular files can be submitted.'); total += stat.size; if (total > 8 * 1024 * 1024) throw Error('Submission exceeds 8 MB.');
      const bytes = readFileSync(file); total += bytes.length - stat.size; if (total > 8 * 1024 * 1024) throw Error('Submission exceeds 8 MB.'); const sha256 = digest(bytes), blob = safeFile(this.blobs, sha256); if (!existsSync(blob)) writeFileSync(blob, bytes, { mode: 0o600, flag: 'wx' });
      return { path, sha256, deleted: false, mode: stat.mode & 0o111 ? '100755' : '100644', blob };
    });
    const snapshot = { id: randomUUID(), baseCommit: run.baseCommit, files }; snapshot.hash = manifestHash(snapshot); return snapshot;
  }
  integrate(run) {
    this.validateWorkspace(run, run.integrationCwd);
    if (this.treeHash(run) !== (run.integration?.hash || run.integrationBaseHash)) throw Error('Integration workspace changed; preserve and inspect it before rebuilding.');
    const snapshots = run.assignments.filter(a => a.role === 'developer').map(a => {
      const s = run.submissions.find(s => s.id === a.submissionId)?.snapshot;
      if (!s || s.baseCommit !== run.baseCommit || manifestHash(s) !== s.hash) throw Error('Missing or altered submission snapshot.'); return s;
    });
    const writes = new Map();
    for (const snapshot of snapshots) for (const file of snapshot.files) {
      cleanPath(file.path); if (writes.has(file.path)) throw Error(`Integration conflict: ${file.path}`); safeFile(run.integrationCwd, file.path);
      let bytes = null; if (!file.deleted) { if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid snapshot blob hash.'); bytes = readFileSync(safeFile(this.blobs, file.sha256)); if (digest(bytes) !== file.sha256) throw Error('Snapshot blob integrity failed.'); }
      writes.set(file.path, { ...file, bytes });
    }
    const baselineEntries = new Map(lines(git(run.integrationCwd, ['ls-tree', '-rz', run.baseCommit])).map(item => { const split = item.indexOf('\t'); return [item.slice(split + 1), item.slice(0, split).split(' ')]; }));
    // Restore only paths managed by the previous integration, never the original checkout.
    for (const path of run.integration?.managedPaths || []) {
      const file = safeFile(run.integrationCwd, path), entry = baselineEntries.get(path);
      if (!entry) { if (existsSync(file)) unlinkSync(file); } else { const baseline = git(run.integrationCwd, ['cat-file', 'blob', entry[2]]); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, baseline); chmodSync(file, entry[0] === '100755' ? 0o755 : 0o644); }
    }
    for (const [path, file] of writes) { const target = safeFile(run.integrationCwd, path); if (file.deleted) { if (existsSync(target)) unlinkSync(target); } else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.bytes); chmodSync(target, file.mode === '100755' ? 0o755 : 0o644); } }
    return { id: randomUUID(), hash: this.treeHash(run), cwd: run.integrationCwd, snapshotIds: snapshots.map(s => s.id), managedPaths: [...writes.keys()] };
  }
  treeHash(run) {
    const cwd = run.integrationCwd; this.validateWorkspace(run, cwd);
    const paths = [...new Set([...lines(git(cwd, ['ls-tree', '-r', '--name-only', '-z', run.baseCommit])), ...lines(git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))])].sort();
    const hash = createHash('sha256'); for (const path of paths) { const file = safeFile(cwd, path); if (!existsSync(file)) { hash.update(JSON.stringify([path, 'deleted'])); continue; } const stat = lstatSync(file); if (!stat.isFile()) throw Error('Integration contains a nonregular file.'); hash.update(JSON.stringify([path, stat.mode & 0o111 ? '100755' : '100644', digest(readFileSync(file))])); } return hash.digest('hex');
  }
}
