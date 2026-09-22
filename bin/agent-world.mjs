#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync, existsSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { startServer } from '../src/server.mjs';

const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
if (args.includes('--help')) {
  console.log('agent-world [--demo] [--port 8791] [--open] [--state-dir PATH] [--claude-dir PATH] [--paired-config PATH] [--tmux-sessions NAME,...]\n\nRuns only on 127.0.0.1. Existing sessions are observed until you explicitly open or fork one. --tmux-sessions imports an explicit comma-separated allowlist of existing tmux sessions as reconnectable terminals.\nDemo uses fictional sessions and never launches models. --paired-config imports a proposal only; approval and launch remain manual.'); process.exit(0);
}
const demo = args.includes('--demo');
const stateDir = resolve(value('--state-dir') || process.env.AGENT_WORLD_STATE_DIR || (demo ? mkdtempSync(join(tmpdir(), 'agent-world-demo-')) : join(homedir(), '.local/state/agent-world')));
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const lock = join(stateDir, 'instance.lock');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8')); let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
  if (alive) { console.error('An app already owns this state directory. Use its launcher URL or choose another --state-dir.'); process.exit(1); }
  unlinkSync(lock);
}
let owned = false;
const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); owned = true;
try {
  const proposal = value('--paired-config') ? JSON.parse(readFileSync(resolve(value('--paired-config')), 'utf8')) : null;
  const tmuxNames = (value('--tmux-sessions') || '').split(',').map(s => s.trim()).filter(Boolean);
  const externalTmux = tmuxNames.map(pane => {
    if (!/^[a-zA-Z0-9_%:.-]+$/.test(pane)) throw Error(`Invalid tmux session name: ${pane}`);
    try { execFileSync('tmux', ['has-session', '-t', pane], { stdio: 'ignore' }); } catch { throw Error(`Tmux session not found: ${pane}`); }
    const cwd = execFileSync('tmux', ['display-message', '-p', '-t', pane, '#{pane_current_path}'], { encoding: 'utf8' }).trim();
    const provider = pane.endsWith('-codex') ? 'codex' : 'claude';
    const role = pane.endsWith('-orchestrator') ? 'orchestrator' : 'developer';
    const biome = pane.endsWith('-backend') ? 'backend' : pane.endsWith('-orchestrator') ? 'ops' : 'frontend';
    return { pane, cwd, name: pane, provider, role, biome, quest: `Live ${role} · ${pane}` };
  });
  const app = await startServer({ demo, stateDir, claudeDir: resolve(value('--claude-dir') || join(homedir(), '.claude')), port: Number(value('--port') || 8791), binaries: { claude: process.env.AGENT_WORLD_CLAUDE_BIN || 'claude', codex: process.env.AGENT_WORLD_CODEX_BIN || 'codex', gemini: process.env.AGENT_WORLD_GEMINI_BIN || 'gemini', opencode: process.env.AGENT_WORLD_OPENCODE_BIN || 'opencode', qwen: process.env.AGENT_WORLD_QWEN_BIN || 'qwen', cursor: process.env.AGENT_WORLD_CURSOR_BIN || 'cursor-agent', grok: process.env.AGENT_WORLD_GROK_BIN || 'grok' }, externalTmux });
  if (proposal) { try { if (!proposal.paired) throw Error('The paired config must contain a paired contract and gates.'); app.orchestration.createRun(proposal); } catch (e) { await app.close(); throw e; } }
  const url = `http://127.0.0.1:${app.port}/#token=${app.token}`;
  console.log(`Agent World ${demo ? '(demo)' : '(local)'}\n${url}\nState: ${stateDir}\nClose with Ctrl-C. App-owned terminals end when the server exits.`);
  if (args.includes('--open')) { const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'; spawn(cmd, [url], { stdio: 'ignore' }).on('error', () => {}); }
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); if (owned && existsSync(lock)) unlinkSync(lock); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
} catch (e) { if (owned && existsSync(lock)) unlinkSync(lock); console.error(e.message); process.exit(1); }
