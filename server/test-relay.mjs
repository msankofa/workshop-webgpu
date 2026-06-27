import WebSocket from 'ws';

const URL = 'ws://localhost:8080';
const ROOM = 'TEST';
const delay = ms => new Promise(r => setTimeout(r, ms));

const host = new WebSocket(URL);
await new Promise(r => host.once('open', r));
host.send(JSON.stringify({ type: 'host', room: ROOM }));

const guest = new WebSocket(URL);
await new Promise(r => guest.once('open', r));
guest.send(JSON.stringify({ type: 'join', room: ROOM }));

const guestMsgs = [];
const hostMsgs = [];
guest.on('message', d => guestMsgs.push(JSON.parse(d)));
host.on('message', d => hostMsgs.push(JSON.parse(d)));
await delay(120);

// host broadcasts — guest should receive
host.send(JSON.stringify({ type: 'sim_state', seq: 1, creatures: [] }));
await delay(120);

console.assert(guestMsgs.some(m => m.type === 'joined'),       'FAIL: guest should receive joined');
console.assert(hostMsgs.some(m => m.type === 'guest_joined'),  'FAIL: host should receive guest_joined');
console.assert(guestMsgs.some(m => m.type === 'sim_state'),    'FAIL: guest should receive sim_state');

// guest sends input — host should receive with clientId attached
const myId = guestMsgs.find(m => m.type === 'joined')?.clientId;
guest.send(JSON.stringify({ type: 'set_target', pos: [1, 0, 2] }));
await delay(120);
const relayed = hostMsgs.find(m => m.type === 'set_target');
console.assert(relayed,                        'FAIL: host should receive set_target');
console.assert(relayed?.clientId === myId,     'FAIL: host should receive clientId on forwarded msg');

// guest disconnect — host should receive guest_left
guest.close();
await delay(120);
console.assert(hostMsgs.some(m => m.type === 'guest_left' && m.clientId === myId),
               'FAIL: host should receive guest_left');

host.close();
console.log('All relay tests passed.');
process.exit(0);
