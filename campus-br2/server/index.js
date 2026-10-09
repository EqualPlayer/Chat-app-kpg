'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const { Matchmaker } = require('./rooms');

const CLIENT = path.join(__dirname, '..', 'client');
const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(CLIENT, p));
  if (!f.startsWith(CLIENT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});

const mm = new Matchmaker();
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let player = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!player) { if (m.t === 'join') player = mm.join(ws, m); }
    else player.room.onMessage(player, m);
  });
  ws.on('close', () => { if (player) player.room.leave(player); });
  ws.on('error', () => {});
});
server.listen(PORT, () => console.log(`Campus BR on http://localhost:${PORT}`));
