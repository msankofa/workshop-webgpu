import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await sleep(1000);
const pages = await fetch('http://127.0.0.1:9334/json').then(response => response.json());
const page = pages.find(candidate => candidate.type === 'page');
if (!page) throw new Error('no CDP page');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await call('Runtime.enable');
await call('Page.enable');
await sleep(8000);
let result = await call('Runtime.evaluate', {
  expression: "(()=>({title:document.title,tiles:[...document.querySelectorAll('.tile')].length,error:document.getElementById('error')?.textContent||''}))()",
  returnByValue: true,
});
console.log('before', JSON.stringify(result.result.value));
result = await call('Runtime.evaluate', {
  expression: "(()=>{const tile=[...document.querySelectorAll('.tile')].find(x=>x.textContent.includes('Charmander'));if(!tile)return false;tile.click();return true})()",
  returnByValue: true,
});
console.log('clicked', result.result.value);
await sleep(12000);
result = await call('Runtime.evaluate', {
  expression: "(()=>({species:document.getElementById('speciesName')?.textContent,error:document.getElementById('error')?.textContent||'',errorDisplay:getComputedStyle(document.getElementById('error')).display,canvas:[document.querySelector('canvas')?.width,document.querySelector('canvas')?.height]}))()",
  returnByValue: true,
});
console.log('after', JSON.stringify(result.result.value));
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const output = path.join(os.tmpdir(), 'pokemon-charmander-flame-smoke.png');
fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
console.log('screenshot', output);
socket.close();
