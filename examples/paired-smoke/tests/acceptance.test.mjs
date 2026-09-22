import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handler } from '../backend/handler.mjs';
import { loadGreeting } from '../frontend/client.mjs';

test('frontend consumes the real backend endpoint over HTTP', async () => {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const hello = await fetch(base + '/api/hello');
    assert.equal(hello.status, 200);
    assert.match(hello.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await hello.json(), { message: 'hello from the backend' });
    assert.equal(await loadGreeting(base), 'hello from the backend');
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/missing')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('frontend uses its supplied URL and reports backend failures', async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/api/hello') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'independent fixture' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await loadGreeting(`http://127.0.0.1:${server.address().port}`), 'independent fixture'); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(loadGreeting('http://127.0.0.1:1'));
});
