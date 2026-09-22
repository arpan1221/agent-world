import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { scanCodebase, CodebaseProjects } from '../src/codebase.mjs';
import { AchievementLedger } from '../src/achievements.mjs';
import { compileBlueprint } from '../src/blueprint.mjs';
import { exportSchematic, voxelize } from '../src/minecraft.mjs';
import { startServer } from '../src/server.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'mapping-test-'));
function fixture() {
  const dir = temp(); for (const p of ['src/api','src/ui','node_modules','secrets']) mkdirSync(join(dir,p), { recursive:true });
  writeFileSync(join(dir,'package.json'), '{"scripts":{"postinstall":"must-never-run"}}');
  writeFileSync(join(dir,'src/api/service.ts'), 'export const api = 1;');
  writeFileSync(join(dir,'src/ui/view.tsx'), 'import {api} from "../api/service.js"; export const View = api;');
  writeFileSync(join(dir,'secrets/password.ts'), 'DO_NOT_READ'); writeFileSync(join(dir,'node_modules/lib.js'), 'DO_NOT_READ');
  const outside = temp(); writeFileSync(join(outside,'outside.ts'), 'DO_NOT_READ'); symlinkSync(outside,join(dir,'src/escape'));
  return dir;
}
// Independent NBT reader for the serialized wire format, not the encoder helpers.
function decodeNBT(bytes) {
  const b = gunzipSync(bytes); let p = 0;
  const u8 = () => b.readUInt8(p++), i32 = () => { const n=b.readInt32BE(p);p+=4;return n; }, u16=()=>{const n=b.readUInt16BE(p);p+=2;return n;};
  const str=()=>{const n=u16(), s=b.toString('utf8',p,p+n);p+=n;return s;};
  function payload(type) {
    if(type===2)return u16(); if(type===3)return i32(); if(type===8)return str();
    if(type===7){const n=i32(),data=b.subarray(p,p+n);p+=n;return data;}
    if(type===11){const n=i32();return Array.from({length:n},i32);}
    if(type===10){const out={};for(let t=u8();t!==0;t=u8()){const name=str();out[name]=payload(t);}return out;}
    throw Error('Unexpected NBT tag '+type);
  }
  assert.equal(u8(),10); assert.equal(str(),''); const result=payload(10);assert.equal(p,b.length);return result.Schematic;
}

test('scanner resolves TS imports and excludes symlinks, dependencies and secrets', async () => {
  const report=await scanCodebase(fixture());
  assert.equal(report.files,2); assert.equal(report.facts.length,2); assert.equal(report.resolvedImports,1);assert.equal(report.complete,true);
  const ui=report.facts.find(f=>f.kind==='interface');assert.equal(ui.dependencies.length,1);assert.equal(ui.mapping.confidence,'heuristic');
  assert.ok(!JSON.stringify(report).includes('DO_NOT_READ'));assert.ok(!JSON.stringify(report).includes('export const'));
  assert.equal((await scanCodebase(report.root,{maxFiles:1})).complete,false);
});
test('complete rescans retire missing modules, partial scans retain them, and plots survive reappearance', async () => {
  const root=fixture(), dir=temp(), ledger=new AchievementLedger(dir), projects=new CodebaseProjects(dir);
  await projects.scan(root,false,ledger);const before=compileBlueprint(ledger.at());
  unlinkSync(join(root,'src/api/service.ts'));writeFileSync(join(root,'src/ui/large.ts'),'a'.repeat(300000));
  await projects.scan(root,false,ledger); assert.ok([...ledger.latest.values()].every(f=>f.status==='mapped'));
  unlinkSync(join(root,'src/ui/large.ts'));await projects.scan(root,false,ledger);
  const retired=compileBlueprint(ledger.at());assert.equal(retired.structures.find(s=>s.kind==='service').status,'retired');
  writeFileSync(join(root,'src/api/service.ts'),'export const api=2');await projects.scan(root,true,ledger);
  assert.deepEqual(compileBlueprint(ledger.at()).structures.map(s=>s.position),before.structures.map(s=>s.position));
  assert.equal(new CodebaseProjects(dir).projects[0].watch,true);assert.equal(compileBlueprint(ledger.at()).counts.accepted,0);
});
test('Sponge v3 export decodes with required palette, indexed block data, roads and private metadata excluded', async () => {
  const report=await scanCodebase(fixture()), ledger=new AchievementLedger(temp());ledger.record(report.facts,'codebase-scan');const plan=compileBlueprint(ledger.at());
  const decoded=decodeNBT(exportSchematic(plan)), voxels=voxelize(plan);
  assert.equal(decoded.Version,3);assert.equal(decoded.DataVersion,3465);assert.deepEqual(decoded.Offset,[0,0,0]);
  assert.equal(decoded.Blocks.Data.length,decoded.Width*decoded.Height*decoded.Length);assert.deepEqual(decoded.Blocks.Data,voxels.data);
  assert.ok(Object.keys(decoded.Blocks.Palette).includes('minecraft:oak_planks')); assert.equal(decoded.Metadata.BlueprintHash,plan.hash);
  assert.ok(!gunzipSync(exportSchematic(plan)).includes(Buffer.from(report.root)));
  assert.ok(voxelize({...plan,roadBlocks:[]}).data.filter(v=>v!==0).length < voxels.data.filter(v=>v!==0).length);
  assert.throws(()=>voxelize(plan,10),/limit/);assert.throws(()=>exportSchematic({...plan,structures:[],roadBlocks:[]}),/no blocks/);
  assert.equal(compileBlueprint(ledger.at()).structures[0].phase,3);
});
test('authenticated map and revision-pinned download run through the server',async()=>{
  const app=await startServer({port:0,stateDir:temp(),demo:true}),base=`http://127.0.0.1:${app.port}`,headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  try{
    assert.equal((await fetch(base+'/api/minecraft.schem?revision=1')).status,401);
    const response=await fetch(base+'/api/codebase/scan',{method:'POST',headers,body:JSON.stringify({root:fixture(),watch:false})});assert.equal(response.status,200);
    const before=await fetch(base+'/api/blueprint',{headers}).then(r=>r.json());
    await fetch(base+'/api/demo/construction',{method:'POST',headers,body:'{}'});
    const downloaded=await fetch(base+`/api/minecraft.schem?revision=${before.revision}`,{headers});assert.equal(downloaded.status,200);
    assert.equal(decodeNBT(Buffer.from(await downloaded.arrayBuffer())).Metadata.BlueprintHash,before.hash);
    assert.equal((await fetch(base+'/api/minecraft.schem?revision=-1',{headers})).status,400);
  }finally{await app.close();}
});

test('opt-in watcher observes file changes and can be stopped',async()=>{
  const root=fixture(),app=await startServer({port:0,stateDir:temp(),demo:true,codebaseEvery:25}),base=`http://127.0.0.1:${app.port}`,headers={authorization:`Bearer ${app.token}`,'content-type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)}).then(r=>r.json());
  try {
    const report=await post('/api/codebase/scan',{root,watch:true}),before=app.snapshot().blueprint.revision;
    writeFileSync(join(root,'src/api/service.ts'),'export const api=987;');
    const deadline=Date.now()+2000;while(app.snapshot().blueprint.revision===before&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    assert.ok(app.snapshot().blueprint.revision>before);
    await post('/api/codebase/watch',{projectId:report.projectId,watch:false});
    await new Promise(r=>setTimeout(r,60));assert.equal(app.snapshot().codebases[0].watch,false);
  } finally {await app.close();}
});

test('stopping a queued project does not restart its watcher',async()=>{
  const dir=temp(), projects=new CodebaseProjects(dir), ledger=new AchievementLedger(dir), a=fixture(), b=fixture();
  const first=await projects.scan(a,true,ledger),second=await projects.scan(b,true,ledger);
  const scan=projects.scan.bind(projects),calls=[];let release;
  const barrier=new Promise(r=>{release=r;});
  projects.scan=async(root,...args)=>{calls.push(root);if(root===first.root)await barrier;return scan(root,...args);};
  const refreshing=projects.refresh(ledger);projects.setWatch(second.projectId,false);release();await refreshing;
  assert.deepEqual(calls,[first.root]);assert.equal(projects.projects.find(p=>p.projectId===second.projectId).watch,false);
});
