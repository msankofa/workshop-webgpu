"""Pull individual .glb models back out of the self-contained pokedex-151.html viewer."""
import base64, json, lzma, os, re, sys

HTML = os.path.join(os.path.dirname(__file__), 'package', 'pokedex-151.html')
OUT = os.path.join(os.path.dirname(__file__), 'glb')

def load_payloads():
    s = open(HTML, encoding='utf-8', errors='replace').read()
    i = s.index('const PAYLOADS = ')
    j = s.index('{', i)
    depth, k, instr, esc = 0, j, False, False
    while k < len(s):
        c = s[k]
        if instr:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': instr = False
        else:
            if c == '"': instr = True
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0: break
        k += 1
    return json.loads(s[j:k + 1])

def main(ids):
    payloads = load_payloads()
    os.makedirs(OUT, exist_ok=True)
    if not ids: ids = sorted(payloads)
    for dex in ids:
        rec = payloads[dex]
        raw = lzma.decompress(base64.b64decode(rec['z']), format=lzma.FORMAT_ALONE)
        name = re.sub(r'[^a-z0-9]+', '', rec['name'].lower())
        path = os.path.join(OUT, f'{dex}_{name}.glb')
        open(path, 'wb').write(raw)
        print(f"{path}  {len(raw):,} bytes  tris={rec['tris']} bones={rec['bones']} clips={len(rec['clips'])}")

if __name__ == '__main__':
    main(sys.argv[1:])
