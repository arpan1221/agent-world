import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { WorldState } from './state.mjs';
import { AchievementLedger } from './achievements.mjs';
import { compileBlueprint } from './blueprint.mjs';
import { CodebaseProjects } from './codebase.mjs';
import { exportSchematic } from './minecraft.mjs';
import { OrchestrationStore } from './orchestration.mjs';
import { Terminals } from './terminals.mjs';
import { BRAND } from './brand.mjs';
import { computeAnalytics } from './analytics.mjs';
import { PROVIDERS, resolveProviderResumeHandle } from './providers.mjs';
import { runGate } from './gates.mjs';
import { prepareDockerStack } from './docker-stack.mjs';
import { toWorld, demoTopology } from './world.mjs';
import { buildTopology } from '../vendor/cc-topology/topology.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const emptyTopology = () => ({ nodes: [], edges: [], host: 'Local machine', generatedAt: new Date().toISOString() });
const safeJSON = o => JSON.stringify(o).replaceAll('<', '\\u003c');
function readBody(req) { return new Promise((resolveBody, reject) => { let size = 0, body = ''; req.on('data', chunk => { size += chunk.length; if (size > 65536) { reject(Error('Request too large.')); req.destroy(); } else body += chunk; }); req.on('end', () => { try { resolveBody(JSON.parse(body || '{}')); } catch { reject(Error('Invalid JSON.')); } }); req.on('error', reject); }); }
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function startServer({ port = 8791, stateDir, claudeDir, demo = false, binary = 'claude', binaries, externalTmux = [], scan = buildTopology, terminalSpawn, gateRunner = runGate, scanEvery = 5000, codebaseEvery = 30000 }) {
  const state = new WorldState(stateDir), orchestration = new OrchestrationStore(stateDir, { resolveResumeHandle: resolveProviderResumeHandle }), token = randomBytes(32).toString('hex'), hookToken = randomBytes(32).toString('hex'), clients = new Set();
  let topology = demo ? demoTopology() : emptyTopology(), scanning = false, firstScan = true, address;
  const achievements = new AchievementLedger(stateDir), codebases = new CodebaseProjects(stateDir), pairedStates = new Map(); let cachedPlan = null;
  const terminals = new Terminals({ pluginDir: join(root, 'plugin'), stateDir, claudeDir, binaries: binaries || { claude: binary, codex: 'codex', gemini: 'gemini', opencode: 'opencode', qwen: 'qwen', cursor: 'cursor-agent', grok: 'grok' }, mcpScript: join(root, 'plugin/scripts/mcp.mjs'), spawn: terminalSpawn, onChange: (terminal, event) => { if (event === 'exited' && terminal.workerId) orchestration.workerExited(terminal.workerId, terminal.exitCode); broadcast(); } });
  const snapshot = () => {
    const orchestrationView = orchestration.snapshot();
    for (const run of orchestrationView.runs.filter(r => r.paired)) {
      const previous = pairedStates.get(run.id), next = run.paired.state;
      if (previous && previous !== next) state.accept({ id: randomUUID(), type: 'notification', sessionId: run.assignments.find(a => a.sessionId)?.sessionId || 'world-overlord', title: `Paired run · ${next}`, message: run.paired.detail || run.objective });
      pairedStates.set(run.id, next);
    }
    const world = { ...toWorld(topology, state.snapshot(), terminals.list(), orchestrationView), orchestration: orchestrationView, analytics: computeAnalytics({ runs: orchestrationView.runs, terminals: terminals.list() }), app: { demo, scanning, terminals: terminals.list(), pluginPath: join(root, 'plugin'), providers: PROVIDERS, brand: BRAND } };
    achievements.observe(world);
    if (!cachedPlan || cachedPlan.revision !== achievements.data.events.length) cachedPlan = compileBlueprint(achievements.at());
    return { ...world, blueprint: cachedPlan, codebases: codebases.projects };
  };
  function broadcast() { const message = `event: world\ndata: ${JSON.stringify(snapshot())}\n\n`; for (const res of clients) { try { if (res.writableEnded || res.destroyed) { clients.delete(res); continue; } if (res.writableLength > 1024 * 1024) res.end(); else res.write(message); } catch { clients.delete(res); } } }
  for (const terminal of externalTmux) terminals.attachTmux(terminal);
  async function refresh() {
    if (scanning || demo) return;
    scanning = true;
    try {
      const next = await scan({ claudeDir, selfId: 'world-overlord' });
      if (!firstScan) for (const n of next.nodes) { const old = topology.nodes.find(o => o.id === n.id); if (old && (old.status !== n.status || old.live !== n.live)) state.accept({ id: randomUUID(), type: 'session.status', sessionId: n.id, title: `${n.name || n.id.slice(0, 8)} · ${n.status}`, message: 'Observed session status changed.' }); }
      topology = next; firstScan = false;
    } catch (e) { console.error('Session scan failed:', e.message); } finally { scanning = false; broadcast(); }
  }
  function authorized(req, url) { return equal(req.headers.authorization?.replace(/^Bearer /, '') || url.searchParams.get('token'), token); }
  function workerAuth(req) { return orchestration.authenticate(req.headers.authorization?.replace(/^Bearer /, '')); }
  function allowedOrigin(req) { return !req.headers.origin || [`http://127.0.0.1:${address?.port}`, `http://localhost:${address?.port}`].includes(req.headers.origin); }
  function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); }
  function launchAssignment(run, assignment) {
    const issued = orchestration.issueWorker(run.id, assignment.id, null);
    try {
      const terminal = terminals.open({ mode: 'new', cwd: orchestration.pair.cwd(run, assignment), name: `${assignment.role}-${assignment.id.slice(0, 6)}`, prompt: issued.prompt, provider: assignment.provider, model: assignment.model, effort: assignment.effort, role: assignment.role, workerId: issued.worker.id, runId: run.id, workerToken: issued.token, hookToken, agentUrl: `http://127.0.0.1:${address.port}` }, topology.nodes);
      orchestration.bindWorker(run.id, issued.worker.id, terminal.sessionId, terminal.id); return { terminalId: terminal.id, sessionId: terminal.sessionId, workerId: issued.worker.id, assignmentId: assignment.id };
    } catch (error) { orchestration.failLaunch(run.id, issued.worker.id, error.message); throw error; }
  }
  function resumeAssignment(run, assignment, nonce) {
    const issued = orchestration.issueResume(run.id, assignment.id, nonce);
    try {
      const terminal = terminals.resumeManaged({ mode: 'resume', sessionId: issued.ticket.sessionId, cwd: issued.ticket.workspace, name: `${assignment.role}-${assignment.id.slice(0, 6)}`, prompt: issued.prompt, provider: assignment.provider, model: assignment.model, effort: assignment.effort, role: assignment.role, workerId: issued.worker.id, runId: run.id, workerToken: issued.token, hookToken, agentUrl: `http://127.0.0.1:${address.port}` });
      orchestration.bindResume(run.id, issued.worker.id, terminal.sessionId, terminal.id); return { terminalId: terminal.id, sessionId: terminal.sessionId, workerId: issued.worker.id, assignmentId: assignment.id, resumed: true, attempt: assignment.attempt };
    } catch (error) { orchestration.failResume(run.id, issued.worker.id, error.message); throw error; }
  }
  const files = new Map([
    ['/construction.js', [join(root, 'public/construction.js'), 'text/javascript']],
    ['/app.js', [join(root, 'public/app.js'), 'text/javascript']], ['/app.css', [join(root, 'public/app.css'), 'text/css']],
    ['/vendor/three.js', [require.resolve('three/build/three.min.js'), 'text/javascript']],
    ['/vendor/xterm.js', [require.resolve('@xterm/xterm'), 'text/javascript']],
    ['/vendor/xterm.css', [resolve(dirname(require.resolve('@xterm/xterm')), '../css/xterm.css'), 'text/css']],
    ['/vendor/xterm-fit.js', [require.resolve('@xterm/addon-fit'), 'text/javascript']]
  ]);
  const server = createServer(async (req, res) => {
    if (!['127.0.0.1', 'localhost'].some(h => req.headers.host === `${h}:${address?.port}`)) return json(res, 403, { error: 'Unrecognized host.' });
    if (!allowedOrigin(req)) return json(res, 403, { error: 'Cross-origin access denied.' });
    const url = new URL(req.url, 'http://localhost'), path = url.pathname, method = req.method;
    res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY');
    try {
      if (method === 'GET' && path === '/') {
        const html = readFileSync(join(root, 'public/world.html'), 'utf8').replace('__WORLD_JSON__', safeJSON(toWorld(emptyTopology(), { tasks: [], notifications: [], revision: 0 }))).replace('__MC_FONT_B64__', readFileSync(join(root, 'assets/mc.otf')).toString('base64'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" }); return res.end(html);
      }
      if (method === 'GET' && files.has(path)) { const [file, mime] = files.get(path); res.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff' }); return res.end(readFileSync(file)); }
      if (path.startsWith('/agent/')) {
        if (method !== 'POST') return json(res, 405, { error: 'Use POST for worker actions.' });
        const auth = workerAuth(req); if (!auth) return json(res, 401, { error: 'Worker credential is invalid or revoked.' });
        const input = await readBody(req); let result;
        if (path === '/agent/work') result = orchestration.getWork(auth);
        else if (path === '/agent/inbox') result = orchestration.inbox(auth);
        else if (path === '/agent/message') { result = orchestration.send(auth, input); wakeWorker(auth.run, result); }
        else if (path === '/agent/submit' || path === '/agent/review') {
          try { result = path === '/agent/submit' ? orchestration.submit(auth, input) : orchestration.review(auth, input); }
          finally { if (auth.run.paired && auth.worker.revokedAt && auth.worker.terminalId && terminals.items.has(auth.worker.terminalId)) terminals.close(auth.worker.terminalId); }
        }
        else if (path === '/agent/dispatch') {
          orchestration.assertCapability(auth, 'dispatch');
          if (demo) throw Error('Demo mode never launches model sessions.');
          const child = auth.run.assignments.find(a => a.id === input.assignmentId && a.parentAssignmentId === auth.assignment.id);
          if (!child) throw Error('Dispatch is limited to this orchestrator’s pre-approved child assignments.');
          result = child.status === 'running' ? { assignmentId: child.id, workerId: child.workerId, sessionId: child.sessionId, alreadyRunning: true } : launchAssignment(auth.run, child);
        }
        else if (path === '/agent/integrate') { orchestration.assertCapability(auth, 'integrate'); result = orchestration.pair.integrate(auth.run); }
        else return json(res, 404, { error: 'Unknown worker tool.' });
        broadcast(); return json(res, 200, result);
      }
      if (!path.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      if (path === '/api/hooks') {
        if (method !== 'POST' || !equal(req.headers.authorization?.replace(/^Bearer /, ''), hookToken)) return json(res, 401, { error: 'Hook credential is invalid.' });
        const input = await readBody(req); if (state.accept(input)) broadcast(); return json(res, 200, { ok: true });
      }
      if (!authorized(req, url)) return json(res, 401, { error: 'Open the authenticated URL printed by the launcher.' });
      if (method === 'GET' && path === '/api/world') return json(res, 200, snapshot());
      if (method === 'GET' && path === '/api/achievements') { snapshot(); return json(res, 200, { events: achievements.history() }); }
      if (method === 'GET' && path === '/api/blueprint') { snapshot(); return json(res, 200, compileBlueprint(achievements.at(url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined))); }
      if (method === 'GET' && path === '/api/minecraft.schem') {
        snapshot(); const plan = compileBlueprint(achievements.at(Number(url.searchParams.get('revision'))));
        const bytes = exportSchematic(plan);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="agent-world-r${plan.revision}.schem"`, 'cache-control': 'no-store' }); return res.end(bytes);
      }
      if (method === 'GET' && path === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); clients.add(res); res.write(`event: world\ndata: ${JSON.stringify(snapshot())}\n\n`); req.on('close', () => clients.delete(res)); return; }
      if (method === 'GET' && path === '/api/tmux') return json(res, 200, { sessions: terminals.list().map(t => t.sessionId), panes: {}, tmux: false });
      if (method !== 'POST') return json(res, 405, { error: 'Use POST for this action.' });
      const input = await readBody(req);
      if (path === '/api/codebase/scan') { const report = await codebases.scan(input.root, input.watch === true, achievements); broadcast(); return json(res, 200, report); }
      if (path === '/api/codebase/watch') { codebases.setWatch(input.projectId, input.watch === true); broadcast(); return json(res, 200, { ok: true }); }
      if (path === '/api/demo/construction' && demo) {
        const kinds = ['archive', 'blueprint', 'interface', 'service', 'database', 'test-chamber', 'observatory', 'council'];
        const status = ['planned', 'building', 'submitted', 'completed'];
        const old = achievements.latest.get('demo:0'), step = old ? (status.indexOf(old.status) + 1) % status.length : 0;
        achievements.record(kinds.map((kind, i) => ({ id: `demo:${i}`, title: `Demo · ${kind.replaceAll('-', ' ')}`, sessionId: topology.nodes[i]?.id || null, project: 'Fictional system blueprint', role: ['requirements', 'architect', 'developer', 'developer', 'developer', 'tester', 'reviewer', 'council'][i], kind, status: status[step], authority: 'demo', attempt: step === 1 ? 1 : 0, dependencies: i ? [`demo:${i - 1}`] : [], evidence: [], reviews: [], gate: null })), 'demo');
        broadcast(); return json(res, 200, { stage: status[step] });
      }
      if (path === '/api/tasks') { if (!snapshot().sessions.some(s => s.sessionId === input.sessionId)) throw Error('Select a session for this task.'); const task = state.createTask(input); broadcast(); return json(res, 201, task); }
      if (path.startsWith('/api/tasks/')) { const task = state.updateTask(path.slice('/api/tasks/'.length), input); broadcast(); return json(res, 200, task); }
      if (path === '/api/notifications/read') { state.markRead(); broadcast(); return json(res, 200, { ok: true }); }
      if (path === '/api/orchestrations') { const run = orchestration.createRun(input); broadcast(); return json(res, 201, run); }
      const runMatch = path.match(/^\/api\/orchestrations\/([^/]+)\/(launch|resume-worker|launch-wave|message|gate|approve|integrate|recover|rework|docker|handoff|reassign-developer)$/);
      if (runMatch) {
        const [, runId, action] = runMatch, run = orchestration.run(runId);
        if (action === 'handoff') {
          if (demo) throw Error('Demo mode cannot replace live orchestrators.');
          const result = orchestration.pair.handoff(run, input);
          for (const id of result.terminalIds) if (terminals.items.has(id)) terminals.close(id);
          broadcast(); return json(res, 200, result);
        }
        if (action === 'reassign-developer') {
          if (demo) throw Error('Demo mode cannot replace live developers.');
          const result = orchestration.pair.reassignDeveloper(run, input);
          for (const id of result.terminalIds) if (terminals.items.has(id)) terminals.close(id);
          broadcast(); return json(res, 200, result);
        }
        if (action === 'docker') {
          if (demo || !run.paired) throw Error('Docker export requires a real paired integration.');
          orchestration.pair.assertCurrent(run);
          const recipe = prepareDockerStack({ stateDir, run, profile: input.profile || 'app' });
          run.dockerStack = recipe; orchestration.append('docker.prepared', 'user', run.id, { projectName: recipe.projectName, integrationId: recipe.integrationId, treeHash: recipe.treeHash });
          broadcast(); return json(res, 200, recipe);
        }
        if (['approve', 'integrate', 'recover', 'rework'].includes(action)) {
          if (!run.paired) throw Error('This action requires paired mode.');
          if (demo) throw Error('Demo mode cannot provision or mutate execution worktrees.');
          let result;
          if (action === 'approve') { if (input.confirm !== true) throw Error('Explicit approval is required.'); result = orchestration.pair.approve(run, input.approvalHash); }
          if (action === 'integrate') result = orchestration.pair.integrate(run);
          if (action === 'recover') { orchestration.pair.recoverRun(run); result = { status: run.status }; }
          if (action === 'rework') {
            if (orchestration.pair.busy.has(run.id)) throw Error('Wait for the active gate.');
            const target = run.assignments.find(a => a.id === input.assignmentId && a.role === 'developer');
            if (!target || !['submitted', 'challenged', 'accepted', 'ownership-violation', 'interrupted'].includes(target.status)) throw Error('Select a submitted or interrupted developer for rework.');
            if (run.integration) run.integration.invalidatedAt = new Date().toISOString();
            for (const a of run.assignments.filter(a => a.role === 'developer' && a.status === 'accepted')) a.status = 'submitted';
            for (const a of run.assignments.filter(a => ['tester', 'reviewer', 'council'].includes(a.role))) { const w = run.workers.find(w => w.id === a.workerId); if (w) { w.revokedAt = new Date().toISOString(); if (w.terminalId && terminals.items.has(w.terminalId)) terminals.close(w.terminalId); } a.status = 'blocked'; }
            target.status = 'challenged'; orchestration.pair.transition(run, 'challenged', 'Human requested a new implementation attempt.'); result = { status: run.status };
          }
          broadcast(); return json(res, 200, result);
        }
        if (action === 'launch') {
          if (demo) throw Error('Demo mode never launches model sessions.');
          const assignment = run.assignments.find(a => a.id === input.assignmentId); if (!assignment) throw Error('Assignment not found.');
          const launched = launchAssignment(run, assignment); broadcast(); return json(res, 201, launched);
        }
        if (action === 'resume-worker') {
          if (demo) throw Error('Demo mode never resumes model sessions.');
          const assignment = run.assignments.find(a => a.id === input.assignmentId); if (!assignment) throw Error('Assignment not found.');
          const resumed = resumeAssignment(run, assignment, input.nonce); broadcast(); return json(res, 201, resumed);
        }
        if (action === 'launch-wave') { if (demo) throw Error('Demo mode never launches model sessions.'); const ready = run.assignments.filter(a => ['ready', 'challenged'].includes(a.status)); if (!ready.length) throw Error('No assignments are ready.'); const launched = [], failed = []; for (const assignment of ready) { try { launched.push(launchAssignment(run, assignment)); } catch (error) { failed.push({ assignmentId: assignment.id, error: error.message }); } } broadcast(); return json(res, failed.length ? 207 : 201, { launched, failed }); }
        if (action === 'message') { const message = orchestration.sendUser(run.id, input); wakeWorker(run, message); broadcast(); return json(res, 201, message); }
        if (action === 'gate') { if (!input.confirm) throw Error('Trusted gate execution requires explicit confirmation.'); if (run.paired) { if (demo) throw Error('Demo mode cannot execute gates.'); const check = await orchestration.pair.gates(run, gateRunner); broadcast(); return json(res, 200, check); } const result = await gateRunner({ command: input.command, args: input.args, cwd: run.cwd, timeoutMs: input.timeoutMs }); const check = orchestration.recordCheck(run.id, result); broadcast(); return json(res, 200, check); }
      }
      if (path === '/api/demo/event' && demo) { const node = topology.nodes[0]; state.accept({ id: randomUUID(), type: 'notification', sessionId: node.id, title: 'Builder needs your decision', message: 'Demo event: choose the next task from the settlement board.' }); broadcast(); return json(res, 200, { ok: true }); }
      if (path === '/api/terminal/open' || path === '/api/spawn') {
        if (demo) throw Error('Demo mode never launches model sessions. Start without --demo to open a real session.');
        const t = terminals.open({ provider: 'claude', model: 'sonnet', effort: 'high', role: 'developer', hookToken, agentUrl: `http://127.0.0.1:${address.port}`, ...input, mode: path === '/api/spawn' ? 'new' : input.mode }, topology.nodes); broadcast(); return json(res, 201, { ok: true, id: t.id, sessionId: t.sessionId, mode: t.mode });
      }
      if (path === '/api/terminal/close') { terminals.close(input.id); broadcast(); return json(res, 200, { ok: true }); }
      if (path === '/api/command') { if (demo) throw Error('Demo mode cannot send commands.'); terminals.command(input.sessionId, input.message); return json(res, 200, { ok: true, via: 'terminal' }); }
      return json(res, 404, { error: 'Not found.' });
    } catch (e) { broadcast(); if (!res.headersSent) json(res, 400, { error: e.message }); else res.end(); }
  });
  function wakeWorker(run, message) {
    const target = run.workers.find(w => w.id === message.toWorkerId && !w.revokedAt); if (!target?.sessionId) return;
    state.accept({ id: `broker-${message.id}`, type: 'broker.message', sessionId: target.sessionId, title: 'Orchestration dispatch received', message: `From ${message.fromWorkerId}; open the worker or its inbox to inspect.` });
    try { terminals.command(target.sessionId, `[Agent World ${message.id}] A scoped message is waiting from ${message.fromWorkerId}. Call world_inbox before acting.`); } catch {}
  }
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  server.on('upgrade', (req, socket, head) => { const url = new URL(req.url, 'http://localhost'); if (!allowedOrigin(req) || !authorized(req, url) || !url.pathname.startsWith('/api/terminal/')) return socket.destroy(); const id = url.pathname.split('/').pop(); if (!terminals.items.has(id)) return socket.destroy(); wsServer.handleUpgrade(req, socket, head, ws => terminals.connect(id, ws)); });
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); address = server.address();
  const bridge = join(stateDir, 'bridge.json'); writeFileSync(bridge, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: hookToken }), { mode: 0o600 });
  const interval = setInterval(refresh, scanEvery), heartbeat = setInterval(() => { for (const client of clients) { try { if (client.writableEnded || client.destroyed) { clients.delete(client); continue; } client.write(': heartbeat\n\n'); } catch { clients.delete(client); } } }, 15000);
  refresh();
  let codebaseRefresh = null;
  const codebaseInterval = setInterval(() => {
    if (codebaseRefresh || codebases.busy) return;
    codebaseRefresh = (async () => {
      await codebases.refresh(achievements);
      broadcast();
    })().finally(() => { codebaseRefresh = null; });
  }, codebaseEvery);
  return { server, state, orchestration, terminals, token, hookToken, port: address.port, snapshot, refresh, close: async () => { clearInterval(codebaseInterval); if (codebaseRefresh) await codebaseRefresh; clearInterval(interval); clearInterval(heartbeat); terminals.shutdown(); for (const c of clients) c.end(); wsServer.close(); if (existsSync(bridge) && JSON.parse(readFileSync(bridge, 'utf8')).token === hookToken) unlinkSync(bridge); await new Promise(r => server.close(r)); } };
}
