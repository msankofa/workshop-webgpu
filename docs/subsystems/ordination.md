# Code Ordination

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#ordination)

## Purpose

Answers "what code in this repo is most similar to what other code" by embedding source text
and projecting it to a 2D map. Unlike `code-map.html`, which draws the dependency graph (what
imports what — a fact), this draws a *similarity* space (an inference), so it can find files
that resemble each other but were never wired together.

The page is the pipeline: `code-ordination.html` lays the six stages out left to right, each
stage owning the controls that configure it and reporting what it produced.

```
extract  ->  represent  ->  embed  ->  postprocess  ->  ordinate  ->  score
 units      tokens        vectors     Gram matrix       2D coords    vs labels
```

## Files

| File | Role |
|---|---|
| `code-ordination.html` | The tool. Pipeline spine, scatter plot, neighbour list, sweep table. |
| `ordination-extract.js` | Stage 1. Corpus to units (file / function / chunk). Owns the JS masker. |
| `ordination-represent.js` | Stage 2. Unit text to tokens, per capture target. |
| `ordination-embed.js` | Stage 3. Tokens to sparse vectors (tf-idf, BM25, binary, hashing, random). |
| `ordination-vectors.js` | Stages 4–5. Centred Gram matrix, distances, PCA / MDS / stress. |
| `ordination-score.js` | Stage 6. Label parsing, neighbour purity, silhouette, chance baseline, the unconnected-pairs finding. |
| `ordination-pipeline.js` | Ties them together; owns `DEFAULT_CONFIG`, `prepare`/`project`, `sweepTail`. |
| `test-ordination.mjs` | 77 checks, including an end-to-end run over this repo's own source. |
| `ordination-steps.html` | The step viewer. One tab per stage, each showing that stage's input and output side by side. |
| `ordination-annotate.js` | Span-level annotation for the viewer: which characters survived a stage, and why the rest did not. |
| `ordination-explain.js` | Step 3's readable breakdown of one vector, plus the point field for the all-pieces view. |
| `test-ordination-steps.mjs` | 39 checks that the viewer agrees with the pipeline it claims to display. |

Server routes in `serve.py`: `GET /api/code-corpus` (all source text in one request) and
`POST /api/save-ordination` (writes `ordination-config.json`).

## Two pages, different jobs

`code-ordination.html` runs the whole pipeline and shows the finished map. `ordination-steps.html`
shows the pipeline working, one stage at a time, so each stage can be checked before the next one
is trusted. The step viewer came second, after the first page turned out to show knobs and a final
answer with no way to verify anything in between.

Every step tab is laid out the same way: an upstream filter across the top saying what is allowed
into that step, then three panels - a searchable list, the input, and the output.

| Step | In | Out | The check it offers |
|---|---|---|---|
| 1 - Cut the code up | a file | the pieces it was cut into | cut points drawn on the source, a count of lines inside no piece, and a "next gap" jump |
| 2 - Pick what to compare | one piece | the words that come out | dropped text struck through in place, with a tally by reason |
| 3 - Turn words into numbers | a word list | one weight per word | word, count here, count across all pieces, and the weight those two produce |

Step 3's two panels choose their view independently, so all four pairings are reachable:

- **In: this piece** - the words step 2 produced for the selected piece, greying out the ones
  that got no number.
- **In: all words** - the whole shared vocabulary, most-used first, with a search.
- **Out: table** - the selected piece as one row per word, for checking the arithmetic.
- **Out: graph** - the sparse matrix as a 3D point field, one point per non-zero cell, height
  and colour by weight.

Clicking a word in either In view points Out at it: the graph lights that word's column, the
table highlights its row, or says the piece produced no number for it. The first version tied
both panels to one toggle, which made the two most useful pairings unreachable - browsing the
vocabulary against one piece's table, and clicking a word out of one piece to find it in the
whole field.

The field carries labelled axes: word rank left to right, piece number back to front, weight up.
The labels are HTML projected from their 3D anchor points every frame rather than sprites, so the
text stays crisp and stays correct as the camera orbits. Piece ticks show real piece numbers, so
they account for the stride when the view is sampling.

Words past the field's 600-word window have no column, and the page says so rather than lighting
nothing. Three.js WebGPU is imported lazily on first use and torn down whenever Out leaves the
graph view, so the page costs nothing if that view is never opened.

Every control carries a plain-English line on hover, and holding Ctrl swaps it for a longer one
that explains the option values one by one. That text lives in a `HELP` map in the page.

### Why the viewer can be trusted

A viewer that describes a pipeline can drift from it silently and still look convincing. Both new
modules are therefore checked against the real thing rather than assumed to agree:

- `annotateUnit`'s spans imply a word list. `test-ordination-steps.mjs` asserts that list is
  character-for-character what `representUnit` produces, over 1,270 pieces at three capture
  targets. The page re-checks it at runtime and prints a warning in the output panel on a
  mismatch, instead of quietly showing something wrong.
- `nonCodeRegions` is a second implementation of `maskNonCode`'s scan. The test asserts the two
  agree on every character of 120 real files.
- `explainRow` reads its weights straight off the real sparse row rather than recomputing them,
  and the test asserts every displayed weight is the stored one.

Three bugs were caught this way that nothing else would have caught: the overlay ignored the
4,000-word cap, the two scanners disagreed on template-literal delimiters (`${` and `}`), and
chunks named `L61` were filed as classes because the name starts with a capital.

## The five choices, and what each one means

Everything the tool exposes is one of these. They are independent knobs, but the first three
constrain what the last three can possibly recover.

1. **Unit** — `file`, `function`, or `chunk`. Files here run from 40 to 3,000 lines, so a
   file vector partly measures file size. Functions are the sharper unit; chunks are the
   compromise that splits mid-thought.
2. **Capture target** — what text stands in for the code. `raw`, `stripped` (comments and
   imports out), `identifiers` (names only), `shape` (structural skeleton, identifiers
   collapsed to `_`, compared as trigrams), `summary` (the hand-written prose in
   `code-map.html`'s `desc` fields).
3. **Preprocessing** — strip imports, split camelCase, drop keywords, token cap.
4. **Postprocess** — mean-centre, and cosine vs euclidean.
5. **Ordination** — `pca` and `mds` keep interpretable axes; `stress` (SMACOF) fits near
   distances better but its axes and its gaps mean nothing.

Ground truth is the sixth thing, and it is not a knob: subsystem labels are parsed out of
`code-map.html` and used to score whether a configuration actually recovered known structure.

## Architecture note: everything runs off one Gram matrix

Mean-centring a sparse tf-idf matrix would densify it (4,000 dims × n rows) for no gain, so
`buildGram` uses the identity

```
<x-u, y-u> = <x,y> - <x,u> - <y,u> + <u,u>
```

to build the centred Gram straight from sparse dot products. Every distance, neighbour list
and projection then comes from `d(i,j)^2 = G[i][i] + G[j][j] - 2*G[i][j]`.

That is also the reason `ordination-pipeline.js` splits at `prepare` / `project`. Only
`prepare` (stages 1–3) touches the corpus and it is the expensive half; `project` (stages
4–6) is cheap, which is what makes `sweepTail` — every metric × centring × method combination
— affordable. The page tracks which stages are dirty and the Run button reads either
"Re-embed" or "Re-project" accordingly.

`eigenCoords` reuses `powerIteration`/`deflate` from `stats-math.js` (the same routines behind
the creature stats panel's PCA). It runs on the n×n Gram rather than a d×d covariance matrix,
which is what makes PCA on a 4,000-dimensional space tractable.

## Measured on this repo

From `node test-ordination.mjs`, 634 files at file granularity, tf-idf, cosine, PCA. Only 22%
of files carry a subsystem label, because `code-map.html` hand-lists about 140 of them.

| Capture target | Neighbour purity @5 | Silhouette |
|---|---|---|
| `summary` | **0.553** | 0.011 |
| `raw` | 0.306 | −0.006 |
| `stripped` | 0.253 | −0.012 |
| `identifiers` | 0.253 | −0.012 |
| `shape` | 0.153 | −0.074 |
| (chance) | 0.095 | — |
| (random vectors) | 0.029 | — |

Four things in that table are worth carrying into any future work here:

- **Prose about code beats code.** Embedding the hand-written summaries scores roughly twice
  what embedding the source does. If this is ever pointed at a hosted embedding model, the
  first thing to try is embedding LLM-written summaries rather than raw source.
- **Stripping comments made it worse** (`raw` 0.306 > `stripped` 0.253). The generic advice is
  to strip boilerplate; in this repo the comments are unusually substantive, so they carry real
  signal. This is a fact about this codebase, not a general rule.
- **Mean-centring slightly hurt** (0.253 centred vs 0.268 raw). The anisotropy argument for
  centring applies to *learned* embedding spaces; tf-idf does not have that pathology, so
  centring here just discards a little signal. Re-test this if the embedder ever changes.
- **The plot is much worse than the space.** Vector purity 0.253 against layout purity 0.046,
  with the first two components holding only 6% of the variance. Score the vector space; treat
  the picture as a lossy sketch of it. This is why the tool reports both numbers side by side.

Silhouette sits near zero throughout while purity is clearly above chance, which says
subsystems are *local neighbourhoods* in this space rather than globally compact clusters.
Tune on purity; read silhouette as the warning not to trust an apparent blob.

## The unconnected-pairs finding

`findUnconnectedSimilar` crosses the similarity space with `code-map.html`'s `EDGES`: pairs
above a similarity threshold with no import edge either way. Module-and-its-own-test pairs are
filtered out (`isTestOf`) as a similarity nobody needs reported. On the current tree the top
hits are the three `bake-*-lines.mjs` scripts (0.90–0.96 with each other), the `probe_*.mjs`
family, and `forest-cull.js` ~ `dressing-cull.js` at 0.81 — the last being a known pair of
hand-synced CPU/GPU math twins, which is a good sign the measure points at real duplication.

## Measured while building the step viewer

At function granularity over 337 files (root only, tests excluded): 2,108 pieces, 274 ms to turn
them into word lists and 37 ms to weight them. The vocabulary holds 4,819 distinct words, of which
3,356 survive - 1,463 are too rare, and **nothing at all is too common**. The 60%-of-pieces cutoff
never fires at this granularity, which is worth knowing before reaching for it as a tuning knob.

`nav-grid.js` has 210 of its 913 lines inside no piece, spread across 36 gaps. That is what step
1's "next gap" button exists to walk through. Some of it is top-level code genuinely not inside any
function; some may be the splitter missing things.

## Limits worth stating

- The function splitter is a regex over masked source, not a parser. It masks strings,
  comments, template literals and regex literals first, and skips balanced parens so a
  destructured parameter is not mistaken for a function body — but it treats a class as one
  unit and will mis-split code that defeats those heuristics.
- Label coverage is 22%. Every score rests on that minority; unlabelled units are plotted but
  cannot be scored. Extending `code-map.html`'s `NODES` improves the scoring directly.
- `maxUnits` (default 1,200) caps the Gram at a workable size. When it bites, the run reports
  it in the Caveats card rather than silently truncating.
- All embedders here are local and free. That is deliberate: they are the baseline a hosted
  model has to beat, and `random` is the control proving the scoring can tell signal from noise.
