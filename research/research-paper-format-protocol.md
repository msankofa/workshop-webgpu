# Research Paper Format Protocol

This protocol codifies the format, structure, and writing rules used for the WebGPU
synthesis paper (`research/webgpu/webgpu-parallelism-over-serial-synthesis.html`). Use it
as the template for any future research/synthesis paper in this project. The goal is a
single self-contained HTML document that reads like a journal chapter, states one thesis,
synthesizes sources against that thesis, and reports measured results honestly.

---

## 1. Artifact format

- **One self-contained HTML file.** No build step, no external CSS/JS. All styling lives in a
  single `<style>` block in the `<head>`. The file opens directly in a browser.
- **Serif body, sans-serif furniture.** Body text is a serif stack (`"Iowan Old Style",
  "Palatino Linotype", Georgia, ui-serif, serif`); kickers, pills, tables, captions, TOC, and
  references are `ui-sans-serif, system-ui, sans-serif`; code is `ui-monospace, Consolas`.
- **Constrained measure.** `main { max-width: 980px; margin: 0 auto; }` with generous padding.
  Line-height 1.6.
- **Light theme via CSS custom properties.** Define the palette once in `:root` and reference
  it everywhere so callout variants stay consistent:

  ```
  --ink #1c2330   --muted #5a6675   --line #d8dee8   --paper #fbfcfe
  --panel #ffffff --accent #2a4d9b  --accent-2 #8a5a1c
  --soft #eef2fb  --warn #fff6e6    --good #ecf7f0   --code #f3f5f9
  ```

- If the paper embeds a live artifact, gate it behind a click (a button that injects the
  `<iframe>` on demand). Opening the paper must not start a GPU/heavy process on its own.

---

## 2. Document structure (in order)

1. **Header block**
   - `.kicker` — uppercase tracked label naming the track/series (e.g. "Web Graphics
     Architecture · Synthesis Chapter").
   - `h1` — the title.
   - `.subtitle` — italic, one or two sentences stating the thesis and the concrete artifact.
   - `.byline` — track name and date.
   - `.meta` — a row of `.pill` chips (scope, source count, key tech).
2. **Abstract** — `.abstract` box (accent left border). Two paragraphs: (1) the problem and the
   framing, (2) what is synthesized and what the paper concludes/delivers.
3. **Table of contents** — `nav.toc` (two columns), one anchor link per numbered section.
4. **Numbered sections** — `h2` with stable `id`s, `h3` subsections. See section 3 below.
5. **References** — `ol.refs`, each `<li id="rN">` with authors (bold title), venue (italic),
   year, and a resolvable DOI link. Note any excluded source and why.

---

## 3. Section arc (thesis-driven synthesis)

Organize around the thesis, not chronology. The proven arc:

1. **Introduction** — state the single axis/thesis and the claim that this frame is the most
   useful one. Forward-reference the section plan.
2. **Characterize side A** of the thesis (the baseline/incumbent).
3. **Characterize side B** of the thesis (the proposed/new model). A capability comparison
   table belongs here.
4. **Synthesis of the literature** — one `h3` per source, each opening with **bold authors +
   title + venue/year + citation**, then the findings that are load-bearing *for the thesis*.
   End with a cross-cutting synthesis subsection and an explicit caveats callout.
5. **Implications** — apply the synthesized principles to the concrete application; show the
   profiling/data that motivates the work.
6. **Implementation plan** — decompose into sub-projects, each as a `.sp` block with Goal,
   what informed it, caveat wiring, an acceptance **Gate**, and a **result callout** once done.
7. **Discussion** — the *realized* state of the artifact: what was actually built, what the
   measured division of labor turned out to be, what still scales. Honest about residuals.
8. **Conclusion** — the live artifact itself, embedded inline (click-to-launch), with the
   constraints to run it.

Adapt section count to the paper, but keep: thesis up front, sources synthesized against it,
measured results, and an honest discussion of what remains.

---

## 4. Components

- **Callouts** (`.callout` + a variant; each opens with a `.lab` uppercase label):
  - `.finding` (accent) — a synthesized finding or sequencing rationale.
  - `.caveat` (accent-2 / warn) — recurring caveats and boundaries of the claim.
  - `.apply` (green / good) — "applies to us": how a source's result maps to this project.
  - `.result` (teal) — a measured sub-project result. Label it `· measured` or `· shipped`.
- **Sub-project blocks** (`.sp`): `h3` title with a `.tag` status chip
  (`first · complete ✓`, `the bottleneck · complete ✓`, etc.), then Goal / Informed by /
  Caveat wiring / `.gate` (bold "Gate:") / result callout.
- **Tables**: `th` on `--soft`; numeric cells get `class="num"` (tabular-nums, nowrap). Result
  tables are three or four columns: metric, baseline, new, Δ.
- **Figures**: `.figure` (monospace, preformatted) with a `.figcap` italic caption.
- **Citations**: superscript `<sup><a href="#rN">[N]</a></sup>` inline; bracketed numbers
  resolve to the references list.
- **Blockquote**: reserve for a single sharp framing statement per section, not for evidence.

---

## 5. Writing rules (enforced)

These are the corrections that were applied to the paper. Follow them from the start.

- **No em-dashes.** Do not use `—`. Recast: use a colon for a setup-then-payoff, parentheses
  for an appositive, or a semicolon/period to join clauses. En-dashes are allowed only in
  numeric ranges (e.g. "27–46%", "§4.1–§4.2").
- **No editorializing.** State what was done and measured. Do not tell the reader the work is
  impressive, clever, sharp, or important. Cut sentences whose only function is to flatter the
  result or the method.
- **No agent-speak.** Write as an author, not as an assistant narrating its process. Do not
  address the reader about the act of testing/reading ("the sharpest test of X is to..."). If a
  sentence has no audience who needs it, delete it.
- **List hypotheses as hypotheses.** Claims made before the results section are hypotheses;
  keep them falsifiable and do not smuggle conclusions into the framing.
- **Report results honestly.** Distinguish "measured" from "shipped". State where a gain did
  *not* materialize, where a metric is within run-to-run noise, and what still scales the wrong
  way. Never overclaim (e.g. claim "flat fps" when only a subsystem is flat and overall frame
  time still declines with draw distance). Put accuracy guards in writing where a future edit
  might overclaim.
- **Thesis discipline.** Every source is presented for what it contributes to the one thesis,
  not summarized for its own sake. Cut source detail that does not bear on the axis.
- **Caveats are first-class.** State the boundaries of the claim explicitly (a dedicated
  caveats callout), and wire each caveat into the design sections that must respect it.
- **Numbers are specific and sourced.** Quote exact measured figures with units and the
  condition they were taken under (e.g. "at draw distance 9 / 361 chunks"). Tie literature
  numbers to their citation.

---

## 6. Pre-publish checklist

- [ ] One thesis, stated in the subtitle and the introduction, carried through every section.
- [ ] Every source synthesized against the thesis; each opens with bold authors/title/venue.
- [ ] Every numeric claim has units, a condition, and (for literature) a citation.
- [ ] Result callouts mark `measured` vs `shipped`; honest about noise and residuals.
- [ ] No em-dashes (grep for `—`); en-dashes only in ranges.
- [ ] No editorializing, no agent-speak; no sentence written to flatter.
- [ ] No overclaiming; accuracy guards present where a future edit could overreach.
- [ ] TOC anchors all resolve; all `<sup>` citations resolve to a reference `id`.
- [ ] Any embedded live artifact is click-to-launch, not auto-start.
- [ ] If a mirror copy exists (`../workshop/research/...`), sync it.
