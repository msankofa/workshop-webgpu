import re, json, sys
src = open('bot-viewer-v3.html', encoding='utf-8').read()
fn_re = re.compile(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', re.M)
decl_re = re.compile(r'^(?:const|let|var)\s+([A-Za-z_$][\w$]*)', re.M)
BS = chr(92)
fns = {}
for m in fn_re.finditer(src):
    name = m.group(1)
    i = src.index('{', m.end() - 1)
    depth = 0; j = i; in_s = None
    while j < len(src):
        c = src[j]
        if in_s:
            if c == BS: j += 2; continue
            if c == in_s: in_s = None
        else:
            if c in '\'"`': in_s = c
            elif c == '/' and src[j + 1] == '/': j = src.index('\n', j); continue
            elif c == '/' and src[j + 1] == '*': j = src.index('*/', j) + 2; continue
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0: break
        j += 1
    body = src[m.start():j + 1]
    line = src.count('\n', 0, m.start()) + 1
    fns[name] = (line, body)
decls = {m.group(1) for m in decl_re.finditer(src)}
json.dump({'fns': {k: [v[0], v[1]] for k, v in fns.items()}, 'decls': sorted(decls)}, open(sys.argv[1], 'w'))
seeds = sys.argv[2].split(',')
ident_re = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)')
closure = set(); todo = list(seeds)
while todo:
    n = todo.pop()
    if n in closure or n not in fns: continue
    closure.add(n)
    for idn in set(ident_re.findall(fns[n][1])):
        if idn in fns and idn not in closure: todo.append(idn)
globs = {}
for n in closure:
    for idn in set(ident_re.findall(fns[n][1])):
        if idn in decls and idn not in fns: globs.setdefault(idn, []).append(n)
print('FUNCTIONS', len(closure), sum(fns[n][1].count('\n') + 1 for n in closure), 'lines')
for n in sorted(closure, key=lambda k: fns[k][0]): print(f'  {fns[n][0]:6d} {n}')
print('GLOBALS', len(globs))
for g in sorted(globs): print(f'  {g}: {len(globs[g])}')
