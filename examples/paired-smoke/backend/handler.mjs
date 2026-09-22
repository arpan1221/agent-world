export function handler(_request, response) {
  response.writeHead(501, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'Implement GET /api/hello and GET /health.' }));
}
