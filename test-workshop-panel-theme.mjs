// node test-workshop-panel-theme.mjs
// Covers the pure half of workshop-panel-theme.js (theme read + CSS builder). installPanelTheme
// and createSection need a DOM and are left to browser QA.
import {
  readSettingsTheme, themeCssVars, panelCss, hexToRgba,
  setAllSectionsCollapsed, readSectionStates, applySectionStates,
  SETTINGS_THEME_DEFAULTS, THEME_STORAGE_KEY,
} from './workshop-panel-theme.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

const store = (value) => ({ getItem: () => value, setItem: () => {} });

console.log('readSettingsTheme');
{
  check('no storage yields the defaults', readSettingsTheme(store(null)).accent === SETTINGS_THEME_DEFAULTS.accent);
  check('storage key matches environment-ui', THEME_STORAGE_KEY === 'pcw:uiTheme');

  const saved = readSettingsTheme(store(JSON.stringify({
    settings: { surface: '#101010', border: '#202020', text: '#f0f0f0', accent: '#00aaff', opacity: 80 },
    map: { surface: '#000000' },
  })));
  check('reads the settings component', saved.surface === '#101010' && saved.accent === '#00aaff');
  check('reads opacity', saved.opacity === 80);
  check('ignores other components', saved.text === '#f0f0f0');

  const partial = readSettingsTheme(store(JSON.stringify({ settings: { accent: '#123456' } })));
  check('missing keys fall back per-key', partial.accent === '#123456' && partial.surface === SETTINGS_THEME_DEFAULTS.surface);

  const bad = readSettingsTheme(store(JSON.stringify({ settings: { accent: 'red', surface: '#GGGGGG', opacity: 'x' } })));
  check('non-hex values are rejected', bad.accent === SETTINGS_THEME_DEFAULTS.accent && bad.surface === SETTINGS_THEME_DEFAULTS.surface);
  check('non-numeric opacity is rejected', bad.opacity === 100);

  check('unparseable json falls back', readSettingsTheme(store('{oops')).accent === SETTINGS_THEME_DEFAULTS.accent);
  check('array payload falls back', readSettingsTheme(store('[1,2]')).accent === SETTINGS_THEME_DEFAULTS.accent);
  check('settings not an object falls back', readSettingsTheme(store('{"settings":5}')).accent === SETTINGS_THEME_DEFAULTS.accent);
  check('throwing store falls back', readSettingsTheme({ getItem: () => { throw new Error('x'); } }).accent === SETTINGS_THEME_DEFAULTS.accent);
  check('opacity is clamped', readSettingsTheme(store('{"settings":{"opacity":500}}')).opacity === 100);
}

console.log('hexToRgba');
{
  check('full opacity', hexToRgba('#ffffff', 100) === 'rgba(255,255,255,1)');
  check('partial opacity', hexToRgba('#000000', 50) === 'rgba(0,0,0,0.5)');
  check('malformed hex degrades to black', hexToRgba('nope', 100) === 'rgba(0,0,0,1)');
  check('opacity clamps high', hexToRgba('#ffffff', 900) === 'rgba(255,255,255,1)');
  check('opacity clamps low', hexToRgba('#ffffff', -5) === 'rgba(255,255,255,0)');
}

console.log('themeCssVars');
{
  const vars = themeCssVars({ surface: '#ffffff', border: '#d8d8d8', text: '#151515', accent: '#e66b1a', opacity: 100 });
  // These names are the contract with environment-ui.js installThemeStyle / buildThemePanel.
  for (const name of ['--theme-settings-surface', '--theme-settings-border', '--theme-settings-text',
    '--theme-settings-accent', '--theme-settings-surface-rgba']) {
    check(`emits ${name}`, name in vars);
  }
  check('accent passes through', vars['--theme-settings-accent'] === '#e66b1a');
  check('rgba is derived from surface + opacity', vars['--theme-settings-surface-rgba'] === 'rgba(255,255,255,1)');
  check('defaults are usable directly', typeof themeCssVars()['--theme-settings-accent'] === 'string');
}

console.log('panelCss');
{
  const css = panelCss('#ctrl');
  check('scopes every rule to the root', !/(^|\n)\s*[.a-z]/i.test(css.replace(/#ctrl[^{]*\{[^}]*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  for (const sel of ['#ctrl .sec', '#ctrl .sec-head', '#ctrl .sec-body', '#ctrl .row', '#ctrl button',
    '#ctrl .panel-head', '#ctrl .panel-body', '#ctrl .ttl', '#ctrl select']) {
    check(`defines ${sel}`, css.includes(sel));
  }
  check('collapse animates max-height, not display', css.includes('max-height: 0') && !/\.sec\.collapsed \.sec-body\{[^}]*display:\s*none/.test(css));
  check('tokens fall back when :root is unset', css.includes(`var(--theme-settings-accent, ${SETTINGS_THEME_DEFAULTS.accent})`));
  check('range inputs pick up the accent', css.includes('accent-color: var(--wui-accent)'));
  check('re-scopes to any root', panelCss('#panel').includes('#panel .sec-head') && !panelCss('#panel').includes('#ctrl'));
  check('balanced braces', (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length);
  check('panel collapse hides the body', css.includes('#ctrl.collapsed .panel-body{ display: none; }'));
  check('panel collapse releases the full-height dock', /#ctrl\.collapsed\{[^}]*bottom: auto/.test(css));
  check('head buttons opt out of the full-width button rule', /\.head-btns button\{[^}]*width: auto/.test(css));
}

// Fake just enough of the DOM to exercise the section-state helpers; the real panel is browser QA.
function fakeSection(title, collapsed) {
  const classes = new Set(collapsed ? ['sec', 'collapsed'] : ['sec']);
  return {
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    querySelector: (sel) => (sel === '.sec-head span' ? { textContent: title } : null),
  };
}
const fakeHost = (...secs) => ({ querySelectorAll: () => secs });

console.log('section state');
{
  const a = fakeSection('Camera', false), b = fakeSection('Terrain', true);
  const host = fakeHost(a, b);
  check('reads per-title collapse', JSON.stringify(readSectionStates(host)) === '{"Camera":false,"Terrain":true}');

  setAllSectionsCollapsed(host, true);
  check('collapse all', a.classList.contains('collapsed') && b.classList.contains('collapsed'));
  setAllSectionsCollapsed(host, false);
  check('expand all', !a.classList.contains('collapsed') && !b.classList.contains('collapsed'));

  applySectionStates(host, { Camera: true, Nonexistent: true });
  check('applies known titles', a.classList.contains('collapsed'));
  check('unknown titles are ignored', !b.classList.contains('collapsed'));
  applySectionStates(host, { Camera: 'yes' });
  check('non-boolean values are ignored', a.classList.contains('collapsed'));
  applySectionStates(host, null);
  check('null state is a no-op', a.classList.contains('collapsed'));

  const untitled = { classList: { contains: () => false, toggle: () => {} }, querySelector: () => null };
  check('a section with no heading is skipped', JSON.stringify(readSectionStates(fakeHost(untitled))) === '{}');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
