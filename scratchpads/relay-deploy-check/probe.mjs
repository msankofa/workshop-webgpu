// Asks the deployed relay which base-game protocol it requires, by joining with a wrong one.
import pkg from '../../server/node_modules/ws/index.js';
const { WebSocket } = pkg;
const url = process.argv[2] || 'wss://workshop-webgpu.onrender.com';
const started = Date.now();
const el = () => ((Date.now() - started) / 1000).toFixed(1);
const ws = new WebSocket(url);
const t = setTimeout(() => { console.log('TIMEOUT after', el(), 's'); process.exit(1); }, 150000);
ws.on('open', () => {
  console.log('open after', el(), 's');
  ws.send(JSON.stringify({ type: 'base:join', protocol: 1, room: 'PROBE', name: 'probe' }));
});
ws.on('message', (d) => {
  console.log('MSG', d.toString().slice(0, 300));
  clearTimeout(t); ws.close(); process.exit(0);
});
ws.on('error', (e) => { console.log('ERR after', el(), 's:', e.message); clearTimeout(t); process.exit(1); });
