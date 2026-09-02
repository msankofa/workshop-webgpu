// Static integration guard for the Base Game side-panel performance contract.
// Run: node test-base-game-panel-performance.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { panelCss } from './workshop-panel-theme.js';

const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
const css = panelCss('#ctrl');

// Hidden controls must not participate in layout, and off-screen open sections may be skipped.
assert.match(css, /#ctrl \.sec\.collapsed \.sec-body\{\s*display:\s*none;/);
assert.doesNotMatch(css, /\.sec\.collapsed \.sec-body\{[^}]*max-height:\s*0/);
assert.match(css, /content-visibility:\s*auto/);
assert.match(css, /contain:\s*layout paint style/);

// Runtime readouts are time-based and only sampled while their section is visible.
assert.doesNotMatch(html, /terrainRuntimeTick/);
assert.match(html, /runtimeStatusNextMs = frameStart \+ 1000/);
for (const name of ['terrainRuntimeLine', 'grassRuntimeLine', 'forestRuntimeLine']) {
  assert.match(html, new RegExp(`if \\(panelElementVisible\\(${name}\\)\\) refresh`));
}
assert.match(html, /if \(element\.textContent !== text\) element\.textContent = text/);
assert.match(html, /if \(panelElementVisible\(playerStatus\)\)/);

// Opening or folding the panel stores only UI state; it cannot serialize a terrain project.
assert.match(html, /AUTOSAVE_TERRAIN_KEY = 'pcw:base-game:autosave:terrain'/);
assert.match(html, /captureAllState\(\{ includeTerrain: false \}\)/);
assert.match(html, /if \(terrainAutosaveDirty\)[\s\S]{0,220}terrainStore\.capture\(\)/);
assert.match(html, /onChange: \(\) => \{ terrainAutosaveDirty = true;/);
assert.match(html, /requestIdleCallback\([\s\S]{0,180}writeAutosave\(\)/);
assert.match(html, /closest\('#panel-btn,#sections-btn,\.sec-head'\)\) scheduleUiAutosave\(\)/);

const autosaveWriter = html.match(/function writeAutosave\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(autosaveWriter, 'autosave writer is present');
assert.ok(autosaveWriter.indexOf('AUTOSAVE_TERRAIN_KEY') < autosaveWriter.indexOf('AUTOSAVE_KEY'),
  'a dirty terrain record commits before the lightweight record that refers to it');

const panelHandler = html.match(/getElementById\('panel-btn'\)\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
const sectionsHandler = html.match(/getElementById\('sections-btn'\)\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
assert.ok(panelHandler && sectionsHandler, 'panel toggle handlers are present');
assert.doesNotMatch(panelHandler, /scheduleAutosave\(/);
assert.doesNotMatch(sectionsHandler, /scheduleAutosave\(/);

console.log('base-game panel performance tests passed');
