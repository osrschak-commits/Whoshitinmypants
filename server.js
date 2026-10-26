// WHO SHIT IN MY PANTS? server: static files + WebSocket game rooms. Photos live in memory only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const ROUNDS = [
  { n: 1, name: 'Whose Is It?', mult: 1, tagline: 'Match each poo to its owner. Nothing to be ashamed of. Yet.' },
  { n: 2, name: 'Caption Clash', mult: 2, tagline: 'Two players get a poo to describe. The funniest answer wins. Double points.' },
  { n: 3, name: 'Best Poo Wins', mult: 3, tagline: 'Vote for the finest poo in the land. Triple points.' },
];
const WRITE_SECS = 40;
const VOTE_SECS = 20;
const BEST_SECS = 30;
const CAPTION_POOS = 3;   // poos shown in round 2
const VOTE_PTS = 100;     // per vote, x round multiplier
const BEST_BONUS = 200;   // bonus for the winning poo, x round multiplier
const SUBMIT_SECS = 90;
const GUESS_SECS = 25;
const REVEAL_SECS = 9;
const GUESS_PTS = 100;   // x round multiplier
const FOOL_PTS = 50;     // owner gets this per player fooled, x multiplier
const MAX_PLAYERS = 10;

const rooms = new Map();

function lanUrl() {
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  return `${ip ? ip.address : 'localhost'}:${PORT}/play`;
}

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/host.html';
  if (p === '/play') p = '/play.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 6 * 1024 * 1024 });

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); } while (rooms.has(c));
  return c;
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, hasSubmitted: !!room.photos.get(p.id), color: p.color }));
}

function broadcastHost(room, msg) { send(room.host, msg); }
function broadcastPlayers(room, msg) { for (const p of room.players.values()) send(p.ws, msg); }
function broadcastAll(room, msg) { broadcastHost(room, msg); broadcastPlayers(room, msg); }

function pushLobby(room) {
  broadcastAll(room, { type: 'lobby', code: room.code, players: publicPlayers(room), vip: room.vip, joinUrl: lanUrl() });
}

function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function setTimer(room, secs, fn) { clearTimer(room); room.deadline = Date.now() + secs * 1000; room.timer = setTimeout(fn, secs * 1000); }

function startGame(room) {
  if (room.players.size < 3) return;
  room.roundIdx = -1;
  for (const p of room.players.values()) p.score = 0;
  startSubmit(room);
}

function nextRound(room) {
  room.roundIdx++;
  if (room.roundIdx >= ROUNDS.length) return finish(room);
  const r = ROUNDS[room.roundIdx];
  room.phase = 'roundIntro';
  broadcastAll(room, { type: 'roundIntro', round: r, total: ROUNDS.length });
  const start = [startGuessing, startCaptions, startBest][room.roundIdx];
  setTimer(room, 5, () => start(room));
}

// One photo per player for the whole game; all three rounds reuse the same pool.
function startSubmit(room) {
  room.phase = 'submit';
  room.photos = new Map();
  broadcastAll(room, { type: 'submit', round: null, players: publicPlayers(room), deadline: Date.now() + SUBMIT_SECS * 1000 });
  setTimer(room, SUBMIT_SECS, () => afterSubmit(room));
}

function afterSubmit(room) {
  clearTimer(room);
  const owners = [...room.photos.keys()].filter((id) => room.players.has(id));
  if (owners.length < 2) {
    broadcastAll(room, { type: 'skipped', reason: 'Not enough poops were submitted. Cowards. Back to the lobby.' });
    return setTimer(room, 4, () => resetToLobby(room));
  }
  nextRound(room);
}

function startGuessing(room) {
  room.queue = shuffle([...room.photos.keys()].filter((id) => room.players.has(id)));
  room.qi = -1;
  nextPoop(room);
}

function nextPoop(room) {
  room.qi++;
  if (room.qi >= room.queue.length) return roundSummary(room);
  room.phase = 'guess';
  room.guesses = new Map();
  room.currentOwner = room.queue[room.qi];
  const r = ROUNDS[room.roundIdx];
  const msg = { type: 'guess', round: r, index: room.qi + 1, count: room.queue.length, photo: room.photos.get(room.currentOwner), players: publicPlayers(room), deadline: Date.now() + GUESS_SECS * 1000 };
  broadcastHost(room, msg);
  for (const p of room.players.values()) {
    send(p.ws, { ...msg, photo: undefined, isOwner: p.id === room.currentOwner });
  }
  setTimer(room, GUESS_SECS, () => reveal(room));
}

function eligibleGuessers(room) {
  return [...room.players.values()].filter((p) => p.id !== room.currentOwner && p.connected);
}

function reveal(room) {
  clearTimer(room);
  room.phase = 'reveal';
  const r = ROUNDS[room.roundIdx];
  const owner = room.players.get(room.currentOwner);
  const guessers = eligibleGuessers(room);
  const results = [];
  let fooled = 0;
  for (const g of guessers) {
    const guess = room.guesses.get(g.id);
    const correct = guess === room.currentOwner;
    const pts = correct ? GUESS_PTS * r.mult : 0;
    if (correct) g.score += pts; else fooled++;
    results.push({ id: g.id, name: g.name, guess: guess ? (room.players.get(guess) || {}).name || null : null, correct, pts });
  }
  const ownerPts = fooled * FOOL_PTS * r.mult;
  if (owner) owner.score += ownerPts;
  const msg = { type: 'reveal', owner: owner ? { id: owner.id, name: owner.name } : null, ownerPts, results, players: publicPlayers(room), photo: room.photos.get(room.currentOwner), round: r };
  broadcastPlayers(room, { ...msg, photo: undefined });
  broadcastHost(room, msg);
  setTimer(room, REVEAL_SECS, () => nextPoop(room));
}

// ---------- Round 2: Caption Clash ----------
function startCaptions(room) {
  room.queue = shuffle([...room.photos.keys()].filter((id) => room.players.has(id))).slice(0, CAPTION_POOS);
  room.qi = -1;
  nextCaption(room);
}

function nextCaption(room) {
  room.qi++;
  if (room.qi >= room.queue.length) return roundSummary(room);
  const ownerId = room.queue[room.qi];
  const pool = [...room.players.values()].filter((p) => p.connected && p.id !== ownerId);
  if (pool.length < 2) return nextCaption(room);
  room.currentOwner = ownerId;
  room.writers = shuffle(pool).slice(0, 2).map((p) => p.id);
  room.texts = new Map();
  room.phase = 'write';
  const msg = {
    type: 'write', round: ROUNDS[1], index: room.qi + 1, count: room.queue.length,
    photo: room.photos.get(ownerId), writers: room.writers.map((id) => ({ id, name: room.players.get(id).name })),
    deadline: Date.now() + WRITE_SECS * 1000,
  };
  broadcastHost(room, msg);
  for (const p of room.players.values()) {
    const isWriter = room.writers.includes(p.id);
    send(p.ws, { ...msg, photo: isWriter ? msg.photo : undefined, isWriter });
  }
  setTimer(room, WRITE_SECS, () => startCapVote(room));
}

function startCapVote(room) {
  clearTimer(room);
  room.phase = 'capVote';
  room.votes = new Map();
  room.answers = shuffle(room.writers.map((id) => ({ authorId: id, text: room.texts.get(id) || '…froze and wrote nothing.' })));
  const msg = { type: 'capVote', round: ROUNDS[1], photo: room.photos.get(room.currentOwner), answers: room.answers.map((a) => a.text), deadline: Date.now() + VOTE_SECS * 1000 };
  broadcastHost(room, msg);
  for (const p of room.players.values()) send(p.ws, { ...msg, photo: undefined, isWriter: room.writers.includes(p.id) });
  setTimer(room, VOTE_SECS, () => capReveal(room));
}

function capReveal(room) {
  clearTimer(room);
  room.phase = 'capReveal';
  const mult = ROUNDS[1].mult;
  const tally = room.answers.map(() => 0);
  for (const choice of room.votes.values()) tally[choice]++;
  const top = Math.max(...tally);
  const results = room.answers.map((a, i) => {
    const author = room.players.get(a.authorId);
    const pts = tally[i] * VOTE_PTS * mult;
    if (author) author.score += pts;
    return { author: author ? author.name : '???', text: a.text, votes: tally[i], pts, winner: top > 0 && tally[i] === top };
  });
  const msg = { type: 'capReveal', round: ROUNDS[1], results, players: publicPlayers(room), photo: room.photos.get(room.currentOwner) };
  broadcastPlayers(room, { ...msg, photo: undefined });
  broadcastHost(room, msg);
  setTimer(room, REVEAL_SECS, () => nextCaption(room));
}

// ---------- Round 3: Best Poo Wins ----------
function startBest(room) {
  room.bestOrder = shuffle([...room.photos.keys()].filter((id) => room.players.has(id)));
  room.phase = 'bestVote';
  room.votes = new Map();
  const msg = { type: 'bestVote', round: ROUNDS[2], photos: room.bestOrder.map((id) => room.photos.get(id)), deadline: Date.now() + BEST_SECS * 1000 };
  broadcastHost(room, msg);
  for (const p of room.players.values()) send(p.ws, { ...msg, ownIndex: room.bestOrder.indexOf(p.id) });
  setTimer(room, BEST_SECS, () => bestReveal(room));
}

function bestReveal(room) {
  clearTimer(room);
  room.phase = 'bestReveal';
  const mult = ROUNDS[2].mult;
  const tally = room.bestOrder.map(() => 0);
  for (const choice of room.votes.values()) tally[choice]++;
  const top = Math.max(...tally);
  const ranking = room.bestOrder.map((id, i) => {
    const owner = room.players.get(id);
    const winner = top > 0 && tally[i] === top;
    const pts = tally[i] * VOTE_PTS * mult + (winner ? BEST_BONUS * mult : 0);
    if (owner) owner.score += pts;
    return { n: i + 1, owner: owner ? owner.name : '???', ownerId: id, votes: tally[i], pts, winner, photo: room.photos.get(id) };
  }).sort((a, b) => b.votes - a.votes);
  const players = publicPlayers(room);
  broadcastHost(room, { type: 'bestReveal', ranking, players });
  broadcastPlayers(room, { type: 'bestReveal', ranking: ranking.map((r) => ({ ...r, photo: undefined })), players });
  setTimer(room, REVEAL_SECS + 6, () => roundSummary(room));
}

function eligibleVoters(room) {
  const all = [...room.players.values()].filter((p) => p.connected);
  if (room.phase === 'capVote') return all.filter((p) => !room.writers.includes(p.id));
  return all;
}

function roundSummary(room) {
  room.phase = 'roundSummary';
  const r = ROUNDS[room.roundIdx];
  const last = room.roundIdx === ROUNDS.length - 1;
  broadcastAll(room, { type: 'roundSummary', round: r, players: publicPlayers(room), last });
  setTimer(room, 8, () => nextRound(room));
}

function finish(room) {
  clearTimer(room);
  room.phase = 'final';
  const ranked = publicPlayers(room).sort((a, b) => b.score - a.score);
  broadcastAll(room, { type: 'final', ranking: ranked });
}

function resetToLobby(room) {
  clearTimer(room);
  room.phase = 'lobby';
  room.photos = new Map();
  for (const p of room.players.values()) p.score = 0;
  pushLobby(room);
}

const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac', '#a9805b'];

wss.on('connection', (ws) => {
  ws.ctx = {};
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const { role } = ws.ctx;

    if (m.type === 'createRoom') {
      const code = makeCode();
      const room = { code, host: ws, players: new Map(), phase: 'lobby', photos: new Map(), roundIdx: -1, timer: null, vip: null, nextId: 1 };
      rooms.set(code, room);
      ws.ctx = { role: 'host', code };
      return pushLobby(room);
    }

    if (m.type === 'join') {
      const code = String(m.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'No room with that code.' });
      const name = String(m.name || '').trim().slice(0, 14);
      if (!name) return send(ws, { type: 'error', message: 'Enter a name.' });
      const existing = [...room.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (existing.connected) return send(ws, { type: 'error', message: 'That name is taken.' });
        existing.ws = ws; existing.connected = true;       // reconnect
        ws.ctx = { role: 'player', code, id: existing.id };
        send(ws, { type: 'joined', id: existing.id, code });
        return pushLobby(room);
      }
      if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'Game already started.' });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Room is full.' });
      const id = 'p' + room.nextId++;
      room.players.set(id, { id, name, ws, score: 0, connected: true, color: COLORS[room.players.size % COLORS.length] });
      if (!room.vip) room.vip = id;
      ws.ctx = { role: 'player', code, id };
      send(ws, { type: 'joined', id, code });
      return pushLobby(room);
    }

    const room = rooms.get(ws.ctx.code);
    if (!room) return;

    if (role === 'player') {
      const player = room.players.get(ws.ctx.id);
      if (!player) return;
      if (m.type === 'start' && room.vip === player.id && room.phase === 'lobby') return startGame(room);
      if (m.type === 'restart' && room.vip === player.id && room.phase === 'final') return resetToLobby(room);
      if (m.type === 'photo' && room.phase === 'submit') {
        const data = String(m.data || '');
        if (!data.startsWith('data:image/') || data.length > 5 * 1024 * 1024) return send(ws, { type: 'error', message: 'Bad image.' });
        room.photos.set(player.id, data);
        send(ws, { type: 'photoOk' });
        broadcastHost(room, { type: 'submitProgress', players: publicPlayers(room) });
        if ([...room.players.values()].filter((p) => p.connected).every((p) => room.photos.has(p.id))) afterSubmit(room);
        return;
      }
      if (m.type === 'text' && room.phase === 'write' && room.writers.includes(player.id)) {
        const text = String(m.text || '').trim().slice(0, 140);
        if (!text) return;
        room.texts.set(player.id, text);
        send(ws, { type: 'textOk' });
        if (room.writers.every((id) => room.texts.has(id))) startCapVote(room);
        return;
      }
      if (m.type === 'vote' && (room.phase === 'capVote' || room.phase === 'bestVote')) {
        const c = Number(m.choice);
        const max = room.phase === 'capVote' ? room.answers.length : room.bestOrder.length;
        if (!Number.isInteger(c) || c < 0 || c >= max) return;
        if (room.phase === 'capVote' && room.writers.includes(player.id)) return;
        if (room.phase === 'bestVote' && room.bestOrder[c] === player.id) return;   // no voting for your own poo
        room.votes.set(player.id, c);
        send(ws, { type: 'voteOk' });
        const voters = eligibleVoters(room);
        broadcastHost(room, { type: 'voteProgress', done: room.votes.size, total: voters.length });
        if (voters.every((p) => room.votes.has(p.id))) (room.phase === 'capVote' ? capReveal : bestReveal)(room);
      }
      if (m.type === 'guess' && room.phase === 'guess') {
        if (player.id === room.currentOwner || !room.players.has(m.target) || m.target === player.id) return;
        room.guesses.set(player.id, m.target);
        send(ws, { type: 'guessOk' });
        broadcastHost(room, { type: 'guessProgress', done: room.guesses.size, total: eligibleGuessers(room).length });
        if (eligibleGuessers(room).every((p) => room.guesses.has(p.id))) reveal(room);
      }
    }
  });

  ws.on('close', () => {
    const { role, code, id } = ws.ctx;
    const room = rooms.get(code);
    if (!room) return;
    if (role === 'host') { clearTimer(room); broadcastPlayers(room, { type: 'error', message: 'Host left. Game over.' }); rooms.delete(code); return; }
    if (role === 'player') {
      const p = room.players.get(id);
      if (!p) return;
      p.connected = false;
      if (room.phase === 'lobby') {
        room.players.delete(id);
        if (room.vip === id) room.vip = [...room.players.keys()][0] || null;
      }
      pushLobby(room);
    }
  });
});

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  WHO SHIT IN MY PANTS? is running!');
  console.log(`  Host screen (TV/laptop):  http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  Players join on phone:    http://${ip}:${PORT}/play`));
  console.log('');
});
