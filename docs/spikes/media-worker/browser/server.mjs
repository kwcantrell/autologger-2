// Static server + upload sink. node server.mjs <port>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.join(path.dirname(new URL(import.meta.url).pathname), 'www');
const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
const types = { '.html': 'text/html', '.js': 'text/javascript' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/upload') {
    const name = u.searchParams.get('name').replace(/[^\w.-]/g, '_');
    const ws = fs.createWriteStream(path.join(out, name));
    req.pipe(ws); ws.on('finish', () => { res.end('ok'); }); return;
  }
  const p = path.join(root, path.normalize(u.pathname).replace(/^\/+/, '') || 'index.html');
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', types[path.extname(p)] ?? 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(Number(process.argv[2] ?? 8765), '127.0.0.1');
