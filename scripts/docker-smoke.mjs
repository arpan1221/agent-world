import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPairedFixture } from './paired-fixture.mjs';
import { OrchestrationStore } from '../src/orchestration.mjs';
import { prepareDockerStack } from '../src/docker-stack.mjs';

function command(argv, failureExpected = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '';
    child.stdout.on('data', b => { output = (output + b.toString()).slice(-64000); });
    child.stderr.on('data', b => { output = (output + b.toString()).slice(-64000); });
    child.on('error', reject);
    child.on('close', code => { if (!failureExpected && code !== 0) reject(Error(`${argv.join(' ')} failed (${code})\n${output}`)); else resolve({ code, output }); });
  });
}

const fixture = createPairedFixture(), store = new OrchestrationStore(fixture.stateDir), run = store.run(store.createRun(fixture.input).id);
store.pair.approve(run, run.paired.approvalHash);
for (const a of run.assignments.filter(a => a.role === 'developer')) {
  const worker = store.issueWorker(run.id, a.id, `fixture-${a.lane}`);
  const source = a.lane === 'frontend' ? `export async function loadGreeting(base) { const response=await fetch(base+'/api/hello'); if(!response.ok)throw Error('Backend failed'); return (await response.json()).message; }\n` : `export function handler(req,res) { const status=['/api/hello','/health'].includes(req.url)?200:404; res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(req.url==='/api/hello'?{message:'hello from the backend'}:{ok:status===200})); }\n`;
  writeFileSync(join(a.workspace, a.lane === 'frontend' ? 'frontend/client.mjs' : 'backend/handler.mjs'), source);
  store.submit(store.authenticate(worker.token), { summary: 'Deterministic Docker smoke worker; not a model execution.' });
}
store.pair.integrate(run);
const recipe = prepareDockerStack({ stateDir: fixture.stateDir, run, profile: 'smoke' });
const before = await command(['docker', 'ps', '--format', '{{.ID}} {{.Names}}']);
let report;
try {
  console.log(`Building isolated Docker project ${recipe.projectName} from develop ${run.baseCommit}...`);
  await command(recipe.commands.up);
  console.log('Frontend and backend healthy; running container acceptance.');
  const passing = await command(recipe.commands.test);
  if (!passing.output.includes('Docker frontend consumer renders') || !passing.output.match(/pass 2/)) throw Error('Docker acceptance output did not contain both real tests.');
  const base = recipe.commands.ps.slice(0, -1);
  const negative = await command([...base, '--profile', 'test', 'run', '--rm', '--no-deps', '-e', 'EXPECTED_MESSAGE=intentionally-wrong', 'tests'], true);
  if (negative.code === 0 || !negative.output.includes('AssertionError')) throw Error('Negative Docker acceptance did not fail as expected.');
  console.log('Positive acceptance passed; intentional negative acceptance failed as required.');
  const port = await command(recipe.commands.port), ids = await command([...base, 'ps', '-q']);
  const images = await command(['docker', 'inspect', '--format', '{{json .Config.Image}}', ...ids.output.trim().split(/\s+/)]);
  report = { ok: true, modelWorkers: 'simulated', projectName: recipe.projectName, baseRef: run.baseRef, baseCommit: run.baseCommit, worktrees: run.assignments.filter(a => a.role === 'developer').map(a => ({ lane: a.lane, path: a.workspace })), integration: run.integration, frontendAddress: port.output.trim(), passingExit: passing.code, negativeExit: negative.code, images: images.output.trim().split('\n').map(JSON.parse), recipeDirectory: recipe.directory };
} finally {
  await command(recipe.commands.down);
}
const after = await command(['docker', 'ps', '--format', '{{.ID}} {{.Names}}']);
if (before.output.trim().split('\n').sort().join('\n') !== after.output.trim().split('\n').sort().join('\n')) throw Error('Running container inventory changed outside the completed fixture; inspect Docker before continuing.');
report.existingContainersUnchanged = true;
const output = join(fixture.root, 'docker-result.json'); writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, passingExit: report.passingExit, negativeExit: report.negativeExit, baseRef: report.baseRef, baseCommit: report.baseCommit, projectName: report.projectName, existingContainersUnchanged: true, fixtureStopped: true, report: output }, null, 2));
