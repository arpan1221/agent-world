import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.FRONTEND_URL;
if (!base) throw Error('FRONTEND_URL is required; container acceptance must never skip.');
const expected = process.env.EXPECTED_MESSAGE || 'hello from the backend';
test('Docker frontend proxies its paired backend over the private network', async () => {
  const response = await fetch(base + '/api/hello');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { message: expected });
});
test('Docker frontend consumer renders the paired backend response', async () => {
  const response = await fetch(base + '/render');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `<main>${expected}</main>`);
});
