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
