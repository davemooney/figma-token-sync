# figma-token-sync

**Kill the design ↔ code drift.** A tiny TypeScript CLI that pulls your
**Figma Variables** through the Figma REST API, emits **design tokens**
(Style Dictionary JSON + CSS custom properties), and **detects drift**
between what's in Figma and what's committed to your repo — so the handoff
tax stops being paid in Slack threads and "is this the latest hex?" pings.

```
CLI → rate-limited Figma fetcher → token parser → Style Dictionary / CSS emitter → drift validator → reporter
```

Designers move tokens in Figma. Engineers commit tokens in code. Without a
sync gate, the two quietly diverge: a primary brand colour shifts by one hex
digit, a spacing step changes from `16` to `12`, and nobody notices until a
screenshot looks "off" in review. `figma-token-sync` makes that divergence a
**failing CI check** instead of a bug report.

---

## Install

```bash
npx figma-token-sync pull        # no install needed
# or
npm install --save-dev figma-token-sync
```

## Configure

Two environment variables (or pass `--token` / `--file`):

| Var | What | Where to get it |
|-----|------|-----------------|
| `FIGMA_TOKEN` | Personal access token | Figma → Settings → **Personal access tokens** (needs `file_variables:read`) |
| `FILE_KEY` | The file to read | The `…/file/<FILE_KEY>/…` segment of the Figma URL |
| `SLACK_WEBHOOK_URL` | *(optional)* drift notifications | Slack → Incoming Webhooks |

> The Variables REST endpoint requires an **Enterprise** plan token. Colour
> aliases that reference other variables are skipped — primitives are emitted.

## Usage

```bash
# Pull Figma Variables → tokens.json (Style Dictionary) + tokens.css
figma-token-sync pull

# Fail (exit 1) if committed tokens have drifted from Figma — drop this in CI
figma-token-sync diff

# Print a drift table and optionally ping Slack
figma-token-sync report --slack "$SLACK_WEBHOOK_URL"
```

Flags (all commands): `--token`, `--file`, `--json <path>` (default
`tokens.json`), `--css <path>` (default `tokens.css`), `--rpm <n>` (Figma
request budget, default 60/min).

### Example output

```text
$ figma-token-sync diff
✗ Drift detected — 3 token(s) out of sync:

  KIND       TOKEN                   VALUE
  ~ changed  color.brand.primary     #4f46e5 → #4338ca
  ＋ added   space.xl                40
  － removed  radius.pill             999
```

```jsonc
// tokens.json (Style Dictionary shape)
{
  "color": {
    "brand": { "primary": { "value": "#4f46e5", "type": "color" } }
  },
  "space": { "md": { "value": 16, "type": "dimension" } }
}
```

```css
/* tokens.css */
:root {
  --color-brand-primary: #4f46e5;
  --space-md: 16px;
}
```

Sample outputs live in [`examples/`](./examples).

## Audit

Beyond token drift, `figma-token-sync audit` scans **hundreds of Figma files**
through the live REST API for **component-adoption** problems and emits a
**single self-contained HTML report** (inline CSS/JS — opens straight from
disk, no build step) that doubles as a design-system-governance artifact.

```bash
figma-token-sync audit \
  --files file-keys.txt \          # one Figma file key per line (# comments ok)
  --token "$FIGMA_TOKEN" \
  --out report.html                # default audit-report.html
```

### What it detects (5 signals)

| # | Signal | What it flags | Reliability |
|---|--------|---------------|-------------|
| 1 | **Adoption %** | `INSTANCE` coverage vs. raw `RECTANGLE`/`FRAME`/`VECTOR`/`TEXT` geometry, per page / file / portfolio | **reliable** |
| 2 | **Unbound values** | a fill / stroke / effect with a literal value and **no** matching `boundVariables` entry = off-token | **reliable** |
| 3 | **Ad-hoc text** | text nodes with no `styles.text` (typography not using a shared text style) | **reliable** |
| 4 | **Library index + match** | builds a published-component index (`/components` + `/component_sets`) first, then flags **instances of local (non-library) components** and **local components that duplicate a library component by name** | **reliable** (local-vs-library) / **heuristic** (name-dup) |
| 5 | **Detached candidates** | frames whose name + structure match a known component | **heuristic — candidates for review** |

> **Honest framing.** The REST API has **no `wasInstance` flag**, so a detached
> instance just looks like a frame. Signal 5 (and the name-based duplicate
> match in signal 4) are therefore **best-effort heuristics**, surfaced in a
> clearly-labelled "candidates for human review" section — the report **flags
> candidates**, it does not claim perfect detection.

### The report

A dark, [SIGNAL](https://ultramoon.agency)-styled (Switzer + JetBrains Mono)
HTML page with:

- **exec-summary scorecards** — portfolio adoption %, unbound values, ad-hoc
  text, total findings by severity;
- a **severity heatmap** by rule (reliable vs. heuristic tagged);
- **top offending files**;
- a **client-side sortable / filterable / paginated findings table** (stays
  fast across thousands of rows) with working **Figma deep-links**;
- a **per-file drill-down** with per-page adoption.

See the committed sample: [`examples/sample-audit-report.html`](./examples/sample-audit-report.html)
(7 files, 36.2% adoption, 205 findings, 24 frame thumbnails — generated from
fixtures via `npm run sample-report`, no token needed).

### Frame thumbnails (`--thumbnails`)

```bash
figma-token-sync audit --files file-keys.txt --thumbnails \
  --thumb-format svg --thumb-scale 1 --thumb-max 200 --out report.html
```

With `--thumbnails`, each **flagged frame** is rendered once via Figma's
**`GET /v1/images/:key?ids=:frameId&format=svg`** API and the flagged nodes are
outlined *in place*, surfaced two ways:

- **Frame gallery** — a ~4-col card grid. Each card shows the rendered frame
  with overlay rects (green = component instance, solid red = raw / unbound
  node, dashed amber = ad-hoc text, dashed amber box = detached candidate), an
  **adoption ring** (frame-level %), a severity **badge**, the frame name +
  file·page, a compact flag breakdown, and a legend.
- **Inline preview column** — a leading ≈96×60 thumbnail in the findings table,
  the offending node outlined inside its parent frame; **hover enlarges** it.

**Sourcing & self-containment.** `/v1/images` returns time-boxed **S3 URLs**, so
we fetch the bytes *promptly* and **inline** them (SVG as markup, PNG as a
`data:` URI) — the report stays a single self-contained HTML file with **no
external `<img src>` / `<script src>`** beyond the existing webfont `<link>`.
Bytes (not URLs) are cached under `.figma-audit-cache`, keyed by
`(fileKey, version, frameId, format, scale)`. Findings are deduped to their
nearest FRAME/COMPONENT ancestor so each frame is imaged **once** (not per
leaf), fetches are concurrency-bounded, and `--thumb-max` caps the count.
Coordinate space: `/v1/images` renders the frame at its own bounds, so each
flagged child's rect is normalised to `(childBox − frameOrigin) × scale` and
clamped to the frame (unit-tested — it's the one fiddly bit). `--thumbnails` off
yields the byte-identical text-only report.

### Flags

| Flag | Default | What |
|------|---------|------|
| `--files <path>` | — | text file of Figma file keys (one per line) |
| `--team <id>` | — | enumerate a team's files instead of / alongside `--files` |
| `--library <keys>` | all audited files | comma-separated file keys that publish the component library |
| `--out <path>` | `audit-report.html` | report output path |
| `--format <html\|json>` | `html` | `json` emits the same findings machine-readably |
| `--config <path>` | — | audit config JSON (per-rule enable/severity + `ignore` list) |
| `--rpm <n>` | `60` | Figma request budget |
| `--concurrency <n>` | `4` | parallel file fetches |
| `--cache-dir <path>` | `.figma-audit-cache` | on-disk response cache (keyed by file `version`) |
| `--no-cache` | — | disable the version cache |
| `--fail-under <pct>` | — | **CI gate** — exit non-zero if portfolio adoption % is below this |
| `--max-unbound <n>` | — | **CI gate** — exit non-zero if unbound-value findings exceed this |
| `--thumbnails` | off | image each **flagged frame** via `GET /v1/images`, inline it, and render the **gallery** + **inline-preview** surfaces (see below) |
| `--thumb-format <svg\|png>` | `svg` | thumbnail render format (SVG stays vector + tiny; PNG fallback for export-resistant frames) |
| `--thumb-scale <n>` | `1` | pixel scale passed to `/v1/images` (1–4) |
| `--thumb-max <n>` | — | cap how many flagged frames are imaged (logged when truncated — `/v1/images` is rate-limited) |

The fetch layer is concurrency-capped, backs off exponentially on `429`/`5xx`
(honouring `Retry-After`), and caches each file's payload keyed by its Figma
`version`, so an edit-free re-run across hundreds of files costs one cheap
metadata request per file instead of a full tree download.

### Audit config

```jsonc
// audit.config.json
{
  "rules": {
    "detached-candidate": { "enabled": false },
    "unbound-value": { "severity": "error" }
  },
  "ignore": ["1:23", "WIP*", "Sandbox / *"]
}
```

`ignore` entries match a node by exact id, exact name, or a `*`/`?` glob over
its name and slash-joined path.

### Audit CI recipe

```yaml
- run: npx figma-token-sync audit --files file-keys.txt --fail-under 70 --max-unbound 50
  env:
    FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}
```

## CI recipe

```yaml
# .github/workflows/tokens.yml
- run: npx figma-token-sync diff
  env:
    FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}
    FILE_KEY: ${{ secrets.FIGMA_FILE_KEY }}
```

`diff` exits non-zero on drift, so the job goes red the moment Figma and the
repo disagree. Run `pull` and commit the result to resolve.

## How it works

1. **Fetch** — `GET /v1/files/:key/variables/local` with an `X-Figma-Token`
   header, behind a token-bucket rate limiter.
2. **Parse** — flatten collections/modes into a sorted token map; slash paths
   (`color/brand/primary`) become dot paths; RGBA → hex.
3. **Emit** — a nested Style Dictionary JSON tree and a `:root { --… }` CSS file.
4. **Validate** — diff committed vs. live into `added` / `removed` / `changed`.
5. **Report** — console table and/or Slack webhook.

## License

MIT © 2026 Dave Mooney. See [LICENSE](./LICENSE).
