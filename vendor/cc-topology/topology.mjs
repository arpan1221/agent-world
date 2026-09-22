// cc-topology — reconstruct the Claude Code fleet graph from ~/.claude (read-only).
// Nodes = sessions (with status), edges = session→session peer messages (SendMessage /
// cross-session-message), plus the subagent (Task/Agent) tree. Zero dependencies.
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import os from 'node:os';

const NOW = () => Date.now();
// App adaptation: retain parsed metadata/markers until a transcript changes.
const transcriptCache = new Map();
const iso = (ms) => new Date(ms).toISOString();
const ageMin = (ms) => Math.round((NOW() - ms) / 60000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// ---- small sync readers (head for meta+quest, tail for last state) ----------
function readHead(path, maxLines = 90) {
  const out = []; let buf = ''; const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(1 << 16); let pos = 0;
    while (out.length <= maxLines) {
      const n = readSync(fd, chunk, 0, chunk.length, pos); if (n <= 0) break; pos += n;
      buf += chunk.toString('utf8', 0, n); let i;
      while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1); if (out.length > maxLines) break; }
    }
  } finally { closeSync(fd); }
  if (buf) out.push(buf); return out;
}
function readTail(path, bytes = 48000) {
  const size = statSync(path).size, start = Math.max(0, size - bytes), len = size - start;
  if (len <= 0) return []; const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(len); readSync(fd, b, 0, len, start); return b.toString('utf8').split('\n').filter(Boolean); }
  finally { closeSync(fd); }
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => {
    if (typeof b === 'string') return b;
    if (b?.type === 'text') return b.text || '';
    if (b?.type === 'tool_use') return `⚙${b.name}`;
    if (b?.type === 'tool_result') return '⚙result';
    return '';
  }).join(' ').trim();
  return '';
}
function cleanPrompt(s) {
  if (!s) return '';
  return s
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, ' ')
    .replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<persisted-output>[\s\S]*?<\/persisted-output>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/⚙\w+/g, ' ').replace(/\s+/g, ' ').trim();
}
const isNoise = (s) => { if (!s) return true; const c = cleanPrompt(s); return c.length < 4; };

// ---- registry (~/.claude/sessions/<pid>.json) → live session state -----------
function readRegistry(sessionsDir) {
  const reg = {};
  if (!existsSync(sessionsDir)) return reg;
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'));
      if (o?.sessionId) reg[o.sessionId] = {
        name: o.name || null, status: o.status || null, cwd: o.cwd || null, pid: o.pid || null,
        statusUpdatedAt: o.statusUpdatedAt || null, startedAt: o.startedAt || null,
        entrypoint: o.entrypoint || null, version: o.version || null, tmux: o.tmux || null,
      };
    } catch {}
  }
  return reg;
}

// ---- per-transcript head/tail meta ------------------------------------------
function readMeta(path) {
  let cwd = null, branch = null, version = null, entrypoint = null, quest = null;
  for (const ln of readHead(path)) {
    if (!ln) continue; let o; try { o = JSON.parse(ln); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!branch && o.gitBranch) branch = o.gitBranch;
    if (!version && o.version) version = o.version;
    if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
    const m = o.message;
    if (!quest && o.type === 'user' && m && typeof m === 'object' && (m.role === 'user' || !m.role)) {
      const raw = blockText(m.content);
      if (!isNoise(raw) && !/this session is being continued|caveat: the messages below/i.test(raw)) {
        const c = cleanPrompt(raw); if (c.length >= 4) quest = c;
      }
    }
    if (quest && cwd && branch) break;
  }
  let lastRole = null, lastPreview = null, endedMidTool = false, lastTs = null;
  const tail = readTail(path).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (let i = tail.length - 1; i >= 0; i--) {
    const o = tail[i]; if (o.timestamp && !lastTs) lastTs = o.timestamp;
    const m = o.message;
    if ((o.type === 'user' || o.type === 'assistant') && m && typeof m === 'object') {
      const role = m.role || o.type, clean = cleanPrompt(blockText(m.content));
      if (clean.length >= 2 || role === 'assistant') {
        lastRole = role; lastPreview = clean.slice(0, 240);
        if (role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_use')) {
          const after = tail.slice(i + 1).some(x => { const mm = x.message; return mm && Array.isArray(mm.content) && mm.content.some(b => b?.type === 'tool_result'); });
          endedMidTool = !after;
        }
        break;
      }
    }
  }
  return { cwd, branch, version, entrypoint, quest, lastRole, lastPreview, endedMidTool, lastTs };
}

// ---- streaming pass: peer messages, self-IDs, subagents, msg count -----------
async function streamMarkers(path) {
  const out = { sends: [], recvs: [], selfNames: [], subagents: [], messages: 0 };
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const ln of rl) {
    if (!ln) continue;
    if (ln.includes('"type":"assistant"') || ln.includes('"type":"user"')) out.messages++;
    const hasSend = ln.includes('"SendMessage"'), hasRecv = ln.includes('cross-session-message');
    const hasSelf = ln.includes('This session is '), hasAgent = ln.includes('"name":"Agent"') || ln.includes('"name":"Task"');
    if (!(hasSend || hasRecv || hasSelf || hasAgent)) continue;
    if (hasRecv) for (const m of ln.matchAll(/from-name="([^"]+)"/g)) out.recvs.push(m[1]);
    if (hasSelf) for (const m of ln.matchAll(/This session is ([A-Za-z0-9][\w.-]{2,40})/g)) if (!/^being$/i.test(m[1])) out.selfNames.push(m[1]);
    if (hasSend || hasAgent) {
      let o; try { o = JSON.parse(ln); } catch { continue; }
      const c = o?.message?.content;
      if (Array.isArray(c)) for (const b of c) {
        if (b?.type !== 'tool_use') continue;
        if (b.name === 'SendMessage') { const to = b.input?.to; if (to) out.sends.push(String(to)); }
        else if (b.name === 'Agent' || b.name === 'Task') out.subagents.push(String(b.input?.subagent_type || b.input?.description || 'subagent').slice(0, 60));
      }
    }
  }
  return out;
}

// ---- status classification (heuristic, renderer-agnostic) -------------------
function classify(rec) {
  const { live, regStatus, statusAgeMin, lastRole, endedMidTool, lastPreview, actAgeMin } = rec;
  const p = (lastPreview || '').toLowerCase();
  const done = /\b(done|complete|merged|shipped|landed|pushed|passing|fixed|resolved|✅)\b/.test(p);
  const asking = /\?\s*$|which (one|option|direction)|should i|do you want|let me know|confirm|would you like/.test(p);
  if (live) {
    if (regStatus === 'busy') return 'active';
    if (statusAgeMin != null && statusAgeMin > 180 && lastRole === 'assistant' && asking) return 'stuck';
    return 'idle';
  }
  if (endedMidTool) return 'abandoned';
  if (lastRole === 'assistant' && done) return 'converged';
  if (lastRole === 'assistant' && asking) return 'abandoned';
  if (actAgeMin > 60 * 24 * 3) return 'dormant';
  return lastRole === 'user' ? 'abandoned' : 'converged';
}

// ---- main -------------------------------------------------------------------
export async function buildTopology(opts = {}) {
  const claudeDir = opts.claudeDir || join(os.homedir(), '.claude');
  const projectsDir = join(claudeDir, 'projects');
  const sessionsDir = join(claudeDir, 'sessions');
  const sinceMs = opts.sinceDays ? NOW() - opts.sinceDays * 864e5 : null;
  const filter = opts.project ? String(opts.project).toLowerCase() : null;
  const includeDormant = opts.includeDormant !== false;
  const selfId = opts.selfId || process.env.CLAUDE_SESSION_ID || null;

  const registry = readRegistry(sessionsDir);

  // enumerate transcripts
  const files = [];
  if (existsSync(projectsDir)) for (const proj of readdirSync(projectsDir)) {
    const pdir = join(projectsDir, proj); let names;
    try { names = readdirSync(pdir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      let st; try { st = statSync(join(pdir, f)); } catch { continue; }
      if (!st.size) continue;
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      files.push({ id: f.replace(/\.jsonl$/, ''), path: join(pdir, f), project: proj, mtimeMs: st.mtimeMs, sizeKB: Math.round(st.size / 1024) });
    }
  }

  // parse each transcript (meta sync + markers streaming)
  const recs = [];
  for (const f of files) {
    const reg = registry[f.id];
    const cached = transcriptCache.get(f.path), unchanged = cached && cached.mtimeMs === f.mtimeMs && cached.sizeKB === f.sizeKB;
    let meta = unchanged ? cached.meta : {}; if (!unchanged) try { meta = readMeta(f.path); } catch {}
    if (filter) {
      const hay = `${meta.cwd || reg?.cwd || ''} ${f.project}`.toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    let mk = unchanged ? cached.mk : { sends: [], recvs: [], selfNames: [], subagents: [], messages: 0 };
    if (!unchanged) try { mk = await streamMarkers(f.path); } catch {}
    transcriptCache.set(f.path, { mtimeMs: f.mtimeMs, sizeKB: f.sizeKB, meta, mk });
    const actMs = Math.max(f.mtimeMs, meta.lastTs ? Date.parse(meta.lastTs) : 0);
    recs.push({ ...f, ...meta, ...mk, reg, actMs });
  }

  const existingPaths = new Set(files.map(f => f.path));
  for (const path of transcriptCache.keys()) if (!existingPaths.has(path)) transcriptCache.delete(path);
  // name → id resolution map (registry names + "This session is X" self-IDs)
  const nameMap = {};
  for (const id in registry) if (registry[id].name) nameMap[registry[id].name] ??= id;
  for (const r of recs) for (const n of r.selfNames) nameMap[n] ??= r.id;
  const known = new Set(recs.map(r => r.id));
  const resolve = (k) => known.has(k) ? k : (UUID_RE.test(k) ? null : (nameMap[k] || null));

  // edges (directed, aggregated)
  const eAgg = new Map();
  const bump = (a, b) => { if (a && b && a !== b && known.has(a) && known.has(b)) eAgg.set(a + '>' + b, (eAgg.get(a + '>' + b) || 0) + 1); };
  for (const r of recs) {
    for (const to of r.sends) bump(r.id, resolve(to));
    for (const fn of r.recvs) bump(resolve(fn), r.id);
  }
  const edges = [...eAgg].map(([k, count]) => { const [from, to] = k.split('>'); return { from, to, count, kind: 'message' }; })
    .sort((a, b) => b.count - a.count);

  // nodes
  const nodes = recs.map(r => {
    const reg = r.reg;
    const live = !!(reg && pidAlive(reg.pid));
    const rec = {
      live, regStatus: reg?.status || null,
      statusAgeMin: reg?.statusUpdatedAt ? ageMin(Date.parse(reg.statusUpdatedAt)) : null,
      actAgeMin: ageMin(r.actMs), lastRole: r.lastRole, endedMidTool: r.endedMidTool, lastPreview: r.lastPreview,
    };
    return {
      id: r.id, name: reg?.name || null, project: r.project,
      cwd: reg?.cwd || r.cwd || null, branch: r.branch || null,
      status: r.id === selfId ? 'self' : classify(rec),
      live, pid: reg?.pid || null, inTmux: !!(reg && reg.tmux),
      quest: (r.quest || '').slice(0, 300) || null,
      lastRole: r.lastRole, lastPreview: r.lastPreview,
      lastActivity: iso(r.actMs), ageMinutes: rec.actAgeMin,
      messages: r.messages, sizeKB: r.sizeKB,
      version: r.version || reg?.version || null, entrypoint: r.entrypoint || reg?.entrypoint || null,
      isSelf: r.id === selfId || undefined,
    };
  }).sort((a, b) => (b.live - a.live) || (a.ageMinutes - b.ageMinutes));

  // subagent tree (parent session → subagent kind, aggregated)
  const sAgg = new Map();
  for (const r of recs) for (const label of r.subagents) sAgg.set(r.id + '>' + label, (sAgg.get(r.id + '>' + label) || 0) + 1);
  const subagents = [...sAgg].map(([k, count]) => { const i = k.indexOf('>'); return { parent: k.slice(0, i), childLabel: k.slice(i + 1), count }; })
    .sort((a, b) => b.count - a.count);

  if (!includeDormant) { const drop = new Set(nodes.filter(n => n.status === 'dormant').map(n => n.id));
    return finalize(nodes.filter(n => !drop.has(n.id)), edges.filter(e => !drop.has(e.from) && !drop.has(e.to)), subagents.filter(s => !drop.has(s.parent)), claudeDir, selfId); }
  return finalize(nodes, edges, subagents, claudeDir, selfId);
}

function finalize(nodes, edges, subagents, claudeDir, selfId) {
  const byStatus = {};
  for (const n of nodes) byStatus[n.status] = (byStatus[n.status] || 0) + 1;
  return {
    generatedAt: iso(NOW()), host: os.hostname(), claudeDir, self: selfId || null,
    stats: { sessions: nodes.length, live: nodes.filter(n => n.live).length, edges: edges.length, subagentLinks: subagents.length, byStatus },
    nodes, edges, subagents,
  };
}
