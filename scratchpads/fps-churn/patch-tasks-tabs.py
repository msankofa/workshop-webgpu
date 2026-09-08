# One-off: adds the Tasks and Logs tabs to docs/render-pipeline-map.html. Idempotent by assertion.
import io
p = 'docs/render-pipeline-map.html'
s = open(p, encoding='utf-8').read()

def rep(o, n):
    global s
    assert s.count(o) == 1, o[:60]
    s = s.replace(o, n)

rep('''  <button role="tab" aria-selected="false" data-tab="stats">Stats</button>''',
'''  <button role="tab" aria-selected="false" data-tab="stats">Stats</button>
  <button role="tab" aria-selected="false" data-tab="tasks">Tasks</button>
  <button role="tab" aria-selected="false" data-tab="logs">Logs</button>''')

rep("  #stats .fval { font-size: 10.5px; fill: #4b5563; }",
"""  #stats .fval { font-size: 10.5px; fill: #4b5563; }
  #tasks, #logs { max-width: 1100px; color: #1f2937; }
  #tasks h2, #logs h2 { margin: 0 0 12px; color: #6b7280; font-size: 13px; font-weight: 600; letter-spacing: 0.8px; }
  #tasks p.lead, #logs p.lead { font-size: 11.5px; color: #4b5563; margin: 0 0 14px; }
  #tasks .bar { display: flex; gap: 10px; align-items: center; margin: 0 0 14px; font-size: 12px; color: #4b5563; }
  #tasks button { font: inherit; font-size: 12px; padding: 5px 12px; border: 1.6px solid #1f2937; border-radius: 6px; background: #ffffff; color: #1f2937; cursor: pointer; }
  #tasks button.primary { background: #111827; color: #ffffff; }
  #tasks .task { border: 1.6px solid #1f2937; border-radius: 6px; padding: 10px 14px; margin: 0 0 10px; background: #ffffff; }
  #tasks .task.done { background: #dcfce7; border-color: #15803d; }
  #tasks .task .head { display: flex; gap: 10px; align-items: baseline; }
  #tasks .task .head input { width: 16px; height: 16px; }
  #tasks .task .title { font-size: 13.5px; font-weight: 600; color: #111827; }
  #tasks .task .meta { font-size: 11px; color: #6b7280; margin-left: auto; white-space: nowrap; }
  #tasks .task .crit, #tasks .task .why { font-size: 12px; color: #374151; margin: 6px 0 0 26px; line-height: 1.45; }
  #tasks .task .why { color: #6b7280; }
  #tasks .task textarea { display: block; width: calc(100% - 26px); margin: 8px 0 0 26px; min-height: 44px; font: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 5px; box-sizing: border-box; }
  #tasks .task .files { margin: 6px 0 0 26px; font-size: 11.5px; color: #374151; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  #tasks .task .files span.f { background: #f3f4f6; border-radius: 4px; padding: 2px 6px; }
  #tasks .task .files span.f b { cursor: pointer; color: #b91c1c; margin-left: 4px; }
  #tasks .task .files input[type=text] { font: inherit; font-size: 11.5px; padding: 3px 6px; border: 1px solid #d1d5db; border-radius: 4px; width: 320px; }
  #tasks input.note { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 5px; width: 360px; }
  #logs .entry { border-left: 3px solid #4338ca; padding: 6px 14px; margin: 0 0 14px; }
  #logs .entry .at { font-size: 11px; color: #6b7280; }
  #logs .entry .title { font-size: 13.5px; font-weight: 600; color: #111827; margin: 2px 0 4px; }
  #logs .entry .body { font-size: 12.5px; line-height: 1.5; color: #374151; }
  #logs .entry .commits { font-size: 11px; color: #6b7280; margin-top: 4px; }
  #logs .entry .commits code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; margin-right: 4px; }""")

rep('''<section id="glossary" hidden>''', '''<section id="tasks" hidden>
<h2>TASKS FOR YOU</h2>
<p class="lead">Fable's asks, as they arise. Check one off when its criteria are met, add a note, and attach the files that show it (a capture, a screenshot, a log). Saved to <code>docs/render-tasks.json</code> through serve.py on every change; the browser copy is only a fallback. The Notify button appends a line to <code>research/stats/render-tasks-notify.log</code>, which Fable's watcher follows, so Fable reads the task log, assigns the next tasks, and updates the map and stats.</p>
<div class="bar">
  <button class="primary" id="notify">Notify Fable</button>
  <input id="notify-note" class="note" type="text" placeholder="optional note to send with the notify">
  <span id="tasks-status">loading…</span>
</div>
<div id="task-list"></div>
</section>

<section id="logs" hidden>
<h2>PROGRESS LOG</h2>
<p class="lead">What Fable did and when, oldest first, from <code>docs/render-progress-log.json</code>. The map and stats tabs describe the current state and are rewritten as it changes; this tab keeps the steps.</p>
<div id="log-list"></div>
</section>

<section id="glossary" hidden>''')

rep("""    document.getElementById('stats').hidden = b.dataset.tab !== 'stats';""",
"""    document.getElementById('stats').hidden = b.dataset.tab !== 'stats';
    document.getElementById('tasks').hidden = b.dataset.tab !== 'tasks';
    document.getElementById('logs').hidden = b.dataset.tab !== 'logs';""")

MODULE = open('scratchpads/fps-churn/tasks-tab-module.js', encoding='utf-8').read()
rep("</script>\n</body>", "</script>\n<script type=\"module\">\n" + MODULE + "</script>\n</body>")
open(p, 'w', encoding='utf-8', newline='').write(s)
print('page tabs added')
