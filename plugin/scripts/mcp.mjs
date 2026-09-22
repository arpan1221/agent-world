import { createInterface } from 'node:readline';

const base = process.env.AGENT_WORLD_URL, token = process.env.AGENT_WORLD_WORKER_TOKEN;
const tools = [
  ['world_get_work', 'Read this worker’s immutable assignment, policy, and available peers.', {}],
  ['world_inbox', 'Read durable messages addressed to this worker.', {}],
  ['world_send_message', 'Send a scoped, durable message to another worker in this run.', { toWorkerId: { type: 'string' }, body: { type: 'string' }, correlationId: { type: 'string' }, idempotencyKey: { type: 'string' } }, ['toWorkerId', 'body']],
  ['world_submit', 'Submit a work claim and broker-hashed evidence files. This does not mark work accepted.', { summary: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, claims: { type: 'array', items: { type: 'string' } }, idempotencyKey: { type: 'string' } }, ['summary']],
  ['world_review', 'Record an independent verdict. Paired runs require the current integrationId from world_get_work.', { targetAssignmentId: { type: 'string' }, integrationId: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'challenge', 'escalate'] }, findings: { type: 'array', items: { type: 'string' } }, idempotencyKey: { type: 'string' } }, ['targetAssignmentId', 'verdict']],
  ['world_dispatch', 'Orchestrator only: launch one ready, pre-approved child assignment. Cannot add roles, models, scopes or permissions.', { assignmentId: { type: 'string' } }, ['assignmentId']],
  ['world_integrate', 'Orchestrator only: combine both captured developer submissions in the integration worktree. Human approval is still required to execute gates.', {}]
].map(([name, description, properties, required = []]) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
const routes = { world_get_work: 'work', world_inbox: 'inbox', world_send_message: 'message', world_submit: 'submit', world_review: 'review', world_dispatch: 'dispatch', world_integrate: 'integrate' };
async function call(name, args) {
  if (!base || !token || !routes[name]) throw Error('This session is not bound to an Agent World worker.');
  const url = new URL('/agent/' + routes[name], base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('Agent World only accepts its local loopback broker.');
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args || {}), signal: AbortSignal.timeout(120000) });
  const body = await response.json(); if (!response.ok) throw Error(body.error || 'Agent World request failed.'); return body;
}
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined || request.id === null) continue;
  try {
    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-world', version: '0.5.0' } } });
    else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools } });
    else if (request.method === 'tools/call') { const result = await call(request.params?.name, request.params?.arguments); send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }); }
    else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } }); }
}
