import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root=process.env.CAMERA_TEST_ROOT||join(dirname(fileURLToPath(import.meta.url)),'..');
const THREE=createRequire(join(root,'package.json'))('three');
const html=readFileSync(process.env.CAMERA_TEST_HTML||join(root,'public/world.html'),'utf8');
function fixture(){
  const captures=new Set(),opened=[],timers=new Map(),buttons=new Map();
  const canvas={style:{},setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)};
  const context=vm.createContext({THREE,Math,renderer:{domElement:canvas},document:{getElementById:id=>{if(!buttons.has(id))buttons.set(id,{style:{},setAttribute(k,v){this[k]=v;}});return buttons.get(id);}},placeItem:null,hoverSid:null,hoverBox:null,camGoal:{r:100,theta:0,phi:.78,tgt:new THREE.Vector3()},camera:{getWorldDirection:v=>v.set(0,-.6,-.8)},hideMineFx(){},showMineFx(){},mine(){},openDrawer:sid=>opened.push(sid),setTimeout:fn=>{const id=timers.size+1;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(html.slice(html.indexOf('let dragging=false'),html.indexOf('function onResize()')),context);
  vm.runInContext('pickSid=()=>"session"',context);
  const event=(x=0,y=0,extra={})=>({pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y,preventDefault(){},stopPropagation(){this.stopped=true;},...extra});
  return {context,canvas,captures,opened,timers,buttons,event,read:expr=>vm.runInContext(expr,context)};
}
test('dragging orbits through multiple full turns in either direction, with bounded vertical tilt',()=>{
  const f=fixture();f.context.onPointerDown(f.event());
  f.context.onPointerMove(f.event(3000,10000));assert.ok(f.context.camGoal.theta < -Math.PI*2);assert.equal(f.context.camGoal.phi,.05);
  f.context.onPointerMove(f.event(-3000,-10000));assert.ok(f.context.camGoal.theta > Math.PI*2);assert.ok(f.context.camGoal.phi < Math.PI/2);
  const up=f.event(-3000,-10000);f.context.onPointerUp(up);assert.equal(up.stopped,true);assert.equal(f.opened.length,0);assert.equal(f.captures.size,0);
});
test('pan mode and modifier/middle/right drags translate without rotating or selecting',()=>{
  for(const extra of [{button:1},{button:2},{shiftKey:true},{mode:'pan'}]){
    const f=fixture();if(extra.mode)f.context.setCameraMode(extra.mode);
    f.context.onPointerDown(f.event(0,0,extra));f.context.onPointerMove(f.event(50,30,extra));
    assert.equal(f.context.camGoal.theta,0);assert.ok(f.context.camGoal.tgt.length()>0);
    f.context.onPointerUp(f.event(50,30,extra));assert.equal(f.opened.length,0);assert.equal(f.timers.size,0);
  }
});
test('cancelled and foreign pointers cannot leave the camera stuck or select a session',()=>{
  const f=fixture();f.context.onPointerDown(f.event());f.context.onPointerMove(f.event(100,0,{pointerId:2}));assert.equal(f.context.camGoal.theta,0);
  f.context.cancelCameraDrag(f.event(0,0,{pointerId:2}));assert.equal(f.read('dragging'),true);
  f.context.cancelCameraDrag(f.event());assert.equal(f.read('dragging'),false);assert.equal(f.timers.size,0);assert.equal(f.captures.size,0);assert.equal(f.opened.length,0);
  f.context.onPointerDown(f.event());f.context.cancelCameraDrag();assert.equal(f.read('dragging'),false);
});
test('click selects while an out-and-back drag remains a camera gesture',()=>{
  const f=fixture();f.context.onPointerDown(f.event());f.context.onPointerUp(f.event());assert.deepEqual(f.opened,['session']);
  f.context.onPointerDown(f.event());f.context.onPointerMove(f.event(25));f.context.onPointerMove(f.event());
  const up=f.event();f.context.onPointerUp(up);assert.equal(up.stopped,true);assert.deepEqual(f.opened,['session']);assert.equal(f.timers.size,0);
});
test('orbit and pan controls expose the selected interaction mode',()=>{
  const f=fixture();f.context.setCameraMode('pan');assert.equal(f.buttons.get('cameraPan')['aria-pressed'],'true');assert.equal(f.buttons.get('cameraOrbit')['aria-pressed'],'false');
  f.context.setCameraMode('orbit');assert.equal(f.buttons.get('cameraOrbit')['aria-pressed'],'true');
});
