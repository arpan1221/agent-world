import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeHook } from './normalize.mjs';

// Never block, steer or inject context into Claude, even when the app is offline.
try {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) process.exit(0); }
  const event = normalizeHook(JSON.parse(raw));
  if (event) {
    const bridge = process.env.AGENT_WORLD_URL && process.env.AGENT_WORLD_HOOK_TOKEN ? { url: process.env.AGENT_WORLD_URL, token: process.env.AGENT_WORLD_HOOK_TOKEN } : JSON.parse(readFileSync(join(process.env.AGENT_WORLD_STATE_DIR || join(homedir(), '.local/state/agent-world'), 'bridge.json'), 'utf8'));
    const url = new URL(bridge.url);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') await fetch(new URL('/api/hooks', url), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(event), signal: AbortSignal.timeout(1200) });
  }
} catch {}
process.exit(0);
