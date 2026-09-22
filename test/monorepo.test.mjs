import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {scanCodebase}=await import(process.env.SCANNER_TEST_MODULE||'../src/codebase.mjs');
function fixture(t){const root=mkdtempSync(join(tmpdir(),'agent-world-monorepo-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function put(root,path,text='export const active=true'){const p=join(root,path);mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,text);}
test('repository root discovers frontend and all backend apps without entering legacy or unrelated trees',async t=>{
 const root=fixture(t);put(root,'frontend/package.json','{}');put(root,'frontend/src/components/Map.jsx');put(root,'backend/package.json','{}');
 for(const app of ['api','intelligence','curator'])put(root,`backend/apps/${app}/src/main.ts`);
 put(root,'old_backend/package.json','{}');put(root,'old_backend/src/legacy.ts');put(root,'unrelated/src/other.ts');put(root,'backend/generated/client.ts');
 const result=await scanCodebase(root);assert.deepEqual(result.sourceRoots,['frontend','backend']);assert.equal(result.complete,true);assert.equal(result.files,4);
 for(const app of ['api','intelligence','curator'])assert.ok(result.facts.some(f=>f.mapping.directory===`backend/apps/${app}`));
 assert.ok(!JSON.stringify(result).includes('legacy.ts'));assert.ok(!JSON.stringify(result).includes('other.ts'));
});
test('workspace containers discover nested packages and ignore symlinked projects',async t=>{
 const root=fixture(t),outside=fixture(t);put(root,'packages/ui/package.json','{}');put(root,'packages/ui/src/view.ts');put(outside,'package.json','{}');put(outside,'src/private.ts');
 symlinkSync(outside,join(root,'packages','external'),'dir');const result=await scanCodebase(root);assert.equal(result.files,1);assert.deepEqual(result.sourceRoots,['packages/ui']);
});
test('unsupported roots reject and bounded scans remain explicitly partial',async t=>{
 const root=fixture(t);await assert.rejects(scanCodebase(root),/No supported project marker/);
 put(root,'frontend/package.json','{}');put(root,'frontend/src/a.ts');put(root,'frontend/src/b.ts');assert.equal((await scanCodebase(root,{maxFiles:1})).complete,false);
});
