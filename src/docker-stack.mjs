import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { WorkspaceManager } from './workspaces.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const excluded = path => path.split('/').some(part => /^(?:\.env.*|node_modules|\.git|dist|coverage|\.npmrc|\.netrc|\.aws|\.ssh|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part)) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(path);
function safe(root, path) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe Docker export path.');
  if (realpathSync(root) !== resolve(root) || lstatSync(root).isSymbolicLink()) throw Error('Docker storage root must not use symbolic links.');
  let current = root;
  for (const part of path.split('/')) { current = join(current, part); let stat; try { stat = lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (stat?.isSymbolicLink()) throw Error('Docker export must not contain symbolic links.'); }
  return current;
}
function manifest(directory) {
  const files = [];
  const visit = (root, prefix = '') => { for (const name of readdirSync(root).sort()) { const path = prefix ? `${prefix}/${name}` : name; if (!prefix && ['manifest.json', 'frontend.test.env', 'backend.test.env'].includes(name)) continue; const file = safe(directory, path), stat = lstatSync(file); if (stat.isDirectory()) visit(file, path); else if (stat.isFile()) files.push([path, stat.mode & 0o111 ? '100755' : '100644', hash(readFileSync(file))]); else throw Error('Docker export contains a nonregular file.'); } };
  visit(directory); return files;
}
const health = (port, path) => ({ test: ['CMD', 'node', '-e', `fetch('http://127.0.0.1:${port}${path}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`], interval: '3s', timeout: '3s', retries: 30, start_period: '10s' });
const loopback = [{ target: 3000, host_ip: '127.0.0.1', protocol: 'tcp' }];
const dockerIgnore = '**/node_modules\n**/.git\n**/.env*\n**/dist\n**/coverage\n**/*.pem\n**/*.key\n';
const instructions = `# Isolated integration Docker stack

This recipe contains a sanitized copy of the exact integrated revision, not live developer worktrees. Do not edit the exported context: regenerate after a new integration. Test results apply only to its recorded integration ID/tree hash. No model session or Docker service was launched by preparation.

App profile: create backend.test.env and frontend.test.env in this directory yourself. These files are deliberately missing and are NOT build context. Declare the environment variables your own stack requires (database URL, auth keys, third-party tokens, etc.) in these files. Use a dedicated test database and dedicated test credentials with the necessary schema and an approved test user. Never reuse a production database or copy a live .env blindly. Keep external mail, chat, storage, tracing and cron integrations unconfigured unless specifically testing them. Auth is not bypassed. A public health response is NOT an authenticated endpoint acceptance test.

Only frontend, API and private Redis are enabled. Frontend proxies to this stack's API through its private network. No Docker socket, source bind mounts, fixed container names, host API/Redis ports, or live checkout .env are used. Frontend host port is assigned dynamically; use the printed port command. Use rebuild after a new integration; do not accept stale images or skipped tests as passing. Acceptance requires an explicit pinned gate/test command; this recipe does not claim tests passed.
`;

/** Prepare immutable inputs and argv-only commands; never executes Docker or loads user secrets. */
export function prepareDockerStack({ stateDir, run, profile = 'app' }) {
  if (!['app', 'smoke'].includes(profile)) throw Error('Unknown Docker stack profile.');
  if (!run?.paired?.approvedAt || !run.integration || run.integration.invalidatedAt || run.integration.contractHash !== run.paired.approvalHash) throw Error('Docker preparation requires the current approved integration.');
  const workspaces = new WorkspaceManager(stateDir);
  if (workspaces.treeHash(run) !== run.integration.treeHash) throw Error('Integration snapshot is stale; Docker export refused.');
  const root = realpathSync(stateDir), runKey = hash(run.id), integrationKey = hash(run.integration.id);
  const directory = safe(root, `docker/${runKey}/${integrationKey}/${profile}`);
  const projectName = `aw-${runKey.slice(0, 12)}-${integrationKey.slice(0, 12)}-${profile}`;
  const composeFile = join(directory, 'compose.json'), manifestFile = join(directory, 'manifest.json');
  if (existsSync(directory)) {
    if (!existsSync(manifestFile)) throw Error('Incomplete Docker export exists; inspect it before preparing a new revision.');
    const saved = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (saved.integrationId !== run.integration.id || saved.treeHash !== run.integration.treeHash || saved.contractHash !== run.paired.approvalHash || saved.profile !== profile || JSON.stringify(saved.files) !== JSON.stringify(manifest(directory))) throw Error('Docker export integrity failed; existing files were altered.');
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const write = (path, data, mode = 0o600) => { const target = safe(directory, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, data, { flag: 'wx', mode }); };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const tracked = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'ls-tree', '-r', '--name-only', '-z', run.baseCommit], { cwd: run.integrationCwd, maxBuffer: 32 * 1024 * 1024, timeout: 30000, env: { ...env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().split('\0').filter(Boolean);
    let total = 0;
    for (const path of [...new Set([...tracked, ...(run.integration.managedPaths || [])])].sort()) {
      if (excluded(path) || (profile === 'app' && !path.startsWith('frontend/') && !path.startsWith('backend/')) || path.endsWith('/.dockerignore') || path === '.dockerignore') continue;
      const source = safe(run.integrationCwd, path); if (!existsSync(source)) continue;
      const stat = lstatSync(source); if (!stat.isFile()) throw Error('Docker export only supports regular source files.');
      total += stat.size; if (total > 256 * 1024 * 1024) throw Error('Docker export exceeds 256 MB.');
      write(`context/${path}`, readFileSync(source), stat.mode & 0o111 ? 0o700 : 0o600);
    }
    if (workspaces.treeHash(run) !== run.integration.treeHash) throw Error('Integration changed during Docker preparation.');
    let compose;
    if (profile === 'app') {
      for (const path of ['frontend/Dockerfile.dev', 'backend/apps/api/Dockerfile.dev']) if (!existsSync(join(directory, 'context', path))) throw Error(`App profile requires ${path}.`);
      write('context/frontend/.dockerignore', dockerIgnore); write('context/backend/.dockerignore', dockerIgnore);
      compose = { services: {
        redis: { image: 'redis:7-alpine', healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '3s', timeout: '3s', retries: 20 } },
        api: { build: { context: './context/backend', dockerfile: 'apps/api/Dockerfile.dev' }, env_file: ['./backend.test.env'], environment: { NODE_ENV: 'development', PORT: '3001', REDIS_URL: 'redis://redis:6379', RUN_EXTRACTION_IN_API: 'false', LANGSMITH_ENABLED: 'false', LANGSMITH_TRACING: 'false' }, depends_on: { redis: { condition: 'service_healthy' } }, healthcheck: health(3001, '/api/health') },
        frontend: { build: { context: './context/frontend', dockerfile: 'Dockerfile.dev' }, env_file: ['./frontend.test.env'], environment: { API_PROXY_TARGET: 'http://api:3001', VITE_API_URL: '/api', VITE_INTELLIGENCE_WS_URL: 'disabled' }, ports: loopback, depends_on: { api: { condition: 'service_healthy' } }, healthcheck: health(3000, '/') },
      } };
    } else {
      for (const path of ['docker/api.mjs', 'docker/frontend.mjs', 'docker/acceptance.test.mjs']) if (!existsSync(join(directory, 'context', path))) throw Error(`Smoke profile requires ${path}.`);
      write('context/.dockerignore', dockerIgnore); write('context/Dockerfile.agent-world', 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\n');
      const build = { context: './context', dockerfile: 'Dockerfile.agent-world' };
      compose = { services: {
        api: { build, command: ['node', 'docker/api.mjs'], environment: { PORT: '3001' }, healthcheck: health(3001, '/health') },
        frontend: { build, command: ['node', 'docker/frontend.mjs'], environment: { PORT: '3000', API_PROXY_TARGET: 'http://api:3001' }, ports: loopback, depends_on: { api: { condition: 'service_healthy' } }, healthcheck: health(3000, '/') },
        tests: { build, profiles: ['test'], command: ['node', '--test', 'docker/acceptance.test.mjs'], environment: { FRONTEND_URL: 'http://frontend:3000' }, depends_on: { frontend: { condition: 'service_healthy' }, api: { condition: 'service_healthy' } } },
      } };
    }
    write('compose.json', JSON.stringify(compose, null, 2) + '\n'); write('README.md', instructions);
    write('manifest.json', JSON.stringify({ integrationId: run.integration.id, treeHash: run.integration.treeHash, contractHash: run.paired.approvalHash, baseCommit: run.baseCommit, profile, files: manifest(directory) }, null, 2) + '\n');
  }
  const base = ['docker', 'compose', '--project-name', projectName, '--file', composeFile];
  return { directory, composeFile, projectName, integrationId: run.integration.id, treeHash: run.integration.treeHash, profile, commands: {
    up: [...base, 'up', '-d', '--build', '--wait'], ps: [...base, 'ps'], port: [...base, 'port', 'frontend', '3000'], logs: [...base, 'logs', '--tail', '100'], down: [...base, 'down'],
    ...(profile === 'smoke' ? { test: [...base, '--profile', 'test', 'run', '--rm', '--build', 'tests'] } : {}),
  } };
}
