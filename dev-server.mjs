import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const companyApi = require('./api/companies.js');
const envPath = path.join(root, '.env.development.local');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function loadDevelopmentEnv() {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function serveFile(req, res, pathname) {
  const requestedPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(root, requestedPath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let content;
  try { content = await readFile(filePath); } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const cacheControl = filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'content-type': contentType, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff' });
  if (req.method === 'HEAD') res.end();
  else res.end(content);
}

loadDevelopmentEnv();
const port = Number(process.env.PORT || 4174);
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/companies') {
    try { await companyApi(req, res); } catch { sendJson(res, 500, { error: 'Company search is temporarily unavailable.' }); }
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method || '')) {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  await serveFile(req, res, url.pathname);
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`GetItResolved development server listening on ${port}\n`);
});
