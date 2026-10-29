// Optional local runner: node tests/serve.cjs, then open /tests/wiping.html.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
http.createServer((req, res) => {
  let filename;
  try { filename = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0])); }
  catch { res.writeHead(400); return res.end(); }
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(filename, (error, data) => {
    res.writeHead(error ? 404 : 200, { 'Content-Type':filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(error ? 'Not found' : data);
  });
}).listen(5501, '127.0.0.1', () => console.log('http://127.0.0.1:5501/tests/wiping.html'));
