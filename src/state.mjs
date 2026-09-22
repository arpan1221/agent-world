import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { COMPONENTS } from './achievements.mjs';

const stages = new Set(['planned', 'building', 'completed', 'blocked']);
const cut = (v, n = 300) => typeof v === 'string' ? v.slice(0, n) : '';
export function taskKey(sessionId, taskId, team) {
  return createHash('sha256').update(`${team || sessionId}\0${taskId}`).digest('hex').slice(0, 24);
}

// Persist semantic milestones, never guessed percentages or raw tool outputs.
export class WorldState {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'world-state.json');
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, tasks: [], notifications: [], seen: [], revision: 0 };
    if (this.data.version !== 1 || !Array.isArray(this.data.tasks)) throw Error('Unsupported world-state file; original file has been preserved.');
    this.seen = new Set(this.data.seen);
  }
  save() {
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  snapshot() { return structuredClone(this.data); }
  createTask(input) {
    const title = cut(input.title).trim();
    if (!title) throw Error('Task title is required.');
    const task = { id: randomUUID(), title, sessionId: cut(input.sessionId, 100), cwd: cut(input.cwd, 2048), biome: cut(input.biome, 30) || 'wilds', stage: 'planned', source: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    task.component = COMPONENTS.includes(input.component) ? input.component : 'workshop';
    task.dependsOn = [...new Set(Array.isArray(input.dependsOn) ? input.dependsOn : [])].filter(id => this.data.tasks.some(t => t.id === id)).slice(0, 32);
    this.data.tasks.push(task); this.data.revision++; this.save(); return task;
  }
  updateTask(id, input) {
    const task = this.data.tasks.find(t => t.id === id);
    if (!task) throw Error('Task not found.');
    if (!stages.has(input.stage)) throw Error('Unknown task stage.');
    task.stage = input.stage; task.completionAuthority = input.stage === 'completed' ? 'human' : null; task.updatedAt = new Date().toISOString(); this.data.revision++; this.save(); return task;
  }
  accept(event) {
    if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 150 || typeof event.type !== 'string') throw Error('Invalid event.');
    if (this.seen.has(event.id)) return false;
    const at = new Date().toISOString(), sid = cut(event.sessionId, 100);
    if (event.type === 'task.created' || event.type === 'task.updated') {
      if (!event.taskId || !sid) throw Error('Task event requires a session and task ID.');
      const id = taskKey(sid, cut(event.taskId, 100), cut(event.team, 100));
      let task = this.data.tasks.find(t => t.id === id);
      if (!task) { task = { id, title: cut(event.title) || 'Claude task ' + cut(event.taskId, 60), sessionId: sid, cwd: cut(event.cwd, 2048), biome: cut(event.biome, 30) || 'wilds', stage: 'planned', source: 'claude', createdAt: at }; this.data.tasks.push(task); }
      if (event.title) task.title = cut(event.title);
      if (stages.has(event.stage)) { task.stage = event.stage; task.completionAuthority = null; }
      task.updatedAt = at;
    }
    const noisy = event.type === 'tool.succeeded' || event.type === 'session.working';
    if (!noisy) {
      this.data.notifications.push({ id: event.id, type: cut(event.type, 60), sessionId: sid, title: cut(event.title) || event.type.replaceAll('.', ' '), message: cut(event.message, 500), at, read: false });
      this.data.notifications = this.data.notifications.slice(-200);
    }
    this.seen.add(event.id); this.data.seen = [...this.seen].slice(-10000); this.seen = new Set(this.data.seen);
    this.data.revision++; this.save(); return true;
  }
  markRead() { for (const n of this.data.notifications) n.read = true; this.data.revision++; this.save(); }
}
