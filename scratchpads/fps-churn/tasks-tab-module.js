import { createDiskStore, describeStatus } from '../disk-store.js';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
// Tasks: one document on disk, autosaved; localStorage only as the copy a page without the server reads.
const store = createDiskStore({ read: '/docs/render-tasks.json', write: '/api/save-render-tasks', storage: localStorage, key: 'pcw:renderTasks', debounceMs: 500 });
const statusEl = document.getElementById('tasks-status');
store.onStatus(st => { statusEl.textContent = describeStatus(st, { file: 'docs/render-tasks.json' }); });
let doc = { format: 'pcw-render-tasks', version: 1, updatedAt: null, tasks: [] };
function save() { doc.updatedAt = new Date().toISOString(); store.setJSON(doc); }
function render() {
  const list = document.getElementById('task-list'); list.innerHTML = '';
  const tasks = doc.tasks.slice().sort((a, b) => (a.status === 'done') - (b.status === 'done') || String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const t of tasks) {
    const el = document.createElement('div'); el.className = 'task' + (t.status === 'done' ? ' done' : '');
    const files = (t.files || []).map((f, i) => '<span class="f">' + esc(f) + '<b data-i="' + i + '" title="remove">×</b></span>').join('');
    el.innerHTML = '<div class="head"><input type="checkbox" ' + (t.status === 'done' ? 'checked' : '') + ' title="done when the criteria are met"><span class="title">' + esc(t.title) + '</span><span class="meta">assigned ' + esc(when(t.createdAt)) + (t.doneAt ? ' · done ' + esc(when(t.doneAt)) : '') + '</span></div>'
      + '<div class="crit"><b>Done when:</b> ' + esc(t.criteria) + '</div>' + (t.why ? '<div class="why">' + esc(t.why) + '</div>' : '')
      + '<textarea placeholder="notes: what you saw, anything odd">' + esc(t.notes) + '</textarea>'
      + '<div class="files">' + files + '<input type="text" placeholder="file path to attach, then Enter (or pick files)"><input type="file" multiple></div>';
    el.querySelector('input[type=checkbox]').addEventListener('change', e => { t.status = e.target.checked ? 'done' : 'open'; t.doneAt = e.target.checked ? new Date().toISOString() : null; save(); render(); });
    el.querySelector('textarea').addEventListener('input', e => { t.notes = e.target.value; save(); });
    el.querySelector('input[type=text]').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) { (t.files ??= []).push(e.target.value.trim()); e.target.value = ''; save(); render(); } });
    // A picker gives file names, not paths: the name is recorded and a path can be typed beside it.
    el.querySelector('input[type=file]').addEventListener('change', e => { for (const f of e.target.files) (t.files ??= []).push(f.name); save(); render(); });
    el.querySelectorAll('.files b').forEach(b => b.addEventListener('click', () => { t.files.splice(+b.dataset.i, 1); save(); render(); }));
    list.appendChild(el);
  }
  if (!tasks.length) list.innerHTML = '<p class="lead">No tasks assigned.</p>';
}
store.load().then(() => { const j = store.json(); if (j && Array.isArray(j.tasks)) doc = j; render(); }).catch(() => render());
document.getElementById('notify').addEventListener('click', async () => {
  await store.flush();
  const note = document.getElementById('notify-note').value.trim();
  try {
    const res = await fetch('/api/render-tasks-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note, updatedAt: doc.updatedAt, done: doc.tasks.filter(t => t.status === 'done').map(t => t.id) }) });
    statusEl.textContent = res.ok ? 'notified ' + when(new Date().toISOString()) : 'notify failed: ' + res.status;
  } catch (e) { statusEl.textContent = 'notify failed: no server'; }
});
// Logs: read-only here; Fable appends entries to the file.
fetch('/docs/render-progress-log.json', { cache: 'no-store' }).then(r => r.json()).then(log => {
  const list = document.getElementById('log-list');
  for (const e of (log.entries || [])) {
    const el = document.createElement('div'); el.className = 'entry';
    const commits = (e.commits || []).length ? '<div class="commits">' + e.commits.map(c => '<code>' + esc(c) + '</code>').join('') + '</div>' : '';
    el.innerHTML = '<div class="at">' + esc(e.at) + '</div><div class="title">' + esc(e.title) + '</div><div class="body">' + esc(e.body) + '</div>' + commits;
    list.appendChild(el);
  }
}).catch(() => { document.getElementById('log-list').innerHTML = '<p class="lead">The log needs the page served by serve.py.</p>'; });
