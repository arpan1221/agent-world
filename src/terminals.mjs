import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnPty } from './pty.mjs';
import { ensureProviderMcp, providerLaunchPlan } from './providers.mjs';

export const launchPlan = providerLaunchPlan;

export class Terminals {
  constructor({ pluginDir, stateDir, claudeDir, binaries, mcpScript, spawn = spawnPty, onChange = () => {} }) {
    Object.assign(this, { pluginDir, stateDir, claudeDir, binaries, mcpScript, spawn, onChange }); this.items = new Map();
  }
  paneFor(sid) {
    try { for (const file of readdirSync(join(this.claudeDir, 'sessions'))) {
      if (!file.endsWith('.json')) continue;
      try { const r = JSON.parse(readFileSync(join(this.claudeDir, 'sessions', file), 'utf8')); if (r.sessionId === sid && typeof r.tmux === 'string') return r.tmux; } catch {}
    } } catch {}
    return null;
  }
  list() { return [...this.items.values()].filter(t => !t.exited).map(t => ({ id: t.id, sessionId: t.sessionId, cwd: t.cwd, name: t.name, mode: t.mode, biome: t.biome, quest: t.quest, provider: t.provider, model: t.model, role: t.role, workerId: t.workerId, runId: t.runId })); }
  attachTmux(input) {
    const pane = String(input.pane || '');
    if (!/^[a-zA-Z0-9_%:.-]+$/.test(pane)) throw Error('Invalid tmux session name.');
    const sessionId = `tmux:${pane}`;
    const existing = [...this.items.values()].find(t => !t.exited && t.sessionId === sessionId);
    if (existing) return existing;
    if (this.list().length >= 32) throw Error('Close a terminal before opening more than thirty-two.');
    const cwd = input.cwd || process.cwd();
    const env = { ...process.env, TERM: 'xterm-256color' }; delete env.TMUX; delete env.TMUX_PANE; delete env.CLAUDECODE; delete env.AGENT_WORLD_TOKEN; delete env.AGENT_WORLD_STATE_DIR;
    const proc = this.spawn('tmux', ['attach-session', '-t', pane], { name: 'xterm-256color', cols: 100, rows: 24, cwd, env });
    const terminal = { id: randomUUID(), sessionId, cwd, name: input.name || pane, mode: 'attach', biome: input.biome || 'wilds', quest: input.quest || `Imported tmux session ${pane}`, provider: input.provider || 'claude', model: input.model, role: input.role || 'developer', pane, proc, clients: new Set(), buffer: '', exited: false };
    this.items.set(terminal.id, terminal);
    this.bindProcess(terminal);
    this.onChange(terminal, 'opened');
    return terminal;
  }
  open(input, nodes) {
    const node = nodes.find(n => n.id === input.sessionId);
    return this.openResolved(input, node);
  }
  resumeManaged(input) {
    if (input.mode !== 'resume' || !input.sessionId || !input.cwd) throw Error('Managed resume requires an exact session and worktree.');
    return this.openResolved(input, { id: input.sessionId, cwd: input.cwd, live: false });
  }
  openResolved(input, node) {
    const existing = [...this.items.values()].find(t => !t.exited && t.sessionId === input.sessionId);
    if (existing && input.mode !== 'fork') return existing;
    if (this.list().length >= 32) throw Error('Close a terminal before opening more than thirty-two.');
    if (input.mode !== 'new' && !node) throw Error('Session not found.');
    const cwd = input.mode === 'new' ? input.cwd : node.cwd;
    const plan = launchPlan({ ...input, cwd, node: node && { ...node, pane: this.paneFor(node.id) }, pluginDir: this.pluginDir, binaries: this.binaries, mcpScript: this.mcpScript });
    // Register the scoped broker for CLIs that wire MCP through a settings file
    // (e.g. Gemini). No-op for CLIs that pass MCP config via launch flags.
    ensureProviderMcp({ provider: plan.provider, cwd: plan.cwd, mcpScript: this.mcpScript, binaries: this.binaries });
    const env = { ...process.env, AGENT_WORLD_URL: input.agentUrl || '', AGENT_WORLD_WORKER_TOKEN: input.workerToken || '', AGENT_WORLD_HOOK_TOKEN: input.hookToken || '', TERM: 'xterm-256color' }; delete env.CLAUDECODE; delete env.AGENT_WORLD_TOKEN; delete env.AGENT_WORLD_STATE_DIR;
    const proc = this.spawn(plan.file, plan.args, { name: 'xterm-256color', cols: 100, rows: 24, cwd: plan.cwd, env });
    const terminal = { id: randomUUID(), sessionId: plan.sid, cwd: plan.cwd, name: plan.name, mode: plan.mode, biome: input.biome || 'wilds', quest: input.prompt || '', provider: plan.provider, model: plan.model, role: plan.role, workerId: input.workerId, runId: input.runId, proc, clients: new Set(), buffer: '', exited: false };
    this.items.set(terminal.id, terminal);
    this.bindProcess(terminal);
    this.onChange(terminal, 'opened'); return terminal;
  }
  bindProcess(terminal) {
    const { proc } = terminal;
    proc.onData(data => {
      terminal.buffer = (terminal.buffer + data).slice(-128 * 1024);
      const message = JSON.stringify({ type: 'output', data });
      for (const ws of terminal.clients) { if (ws.bufferedAmount > 1024 * 1024) ws.close(1013, 'Reconnect to catch up'); else if (ws.readyState === 1) ws.send(message); }
    });
    proc.onExit(({ exitCode }) => { terminal.exited = true; terminal.exitCode = exitCode; for (const ws of terminal.clients) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode })); ws.close(); } this.onChange(terminal, 'exited'); });
  }
  connect(id, ws) {
    const t = this.items.get(id);
    if (!t || t.exited) return ws.close(1008, 'Terminal unavailable');
    t.clients.add(ws); ws.send(JSON.stringify({ type: 'output', data: t.buffer }));
    ws.on('close', () => t.clients.delete(ws));
    ws.on('message', raw => { try { const m = JSON.parse(raw.toString());
      if (m.type === 'input' && typeof m.data === 'string' && m.data.length <= 16384) t.proc.write(m.data);
      if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) t.proc.resize(Math.max(20, Math.min(300, m.cols)), Math.max(5, Math.min(120, m.rows)));
    } catch {} });
  }
  command(sid, message) { const t = [...this.items.values()].find(t => t.sessionId === sid && !t.exited); if (!t) throw Error('Open this session in the app before sending context.'); if (typeof message !== 'string' || !message || message.length > 16000) throw Error('Invalid message.'); t.proc.write(message + '\r'); }
  close(id) { const t = this.items.get(id); if (!t) throw Error('Terminal not found.'); if (!t.exited) t.proc.kill(); this.items.delete(id); }
  shutdown() { for (const t of this.items.values()) if (!t.exited) t.proc.kill(); }
}
