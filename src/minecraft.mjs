import { gzipSync } from 'node:zlib';

export const BLOCK_STATES = { grass: 'minecraft:grass_block', dirt: 'minecraft:dirt', stone: 'minecraft:stone', stonebrick: 'minecraft:stone_bricks', cobble: 'minecraft:cobblestone', mossbrick: 'minecraft:mossy_stone_bricks', planks: 'minecraft:oak_planks', log: 'minecraft:oak_log[axis=y]', blue: 'minecraft:cyan_wool', gold: 'minecraft:yellow_wool', red: 'minecraft:red_wool', green: 'minecraft:green_wool', glowstone: 'minecraft:glowstone' };
// Java 1.20.1 baseline; all palette blocks predate this release.
const DATA_VERSION = 3465, MAX_VOLUME = 4_000_000;
const short = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const int = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const string = value => { const b = Buffer.from(value, 'utf8'); return Buffer.concat([short(b.length), b]); };
const named = (type, name, bytes) => Buffer.concat([Buffer.from([type]), string(name), bytes]);
const compound = (name, tags) => named(10, name, Buffer.concat([...tags, Buffer.from([0])]));

export function voxelize(plan, maxVolume = MAX_VOLUME) {
  const cubes = [];
  for (const s of plan.structures) for (const b of s.blocks) cubes.push({ ...b, x: b.x + s.position.x, y: b.y + s.position.y, z: b.z + s.position.z });
  cubes.push(...(plan.roadBlocks || []));
  if (!cubes.length) throw Error('This blueprint has no blocks to export.');
  // Fractional decorative parts occupy their nearest full block. Later pieces win.
  const boxes = cubes.map(b => {
    if (!BLOCK_STATES[b.material] || ![b.x,b.y,b.z,b.w,b.h,b.d].every(Number.isFinite) || Math.min(b.w,b.h,b.d) <= 0) throw Error('Unsupported blueprint block.');
    const x = Math.round(b.x - b.w / 2), y = Math.round(b.y - b.h / 2), z = Math.round(b.z - b.d / 2);
    return { x, y, z, w: Math.max(1, Math.round(b.w)), h: Math.max(1, Math.round(b.h)), d: Math.max(1, Math.round(b.d)), state: BLOCK_STATES[b.material] };
  });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) { min[0] = Math.min(min[0], b.x); min[1] = Math.min(min[1], b.y); min[2] = Math.min(min[2], b.z); max[0] = Math.max(max[0], b.x+b.w); max[1] = Math.max(max[1], b.y+b.h); max[2] = Math.max(max[2], b.z+b.d); }
  const [width, height, length] = max.map((v, i) => v-min[i]), volume = width*height*length;
  if (!Number.isSafeInteger(volume) || volume > Math.min(maxVolume, MAX_VOLUME) || Math.max(width,height,length) > 65535) throw Error('Export exceeds the 4-million-voxel limit; export a smaller blueprint revision.');
  const palette = ['minecraft:air', ...[...new Set(boxes.map(b => b.state))].sort()], ids = new Map(palette.map((s,i) => [s,i]));
  // Our bounded vanilla palette has fewer than 128 entries: one-byte varints.
  const data = Buffer.alloc(volume);
  for (const b of boxes) for (let y=b.y; y<b.y+b.h; y++) for (let z=b.z; z<b.z+b.d; z++) for (let x=b.x; x<b.x+b.w; x++) data[(x-min[0]) + (z-min[2])*width + (y-min[1])*width*length] = ids.get(b.state);
  return { width, height, length, origin: min, palette, data };
}

export function exportSchematic(plan) {
  const v = voxelize(plan);
  const schematic = compound('Schematic', [named(3,'Version',int(3)), named(3,'DataVersion',int(DATA_VERSION)), named(2,'Width',short(v.width)), named(2,'Height',short(v.height)), named(2,'Length',short(v.length)), named(11,'Offset',Buffer.concat([int(3), int(0), int(0), int(0)])),
    compound('Metadata', [named(8,'Name',string(`Agent World revision ${plan.revision}`)), named(8,'Author',string('Agent World')), named(8,'BlueprintHash',string(plan.hash))]),
    compound('Blocks',[compound('Palette',v.palette.map((s,i) => named(3,s,int(i)))), named(7,'Data',Buffer.concat([int(v.data.length),v.data]))])]);
  return gzipSync(compound('', [schematic]));
}
