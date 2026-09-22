/* Achievement district: deterministic plans, shared voxel batches, independent replay. */
'use strict';
let awPlan = null, awPlanGroup = null, awReplay = null, awHistory = [], awHistoryPending = false, awPlanRequest = 0, awConstructionHits = [], awConstructionBatches = [], awBuilderBatches = [], awBuilders = [], awInspectedSite = null;
const awBuildMatrix = new THREE.Matrix4();
const awKindNames = { workshop: 'Workshop', interface: 'Interface hall', service: 'Service forge', database: 'Data vault', pipeline: 'Pipeline mill', observatory: 'Review observatory', citadel: 'Command citadel', archive: 'Requirements archive', blueprint: 'Blueprint spire', 'test-chamber': 'Test chamber', council: 'Council sanctuary' };
const awConstructionFly = flyTo;
flyTo = function (target, radius, phi) {
  awConstructionFly(target, radius, phi);
  const sun = scene?.children.find(o => o.isDirectionalLight && o.castShadow);
  if (sun) { sun.position.set(target.x - 85, target.y + 105, target.z + 65); sun.target.position.copy(target); if (!sun.target.parent) scene.add(sun.target); renderer.shadowMap.needsUpdate = true; }
};
const awConstructionInit = awInit;
awInit = function () {
  awConstructionInit();
  if (document.getElementById('aw-blueprint-toggle')) return;
  const button = document.createElement('button'); button.id = 'aw-blueprint-toggle'; button.className = 'aw-button'; button.textContent = 'BLUEPRINT'; document.getElementById('aw-tools').prepend(button);
  document.body.insertAdjacentHTML('beforeend', `<section class="aw-pane" id="aw-blueprint" hidden><header><h3>World blueprint</h3><button class="aw-button" id="aw-blueprint-close">CLOSE</button></header><p id="aw-blueprint-summary"></p><div class="aw-actions"><button class="aw-button primary" id="aw-blueprint-focus">SURVEY WORLD</button><button class="aw-button" id="aw-blueprint-demo" hidden>ADVANCE DEMO</button></div><label for="aw-history">Construction history</label><input id="aw-history" type="range" min="0" max="0" value="0" step="1"><p id="aw-history-label">Live world</p><button class="aw-button" id="aw-history-live">RETURN TO LIVE</button><p class="aw-blueprint-key">Foundations → scaffolds → submitted structures → completed landmarks. Green beacons mark broker acceptance; gold lamps mark human completion. Demo sites remain fictional.</p><div id="aw-blueprint-sites"></div></section><section class="aw-pane" id="aw-site" hidden></section>`);
  button.onclick = () => { document.getElementById('aw-blueprint').hidden = false; for (const id of ['aw-orchestrate', 'aw-tasks', 'aw-notices', 'aw-site']) document.getElementById(id).hidden = true; awFocusBlueprint(); awLoadHistory(); };
  document.getElementById('aw-blueprint-close').onclick = () => { document.getElementById('aw-blueprint').hidden = true; };
  document.getElementById('aw-blueprint-focus').onclick = awFocusBlueprint;
  document.getElementById('aw-blueprint-focus').parentElement.insertAdjacentHTML('afterend', `<div class="aw-actions"><button class="aw-button" id="aw-map-codebase">MAP CODEBASE</button><button class="aw-button" id="aw-export-minecraft">EXPORT MINECRAFT</button></div><div id="aw-codebase-projects"></div><p id="aw-export-info" hidden></p>`);
  document.getElementById('aw-map-codebase').onclick = () => awForm('Map a codebase', '<p>Read-only scan of source directories and static JS/TS imports. No code is executed. Directory and filename rules infer component roles.</p><label>Project directory</label><input name="root" required placeholder="/absolute/path/to/project"><label>Refresh</label><select name="watch"><option value="no">Scan once</option><option value="yes">Rescan every 30 seconds</option></select>', 'SCAN PROJECT', async input => { const report = await awRequest('/api/codebase/scan', { root: input.root, watch: input.watch === 'yes' }); showToast(`${report.components} components mapped · ${report.files} source files`); awFocusBlueprint(); });
  document.getElementById('aw-export-minecraft').onclick = async () => {
    const b = document.getElementById('aw-export-minecraft'); b.disabled = true;
    try {
      const revision = awPlan?.revision || 0, response = await fetch('/api/minecraft.schem?revision=' + revision);
      if (!response.ok) throw Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob()), a = document.createElement('a'); a.href = url; a.download = `agent-world-r${revision}.schem`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      const info = document.getElementById('aw-export-info'); info.hidden = false; info.textContent = `Exported revision ${revision}. Java/WorldEdit: place the file in plugins/WorldEdit/schematics, then //schem load agent-world-r${revision}. Preview placement with //paste -n; //paste -a places non-air blocks. Use an empty build area. Fractional details are rounded to full blocks. Source text, paths and live sessions are excluded.`;
    } catch (e) { showToast(e.message); } finally { b.disabled = false; }
  };
  document.getElementById('aw-blueprint-demo').onclick = async () => { try { await awRequest('/api/demo/construction', {}); await awLoadHistory(); awFocusBlueprint(); } catch (e) { showToast(e.message); } };
  document.getElementById('aw-history').oninput = async e => {
    const revision = Number(e.target.value), request = ++awPlanRequest; awReplay = revision;
    try { const plan = await awRequest('/api/blueprint?revision=' + revision); if (request !== awPlanRequest) return; awDrawPlan(plan, false); awRenderBlueprint(); } catch (err) { if (request === awPlanRequest) showToast(err.message); }
  };
  document.getElementById('aw-history-live').onclick = () => { awPlanRequest++; awReplay = null; awDrawPlan(awWorld.blueprint, false); awRenderBlueprint(); awLoadHistory(); };
  let down = null;
  document.getElementById('stage').addEventListener('pointerdown', e => { if (e.button === 0 && !e.shiftKey) down = [e.clientX, e.clientY]; else down = null; });
  document.getElementById('stage').addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; down = null;
    pointer.set(e.clientX / innerWidth * 2 - 1, 1 - e.clientY / innerHeight * 2); raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(awConstructionHits, false)[0]; if (hit) awInspectSite(hit.object.userData.structureId);
  });
  awBuildTasks();
};

// Replaces the old one-house-per-session aggregation. Live data stays authoritative
// while a historical plan is displayed; returning live performs one plan update.
awBuildTasks = function () {
  if (!awWorld?.blueprint) return;
  if (awReplay === null) awDrawPlan(awWorld.blueprint, true);
  else if (awPlanGroup?.parent !== scene && awPlan) awDrawPlan(awPlan, false);
  awRenderBlueprint();
};
async function awLoadHistory() {
  if (awHistoryPending) return; awHistoryPending = true;
  try { const result = await awRequest('/api/achievements'); awHistory = result.events; awRenderBlueprint(); } catch (e) { showToast(e.message); } finally { awHistoryPending = false; }
}
function awRenderBlueprint() {
  const mount = document.getElementById('aw-blueprint-sites'); if (!mount || !awPlan) return;
  const projects = document.getElementById('aw-codebase-projects');
  if (projects) {
    projects.innerHTML = (awWorld.codebases || []).map(p => `<article class="aw-row"><h4>${esc(p.root)}</h4><small>${p.files} source files · ${p.components} components · ${p.resolvedImports} resolved imports · ${p.unresolvedImports} external/unresolved imports · ${p.complete ? 'complete within supported scope' : 'partial scan'}<br>${esc(p.warnings.join(' '))}${p.lastError ? '<br>' + esc(p.lastError) : ''}</small><button class="aw-button" data-rescan="${esc(p.projectId)}">RESCAN</button><button class="aw-button" data-watch-project="${esc(p.projectId)}">${p.watch ? 'STOP WATCHING' : 'WATCH CHANGES'}</button></article>`).join('');
    projects.querySelectorAll('[data-rescan]').forEach(b => b.onclick = async () => { const p = awWorld.codebases.find(p => p.projectId === b.dataset.rescan); try { b.disabled = true; await awRequest('/api/codebase/scan', { root: p.root, watch: p.watch }); } catch(e) { showToast(e.message); } finally { b.disabled = false; } });
    projects.querySelectorAll('[data-watch-project]').forEach(b => b.onclick = () => { const p = awWorld.codebases.find(p => p.projectId === b.dataset.watchProject); awRequest('/api/codebase/watch', { projectId: p.projectId, watch: !p.watch }).catch(e => showToast(e.message)); });
  }
  document.getElementById('aw-blueprint-demo').hidden = !awWorld?.app?.demo;
  const slider = document.getElementById('aw-history'); slider.max = awWorld.blueprint?.revision || 0; slider.value = awReplay ?? slider.max;
  document.getElementById('aw-history-label').textContent = awReplay === null ? `Live · revision ${awPlan.revision}` : `Replay · revision ${awPlan.revision} · ${awHistory.find(e => e.revision === awPlan.revision)?.origin || 'recorded'}`;
  document.getElementById('aw-blueprint-summary').textContent = `${awPlan.counts.sites} system components · ${awPlan.counts.working} builders at work · ${awPlan.counts.accepted} accepted landmarks`;
  mount.innerHTML = awPlan.structures.length ? awPlan.structures.map(s => `<article class="aw-row"><h4>${esc(s.title)}</h4><small>${esc(awKindNames[s.kind])} · ${esc(s.status)} · ${esc(s.authority)}</small><button class="aw-button" data-site="${esc(s.id)}">VISIT BUILD</button></article>`).join('') : '<p>No foundations yet. Create a task or orchestration run. In demo mode, advance the fictional construction journey.</p>';
  mount.querySelectorAll('[data-site]').forEach(b => b.onclick = () => awInspectSite(b.dataset.site));
  if (awInspectedSite && !document.getElementById('aw-site').hidden) awInspectSite(awInspectedSite, false);
  if ((!document.getElementById('aw-blueprint').hidden || !document.getElementById('aw-site').hidden) && (awHistory.at(-1)?.revision || 0) < (awWorld.blueprint?.revision || 0)) awLoadHistory();
}
function awFocusBlueprint() {
  if (!awPlan?.structures.length) return;
  const xs = awPlan.structures.map(s => s.position.x), zs = awPlan.structures.map(s => s.position.z), minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  flyTo(new THREE.Vector3((minX + maxX) / 2, 2, (minZ + maxZ) / 2), Math.max(55, (Math.max(maxX - minX, maxZ - minZ) + 22) * 1.5), .72);
}
function awInspectSite(id, focus = true) {
  const site = awPlan?.structures.find(s => s.id === id), panel = document.getElementById('aw-site');
  if (!site) { panel.hidden = true; awInspectedSite = null; return; }
  awInspectedSite = id; panel.hidden = false; document.getElementById('aw-blueprint').hidden = true;
  const history = awHistory.filter(e => e.id === id && e.revision <= awPlan.revision).slice(-8);
  panel.innerHTML = `<header><h3>${esc(site.title)}</h3><button class="aw-button" data-back>BACK</button></header><p>${esc(awKindNames[site.kind])} · ${esc(site.role)}<br>${esc(site.project)}</p><p>${site.verified ? 'Accepted by orchestration gates' : site.authority === 'demo' ? 'Fictional demonstration — no real achievement' : site.status === 'completed' ? 'Completion recorded by ' + esc(site.authority) : 'Recorded state: ' + esc(site.status)} · attempt ${site.attempt}</p><h4>Evidence chest</h4>${site.evidence.length ? site.evidence.map(e => `<p>${esc(e.path)}<code>${esc(e.sha256)}</code>${e.bytes} bytes at submission</p>`).join('') : '<p>No artifact evidence recorded.</p>'}<h4>Independent reviews</h4>${site.reviews.length ? site.reviews.map(v => `<p>${esc(v.lens || v.role)} · ${esc(v.verdict)}<br>${v.findings.map(esc).join('<br>')}</p>`).join('') : '<p>No verdicts recorded.</p>'}<p>Run gate: ${site.gate ? site.gate.exitCode === 0 && !site.gate.timedOut ? 'passed (see acceptance state)' : 'failed or timed out' : 'not recorded'}</p><h4>Dependencies</h4>${site.dependencies.length ? site.dependencies.map(d => `<button class="aw-button" data-dependency="${esc(d)}">${esc(awPlan.structures.find(s => s.id === d)?.title || d)}</button>`).join('') : '<p>Independent foundation.</p>'}<h4>Recorded history</h4>${history.map(e => `<p>r${e.revision} · ${esc(e.status)} · ${esc(e.origin)}</p>`).join('') || '<p>Open construction history to load milestones.</p>'}${site.sessionId && byId[site.sessionId] ? '<button class="aw-button primary" data-session>INSPECT SESSION</button>' : ''}`;
  panel.querySelector('[data-back]').onclick = () => { panel.hidden = true; document.getElementById('aw-blueprint').hidden = false; };
  if (site.mapping) {
    const evidenceTitle = [...panel.querySelectorAll('h4')].find(e => e.textContent === 'Evidence chest');
    evidenceTitle.insertAdjacentHTML('beforebegin', `<p><strong>${site.status === 'retired' ? 'Retired source component' : 'Observed architecture — not verified task completion'}</strong><br>${esc(site.mapping.reason)} · heuristic classification<br>${site.mapping.fileCount} files; up to 20 file hashes shown. Import edges cover resolvable static JS/TS relative imports.</p>`);
  }
  panel.querySelectorAll('[data-dependency]').forEach(b => b.onclick = () => awInspectSite(b.dataset.dependency));
  const session = panel.querySelector('[data-session]'); if (session) session.onclick = () => { panel.hidden = true; openDrawer(site.sessionId); };
  if (focus) flyTo(new THREE.Vector3(site.position.x, 3, site.position.z), 29, .93);
  if (focus && (awHistory.at(-1)?.revision || 0) < awPlan.revision) awLoadHistory();
}
function awTexture(name) {
  if (name === 'green') return T.wool(0x65946f);
  if (name === 'blue') return T.wool(0x6d9b9a); if (name === 'gold') return T.wool(0xc6a457); if (name === 'red') return T.wool(0xaa634e);
  if (name === 'grass') return T.grassTop(); return T[name] ? T[name]() : T.stonebrick();
}
function awVoxelMat(texture) {
  const key = 'construction:' + texture.uuid;
  if (!materialCache.has(key)) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
    const material = new THREE.MeshLambertMaterial({ map: texture });
    material.onBeforeCompile = shader => { shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      #if defined(USE_INSTANCING) && defined(USE_UV)
      vec3 tileScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vUv *= abs(normal.y) > .5 ? tileScale.xz : abs(normal.x) > .5 ? tileScale.zy : tileScale.xy;
      #endif`); };
    material.customProgramCacheKey = () => 'construction-world-uv-v1'; materialCache.set(key, material);
  }
  return materialCache.get(key);
}
function awDrawPlan(plan, animate) {
  if (!plan || !scene) return;
  if (awPlan?.hash === plan.hash && awPlanGroup?.parent === scene) return;
  const previous = new Map((awPlan?.structures || []).map(s => [s.id, s]));
  if (awPlanGroup) { awPlanGroup.parent?.remove(awPlanGroup); awPlanGroup.traverse(o => { if (o.isInstancedMesh) o.dispose?.(); }); }
  awPlan = plan; awPlanGroup = new THREE.Group(); scene.add(awPlanGroup); awConstructionHits = []; awConstructionBatches = []; awBuilderBatches = []; awBuilders = [];
  const materials = new Map(), add = (material, item, fresh = false) => { if (!materials.has(material)) materials.set(material, { old: [], fresh: [] }); materials.get(material)[fresh ? 'fresh' : 'old'].push(item); };
  const owners = new Map();
  for (const s of plan.structures) {
    const old = previous.get(s.id), known = new Set((old?.blocks || []).map(b => JSON.stringify(b)));
    for (const b of s.blocks) add(awVoxelMat(awTexture(b.material)), [s.position.x + b.x, s.position.y + b.y, s.position.z + b.z, b.w, b.h, b.d], animate && !RM && !!old && !known.has(JSON.stringify(b)));
    const hit = new THREE.Mesh(geoBox(14, 12, 14), mat(T.stonebrick())); hit.visible = false; hit.position.set(s.position.x, 5, s.position.z); hit.userData.structureId = s.id; awPlanGroup.add(hit); awConstructionHits.push(hit);
    if (s.authority === 'codebase') continue;
    const owner = s.sessionId || s.id, current = owners.get(owner);
    if (!current || ['working', 'repairing'].includes(s.builderState)) owners.set(owner, s);
  }
  for (const b of plan.roadBlocks || []) add(awVoxelMat(awTexture(b.material)), [b.x,b.y,b.z,b.w,b.h,b.d]);
  for (const [material, entries] of materials) {
    const cubes = entries.old.concat(entries.fresh), mesh = new THREE.InstancedMesh(geoBox(1, 1, 1), material, cubes.length);
    cubes.forEach((v, i) => { awBuildMatrix.makeScale(v[3], v[4], v[5]); awBuildMatrix.setPosition(v[0], v[1], v[2]); mesh.setMatrixAt(i, awBuildMatrix); });
    mesh.count = entries.old.length; mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; awPlanGroup.add(mesh);
    awConstructionBatches.push({ mesh, target: cubes.length, shown: mesh.count });
  }
  const bodyBatches = new Map();
  const part = (actor, material, x, y, z, w, h, d, motion) => { if (!bodyBatches.has(material)) bodyBatches.set(material, []); bodyBatches.get(material).push({ actor, x, y, z, w, h, d, motion }); };
  let i = 0;
  for (const s of owners.values()) {
    const actor = { site: s, offset: i++ * 1.17, x: s.position.x, z: s.position.z + 5.7, turn: 0, celebrateUntil: animate && previous.get(s.id)?.status !== s.status && s.builderState === 'celebrating' ? clock.elapsedTime + 2 : 0 }; awBuilders.push(actor);
    const robe = mat(awTexture(['tester', 'reviewer', 'council'].includes(s.role) ? 'blue' : 'gold'));
    part(actor, mat(T.skin()), 0, 2.1, 0, .65, .7, .65); part(actor, mat(T.skin()), 0, 1.96, .42, .17, .3, .25);
    part(actor, mat(T.pants()), -.16, 2.15, .33, .12, .07, .04); part(actor, mat(T.pants()), .16, 2.15, .33, .12, .07, .04);
    part(actor, robe, 0, 1.25, 0, .7, 1, .5); part(actor, robe, .46, 1.4, .22, .23, .7, .25, 'tool');
    part(actor, mat(T.pants()), -.19, .45, 0, .28, .9, .3, 'left'); part(actor, mat(T.pants()), .19, .45, 0, .28, .9, .3, 'right');
    part(actor, mat(T.stonebrick()), .6, 1.65, .5, .7, .18, .2, 'tool'); part(actor, mat(T.log()), .6, 1.25, .5, .12, .8, .12, 'tool');
    part(actor, robe, 0, 2.55, 0, .9, .15, .9); part(actor, robe, 0, 2.7, 0, .65, .25, .65);
  }
  for (const [material, parts] of bodyBatches) { const mesh = new THREE.InstancedMesh(geoBox(1, 1, 1), material, parts.length); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.castShadow = true; mesh.frustumCulled = false; awPlanGroup.add(mesh); awBuilderBatches.push({ mesh, parts }); }
  awAnimateConstruction(0, 0); renderer.shadowMap.needsUpdate = true;
}
window.awAnimateConstruction = function (dt, t) {
  if (!awPlanGroup || awPlanGroup.parent !== scene) return;
  for (const batch of awConstructionBatches) if (batch.mesh.count < batch.target) { batch.shown = Math.min(batch.target, batch.shown + (RM ? batch.target : dt * 32)); batch.mesh.count = Math.floor(batch.shown); renderer.shadowMap.needsUpdate = true; }
  for (const actor of awBuilders) {
    const working = ['working', 'repairing'].includes(actor.site.builderState), phase = RM || !working ? 0 : (t * .35 + actor.offset) % 4;
    actor.x = actor.site.position.x + (phase < 1 ? -3 + phase * 6 : phase < 2 ? 3 : phase < 3 ? 3 - (phase - 2) * 6 : -3);
    actor.z = actor.site.position.z + 5.7; actor.turn = phase < 1 ? Math.PI / 2 : phase < 2 ? Math.PI : phase < 3 ? -Math.PI / 2 : Math.PI;
    actor.swing = RM || !working ? 0 : Math.sin(t * 5 + actor.offset) * .22;
    actor.hop = !RM && t < actor.celebrateUntil ? Math.abs(Math.sin(t * 7)) * .35 : 0;
  }
  for (const batch of awBuilderBatches) {
    for (let i = 0; i < batch.parts.length; i++) {
      const p = batch.parts[i], a = p.actor, c = Math.cos(a.turn), s = Math.sin(a.turn), swing = p.motion === 'tool' ? a.swing : 0;
      awBuildMatrix.makeRotationY(a.turn); awBuildMatrix.scale(awConstructionScale.set(p.w, p.h, p.d)); awBuildMatrix.setPosition(a.x + p.x * c + p.z * s, a.site.position.y + p.y + swing + a.hop, a.z - p.x * s + p.z * c + (p.motion === 'left' ? a.swing : p.motion === 'right' ? -a.swing : 0)); batch.mesh.setMatrixAt(i, awBuildMatrix);
    }
    batch.mesh.instanceMatrix.needsUpdate = true;
  }
};
const awConstructionScale = new THREE.Vector3();
