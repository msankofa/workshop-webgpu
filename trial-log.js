// The record of every setting that was tried, what it scored, and what a person made of it.
//
// WHY IT IS WORTH KEEPING. A tuning session is hundreds of small judgements — that looked better, that
// looked worse — and none of them survive the session unless they are written down. Written down, they
// become something a plot can be drawn from and a correlation can be taken over: does the machine's
// verdict agree with the eye's, and which knob was actually responsible.
//
// TWO SCORES, NEVER MERGED. Each row carries the human verdict and the machine metrics separately. It is
// tempting to fuse them into one "quality" number, and it destroys the only interesting question in the
// data — whether they agree. `pearson` from `stats-math.js` can answer that later only if both survive.
//
// Storage is injected rather than reaching for `localStorage`, so the whole thing runs in Node.

/** Fields promoted out of a monitor report, so a row is flat enough to plot and to put in a CSV. */
export function flattenMetrics(report, headroom) {
  const m = {};
  if (headroom) {
    m.dragRisk = headroom.dragRisk;
    m.tapRisk = headroom.tapRisk;
    m.speedOverrun = headroom.speedOverrun;
    m.restepEnvelopes = headroom.restepEnvelopes;
    m.stepFrames = headroom.stepFrames;
    m.strideNumber = headroom.strideNumber;
    m.cycleSpeed = headroom.cycleSpeed;
  }
  if (report) {
    m.skate = report.dragging.worstLegFraction;
    m.stanceSkate = report.dragging.worstStanceSkate;
    m.clamped = report.dragging.clampedFraction;
    m.blocked = report.dragging.blockedFraction;
    m.stray = report.dragging.worstStrayFraction;
    m.tapRate = report.tapping.worstLegRate;
    m.stride = report.tapping.medianTravel;
    m.stepRate = report.tapping.stepRate;
    m.speedVsMax = report.speedVsMax;
    m.speedEfficiency = report.speedEfficiency;
    m.dragging = report.verdict.dragging ? 1 : 0;
    m.tapping = report.verdict.tapping ? 1 : 0;
  }
  return m;
}

/**
 * An append-only log with a cap.
 *
 * `storage` needs only `getItem`/`setItem`. The cap exists because this grows without anyone deciding to
 * grow it — unlike saved presets, which are bounded by how many a person bothers to name — and a quota
 * error here would take down the page's other saved state with it. Oldest rows are dropped first and
 * `pruned` counts them, so the panel can say so rather than losing history silently.
 */
export function createTrialLog(storage, { key = 'pcw:stadiumTrials', cap = 800 } = {}) {
  let rows = [];
  let pruned = 0;
  let nextId = 1;

  function load() {
    try {
      const raw = storage?.getItem(key);
      const data = raw ? JSON.parse(raw) : null;
      if (data && Array.isArray(data.rows)) {
        rows = data.rows;
        pruned = data.pruned || 0;
        nextId = rows.reduce((m, r) => Math.max(m, r.id + 1), 1);
      }
    } catch { rows = []; }
    return rows;
  }

  function save() {
    try { storage?.setItem(key, JSON.stringify({ rows, pruned })); }
    // A full quota must not take the page with it. The rows stay in memory and export still works, which
    // is the difference between "you lost your session" and "you should export now".
    catch (err) { return { ok: false, error: String(err) }; }
    return { ok: true };
  }

  /**
   * `trial` is `{species, gait, values, metrics, verdict, setpoint, pct, changed, note, windowId}`.
   * `metrics` may be null — a row whose window had not closed is an unrated row, not a corrupt one, and
   * every consumer here filters on it rather than assuming it is there.
   */
  function add(trial) {
    const row = { id: nextId++, at: new Date().toISOString(), verdict: null, note: '', ...trial };
    rows.push(row);
    while (rows.length > cap) { rows.shift(); pruned++; }
    return { row, ...save() };
  }

  function update(id, patch) {
    const row = rows.find(r => r.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    save();
    return row;
  }

  function remove(id) {
    const i = rows.findIndex(r => r.id === id);
    if (i < 0) return false;
    rows.splice(i, 1);
    save();
    return true;
  }

  function clear() { rows = []; pruned = 0; save(); }

  return {
    load, save, add, update, remove, clear,
    get rows() { return rows; },
    get pruned() { return pruned; },
    get near() { return rows.length / cap; },
    list(filter = {}) {
      return rows.filter(r =>
        (!filter.species || r.species === filter.species)
        && (!filter.verdict || r.verdict === filter.verdict)
        && (!filter.rated || r.verdict != null)
        && (!filter.measured || r.metrics != null));
    },
  };
}

/**
 * Rows as CSV, one column per setting and per metric.
 *
 * The union of keys across rows rather than the first row's, because the knob list grows over time and a
 * log written before a knob existed must not silently drop it from everything after.
 */
export function toCSV(rows) {
  if (!rows.length) return '';
  const settingKeys = [...new Set(rows.flatMap(r => Object.keys(r.values || {})))].sort();
  const metricKeys = [...new Set(rows.flatMap(r => Object.keys(r.metrics || {})))].sort();
  const head = ['id', 'at', 'species', 'gait', 'verdict', 'setpoint', 'pct', 'note',
    ...settingKeys.map(k => `set.${k}`), ...metricKeys.map(k => `m.${k}`)];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map(r => [
    r.id, r.at, r.species, r.gait, r.verdict, r.setpoint, r.pct, r.note,
    ...settingKeys.map(k => r.values?.[k]), ...metricKeys.map(k => r.metrics?.[k]),
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}

/**
 * A matrix ready for PCA or a scatter, plus the column names.
 *
 * NORMALISED AGAINST EACH KNOB'S OWN DECLARED RANGE, not against the spread of the trials. That choice is
 * the difference between a plot that means something and one that does not. Scaling by observed variance
 * would make a knob you happened to nudge slightly count as much as one you swept end to end, and would
 * move every existing point every time a new trial arrived. The slider's own bounds are fixed, so a trial
 * plotted today sits in the same place next month.
 *
 * Columns with no spread across the rows are dropped: a knob nobody varied contributes a constant, which
 * an ordination cannot use and which distance metrics are only diluted by.
 */
export function tuningMatrix(rows, specs) {
  const keys = Object.keys(specs).filter(k => {
    const spec = specs[k];
    if (!(spec.max > spec.min)) return false;
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) {
      const v = r.values?.[k];
      if (typeof v !== 'number') continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo > 1e-9;
  });
  const matrix = rows.map(r => keys.map(k => {
    const spec = specs[k];
    const v = r.values?.[k] ?? spec.value;
    return (v - spec.min) / (spec.max - spec.min);
  }));
  return { keys, matrix };
}

/** Verdicts as numbers, for correlating the eye against the machine. Unrated rows are excluded. */
export function verdictSeries(rows, metricKey) {
  const score = { worse: -1, neutral: 0, better: 1 };
  const x = [], y = [];
  for (const r of rows) {
    if (r.verdict == null || !r.metrics) continue;
    const m = r.metrics[metricKey];
    if (typeof m !== 'number' || !Number.isFinite(m)) continue;
    x.push(score[r.verdict] ?? 0);
    y.push(m);
  }
  return { x, y, n: x.length };
}
