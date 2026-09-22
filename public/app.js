/* Standalone app layer. The procedural world remains the renderer. */
'use strict';
const awToken = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('agent-world-token') || '';
if (awToken) { sessionStorage.setItem('agent-world-token', awToken); history.replaceState(null, '', location.pathname); }
const awFetch = window.fetch.bind(window);
window.fetch = (url, options = {}) => { if (typeof url === 'string' && url.startsWith('/api/')) return awFetch(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + awToken } }); return awFetch(url, options); };
async function awRequest(path, body) { const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error || 'Request failed'); return j; }
let awWorld = null, awSource = null, awSignature = '', awTaskSignature = '', awBuildings = null, awNotificationsReady = false;
const awTerminals = new Map();
let awTerminalColumns = Math.max(1, Math.min(4, Number(localStorage.getItem('agent-world-terminal-columns')) || 2));
let awTerminalMode = localStorage.getItem('agent-world-terminal-mode') === 'free' ? 'free' : 'grid', awTerminalZ = 1;
let awTerminalGeometry = {}; try { awTerminalGeometry = JSON.parse(localStorage.getItem('agent-world-terminal-geometry') || '{}') || {}; } catch {}
let awTerminalRestore = []; try { const saved = JSON.parse(sessionStorage.getItem('agent-world-terminal-views') || '[]'); if (Array.isArray(saved)) awTerminalRestore = saved.filter(id => typeof id === 'string'); } catch {}
const awSeen = new Set();
const awOriginalHUD = initHUD, awOriginalDrawer = openDrawer, awOriginalUpdate = applyUpdate;
const awOriginalBoot = boot;
boot = async function () { if (window.worldBootStarted) return; window.worldBootStarted = true; try { await awOriginalBoot(); } catch (e) { showToast(e.message); document.getElementById('loader').style.display = 'none'; } };
poll = function () {}; // SSE is authoritative; no second live polling/render loop.
initHUD = function () { awOriginalHUD(); awInit(); };
openDrawer = function (sid) {
  awOriginalDrawer(sid); const s = byId[sid]; if (!s || sid === WORLD.self.sessionId) return;
  const old = document.querySelector('#dBody .actions'); if (old) old.remove();
  const managed = awWorld?.app?.terminals.find(t => t.sessionId === sid), area = document.createElement('div'); area.className = 'aw-launch';
  const options = managed ? [['reconnect', 'Open terminal']] : s.live ? (s.inTmux ? [['attach', 'Attach terminal'], ['fork', 'Fork conversation']] : [['fork', 'Fork into app']]) : s.source === 'archive' ? [] : [['resume', 'Resume in app']];
  area.innerHTML = options.map(([mode, label]) => `<button class="aw-button primary" data-open="${mode}">${label}</button>`).join(' ') + `<p>${managed ? 'Reconnects to the running terminal.' : s.live && !s.inTmux ? 'This session runs outside the app. Fork starts a separate conversation with its history.' : 'Opens an interactive terminal here, using normal Claude permissions.'}</p><button class="aw-button" data-task>Add task</button>`;
  area.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => { try { b.disabled = true; const t = managed || await awRequest('/api/terminal/open', { mode: b.dataset.open, sessionId: sid, name: s.name || 'World builder' }); awOpenTerminal(t.id, s.name); } catch (e) { showToast(e.message); } finally { b.disabled = false; } });
  area.querySelector('[data-task]').onclick = () => awTaskForm(sid); document.getElementById('dBody').appendChild(area);
};
openModal = function () { awLaunchForm(); };
sendCommand = async function (sid, message) { try { await awRequest('/api/command', { sessionId: sid, message }); showToast('Sent to the open terminal'); } catch (e) { showToast(e.message); } };
giveContext = async function (sid) { const item = inv[placeItem]; if (!item) return; try { await awRequest('/api/command', { sessionId: sid, message: item.ctx }); placeItem = null; renderInv(); updateInvHint(); showToast('Context placed in the open terminal'); } catch (e) { showToast(e.message); } };

function awInit() {
  if (document.getElementById('aw-tools')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <nav id="aw-tools"><span class="aw-mode" id="aw-mode">LOCAL</span><button class="aw-button" id="aw-orchestrate-toggle">ORCHESTRATE</button><button class="aw-button" id="aw-tasks-toggle">TASKS</button><button class="aw-button" id="aw-notices-toggle">NOTICES <span class="aw-badge" id="aw-unread">0</span></button><button class="aw-button" id="aw-compute-toggle">COMPUTE</button><button class="aw-button primary" id="aw-launch-toggle">NEW SESSION</button></nav>
    <section class="aw-pane aw-wide" id="aw-orchestrate" hidden><header><h3>${esc(`${WORLD?.app?.brand?.name || 'Agent World'} ${WORLD?.app?.brand?.pipeline || 'SDLC'} control room`)}</h3><div class="aw-actions"><button class="aw-button" id="aw-new-run">+ RUN</button><button class="aw-button primary" id="aw-new-paired-run">+ PAIRED RUN</button></div></header><p>Mixed-model workers submit claims. Independent tests, reviews, deterministic gates, and the five-lens council decide acceptance.</p><div id="aw-run-list"></div></section>
    <section class="aw-pane" id="aw-tasks" hidden><header><h3>Settlement board</h3><button class="aw-button" id="aw-add-task">+ TASK</button></header><p>Plan a foundation. Build a workshop. Leave completed work in the world.</p><div id="aw-task-list"></div></section>
    <section class="aw-pane" id="aw-notices" hidden><header><h3>World notices</h3><button class="aw-button" id="aw-read">READ ALL</button></header><button class="aw-button" id="aw-enable-notifications">Enable desktop notices</button><button class="aw-button" id="aw-demo-event" hidden>Try a demo notice</button><div id="aw-notice-list"></div></section>
    <section class="aw-pane aw-wide" id="aw-compute" hidden><header><h3>Compute observatory</h3></header><p>Estimated compute and spend across every session and CLI. Cost is an estimate (no live token telemetry yet); tokens are a per-role heuristic.</p><div id="aw-compute-body"></div></section>
    <section id="aw-terminal-deck" hidden aria-label="Open agent terminals"><header class="aw-terminal-deck-head"><div><strong>Terminal desk</strong><span id="aw-terminal-count">0 open</span></div><button class="aw-button" id="aw-terminal-open-all" title="Connect views to existing sessions; never spawn new agents">OPEN ALL LIVE</button><button class="aw-button" id="aw-terminal-mode">FREEFORM</button><div class="aw-terminal-layout" role="group" aria-label="Terminal columns"><button class="aw-button" data-aw-columns="1">1</button><button class="aw-button" data-aw-columns="2">2</button><button class="aw-button" data-aw-columns="3">3</button><button class="aw-button" data-aw-columns="4">4</button></div><button class="aw-button" id="aw-terminal-full">EXPAND</button><button class="aw-button" id="aw-terminal-reset">ARRANGE</button><button class="aw-button" id="aw-terminal-hide">HIDE</button></header><div id="aw-terminal-switcher" aria-label="Terminal views"></div><div id="aw-terminal-grid"></div><p class="aw-terminal-help">Drag a title to move / reorder · drag the corner to resize · arrow keys on a title move it · arrow keys on a resize handle resize it · CLOSE keeps the session running</p></section>
    <div id="aw-form" hidden></div><div id="aw-connect" hidden><section><h2>Connect to your world</h2><p>Open the authenticated URL printed by the Agent World launcher. Session data and terminal controls require that local connection.</p></section></div>`);
  const paneIds = ['aw-orchestrate', 'aw-tasks', 'aw-notices', 'aw-compute']; const toggle = id => { const el = document.getElementById(id), show = el.hidden; for (const pane of paneIds) document.getElementById(pane).hidden = true; el.hidden = !show; };
  document.getElementById('aw-orchestrate-toggle').onclick = () => toggle('aw-orchestrate'); document.getElementById('aw-tasks-toggle').onclick = () => toggle('aw-tasks'); document.getElementById('aw-notices-toggle').onclick = () => toggle('aw-notices'); document.getElementById('aw-compute-toggle').onclick = () => toggle('aw-compute');
  document.getElementById('aw-add-task').onclick = () => awTaskForm(); document.getElementById('aw-launch-toggle').onclick = awLaunchForm;
  document.getElementById('aw-new-run').onclick = () => awOrchestrationForm();
  document.getElementById('aw-new-paired-run').onclick = () => awOrchestrationForm(true);
  document.getElementById('aw-read').onclick = () => awRequest('/api/notifications/read', {}).catch(e => showToast(e.message));
  document.getElementById('aw-demo-event').onclick = () => awRequest('/api/demo/event', {}).catch(e => showToast(e.message));
  document.getElementById('aw-enable-notifications').onclick = async () => { if (!('Notification' in window)) return showToast('Desktop notices are unavailable in this browser.'); const result = await Notification.requestPermission(); localStorage.setItem('agent-world-notify', result === 'granted' ? 'yes' : 'no'); showToast(result === 'granted' ? 'Desktop notices enabled' : 'In-app notices remain available'); };
  document.getElementById('aw-terminal-hide').onclick = () => { document.getElementById('aw-terminal-deck').hidden = true; };
  const deskButton = document.createElement('button'); deskButton.className = 'aw-button'; deskButton.id = 'aw-terminal-toggle'; deskButton.textContent = 'TERMINALS';
  document.getElementById('aw-tools').appendChild(deskButton);
  deskButton.onclick = () => { document.getElementById('aw-terminal-deck').hidden = false; awUpdateTerminalDeck(); requestAnimationFrame(awFitTerminals); };
  document.getElementById('aw-terminal-open-all').onclick = () => { for (const t of awWorld?.app?.terminals || []) awOpenTerminal(t.id, t.name); };
  document.getElementById('aw-terminal-mode').onclick = () => awSetTerminalMode(awTerminalMode === 'free' ? 'grid' : 'free');
  document.getElementById('aw-terminal-full').onclick = () => { const expanded = document.getElementById('aw-terminal-deck').classList.toggle('is-expanded'); document.getElementById('aw-terminal-full').textContent = expanded ? 'RESTORE DESK' : 'EXPAND'; requestAnimationFrame(awFitTerminals); };
  document.getElementById('aw-terminal-reset').onclick = awArrangeTerminals;
  document.querySelectorAll('[data-aw-columns]').forEach(button => button.onclick = () => awSetTerminalColumns(Number(button.dataset.awColumns)));
  awSetTerminalColumns(awTerminalColumns);
  awSetTerminalMode(awTerminalMode);
  addEventListener('resize', () => { if (!document.getElementById('aw-terminal-deck').hidden) requestAnimationFrame(awFitTerminals); });
  if (!awToken) { document.getElementById('aw-connect').hidden = false; return; }
  awWorld = WORLD; awSignature = awNodeSignature(WORLD); awRenderPanels(WORLD); awBuildTasks(WORLD.tasks || []);
  awSource = new EventSource('/api/events?token=' + encodeURIComponent(awToken));
  awSource.addEventListener('world', e => { try { awReceiveWorld(JSON.parse(e.data)); } catch (err) { console.error('World update failed', err); showToast('World update failed: ' + err.message); } });
  awSource.onerror = () => { document.getElementById('liveTxt').textContent = 'RECONNECTING'; };
}
function awNodeSignature(w) { return w.sessions.map(s => [s.sessionId, s.biome, s.status, s.live].join(':')).sort().join('|'); }
function awClearScene() {
  const keepGeometries = new Set(geometryCache.values()), keepMaterials = new Set([...materialCache.values(), ...[...blockMaterialCache.values()].flat()]), keepTextures = new Set([...Object.values(texCache), GLOWTEX]);
  if (scene) { scene.traverse(o => { if (o.shadow?.map) o.shadow.map.dispose(); if (o.isInstancedMesh) o.dispose?.(); if (o.geometry && !keepGeometries.has(o.geometry)) o.geometry.dispose(); if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!keepMaterials.has(m)) { if (m.map && !keepTextures.has(m.map)) m.map.dispose(); m.dispose(); } }); scene.background?.dispose?.(); }
  for (const map of [agentPos, agentGroup, agentWool, agentStatus, agentWalk, agentGlow, biomeCenters, biomeNext]) for (const key of Object.keys(map)) delete map[key];
  for (const list of [pickables, walkers, labels, particles, linkFlows, portals, ambientMotes, districtLabels, contactShadows, labelItems, placedLabels]) list.length = 0;
  sceneryBatches.clear(); clouds = []; linkGroup = null; awBuildings = null; awTaskSignature = '';
}
function awReceiveWorld(w) {
  const next = awNodeSignature(w), changed = next !== awSignature;
  awWorld = w;
  if (awTerminalRestore.length && w.app?.terminals) { const saved = awTerminalRestore; awTerminalRestore = []; for (const id of saved) { const t = w.app.terminals.find(t => t.id === id); if (t) awOpenTerminal(t.id, t.name); } }
  if (changed) { const sid = selectedSid; awClearScene(); WORLD = w; reindex(); initScene(); awSignature = next; if (sid && byId[sid]) openDrawer(sid); }
  awOriginalUpdate(w); byId[WORLD.self.sessionId] ||= { sessionId: WORLD.self.sessionId, name: 'You', status: 'overlord', questTitle: 'Your settlement', whatItsDoing: 'Inspect builders, open sessions, and grow the settlement through completed tasks.' }; setLive(true); document.getElementById('liveTxt').textContent = w.app?.demo ? 'DEMO · FICTIONAL SESSIONS' : w.app?.scanning ? 'LIVE · SCANNING' : 'LIVE · CONNECTED';
  const edgeKey = JSON.stringify(w.edges), oldEdges = awReceiveWorld.edgeKey;
  if (!changed && edgeKey !== oldEdges) { if (linkGroup) linkGroup.traverse(o => { if (o.isMesh) { if (![...geometryCache.values()].includes(o.geometry)) o.geometry.dispose(); o.material.dispose(); } }); buildLinks(); }
  awReceiveWorld.edgeKey = edgeKey;
  awRenderPanels(w); awBuildTasks(w.tasks || []);
}
applyUpdate = awReceiveWorld;

function awRenderPanels(w) {
  document.getElementById('aw-mode').textContent = w.app?.demo ? 'DEMO' : 'LOCAL'; document.getElementById('aw-demo-event').hidden = !w.app?.demo;
  const tasks = w.tasks || [], notices = w.notifications || [];
  document.getElementById('aw-task-list').innerHTML = tasks.length ? [...tasks].reverse().map(t => `<article class="aw-row"><h4>${esc(t.title)}</h4><small>${esc(disp(byId[t.sessionId] || {}))} · ${esc(t.stage)}${t.source === 'orchestration' ? ' · VERIFIED PIPELINE' : ''}</small><div class="aw-actions">${t.source === 'orchestration' ? '' : ['planned', 'building', 'blocked', 'completed'].map(stage => `<button class="aw-button${t.stage === stage ? ' primary' : ''}" data-stage="${stage}" data-task-id="${t.id}" ${t.stage === stage ? 'disabled' : ''}>${stage}</button>`).join('')}<button class="aw-button" data-inspect="${esc(t.sessionId)}">INSPECT</button></div></article>`).join('') : '<p class="aw-empty">No task sites yet. Add a task for a builder, or let the companion plugin report one.</p>';
  document.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => awRequest('/api/tasks/' + b.dataset.taskId, { stage: b.dataset.stage }).catch(e => showToast(e.message)));
  document.querySelectorAll('[data-inspect]').forEach(b => b.onclick = () => openDrawer(b.dataset.inspect));
  setTxt('aw-unread', notices.filter(n => !n.read).length);
  document.getElementById('aw-notice-list').innerHTML = notices.length ? [...notices].reverse().map(n => `<article class="aw-row${n.read ? '' : ' unread'}"><h4>${esc(n.title)}</h4><p>${esc(n.message)}</p><small>${new Date(n.at).toLocaleTimeString()}</small>${byId[n.sessionId] ? `<button class="aw-button" data-notice-session="${esc(n.sessionId)}">GO TO SESSION</button>` : ''}</article>`).join('') : '<p class="aw-empty">All quiet. Session changes and requests for attention appear here.</p>';
  document.querySelectorAll('[data-notice-session]').forEach(b => b.onclick = () => { document.getElementById('aw-notices').hidden = true; openDrawer(b.dataset.noticeSession); });
  for (const n of notices) if (!awSeen.has(n.id)) { awSeen.add(n.id); if (awNotificationsReady && !n.read) { showToast(n.title); if ('Notification' in window && Notification.permission === 'granted' && localStorage.getItem('agent-world-notify') === 'yes' && document.hidden) { const notice = new Notification(n.title, { body: n.message, tag: n.id }); notice.onclick = () => { window.focus(); openDrawer(n.sessionId); notice.close(); }; } } }
  awNotificationsReady = true;
  awRenderOrchestration(w);
  awRenderCompute(w);
}
function awFmtTokens(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
function awFmtUsd(n) { n = Number(n) || 0; return '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2)); }
function awBar(value, max, label) { const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0; return `<div class="aw-meter"><span class="aw-meter-label">${label}</span><div class="aw-meter-track"><div class="aw-meter-fill" style="width:${pct}%"></div></div></div>`; }
function awRenderCompute(w) {
  const body = document.getElementById('aw-compute-body'); if (!body) return;
  const a = w.analytics;
  if (!a || (!a.totals.workers && !a.totals.sessions && !a.runs.length)) { body.innerHTML = '<p class="aw-empty">No compute yet. Create a run or open sessions to see spend and tokens flow across your CLIs.</p>'; return; }
  const t = a.totals;
  const tiles = [
    ['COMPUTE (est)', awFmtTokens(t.estTokens) + ' tok'],
    ['LIVE', `${t.live} / ${t.workers}`],
    ['SPEND (est)', awFmtUsd(t.spendByUnit.usd)],
    ['SESSIONS', String(t.sessions)],
    ['RUNS', String(t.runs)],
  ].map(([k, v]) => `<div class="aw-stat"><div class="aw-stat-v">${esc(v)}</div><div class="aw-stat-k">${esc(k)}</div></div>`).join('');
  const maxProv = Math.max(1, ...a.byProvider.map(g => g.estTokens));
  const provRows = a.byProvider.length ? a.byProvider.map(g => awBar(g.estTokens, maxProv, `${esc(g.key)} · ${g.live}/${g.workers}w · ${awFmtTokens(g.estTokens)} · ${awFmtUsd(g.spend.usd)}`)).join('') : '<p class="aw-empty">No workers yet.</p>';
  const tierRow = a.byTier.map(g => `<span class="aw-chip">${esc(g.key)}: ${g.workers}</span>`).join(' ');
  const runRows = a.runs.filter(r => r.workers || r.budget).map(r => { const b = r.budget; const line = b ? `${b.unit === 'usd' ? awFmtUsd(b.spent) + ' / ' + awFmtUsd(b.limit) : (b.spent || 0) + ' / ' + b.limit + ' ' + b.unit}` : `${awFmtTokens(r.estTokens)} tok · ${awFmtUsd(r.spend.usd)}`; return `<div class="aw-crun"><small>${esc(r.objective || r.id)}</small>${b ? awBar(b.spent || 0, b.limit, `${esc(r.status)} · ${line}`) : `<div class="aw-meter-label">${esc(r.status)} · ${line}</div>`}</div>`; }).join('');
  const log = a.recent.length ? a.recent.map(e => `<li><span class="aw-dot${e.live ? ' live' : ''}"></span>${new Date(e.at).toLocaleTimeString()} · ${esc(e.provider)} · ${esc(e.role)} · ${e.unit === 'usd' ? awFmtUsd(e.cost) : e.cost + ' ' + e.unit}</li>`).join('') : '<li class="aw-empty">No launches yet.</li>';
  body.innerHTML = `<div class="aw-stats">${tiles}</div><h4>Compute by CLI</h4>${provRows}${tierRow ? `<p class="aw-tiers">${tierRow}</p>` : ''}${runRows ? `<h4>Budget by run</h4>${runRows}` : ''}<h4>Recent launches</h4><ul class="aw-log">${log}</ul>`;
}
function awRenderOrchestration(w) {
  const mount = document.getElementById('aw-run-list'); if (!mount) return; const runs = w.orchestration?.runs || [];
  mount.innerHTML = runs.length ? [...runs].reverse().map(run => {
    const workers = new Map(run.workers.map(worker => [worker.id, worker])), terminalByWorker = new Map((w.app?.terminals || []).map(t => [t.workerId, t]));
    const launchBlocked = w.app?.demo || (run.paired && (!run.paired.approvedAt || ['provision-failed', 'interrupted', 'needs-human', 'passed', 'testing', 'integrating'].includes(run.paired.state)));
    const rows = run.assignments.map(a => { const worker = workers.get(a.workerId), terminal = worker && terminalByWorker.get(worker.id), canLaunch = ['ready', 'challenged'].includes(a.status) && !launchBlocked;
      const workspace = a.workspace || (run.paired && a.role !== 'developer' ? run.integrationCwd : null);
      const handoff = !w.app?.demo && a.role === 'orchestrator' && run.paired?.approvedAt && run.integration && ['awaiting-gates', 'awaiting-review', 'interrupted'].includes(run.paired.state) ? `<button class="aw-button" data-aw-handoff="${a.id}" data-run="${run.id}">HANDOFF</button>` : '';
      const reassign = !w.app?.demo && a.role === 'developer' && a.status === 'submitted' && run.paired?.approvedAt && run.integration && ['submitted', 'awaiting-gates', 'awaiting-review'].includes(run.paired.state) ? `<button class="aw-button" data-aw-reassign="${a.id}" data-run="${run.id}">REASSIGN</button>` : '';
      return `<article class="aw-assignment"><div><strong>${esc(a.title)}</strong><small>${esc(a.provider)} · ${esc(a.model)} · ${esc(a.effort)} · ${esc(a.status)} · attempt ${a.attempt}/${run.policy.maxAttempts}</small>${a.allowedPaths ? `<small>Owns: ${esc(a.allowedPaths.join(', '))}</small>` : ''}${workspace ? `<small>Workspace: ${esc(workspace)}</small>` : ''}</div><div class="aw-actions">${handoff}${reassign}${canLaunch ? `<button class="aw-button primary" data-aw-launch="${a.id}" data-run="${run.id}">LAUNCH</button>` : ''}${terminal ? `<button class="aw-button" data-aw-terminal="${terminal.id}" data-name="${esc(a.title)}">OPEN</button>` : ''}${worker && !worker.revokedAt ? `<button class="aw-button" data-aw-message="${worker.id}" data-run="${run.id}">MESSAGE</button>` : ''}${run.paired?.approvedAt && a.role === 'developer' && ['submitted', 'challenged', 'ownership-violation', 'interrupted'].includes(a.status) ? `<button class="aw-button" data-aw-rework="${a.id}" data-run="${run.id}">REWORK</button>` : ''}</div></article>`; }).join('');
    const lastGate = run.checks.at(-1), staleGate = run.paired && (run.integration?.invalidatedAt || lastGate?.integrationId !== run.integration?.id), gate = lastGate ? `${staleGate ? 'STALE' : lastGate.exitCode === 0 && !lastGate.timedOut ? 'PASS' : 'FAIL'} · ${esc(lastGate.command)}` : 'NOT RUN';
    const messages = run.messages.slice(-6).reverse().map(m => `<li>${esc(m.fromWorkerId === 'user' ? 'you' : workers.get(m.fromWorkerId)?.role || 'worker')} → ${esc(workers.get(m.toWorkerId)?.role || 'worker')}: ${esc(m.body)}</li>`).join('');
    const pairedControls = run.paired ? `${run.paired.state === 'awaiting-approval' ? `<button class="aw-button primary" data-aw-approve="${run.id}">APPROVE &amp; PROVISION</button>` : ''}${run.paired.approvedAt ? `<button class="aw-button" data-aw-integrate="${run.id}" ${run.assignments.filter(a => a.role === 'developer').every(a => a.status === 'submitted') ? '' : 'disabled'}>INTEGRATE</button>${['interrupted', 'gate-failed', 'integration-conflict', 'ownership-violation', 'challenged', 'needs-human'].includes(run.paired.state) ? `<button class="aw-button" data-aw-recover="${run.id}">RECOVER</button>` : ''}` : ''}` : '';
    const pairedDetails = run.paired ? `<p>${esc(run.paired.detail || 'Codex frontend and Claude backend share the approved endpoint contract.')}</p><p>Base: ${esc(run.baseRef || (run.paired.base ? [run.paired.base.remote, run.paired.base.ref].filter(Boolean).join('/') : 'HEAD (legacy)'))} · ${esc(run.baseCommit || 'pinned on approval')}</p><details><summary>Approved scope, contract and gates</summary>${awPairDetails(run)}</details>${run.integration ? `<small>Integration: ${esc(run.integration.id)} · ${esc(run.integration.treeHash || run.integration.hash)}</small><p><button class="aw-button" data-aw-docker="${run.id}">PREPARE DOCKER STACK</button></p>` : ''}` : '';
    return `<section class="aw-run"><header><div><h4>${esc(run.objective)}</h4><small>${esc(run.paired?.state || run.status)} · audit ${esc((w.orchestration.auditHead || '').slice(0, 10))}${run.policy?.budget ? ` · ${esc(awBudgetLabel(run.policy.budget))}` : ''}</small></div><div class="aw-actions">${pairedControls}<button class="aw-button primary" data-aw-wave="${run.id}" ${launchBlocked ? 'disabled' : ''}>LAUNCH READY WAVE</button><button class="aw-button" data-aw-gate="${run.id}" ${run.paired && (!run.integration || !run.paired.approvedAt) ? 'disabled' : ''}>RUN GATE</button></div></header><p>Trusted gate: ${gate}</p>${pairedDetails}${rows}${messages ? `<ul class="aw-messages">${messages}</ul>` : ''}</section>`;
  }).join('') : '<p class="aw-empty">No orchestration runs yet. Create a mixed-model SDLC run.</p>';
  mount.querySelectorAll('[data-aw-launch]').forEach(button => button.onclick = async () => { try { button.disabled = true; const result = await awRequest(`/api/orchestrations/${button.dataset.run}/launch`, { assignmentId: button.dataset.awLaunch }); awOpenTerminal(result.terminalId, 'Orchestration worker'); } catch (e) { showToast(e.message); } finally { button.disabled = false; } });
  mount.querySelectorAll('[data-aw-terminal]').forEach(button => button.onclick = () => awOpenTerminal(button.dataset.awTerminal, button.dataset.name));
  mount.querySelectorAll('[data-aw-message]').forEach(button => button.onclick = () => awMessageForm(button.dataset.run, button.dataset.awMessage));
  mount.querySelectorAll('[data-aw-handoff]').forEach(button => button.onclick = () => awHandoffForm(button.dataset.run, button.dataset.awHandoff));
  mount.querySelectorAll('[data-aw-reassign]').forEach(button => button.onclick = () => awReassignForm(button.dataset.run, button.dataset.awReassign));
  mount.querySelectorAll('[data-aw-gate]').forEach(button => button.onclick = () => awGateForm(button.dataset.awGate));
  mount.querySelectorAll('[data-aw-docker]').forEach(button => button.onclick = () => awDockerForm(button.dataset.awDocker));
  mount.querySelectorAll('[data-aw-approve]').forEach(button => button.onclick = () => awApprovePair(button.dataset.awApprove));
  mount.querySelectorAll('[data-aw-integrate]').forEach(button => button.onclick = async () => { try { button.disabled = true; await awRequest(`/api/orchestrations/${button.dataset.awIntegrate}/integrate`, {}); showToast('Integration captured. Run the approved gates next.'); } catch (e) { showToast(e.message); } finally { button.disabled = false; } });
  mount.querySelectorAll('[data-aw-recover]').forEach(button => button.onclick = () => awForm('Recover the retained run', '<p>Retained worktrees will be preserved. Recovery reopens interrupted assignments within their attempt budgets. Stop active implementation and review terminals before recovering.</p>', 'RECOVER', () => awRequest(`/api/orchestrations/${button.dataset.awRecover}/recover`, {})));
  mount.querySelectorAll('[data-aw-rework]').forEach(button => button.onclick = () => awForm('Reopen this developer assignment', '<p>Keep the existing worktree for repairs. A new submission will require integration, gates, and independent review again.</p>', 'REOPEN FOR REWORK', () => awRequest(`/api/orchestrations/${button.dataset.run}/rework`, { assignmentId: button.dataset.awRework })));
  mount.querySelectorAll('[data-aw-wave]').forEach(button => button.onclick = async () => { try { button.disabled = true; const result = await awRequest(`/api/orchestrations/${button.dataset.awWave}/launch-wave`, {}); showToast(`Launched ${result.launched.length} workers${result.failed?.length ? ` · ${result.failed.length} need attention` : ''}`); } catch (e) { showToast(e.message); } finally { button.disabled = false; } });
}
function awBudgetLabel(b) {
  const fmt = v => b.unit === 'usd' ? '$' + Number(v).toFixed(Number(v) < 1 ? 4 : 2) : `${v} ${b.unit}`;
  return `budget ${fmt(b.spent || 0)} / ${fmt(b.limit)}`;
}
function awRosterRow(role, provider, model, effort = 'high', lens = '') {
  const providerNames = Object.keys(awWorld?.app?.providers || { claude: 1, codex: 1 });
  const models = awWorld?.app?.providers?.[provider]?.models || []; return `<div class="aw-roster-row"><span>${esc(lens ? `${role} · ${lens}` : role)}</span><select name="provider">${providerNames.map(p => `<option ${provider === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select><input name="model" required value="${esc(model)}" list="aw-models"><select name="effort">${['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(v => `<option ${v === effort ? 'selected' : ''}>${v}</option>`).join('')}</select><input type="hidden" name="role" value="${role}"><input type="hidden" name="lens" value="${lens}"></div>`; }
function awHandoffForm(runId, assignmentId) {
  const run = awWorld?.orchestration?.runs.find(r => r.id === runId), a = run?.assignments.find(a => a.id === assignmentId);
  if (!a || !run.integration) return;
  const expected = { assignmentId, workerId: a.workerId, approvalHash: run.paired.approvalHash, integrationId: run.integration.id, confirm: true };
  awForm('Approve orchestrator handoff', `<p>Replace ${esc(a.provider)} / ${esc(a.model)} / ${esc(a.effort)}. Revoke its credential and stop its terminal. Developer submissions and source bytes are preserved. This amends the roster approval and requires fresh gates and independent reviews. Launch the replacement separately after approval.</p>${awRosterRow('orchestrator', 'claude', 'claude-opus-4-8', 'high')}<label>Current approval</label><textarea readonly>${esc(expected.approvalHash)}</textarea>`, 'APPROVE HANDOFF', async input => {
    await awRequest(`/api/orchestrations/${runId}/handoff`, { ...expected, provider: input.provider, model: input.model, effort: input.effort });
    showToast('Handoff approved. Use LAUNCH on the replacement orchestrator.');
  });
}
function awReassignForm(runId, assignmentId) {
  const run = awWorld?.orchestration?.runs.find(r => r.id === runId), a = run?.assignments.find(a => a.id === assignmentId);
  if (!a || !run.integration) return;
  const expected = { assignmentId, workerId: a.workerId, submissionId: a.submissionId, targetAttempt: a.attempt, approvalHash: run.paired.approvalHash, integrationId: run.integration.id, confirm: true };
  const efforts = awWorld?.app?.providers?.[a.provider]?.efforts || ['low', 'medium', 'high', 'xhigh', 'max'];
  awForm('Approve developer reassignment', `<p>Replace ${esc(a.provider)} / ${esc(a.model)} / ${esc(a.effort)} while preserving its worktree, ownership, history and sibling submission. The old integration and Docker export become stale. A new attempt, capture, integration, gates and reviews are mandatory.</p><label>Provider</label><input readonly value="${esc(a.provider)}"><label>Model</label><input name="model" required value="${esc(a.provider === 'codex' ? 'gpt-5.6-sol' : a.model)}"><label>Effort</label><select name="effort">${efforts.map(v => `<option ${v === 'medium' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><label>Current approval</label><textarea readonly>${esc(expected.approvalHash)}</textarea>`, 'APPROVE REASSIGNMENT', async input => {
    await awRequest(`/api/orchestrations/${runId}/reassign-developer`, { ...expected, model: input.model, effort: input.effort });
    showToast('Developer reassigned. The orchestrator can launch the new attempt.');
  });
}
function awOrchestrationForm(paired = false) {
  const council = ['assumptions', 'completeness', 'data-truth', 'silent-failure', 'spec-fidelity'];
  const rows = [awRosterRow('orchestrator', 'claude', 'opus', 'xhigh'), awRosterRow('orchestrator', 'codex', 'gpt-6-astra', 'xhigh'), ...(paired ? [] : [awRosterRow('requirements', 'claude', 'opus', 'high'), awRosterRow('architect', 'codex', 'gpt-6-astra', 'xhigh')]), awRosterRow('developer', 'claude', 'sonnet'), awRosterRow('developer', 'codex', 'gpt-5.6-terra'), awRosterRow('tester', 'codex', 'gpt-5.6-sol'), awRosterRow('reviewer', 'claude', 'opus', 'xhigh'), ...council.map((lens, i) => awRosterRow('council', i % 2 ? 'claude' : 'codex', i % 2 ? 'opus' : 'gpt-6-astra', 'xhigh', lens))];
  const allModels = Object.values(awWorld?.app?.providers || {}).flatMap(p => p.models || []);
  const defaultContract = { endpoints: [{ method: 'GET', path: '/api/hello', request: {}, response: { status: 200, body: { message: 'hello' } } }], acceptance: ['Frontend consumes the backend response'] };
  const pairedFields = paired ? `<p>Codex owns frontend work; Claude owns backend work. Each gets a separate worktree from the same pinned branch revision. Shared files remain human-owned. Creating a proposal does not launch workers.</p><label>Base branch</label><input name="baseRef" value="develop" required><label>Remote (blank for local fixture)</label><input name="baseRemote" value="origin"><label>Refresh before provisioning</label><select name="baseRefresh"><option value="true">Fetch latest remote branch (required for fresh develop)</option><option value="false">Use local ref without fetching (offline fixture)</option></select><label>Frontend directories, one per line</label><textarea name="frontendPaths" required>frontend/</textarea><label>Backend directories, one per line</label><textarea name="backendPaths" required>backend/</textarea><label>Endpoint contract and acceptance criteria (JSON)</label><textarea name="contract" rows="10" required>${esc(JSON.stringify(defaultContract, null, 2))}</textarea><label>Trusted evaluation commands (JSON)</label><textarea name="gates" rows="5" required>${esc(JSON.stringify([{ command: 'node', args: ['--test', 'tests/acceptance.test.mjs'] }], null, 2))}</textarea><p>Keep the acceptance harness outside developer-owned directories. Review the actual commands before approval.</p>` : '';
  awForm(paired ? 'Propose a paired worktree run' : 'Create an SDLC run', `<label>Objective</label><textarea name="objective" required maxlength="4000" placeholder="What outcome should the council verify?"></textarea><label>Project directory</label><input name="cwd" required placeholder="/absolute/path/to/project">${pairedFields}${paired ? '' : `<label>Budget (optional)</label><div class="aw-budget-row"><select name="budgetUnit"><option value="">No cap</option><option value="usd">US dollars ($, estimated)</option><option value="tokens">Tokens (estimated)</option><option value="agents">Agent launches (exact)</option></select><input name="budgetLimit" type="number" min="0" step="any" placeholder="limit, e.g. 5"><label class="aw-check"><input type="checkbox" name="autoRoute"> Auto-route models from the catalog (local for light roles, frontier for heavy reasoning)</label></div>`}<label>Provider and model roster</label><datalist id="aw-models">${allModels.map(m => `<option value="${esc(m)}">`).join('')}</datalist><div id="aw-roster">${rows.join('')}</div>`, paired ? 'CREATE PROPOSAL' : 'CREATE RUN', async (_flat, form) => {
    const roster = [...form.querySelectorAll('.aw-roster-row')].map(row => ({ role: row.querySelector('[name=role]').value, provider: row.querySelector('[name=provider]').value, model: row.querySelector('[name=model]').value, effort: row.querySelector('[name=effort]').value, count: 1 }));
    const input = { objective: form.elements.objective.value, cwd: form.elements.cwd.value, roster };
    if (!paired) { const unit = form.elements.budgetUnit?.value; if (unit) input.budget = { unit, limit: Number(form.elements.budgetLimit.value) }; if (form.elements.autoRoute?.checked) input.autoRoute = true; }
    if (paired) { try { input.paired = { base: { ref: form.elements.baseRef.value.trim(), remote: form.elements.baseRemote.value.trim() || null, refresh: form.elements.baseRefresh.value === 'true' }, contract: JSON.parse(form.elements.contract.value), gates: JSON.parse(form.elements.gates.value), frontendPaths: form.elements.frontendPaths.value.split(/\n/).map(p => p.trim()).filter(Boolean), backendPaths: form.elements.backendPaths.value.split(/\n/).map(p => p.trim()).filter(Boolean) }; } catch { throw Error('Contract and gate fields must contain valid JSON.'); } }
    await awRequest('/api/orchestrations', input); document.getElementById('aw-orchestrate').hidden = false;
  });
}
function awMessageForm(runId, toWorkerId) { awForm('Dispatch a scoped message', '<label>Message</label><textarea name="body" required maxlength="8000" placeholder="Finding, decision, or request. This cannot grant permissions."></textarea>', 'SEND', input => awRequest(`/api/orchestrations/${runId}/message`, { toWorkerId, body: input.body })); }
function awPairDetails(run) { return `<label>Approval hash</label><textarea readonly rows="2">${esc(run.paired.approvalHash)}</textarea><label>Contract</label><textarea readonly rows="8">${esc(JSON.stringify(run.paired.contract, null, 2))}</textarea><label>Frozen gate commands</label><textarea readonly rows="5">${esc(JSON.stringify(run.paired.gates, null, 2))}</textarea><p>Protected evaluation paths: ${esc((run.paired.protectedPaths || []).join(', '))}. Package manifests are also human-owned.</p><label>Ownership and worker roster</label><textarea readonly rows="8">${esc(JSON.stringify(run.assignments.map(a => ({ role: a.role, provider: a.provider, model: a.model, effort: a.effort, allowedPaths: a.allowedPaths || [], parentAssignmentId: a.parentAssignmentId })), null, 2))}</textarea>`; }
function awApprovePair(runId) { const run = awWorld?.orchestration?.runs.find(r => r.id === runId); if (!run?.paired) return; awForm('Approve contract and provision worktrees', `<p>Approve this exact contract, ownership, roster and trusted gate commands. Provisioning creates detached Git worktrees from the selected branch; it does not launch model sessions. Gate execution is separate.</p><p>Repository: ${esc(run.cwd)}</p><p>Base policy: ${esc(JSON.stringify(run.paired.base || { ref: 'HEAD', refresh: false }))}. A failed fetch stops provisioning; no stale fallback.</p>${awPairDetails(run)}`, 'APPROVE & PROVISION', () => awRequest(`/api/orchestrations/${runId}/approve`, { confirm: true, approvalHash: run.paired.approvalHash })); }
function awDockerForm(runId) {
  awForm('Prepare an isolated Docker stack', '<p>Exports this integration revision into sanitized build contexts. Does not start containers or copy credentials. The app profile requires a dedicated test database and the test credentials your own stack declares.</p><label>Stack profile</label><select name="profile"><option value="app">App stack (frontend + API + Redis)</option><option value="smoke">Credential-free paired fixture</option></select>', 'PREPARE', async input => {
    const recipe = await awRequest(`/api/orchestrations/${runId}/docker`, input);
    // Open after awForm finishes closing its submission dialog.
    setTimeout(() => {
      const quote = v => "'" + String(v).replaceAll("'", "'\\''") + "'";
      const commands = Object.entries(recipe.commands).map(([name, argv]) => `${name}:\n${argv.map(quote).join(' ')}`).join('\n\n');
      awForm('Docker stack prepared', `<p>Project: ${esc(recipe.projectName)}</p><p>Files: ${esc(recipe.directory)}</p><p>Configure only test credentials in the generated env files before starting the stack. Read the generated instructions. No containers have been started.</p><textarea readonly rows="14">${esc(commands)}</textarea>`, 'DONE', async () => {});
    }, 0);
  });
}
function awGateForm(runId) { const run = awWorld?.orchestration?.runs.find(r => r.id === runId); if (run?.paired) { awForm('Run the approved integration gates', `<p>Execute these frozen commands in the captured integration worktree. Source changes invalidate the result.</p><p>${esc(run.integrationCwd || '')}</p><textarea readonly rows="8">${esc(JSON.stringify(run.paired.gates, null, 2))}</textarea>`, 'RUN AND RECORD', () => awRequest(`/api/orchestrations/${runId}/gate`, { confirm: true })); return; } awForm('Run a trusted deterministic gate', '<p>This executes directly in the run directory with secrets removed. No shell interpolation is used.</p><label>Executable</label><input name="command" required value="npm"><label>Arguments, one per line</label><textarea name="args" placeholder="test"></textarea>', 'RUN AND RECORD', input => awRequest(`/api/orchestrations/${runId}/gate`, { command: input.command, args: input.args.split(/\n/).map(v => v.trim()).filter(Boolean), confirm: true })); }
function awForm(title, fields, submitLabel, onSubmit) {
  const wrap = document.getElementById('aw-form'); wrap.hidden = false;
  wrap.innerHTML = `<form><h2>${title}</h2>${fields}<p id="aw-error" role="alert"></p><div class="aw-actions"><button type="button" class="aw-button" id="aw-cancel">CANCEL</button><button class="aw-button primary" type="submit">${submitLabel}</button></div></form>`;
  wrap.querySelector('#aw-cancel').onclick = () => { wrap.hidden = true; };
  wrap.querySelector('form').onsubmit = async e => { e.preventDefault(); const b = e.target.querySelector('[type=submit]'); b.disabled = true; try { await onSubmit(Object.fromEntries(new FormData(e.target)), e.target); wrap.hidden = true; } catch (err) { document.getElementById('aw-error').textContent = err.message; } finally { b.disabled = false; } };
  wrap.querySelector('input')?.focus();
}
function awTaskForm(sid) {
  const sessions = WORLD.sessions.filter(s => s.source !== 'archive');
  awForm('Plan a new build', `<label>Task</label><input name="title" required maxlength="300" placeholder="What are we building?"><label>System component</label><select name="component">${Object.entries(awKindNames).map(([key, name]) => `<option value="${key}">${name}</option>`).join('')}</select><label>Depends on</label><select name="dependency"><option value="">Independent foundation</option>${(awWorld.tasks || []).filter(t => t.source !== 'orchestration').map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select><label>Builder</label><select name="sessionId" required>${sessions.map(s => `<option value="${esc(s.sessionId)}" ${s.sessionId === sid ? 'selected' : ''}>${esc(disp(s))}</option>`).join('')}</select>`, 'LAY FOUNDATION', async input => { const s = byId[input.sessionId]; await awRequest('/api/tasks', { ...input, dependsOn: input.dependency ? [input.dependency] : [], cwd: s?.cwd, biome: s?.biome }); document.getElementById('aw-tasks').hidden = false; });
}
function awLaunchForm() {
  const models = Object.values(awWorld?.app?.providers || {}).flatMap(p => p.models || []);
  awForm('Invite a builder', `<label>Session name</label><input name="name" required maxlength="80" placeholder="New builder"><label>Provider</label><select name="provider"><option value="claude">Claude Code</option><option value="codex">Codex</option></select><label>Model</label><input name="model" required value="sonnet" list="aw-launch-models"><datalist id="aw-launch-models">${models.map(m => `<option value="${esc(m)}">`).join('')}</datalist><label>Effort</label><select name="effort"><option>medium</option><option selected>high</option><option>xhigh</option><option>max</option></select><label>Project directory</label><input name="cwd" required placeholder="/absolute/path/to/project"><label>Opening task</label><textarea name="prompt" maxlength="16000" placeholder="What should this builder work on?"></textarea>`, 'OPEN SESSION', async input => { const t = await awRequest('/api/terminal/open', { ...input, role: 'developer', mode: 'new' }); awOpenTerminal(t.id, input.name); });
}
function awSetTerminalColumns(columns) {
  awTerminalColumns = Math.max(1, Math.min(4, columns || 2)); localStorage.setItem('agent-world-terminal-columns', String(awTerminalColumns));
  const deck = document.getElementById('aw-terminal-deck'); if (!deck) return; deck.dataset.columns = String(awTerminalColumns);
  deck.style.setProperty('--aw-terminal-columns', awTerminalColumns);
  deck.querySelectorAll('[data-aw-columns]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.awColumns) === awTerminalColumns)));
  requestAnimationFrame(awFitTerminals);
}
function awFitTerminals() { for (const item of awTerminals.values()) { try { item.fit.fit(); } catch {} } }
function awUpdateTerminalDeck() {
  const count = awTerminals.size, deck = document.getElementById('aw-terminal-deck');
  try { sessionStorage.setItem('agent-world-terminal-views', JSON.stringify([...awTerminals.keys()])); } catch {}
  setTxt('aw-terminal-count', `${count} open`);
  const switcher = document.getElementById('aw-terminal-switcher'); switcher.replaceChildren();
  for (const item of awTerminals.values()) { const b = document.createElement('button'); b.className = 'aw-terminal-control'; b.textContent = item.name; b.onclick = () => { awRevealTerminal(item); item.card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); requestAnimationFrame(() => { item.fit.fit(); item.terminal.focus(); }); }; switcher.appendChild(b); }
  if (!count) switcher.textContent = 'Open a session from the world, or choose OPEN ALL LIVE. This only opens views.';
}
function awTerminalRect(rect = {}, index = 0) {
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return { x: Math.max(0, Math.min(8000, number(rect.x, (index % 3) * 36))), y: Math.max(0, Math.min(8000, number(rect.y, Math.floor(index / 3) * 280 + (index % 3) * 28))), w: Math.max(320, Math.min(2400, number(rect.w, 600))), h: Math.max(220, Math.min(1600, number(rect.h, 360))) };
}
function awApplyTerminalRect(item) {
  const r = item.rect; item.card.style.setProperty('--terminal-x', `${r.x}px`); item.card.style.setProperty('--terminal-y', `${r.y}px`); item.card.style.setProperty('--terminal-w', `${r.w}px`); item.card.style.setProperty('--terminal-h', `${r.h}px`);
}
function awSaveTerminalRect(item) { awTerminalGeometry[item.id] = item.rect; try { localStorage.setItem('agent-world-terminal-geometry', JSON.stringify(awTerminalGeometry)); } catch {} }
function awRaiseTerminal(item) { item.card.style.zIndex = String(++awTerminalZ); for (const t of awTerminals.values()) t.card.classList.toggle('is-active', t === item); }
function awRevealTerminal(item) { for (const t of awTerminals.values()) t.card.classList.remove('is-focused'); document.getElementById('aw-terminal-deck').classList.remove('has-focus'); item.card.classList.remove('is-minimized'); awRaiseTerminal(item); }
function awSetTerminalMode(mode) {
  awTerminalMode = mode === 'free' ? 'free' : 'grid'; localStorage.setItem('agent-world-terminal-mode', awTerminalMode);
  document.getElementById('aw-terminal-deck').dataset.mode = awTerminalMode;
  document.getElementById('aw-terminal-mode').textContent = awTerminalMode === 'free' ? 'TILE GRID' : 'FREEFORM';
  for (const item of awTerminals.values()) awApplyTerminalRect(item);
  requestAnimationFrame(awFitTerminals);
}
function awArrangeTerminals() {
  const grid = document.getElementById('aw-terminal-grid'), columns = Math.max(1, Math.floor(grid.clientWidth / 420)); let i = 0;
  for (const item of awTerminals.values()) { item.card.classList.remove('is-focused', 'is-minimized'); item.rect = awTerminalRect({ x: (i % columns) * 420 + 8, y: Math.floor(i / columns) * 300 + 8, w: 412, h: 292 }); awApplyTerminalRect(item); awSaveTerminalRect(item); i++; }
  document.getElementById('aw-terminal-deck').classList.remove('has-focus'); requestAnimationFrame(awFitTerminals);
}
function awBindTerminalWindow(item) {
  const header = item.card.querySelector('header'), handle = item.card.querySelector('[data-terminal-resize]');
  header.tabIndex = 0; header.setAttribute('aria-label', `Move ${item.name}; use arrow keys`);
  function move(event, resize) {
    if (event.button !== 0 || item.card.classList.contains('is-focused') || (!resize && event.target.closest('button'))) return;
    event.preventDefault(); awRaiseTerminal(item);
    const target = resize ? handle : header, start = { ...item.rect }, x = event.clientX, y = event.clientY;
    target.setPointerCapture(event.pointerId); item.card.classList.add('is-dragging');
    const update = e => { const dx = e.clientX - x, dy = e.clientY - y;
      if (resize) item.rect = awTerminalRect({ ...start, w: start.w + dx, h: start.h + dy });
      else if (awTerminalMode === 'free') item.rect = awTerminalRect({ ...start, x: start.x + dx, y: start.y + dy });
      else { const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.aw-terminal-card'); if (over && over !== item.card) { const box = over.getBoundingClientRect(); over.parentNode.insertBefore(item.card, e.clientY < box.top + box.height / 2 ? over : over.nextSibling); } }
      awApplyTerminalRect(item);
    };
    const end = () => { target.removeEventListener('pointermove', update); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); target.removeEventListener('lostpointercapture', end); item.card.classList.remove('is-dragging'); if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId); awSaveTerminalRect(item); };
    target.addEventListener('pointermove', update); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end); target.addEventListener('lostpointercapture', end);
  }
  header.addEventListener('pointerdown', e => move(e, false)); handle.addEventListener('pointerdown', e => move(e, true));
  const keyboard = (e, resize) => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key) || (!resize && e.target !== header)) return; e.preventDefault();
    const dx = e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0, dy = e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0;
    if (resize) item.rect = awTerminalRect({ ...item.rect, w: item.rect.w + dx, h: item.rect.h + dy });
    else if (awTerminalMode === 'free') item.rect = awTerminalRect({ ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy });
    else { const next = dx + dy > 0 ? item.card.nextElementSibling : item.card.previousElementSibling; if (next) next.parentNode.insertBefore(item.card, dx + dy > 0 ? next.nextSibling : next); }
    awApplyTerminalRect(item); awSaveTerminalRect(item);
  };
  header.addEventListener('keydown', e => keyboard(e, false)); handle.addEventListener('keydown', e => keyboard(e, true));
  let frame = 0; item.observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (item.card.isConnected && item.card.offsetWidth) { try { item.fit.fit(); } catch {} } }); }); item.observer.observe(item.card);
  item.cancelFit = () => cancelAnimationFrame(frame);
}
function awFocusTerminal(id) {
  const selected = awTerminals.get(id); if (!selected) return;
  selected.card.classList.remove('is-minimized');
  const focused = selected.card.classList.toggle('is-focused');
  for (const [otherId, item] of awTerminals) if (otherId !== id) item.card.classList.remove('is-focused');
  document.getElementById('aw-terminal-deck').classList.toggle('has-focus', focused);
  requestAnimationFrame(() => { awFitTerminals(); selected.terminal.focus(); });
}
async function awCloseTerminal(id, stop = false) {
  const item = awTerminals.get(id); if (!item) return;
  if (stop && !confirm(`Stop ${item.name}? Imported tmux sessions are detached from Agent World; app-launched processes are ended.`)) return;
  if (stop) await awRequest('/api/terminal/close', { id });
  item.observer?.disconnect(); item.cancelFit?.();
  item.socket.close(); item.terminal.dispose(); item.card.remove(); awTerminals.delete(id);
  document.getElementById('aw-terminal-deck').classList.remove('has-focus'); awUpdateTerminalDeck(); requestAnimationFrame(awFitTerminals);
}
function awOpenTerminal(id, name) {
  closeDrawer(); const deck = document.getElementById('aw-terminal-deck'); deck.hidden = false;
  const existing = awTerminals.get(id); if (existing) { awRevealTerminal(existing); existing.card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); requestAnimationFrame(() => { existing.fit.fit(); existing.terminal.focus(); }); return; }
  const card = document.createElement('article'); card.className = 'aw-terminal-card'; card.dataset.terminalId = id;
  card.innerHTML = `<header><div class="aw-terminal-identity"><i aria-hidden="true"></i><strong>${esc(name || 'Builder terminal')}</strong><span>connecting</span></div><div class="aw-terminal-actions"><button class="aw-terminal-control" data-terminal-minimize title="Minimize view">−</button><button class="aw-terminal-control" data-terminal-focus title="Focus or restore this terminal">FOCUS</button><button class="aw-terminal-control" data-terminal-close title="Close this view; keep the session running">CLOSE</button><button class="aw-terminal-control danger" data-terminal-stop title="Stop or detach the Agent World terminal">STOP</button></div></header><div class="aw-terminal-screen"></div><button class="aw-terminal-resize" data-terminal-resize aria-label="Resize terminal; use arrow keys" title="Drag to resize; arrow keys also resize">◢</button>`;
  document.getElementById('aw-terminal-grid').appendChild(card);
  const mount = card.querySelector('.aw-terminal-screen'), status = card.querySelector('.aw-terminal-identity span');
  const terminal = new Terminal({ cursorBlink: !RM, fontSize: 12, lineHeight: 1.15, fontFamily: 'Menlo, Consolas, monospace', scrollback: 5000, allowProposedApi: false, theme: { background: '#172019', foreground: '#dce5ce', cursor: '#c7dd9c', cursorAccent: '#172019', selectionBackground: '#667957aa', black: '#172019', brightBlack: '#657064' } });
  const fit = new FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(mount);
  const socket = new WebSocket(`ws://${location.host}/api/terminal/${encodeURIComponent(id)}?token=${encodeURIComponent(awToken)}`);
  const item = { id, name: name || 'Builder terminal', card, terminal, fit, socket }; awTerminals.set(id, item); awUpdateTerminalDeck();
  item.rect = awTerminalRect(awTerminalGeometry[id], awTerminals.size - 1); awApplyTerminalRect(item); awBindTerminalWindow(item); awRaiseTerminal(item);
  socket.onopen = () => { status.textContent = 'live'; card.classList.add('is-live'); fit.fit(); socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); terminal.focus(); };
  socket.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'output') terminal.write(m.data); if (m.type === 'exit') { status.textContent = `exited ${m.code}`; card.classList.remove('is-live'); terminal.writeln(`\r\n[Process exited: ${m.code}]`); } };
  socket.onerror = () => { status.textContent = 'connection failed'; card.classList.add('has-error'); showToast(`${item.name}: terminal connection failed`); };
  socket.onclose = () => { if (status.textContent === 'live') status.textContent = 'disconnected'; card.classList.remove('is-live'); };
  terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); });
  terminal.onResize(({ cols, rows }) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows })); });
  card.querySelector('[data-terminal-focus]').onclick = () => awFocusTerminal(id);
  card.querySelector('[data-terminal-minimize]').onclick = () => { card.classList.remove('is-focused'); card.classList.toggle('is-minimized'); document.getElementById('aw-terminal-deck').classList.remove('has-focus'); };
  card.querySelector('[data-terminal-close]').onclick = () => awCloseTerminal(id, false).catch(e => showToast(e.message));
  card.querySelector('[data-terminal-stop]').onclick = () => awCloseTerminal(id, true).catch(e => showToast(e.message));
  card.addEventListener('pointerdown', () => awRaiseTerminal(item)); mount.addEventListener('pointerdown', () => terminal.focus()); requestAnimationFrame(() => fit.fit());
}

function awBuildTasks(tasks) {
  const signature = JSON.stringify(tasks.map(t => [t.id, t.sessionId, t.stage])); if (signature === awTaskSignature) return; awTaskSignature = signature;
  if (awBuildings) { scene.remove(awBuildings); awBuildings.traverse(m => { if (m.isInstancedMesh) m.dispose?.(); }); }
  for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i].userData.taskBuilding) { pickables[i].material.dispose(); pickables.splice(i, 1); }
  awBuildings = new THREE.Group(); scene.add(awBuildings); const batches = new Map(), owners = new Map();
  for (const task of tasks) { if (!owners.has(task.sessionId)) owners.set(task.sessionId, []); owners.get(task.sessionId).push(task); }
  const add = (x, y, z, w, h, d, texture) => { const material = mat(texture); if (!batches.has(material)) batches.set(material, []); batches.get(material).push([x, y, z, w, h, d]); };
  for (const [sid, list] of owners) {
    const p = agentPos[sid]; if (!p) continue; const x = p.x, z = p.z - 1.8, y = p.y, done = list.filter(t => t.stage === 'completed').length, active = list.some(t => t.stage === 'building'), blocked = list.some(t => t.stage === 'blocked');
    add(x, y + .08, z, 2.4, .16, 2.4, T.stonebrick());
    const h = 1.7 + Math.min(2, Math.max(0, done - 1)) * .8;
    if (done) {
      add(x, y + h / 2, z - .9, 2, h, .2, T.cobble()); add(x - .9, y + h / 2, z, .2, h, 2, T.cobble()); add(x + .9, y + h / 2, z, .2, h, 2, T.cobble());
      for (const side of [-1, 1]) add(x + side * .68, y + h / 2, z + .9, .65, h, .2, T.planks());
      add(x, y + h - .2, z + .9, 2, .4, .2, T.planks());
      for (let i = 0; i < 4; i++) add(x, y + h + i * .23, z, 2.6 - i * .6, .26, 2.6, T.planks());
      add(x + .7, y + 1.1, z + 1.04, .22, .3, .12, T.glowstone());
    } else if (active || blocked) {
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) add(x + dx, y + .9, z + dz, .16, 1.8, .16, T.log());
      add(x, y + 1.7, z, 2.2, .13, 2.2, T.planks());
    }
    if (blocked) add(x + 1, y + 2.4, z, .5, .5, .12, T.wool(0xb97845));
    const hit = new THREE.Mesh(geoBox(2.5, h + 1, 2.5), new THREE.MeshBasicMaterial({ visible: false })); hit.position.set(x, y + h / 2, z); hit.userData.sid = sid; hit.userData.taskBuilding = true; awBuildings.add(hit); pickables.push(hit);
  }
  for (const [material, cubes] of batches) { const m = new THREE.InstancedMesh(geoBox(1, 1, 1), material, cubes.length); cubes.forEach(([x, y, z, w, h, d], i) => { scratchMatrix.makeScale(w, h, d); scratchMatrix.setPosition(x, y, z); m.setMatrixAt(i, scratchMatrix); }); m.castShadow = m.receiveShadow = true; awBuildings.add(m); }
  renderer.shadowMap.needsUpdate = true;
}
