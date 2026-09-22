import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function element() {
  const events = new Map(), classes = new Set();
  return { events, style: { setProperty() {} }, classList: { contains: x => classes.has(x), add: x => classes.add(x), remove: (...xs) => xs.forEach(x => classes.delete(x)), toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } },
    setAttribute() {}, addEventListener(t, fn) { events.set(t, fn); }, removeEventListener(t) { events.delete(t); }, setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {}, isConnected: true, offsetWidth: 600 };
}
function harness() {
  const header = element(), handle = element(), card = element(); card.querySelector = s => s === 'header' ? header : handle;
  const item = { id: 'one', name: 'Review', card, fit: { fit() {} }, rect: { x: 30, y: 40, w: 600, h: 360 } };
  const state = { awTerminals: new Map([['one', item]]), awTerminalMode: 'free', awTerminalZ: 1, awTerminalGeometry: {}, localStorage: { setItem() {} }, document: {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, ResizeObserver: class { observe() {} disconnect() {} } };
  vm.createContext(state); vm.runInContext(source.slice(source.indexOf('function awTerminalRect('), source.indexOf('function awFocusTerminal(')), state);
  state.awBindTerminalWindow(item); return { state, item, header, handle };
}
test('geometry clamps nonfinite values and enforces usable sizes', () => {
  const { state } = harness(); const r = state.awTerminalRect({ x: -3, y: Infinity, w: 1, h: 99999 });
  assert.equal(r.x, 0); assert.equal(r.y, 0); assert.equal(r.w, 320); assert.equal(r.h, 1600);
});
test('header drag moves a freeform window and cleans pointer handlers', () => {
  const { item, header } = harness();
  header.events.get('pointerdown')({ button: 0, pointerId: 1, clientX: 100, clientY: 100, target: { closest: () => null }, preventDefault() {} });
  header.events.get('pointermove')({ clientX: 140, clientY: 125 }); assert.equal(item.rect.x, 70); assert.equal(item.rect.y, 65);
  header.events.get('pointerup')(); assert.equal(header.events.has('pointermove'), false);
});
test('resize handle changes dimensions, not position', () => {
  const { item, handle } = harness();
  handle.events.get('pointerdown')({ button: 0, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {} });
  handle.events.get('pointermove')({ clientX: 100, clientY: 80 }); assert.equal(item.rect.w, 700); assert.equal(item.rect.h, 440); assert.equal(item.rect.x, 30);
  handle.events.get('pointercancel')(); assert.equal(handle.events.has('pointermove'), false);
});
test('keyboard resizing is available without entering terminal input', () => {
  const { item, handle } = harness(); let prevented = false;
  handle.events.get('keydown')({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(item.rect.w, 620); assert.equal(prevented, true);
});
test('close view disposes observers and socket without stopping process', async () => {
  const { state, item } = harness(); const calls = [];
  state.awUpdateTerminalDeck = () => {}; state.awFitTerminals = () => {}; state.document.getElementById = () => ({ classList: { remove() {} } });
  state.awRequest = () => { calls.push('STOP'); }; item.socket = { close() { calls.push('socket'); } }; item.terminal = { dispose() { calls.push('dispose'); } }; item.card.remove = () => calls.push('card'); item.observer.disconnect = () => calls.push('observer');
  vm.runInContext(source.slice(source.indexOf('async function awCloseTerminal('), source.indexOf('function awOpenTerminal(')), state);
  await state.awCloseTerminal('one', false); assert.deepEqual(calls, ['observer', 'socket', 'dispose', 'card']); assert.equal(state.awTerminals.size, 0);
});
