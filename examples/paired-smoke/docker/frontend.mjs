import { createServer } from 'node:http';
import { loadGreeting } from '../frontend/client.mjs';
const api = process.env.API_PROXY_TARGET || 'http://api:3001';
createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Paired Docker fixture</h1>'); }
    if (req.url === '/render') { const message = await loadGreeting(api); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<main>${message}</main>`); }
    if (req.url === '/api/hello') { const upstream = await fetch(api + '/api/hello'); res.writeHead(upstream.status, { 'content-type': 'application/json' }); return res.end(await upstream.text()); }
    res.writeHead(404); res.end();
  } catch { res.writeHead(502); res.end('Paired backend unavailable'); }
}).listen(3000, '0.0.0.0');
