// Versioned, renderer-independent build grammar. Coordinates and materials are data.
export function compileBlueprint(snapshot) {
  const structures = snapshot.facts.map((fact, slot) => {
    const state = fact.status, finished = state === 'accepted' || state === 'completed', submitted = state === 'submitted', working = state === 'running' || state === 'building', damaged = state === 'challenged' || state === 'needs-human' || state === 'blocked';
    const phase = state === 'retired' ? 0 : state === 'mapped' ? 3 : Math.max(fact.builtPhase || 0, finished ? 3 : submitted ? 2 : working || state === 'challenged' ? 1 : 0);
    const blocks = [], put = (x, y, z, w, h, d, material) => blocks.push({ x, y, z, w, h, d, material });
    // One immutable 18-block plot per first-observed component.
    const island = Math.floor(slot / 32), local = slot % 32;
    const position = { x: 210 + island % 4 * 95 + local % 4 * 18, y: 1, z: -80 + Math.floor(island / 4) * 165 + Math.floor(local / 4) * 18 };
    put(0, -.35, 0, 15, .7, 15, 'grass'); put(0, -.95, 0, 15, .5, 15, 'dirt');
    put(0, -2, 0, 15, 1.6, 15, 'dirt'); put(0, -4, 0, 14.8, 2.4, 14.8, 'stone');
    put(0, .1, 0, 9, .2, 9, 'stonebrick');
    for (const x of [-4, 4]) for (const z of [-4, 4]) put(x, .4, z, .45, .6, .45, 'log');
    if (phase > 0) {
      const tower = ['citadel', 'observatory', 'blueprint', 'council'].includes(fact.kind), height = tower ? 6 : 3.5;
      const wall = fact.kind === 'database' ? 'stonebrick' : ['archive', 'interface', 'workshop'].includes(fact.kind) ? 'planks' : 'cobble';
      for (const x of [-3.5, 3.5]) for (const z of [-3.5, 3.5]) put(x, height / 2, z, .55, height, .55, 'log');
      const builtHeight = phase === 1 ? height * .4 : height;
      // Individual masonry courses give construction a real block-placement sequence.
      for (let y = .6; y < builtHeight; y += .8) for (let x = -3; x <= 3; x++) {
        put(x, y, -3.4, .96, .76, .5, wall);
        if (Math.abs(x) > 1) put(x, y, 3.4, .96, .76, .5, wall);
        if (!(y > 1.5 && y < 2.8 && Math.abs(x) < 1.5)) { put(-3.4, y, x, .5, .76, .96, wall); put(3.4, y, x, .5, .76, .96, wall); }
      }
      if (phase < 3 || damaged) {
        for (const x of [-4.3, 4.3]) { put(x, 2, 0, .18, 4, .18, 'log'); put(x, 3.8, 0, .8, .18, 8.6, 'planks'); }
        for (let y = .8; y < 4; y += .6) put(4.3, y, 3, .8, .1, .15, 'planks');
      }
      if (phase >= 2) {
        if (tower) {
          for (let level = 0; level < 3; level++) put(0, height + level * .4, 0, 8.4 - level * 1.5, .4, 8.4 - level * 1.5, fact.kind === 'council' ? 'mossbrick' : 'stonebrick');
          put(0, height + 2, 0, .3, 2, .3, 'log'); put(.6, height + 2.5, 0, 1.2, .8, .15, fact.kind === 'blueprint' ? 'blue' : 'gold');
        } else for (let level = 0; level < 5; level++) put(0, height + level * .4, 0, 8.6 - level * 1.5, .45, 8.6, 'planks');
        if (fact.kind === 'database') for (const x of [-2, 0, 2]) for (let y = .7; y < 2.8; y += .8) put(x, y, 0, 1.5, .7, 1.5, 'stonebrick');
        if (fact.kind === 'interface') { put(0, 2.5, 3.7, 2.8, 1.2, .2, 'blue'); put(0, 4, 4.1, 8, .3, 1.8, 'blue'); }
        if (fact.kind === 'service' || fact.kind === 'workshop') { put(-2, height + 1.4, -2, 1.1, 2.8, 1.1, 'stonebrick'); put(0, .6, 1, 2, 1, 1.2, 'log'); }
        if (fact.kind === 'archive') for (const x of [-2.5, 2.5]) for (let y = .8; y < 3; y += .8) put(x, y, 0, .7, .6, 4, 'gold');
        if (fact.kind === 'pipeline' || fact.kind === 'test-chamber') for (let z = -2; z <= 2; z++) { put(0, .4, z, .3, .15, .9, 'red'); put(-1.5, .65, z, .6, .6, .6, 'stonebrick'); }
      }
    }
    // Evidence has bounded visual encoding; exact counts remain in the inspector.
    for (let i = 0; i < Math.min(6, fact.evidence.length); i++) put(-3 + i * 1.1, .6, 5.4, .85, .8, .7, 'log');
    const passes = fact.reviews.filter(v => v.verdict === 'pass').length;
    for (let i = 0; i < Math.min(5, passes); i++) put(-2.4 + i * 1.2, .45, -5.4, .4, .6, .4, 'glowstone');
    if (finished) { put(-4.7, 1.2, 4.7, .25, 2.4, .25, 'log'); put(-4.7, 2.5, 4.7, .6, .6, .6, state === 'accepted' ? 'green' : 'gold'); if (state === 'accepted') { put(-4.7, 3, 4.7, .4, .4, .4, 'glowstone'); put(-4.7, 4.5, 4.7, .15, 2.6, .15, 'green'); } }
    if (damaged) { put(4.7, 1.2, 4.7, .25, 2.4, .25, 'log'); put(4.7, 2.4, 4.7, 1, .8, .15, 'red'); }
    return { ...fact, slot, position, phase, blocks, builderState: working ? (fact.attempt > 1 ? 'repairing' : 'working') : damaged ? 'waiting' : finished ? 'celebrating' : submitted ? 'submitted' : 'idle', verified: state === 'accepted' && fact.authority === 'broker' };
  });
  const ids = new Set(structures.filter(s => s.status !== 'retired').map(s => s.id));
  const roads = structures.filter(s => s.status !== 'retired').flatMap(s => s.dependencies.filter(id => ids.has(id)).map(from => ({ id: `${from}->${s.id}`, from, to: s.id, ready: ['mapped', 'submitted', 'completed', 'accepted'].includes(structures.find(a => a.id === from).status) })));
  const roadBlocks = roads.flatMap(r => {
    const a = structures.find(s => s.id === r.from).position, b = structures.find(s => s.id === r.to).position, z = a.z + 8.1;
    return [
      { x: (a.x + b.x + 8.1) / 2, y: .95, z, w: Math.max(.8, Math.abs(a.x - b.x - 8.1)), h: .2, d: 1, material: 'stonebrick' },
      { x: b.x + 8.1, y: .95, z: (z + b.z + 8.1) / 2, w: 1, h: .2, d: Math.max(.8, Math.abs(z - b.z - 8.1)), material: 'stonebrick' },
      { x: b.x + 4, y: .95, z: b.z + 8.1, w: 8.2, h: .2, d: 1, material: 'stonebrick' },
      { x: b.x + 8.1, y: 1.2, z: b.z + 8.1, w: .65, h: .3, d: .65, material: r.ready ? 'gold' : 'red' }
    ];
  });
  return { version: 1, revision: snapshot.revision, hash: snapshot.hash, structures, roads, roadBlocks, counts: { sites: structures.length, accepted: structures.filter(s => s.verified).length, working: structures.filter(s => ['working', 'repairing'].includes(s.builderState)).length } };
}
