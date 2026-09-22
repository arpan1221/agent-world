import { createHash, randomUUID } from 'node:crypto';
const text = (v, n = 300) => typeof v === 'string' ? v.slice(0, n) : '';
export function normalizeHook(input) {
  const sid = text(input.session_id, 100);
  if (!sid) return null;
  const base = { id: input.tool_use_id ? createHash('sha256').update(`${sid}:${input.hook_event_name}:${input.tool_use_id}`).digest('hex') : randomUUID(), sessionId: sid, cwd: text(input.cwd, 2048), team: text(input.team_name, 100) };
  const kind = input.hook_event_name;
  if (kind === 'Notification') return { ...base, type: 'notification', title: text(input.title) || 'Session needs attention', message: text(input.message, 500) };
  if (kind === 'SessionStart') return { ...base, type: 'session.started', title: 'Session opened' };
  if (kind === 'SessionEnd') return { ...base, type: 'session.ended', title: 'Session ended' };
  if (kind === 'Stop') return { ...base, type: 'turn.completed', title: 'Response ready', message: 'Claude finished its response. This does not mark the task complete.' };
  if (kind === 'UserPromptSubmit') return { ...base, type: 'session.working', title: 'Session working' };
  if (kind === 'PostToolUseFailure') return { ...base, type: 'tool.failed', title: text(input.tool_name, 80) + ' failed', message: 'Open the session to inspect the failure.' };
  if (kind !== 'PostToolUse') return null;
  const tool = input.tool_name, args = input.tool_input || {}, response = input.tool_response || {};
  if (tool === 'TaskCreate') {
    const task = response.task || response;
    if (!task.id && !task.taskId && !task.task_id) return null;
    return { ...base, type: 'task.created', taskId: String(task.id || task.taskId || task.task_id), title: text(args.subject || task.subject), stage: 'planned' };
  }
  if (tool === 'TaskUpdate' && args.taskId) {
    const stage = { pending: 'planned', in_progress: 'building', completed: 'completed' }[args.status];
    if (!stage) return null;
    if (stage === 'completed') return { ...base, type: 'task.claimed', taskId: String(args.taskId), title: text(args.subject) || 'Worker reported task complete', message: 'Awaiting independent verification before acceptance.', stage: 'building' };
    return { ...base, type: 'task.updated', taskId: String(args.taskId), title: text(args.subject), stage };
  }
  return null;
}
