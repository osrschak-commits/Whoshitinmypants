// Smoke test: host + 3 bots play a full 3-round game against a running server.
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 3000);
const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
const host = new WebSocket(URL);
const log = [];
let code;
host.on('open', () => host.send(JSON.stringify({ type: 'createRoom' })));
host.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'lobby' && !code) { code = m.code; for (const n of ['Ann', 'Bob', 'Cy']) bot(n); }
  if (m.type !== 'guessProgress' && m.type !== 'submitProgress') log.push(m.type + (m.type === 'reveal' ? ' ' + m.owner.name + ' +' + m.ownerPts : ''));
  if (m.type === 'final') {
    console.log(log.join('\n'));
    console.log('RANKING', m.ranking.map((p) => p.name + ':' + p.score).join(', '));
    process.exit(0);
  }
});
function bot(name) {
  const ws = new WebSocket(URL); let id, others = [], isVip = false;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code, name })));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'joined') id = m.id;
    if (m.type === 'lobby') { isVip = m.vip === id; if (isVip && m.players.length === 3) ws.send(JSON.stringify({ type: 'start' })); }
    if (m.type === 'submit') ws.send(JSON.stringify({ type: 'photo', data: PIC }));
    if (m.type === 'guess' && !m.isOwner) {
      const t = m.players.filter((p) => p.id !== id)[Math.floor(Math.random() * 2)];
      ws.send(JSON.stringify({ type: 'guess', target: t.id }));
    }
  });
}
setTimeout(() => { console.log('TIMEOUT', log.slice(-5)); process.exit(1); }, 150000);
