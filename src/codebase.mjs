import { promises as fs, constants, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, extname, resolve, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', '__pycache__', 'venv', 'env', 'secrets', 'credentials', 'fixtures', 'generated', 'tmp', 'old_backend']);
const extensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.vue', '.svelte', '.sql', '.prisma', '.css', '.scss']);
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
function groupFor(path) {
  const parts = path.split('/'), dirs = parts.slice(0, -1);
  const feature = dirs.findIndex(p => ['features', 'modules', 'packages', 'apps'].includes(p));
  if (feature >= 0 && dirs[feature + 1]) return dirs.slice(0, feature + 2).join('/');
  const src = dirs.indexOf('src');
  if (src >= 0) return dirs.slice(0, Math.min(dirs.length, src + 2)).join('/') || 'root';
  return dirs.slice(0, 2).join('/') || 'root';
}
function classify(paths) {
  const rules = [['test-chamber', /test|spec|__tests__/i], ['database', /\.sql$|\.prisma$|migration|schema|database/i], ['interface', /\.tsx$|\.jsx$|\.vue$|\.svelte$|\.css$|\.scss$|component|frontend/i], ['pipeline', /pipeline|ingest|etl|worker|queue/i], ['service', /service|controller|route|server|backend|api/i]];
  const counts = rules.map(([kind, pattern]) => ({ kind, count: paths.filter(p => pattern.test(p)).length }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count ? { kind: counts[0].kind, reason: `${counts[0].count} of ${paths.length} source paths match ${counts[0].kind} naming or extension rules` } : { kind: 'workshop', reason: 'Source directory; no specific component role detected' };
}

export async function scanCodebase(input, limits = {}) {
  const root = await fs.realpath(input), maxFiles = limits.maxFiles ?? 4000, maxBytes = limits.maxBytes ?? 16 * 1024 * 1024;
  if (root === '/' || root === homedir() || !(await fs.stat(root)).isDirectory()) throw Error('Choose a project directory, not a filesystem or home root.');
  const markers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'src'];
  const hasMarker = async dir => (await Promise.all(markers.map(async name => {
    try { const stat = await fs.lstat(join(dir, name)); return !stat.isSymbolicLink() && (name === 'src' ? stat.isDirectory() : stat.isFile()); } catch { return false; }
  }))).some(Boolean);
  let sourceRoots = [root];
  if (!await hasMarker(root)) {
    // A repository may contain independent runtimes without a root manifest.
    // Search conventional workspace containers only; never sweep unrelated repos.
    sourceRoots = [];
    const containers = ['frontend', 'backend', 'client', 'server', 'apps', 'packages', 'services'];
    const queue = containers.map(name => ({ dir: join(root, name), depth: 0 }));
    let discovered = 0;
    while (queue.length && discovered++ < 256) {
      const { dir, depth } = queue.shift();
      let stat; try { stat = await fs.lstat(dir); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await fs.realpath(dir))) continue;
      if (await hasMarker(dir)) { sourceRoots.push(dir); continue; }
      if (depth >= 2) continue;
      for await (const entry of await fs.opendir(dir)) {
        if (queue.length >= 256) throw Error('Workspace discovery limit reached; select a smaller project directory.');
        if (entry.isDirectory() && !entry.name.startsWith('.') && !excluded.has(entry.name) && !/secret|credential|private.?key/i.test(entry.name)) queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
    if (!sourceRoots.length) throw Error('No supported project marker found. Choose a package directory or a repository with frontend, backend, apps, packages or services workspaces.');
    // Incomplete discovery must never retire previously mapped components.
    if (queue.length) throw Error('Workspace discovery limit reached; select a smaller project directory.');
  }
  const files = new Map(), warnings = [], stack = [...sourceRoots].reverse(); let bytes = 0, complete = true, entries = 0;
  while (stack.length) {
    if (entries >= 20000) { complete = false; break; }
    const dir = stack.pop(); let list;
    try {
      if (!inside(root, await fs.realpath(dir))) throw Error('Directory left project root'); list = [];
      for await (const entry of await fs.opendir(dir)) { if (list.length >= 20000 - entries) { complete = false; break; } list.push(entry); }
    } catch { complete = false; warnings.push('A directory was unreadable; missing components will be retained.'); continue; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of list) {
      if (++entries > 20000 || files.size >= maxFiles || bytes >= maxBytes) { complete = false; stack.length = 0; break; }
      if (entry.name.startsWith('.') || excluded.has(entry.name) || /secret|credential|private.?key|\.min\./i.test(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(path); continue; }
      if (!entry.isFile() || !extensions.has(extname(path)) || /\.d\.ts$/.test(path)) continue;
      let handle;
      try {
        if (!inside(root, await fs.realpath(path))) continue;
        handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 256 * 1024 || bytes + stat.size > maxBytes) { complete = false; continue; }
        const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), after = await handle.stat();
        if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) { complete = false; continue; }
        const data = buffer.subarray(0, bytesRead); bytes += data.length;
        if (data.includes(0)) continue;
        const rel = relative(root, path).split('\\').join('/');
        files.set(rel, { path: rel, group: groupFor(rel), sha256: hash(data), bytes: data.length, text: data.toString('utf8') });
      } catch { complete = false; warnings.push('A source file was unreadable; missing components will be retained.'); } finally { await handle?.close(); }
    }
  }
  const projectId = hash(root).slice(0, 20), groups = new Map();
  for (const f of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); }
  const facts = [], idFor = group => `code:${projectId}:${group}`;
  let unresolvedImports = 0, resolvedImports = 0;
  if (groups.size > 256) { complete = false; warnings.push('Component limit reached (256); select a smaller project root for the remaining components.'); }
  for (const [group, members] of [...groups].slice(0, 256)) {
    const deps = new Set(), links = [];
    for (const f of members) {
      if (!/\.[cm]?[jt]sx?$/.test(f.path)) continue;
      // Conservative static literals only. No import evaluation or project execution.
      const text = f.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const rx = /\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const match of text.matchAll(rx)) {
        const spec = match[1] || match[2]; if (!spec.startsWith('.')) { unresolvedImports++; continue; }
        const base = relative(root, resolve(root, dirname(f.path), spec)).split('\\').join('/');
        const stem = base.replace(/\.[cm]?js$/, '');
        const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(e => base + e), stem + '.ts', stem + '.tsx', ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map(n => base + '/' + n)];
        const target = candidates.map(p => files.get(p)).find(Boolean);
        if (!target) { unresolvedImports++; continue; } resolvedImports++;
        if (target.group !== group) { deps.add(idFor(target.group)); if (links.length < 50) links.push({ from: f.path, to: target.path }); }
      }
    }
    const type = classify(members.map(f => f.path));
    facts.push({ id: idFor(group), title: `${basename(root)} / ${group}`, sessionId: null, project: root, projectId, role: 'architecture', kind: type.kind, status: 'mapped', authority: 'codebase', attempt: 0, dependencies: [...deps].sort(), evidence: members.slice(0, 20).map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), reviews: [], gate: null, mapping: { directory: group, reason: type.reason, confidence: 'heuristic', fileCount: members.length, digest: hash(members.map(f => f.path + ':' + f.sha256).join('\n')), links } });
  }
  if (!complete) warnings.push('Scan limits or unreadable files caused partial coverage; missing components were not retired.');
  return { projectId, root, sourceRoots: sourceRoots.map(dir => relative(root, dir) || '.'), scannedAt: new Date().toISOString(), complete, files: files.size, bytes, resolvedImports, unresolvedImports, warnings: [...new Set(warnings)], facts };
}

export class CodebaseProjects {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); this.file = join(dir, 'codebase-projects.json');
    this.projects = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : []; this.busy = false; this.watchRevision = 0;
    if (!Array.isArray(this.projects)) throw Error('Invalid codebase project state.');
  }
  save() { writeFileSync(this.file + '.tmp', JSON.stringify(this.projects), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file); }
  async scan(root, watch, ledger) {
    if (this.busy) throw Error('A project scan is already running.'); this.busy = true; const watchRevision = this.watchRevision;
    try {
      const report = await scanCodebase(root), ids = new Set(report.facts.map(f => f.id));
      const retired = report.complete ? [...ledger.latest.values()].filter(f => f.authority === 'codebase' && f.projectId === report.projectId && !ids.has(f.id) && f.status !== 'retired').map(f => ({ ...f, status: 'retired', dependencies: [] })) : [];
      ledger.record([...report.facts, ...retired], 'codebase-scan');
      const previous = this.projects.find(p => p.projectId === report.projectId);
      const { facts, ...summary } = report, record = { ...summary, components: facts.length, watch: previous && watchRevision !== this.watchRevision ? previous.watch : !!watch };
      const old = this.projects.findIndex(p => p.projectId === report.projectId); if (old < 0) this.projects.push(record); else this.projects[old] = record;
      this.save(); return record;
    } finally { this.busy = false; }
  }
  setWatch(id, enabled) { const p = this.projects.find(p => p.projectId === id); if (!p) throw Error('Project not found.'); p.watch = !!enabled; this.watchRevision++; this.save(); }
  async refresh(ledger) {
    for (const id of this.projects.map(p => p.projectId)) {
      const project = this.projects.find(p => p.projectId === id); if (!project?.watch) continue;
      try { await this.scan(project.root, true, ledger); } catch (e) { project.lastError = e.message; }
    }
  }
}
