// test-page-syntax.mjs — the pages' inline module scripts parse.
//
// A page is one <script type="module"> that nothing in Node ever loads, so a duplicate `const`
// or a stray brace ships as a blank page with one console error (base-game.html at f199597 had
// two `const stands` in one function). Each module script is extracted and handed to
// `node --check`, which parses without resolving the importmap's bare specifiers or running it.
//
// node test-page-syntax.mjs [page.html ...]

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : ['base-game.html', 'bot-viewer-v3.html', 'environment-viewer.html'];
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'page-syntax-'));
for (const page of PAGES) {
  const html = readFileSync(page, 'utf8');
  const scripts = [...html.matchAll(/<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim());
  check(`${page} has a module script`, scripts.length > 0);
  scripts.forEach((src, i) => {
    const file = join(dir, `${page.replace(/[^a-z0-9]/gi, '_')}-${i}.mjs`);
    writeFileSync(file, src);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    const err = (r.stderr || '').split('\n').filter(l => /SyntaxError|^\s+at |:\d+$/.test(l) || /^\S+:\d+/.test(l)).slice(0, 3).join(' | ');
    check(`${page} module script ${i + 1} parses`, r.status === 0, err || r.stderr?.trim().slice(0, 200));
  });
}
rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
