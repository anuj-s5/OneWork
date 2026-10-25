const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const frame = (opcode, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (body.length < 126) { head = Buffer.from([0x80 | opcode, body.length]); }
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, body]);
};
function send(socket, data) {
  if (!socket || socket.destroyed || !socket.upgraded) return;
  socket.write(frame(1, JSON.stringify(data)));
}
function parseFrames(socket, chunk) {
  socket.buffer = Buffer.concat([socket.buffer || Buffer.alloc(0), chunk]);
  while (socket.buffer.length >= 2) {
    const b0 = socket.buffer[0], b1 = socket.buffer[1];
    let length = b1 & 0x7f, offset = 2;
    if (length === 126) { if (socket.buffer.length < 4) return; length = socket.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (socket.buffer.length < 10) return; const n = socket.buffer.readBigUInt64BE(2); if (n > 65536n) return socket.destroy(); length = Number(n); offset = 10; }
    const masked = !!(b1 & 0x80), maskOffset = offset;
    if (masked) offset += 4;
    if (socket.buffer.length < offset + length) return;
    let payload = socket.buffer.subarray(offset, offset + length);
    if (masked) { const mask = socket.buffer.subarray(maskOffset, maskOffset + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
    socket.buffer = socket.buffer.subarray(offset + length);
    const opcode = b0 & 0x0f;
    if (opcode === 8) { socket.end(frame(8, payload)); return; }
    if (opcode === 9) { socket.write(frame(10, payload)); continue; }
    if (opcode !== 1) continue;
    try { handleMessage(socket, JSON.parse(payload.toString('utf8'))); }
    catch { send(socket, { type: 'error', message: 'Could not read that request.' }); }
  }
}
function roomCode() { return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); }
function blankBoard() { return Array.from({ length: 6 }, () => Array(7).fill(null)); }
function cleanName(value) { return String(value || 'Player').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 18) || 'Player'; }
function snapshot(room) { return { type: 'state', code: room.code, board: room.board, players: room.players.map(p => p && ({ name: p.name, connected: !!p.socket && !p.socket.destroyed })), turn: room.turn, status: room.status, winner: room.winner, lastMove: room.lastMove }; }
function broadcast(room) { const data = snapshot(room); room.players.forEach(p => p && send(p.socket, data)); }
function hasFour(board, row, col, color) {
  for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
    let count = 1;
    for (const sign of [-1, 1]) { let r = row + dr * sign, c = col + dc * sign; while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === color) { count++; r += dr * sign; c += dc * sign; } }
    if (count >= 4) return true;
  }
  return false;
}
function handleMessage(socket, msg) {
  let player = socket.player;
  if (msg.type === 'create') {
    if (player) return;
    let code; do { code = roomCode(); } while (rooms.has(code));
    const p = { id: crypto.randomBytes(12).toString('hex'), name: cleanName(msg.name), seat: 0, socket };
    const room = { code, board: blankBoard(), players: [p, null], turn: 0, status: 'waiting', winner: null, lastMove: null, tokens: new Map([[p.id, p]]) };
    rooms.set(code, room); p.room = room; socket.player = p;
    send(socket, { type: 'joined', token: p.id, seat: 0 }); broadcast(room);
  } else if (msg.type === 'join') {
    if (player) return;
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4), room = rooms.get(code);
    if (!room) return send(socket, { type: 'error', message: 'Room not found. Check the code and try again.' });
    let p;
    if (msg.token && room.tokens.has(msg.token)) {
      p = room.tokens.get(msg.token);
      if (p.socket && p.socket !== socket && !p.socket.destroyed) return send(socket, { type: 'error', message: 'That player is already connected.' });
      p.socket = socket;
    } else {
      const seat = room.players.findIndex(slot => !slot);
      if (seat < 0) return send(socket, { type: 'error', message: 'This room already has two players.' });
      p = { id: crypto.randomBytes(12).toString('hex'), name: cleanName(msg.name), seat, socket, room };
      room.players[seat] = p; room.tokens.set(p.id, p);
    }
    socket.player = p;
    if (room.players.every(Boolean) && room.status === 'waiting') room.status = 'playing';
    send(socket, { type: 'joined', token: p.id, seat: p.seat }); broadcast(room);
  } else if (msg.type === 'move') {
    if (!player) return;
    const room = player.room;
    if (!room || room.players[player.seat] !== player || room.status !== 'playing') return send(socket, { type: 'error', message: 'The game is not ready for a move.' });
    if (room.turn !== player.seat) return send(socket, { type: 'error', message: 'Wait for your turn.' });
    const col = Number(msg.column); if (!Number.isInteger(col) || col < 0 || col > 6) return;
    let row = -1; for (let r = 5; r >= 0; r--) if (room.board[r][col] === null) { row = r; break; }
    if (row < 0) return send(socket, { type: 'error', message: 'That column is full. Choose another.' });
    const color = player.seat; room.board[row][col] = color; room.lastMove = { row, col };
    if (hasFour(room.board, row, col, color)) { room.status = 'finished'; room.winner = color; }
    else if (room.board.every(r => r.every(cell => cell !== null))) room.status = 'draw';
    else room.turn = 1 - room.turn;
    broadcast(room);
  } else if (msg.type === 'rematch') {
    const room = player?.room; if (!room || !room.players.every(Boolean)) return;
    room.board = blankBoard(); room.turn = 0; room.status = 'playing'; room.winner = null; room.lastMove = null; broadcast(room);
  }
}
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file); const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' }); res.end(data);
  });
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.upgraded = true; socket.buffer = Buffer.alloc(0);
  socket.on('data', chunk => parseFrames(socket, chunk));
  socket.on('close', () => { const p = socket.player; if (!p || p.socket !== socket) return; p.socket = null; broadcast(p.room); });
  socket.on('error', () => {});
});
const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Neon Four listening on ${port}`));
