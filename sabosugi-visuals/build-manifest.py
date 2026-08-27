#!/usr/bin/env python3
"""Regenerate pens-manifest.json, which gallery.html reads to build its list.

Titles, categories and source URLs come from VISUALS_INDEX.md so the hand-written catalog stays the one
place they are edited. Everything else is read out of the pens themselves: which Three version they pin,
whether they want a file dropped on them, whether they fetch something remote. Run this after adding a
pen or editing the index:

    python sabosugi-visuals/build-manifest.py
"""

import json
import os
import re
import sys
import urllib.parse
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, 'VISUALS_INDEX.md')
OUT = os.path.join(HERE, 'pens-manifest.json')

# Duplicate downloads and the root index.html copy, all recorded in VISUALS_INDEX.md. Listing them here
# rather than pattern-matching "(1)" keeps the skip deliberate.
SKIP = {
    'colorful-smoke-support-me-by-paypal-https-paypal-com-paypalme-sabosugi (1).zip',
    'glass-logo-with-panorama-svg-support (1).zip',
    'index.html',
}

# CDNs every pen loads its library from. A hit on anything else means the pen fetches a real asset and
# will look broken without a network, which the gallery flags rather than silently failing.
LIBRARY_HOSTS = {'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'www.w3.org'}


def parse_index():
    """Rows of (title, subcategory, file-patterns, source-url, category) from the catalog's tables."""
    rows = []
    category = None
    with open(INDEX, encoding='utf-8') as f:
        for line in f:
            heading = re.match(r'^##\s+(.+?)\s*$', line)
            if heading:
                category = heading.group(1)
                continue
            if not line.startswith('|') or category in (None, 'Hybrids'):
                continue
            cells = [c.strip() for c in line.strip().strip('|').split('|')]
            if len(cells) < 4 or cells[0] in ('Visual', 'Hybrid') or set(cells[0]) <= set('-: '):
                continue
            title, sub, filecell, source = cells[0], cells[1], cells[2], cells[3]
            patterns = re.findall(r'`([^`]+)`', filecell)
            url = re.search(r'\((https?://[^)]+)\)', source)
            rows.append({
                'title': title,
                'subcategory': sub,
                'patterns': patterns,
                'source': url.group(1) if url else None,
                'category': category,
            })
    return rows


def matches(pattern, filename):
    """The catalog abbreviates long filenames with an ellipsis, so match on both ends of it."""
    if '...' in pattern:
        head, tail = pattern.split('...', 1)
        return filename.startswith(head) and filename.endswith(tail)
    return pattern == filename


def read_pen_sources(path):
    """The pen's markup and script, however it is packaged."""
    if path.endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            entry = next((n for n in names if n.endswith('dist/index.html')), None)
            if not entry:
                return None, None, 'no dist/index.html'
            base = entry.rsplit('/', 1)[0]
            text = z.read(entry).decode('utf-8', 'replace')
            for ref in ('script.js', 'style.css'):
                if base + '/' + ref not in names:
                    return None, None, 'dist references missing ' + ref
            script = z.read(base + '/script.js').decode('utf-8', 'replace')
            return text, script, None
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read(), '', None


def describe(html, script):
    text = (html or '') + '\n' + (script or '')
    versions = sorted(set(re.findall(r'three@([0-9.]+)', text)))
    hosts = set(re.findall(r'https?://([A-Za-z0-9._-]+)/', text))
    remote = sorted(h for h in hosts
                    if h not in LIBRARY_HOSTS and 'codepen' not in h and 'paypal' not in h)
    return {
        'three': versions[0] if versions else None,
        'remoteAssets': remote,
        'wantsFile': bool(re.search(r'type=["\']file', text)),
        'hasVideo': bool(re.search(r'<video|createElement\(["\']video', text)),
        'hasAudio': bool(re.search(r'AudioContext|new Audio\(|<audio', text)),
    }


def slugify(filename):
    stem = re.sub(r'\.(zip|html)$', '', filename)
    # Strip the donation appeal the CodePen titles carry, then reduce to a URL-safe stem.
    stem = re.sub(r'[-\s]*support[-\s]*me[-\s]*by[-\s]*paypal.*$', '', stem, flags=re.I)
    stem = re.sub(r'[-\s]*https?[-\s]*paypal.*$', '', stem, flags=re.I)
    stem = re.sub(r'[^A-Za-z0-9]+', '-', stem).strip('-').lower()
    return stem or 'pen'


def main():
    rows = parse_index()
    files = [f for f in sorted(os.listdir(HERE))
             if (f.endswith('.zip') or f.endswith('.html')) and f not in SKIP
             and f not in ('gallery.html',)]

    pens = []
    used_slugs = {}
    unmatched_files = []
    unmatched_rows = {id(r) for r in rows}

    for filename in files:
        row = None
        for candidate in rows:
            if any(matches(p, filename) for p in candidate['patterns']):
                row = candidate
                unmatched_rows.discard(id(candidate))
                break
        if row is None:
            unmatched_files.append(filename)
            continue

        html, script, err = read_pen_sources(os.path.join(HERE, filename))
        if err:
            print('SKIP %s: %s' % (filename, err), file=sys.stderr)
            continue

        slug = slugify(filename)
        if slug in used_slugs:
            used_slugs[slug] += 1
            slug = '%s-%d' % (slug, used_slugs[slug])
        else:
            used_slugs[slug] = 1

        pen = {
            'slug': slug,
            'title': row['title'],
            'category': row['category'],
            'subcategory': row['subcategory'],
            'source': row['source'],
            'file': filename,
            'packaging': 'zip' if filename.endswith('.zip') else 'html',
            # Fourteen of the standalone pens have spaces in their filenames, so the URL is escaped
            # here rather than left for each consumer to get right.
            'url': ('/sabosugi/%s/index.html' % slug) if filename.endswith('.zip')
                   else ('/sabosugi-visuals/' + urllib.parse.quote(filename)),
        }
        pen.update(describe(html, script))
        pens.append(pen)

    # The hybrids are ours and are not in the catalog's tables, so they are added directly.
    hybrid_dir = os.path.join(HERE, 'hybrids')
    if os.path.isdir(hybrid_dir):
        for filename in sorted(os.listdir(hybrid_dir)):
            if not filename.endswith('.html'):
                continue
            html, script, err = read_pen_sources(os.path.join(hybrid_dir, filename))
            if err:
                continue
            title = re.search(r'<title>(.*?)</title>', html or '', re.S)
            pen = {
                'slug': 'hybrid-' + slugify(filename),
                'title': (title.group(1).strip() if title else slugify(filename)),
                'category': 'Hybrids',
                'subcategory': 'WebGPU port' if filename.endswith('-webgpu.html') else 'Combination',
                'source': None,
                'file': 'hybrids/' + filename,
                'packaging': 'html',
                'url': '/sabosugi-visuals/hybrids/' + urllib.parse.quote(filename),
            }
            pen.update(describe(html, script))
            pens.append(pen)

    manifest = {
        'generated_by': 'build-manifest.py',
        'count': len(pens),
        'categories': list(dict.fromkeys(p['category'] for p in pens)),
        'pens': pens,
    }
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
        f.write('\n')

    print('wrote %s: %d pens across %d categories' % (
        os.path.relpath(OUT, HERE), len(pens), len(manifest['categories'])))
    if unmatched_files:
        print('\n%d file(s) on disk with no VISUALS_INDEX.md row:' % len(unmatched_files),
              file=sys.stderr)
        for f in unmatched_files:
            print('  ' + f, file=sys.stderr)
    leftovers = [r for r in rows if id(r) in unmatched_rows]
    if leftovers:
        print('\n%d catalog row(s) with no file on disk:' % len(leftovers), file=sys.stderr)
        for r in leftovers:
            print('  %s  (%s)' % (r['title'], ', '.join(r['patterns'])), file=sys.stderr)
    return 1 if (unmatched_files or leftovers) else 0


if __name__ == '__main__':
    sys.exit(main())
