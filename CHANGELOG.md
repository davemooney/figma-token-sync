# Changelog

All notable changes to this project are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-15

### Added
- `pull` command — fetch Figma Variables via the REST API and emit
  `tokens.json` (Style Dictionary shape) plus a `:root { --… }` CSS file.
- `diff` command — detect drift between the committed token files and the
  live Figma file; exits non-zero when drift is found (CI-friendly).
- `report` command — print a drift table to the console and optionally POST a
  summary to a Slack incoming webhook.
- Rate-limited Figma client (token-bucket) to stay within REST API limits.
- Parser for Figma Variables (collections + modes) into a flat token map.
- Style Dictionary JSON and CSS custom-property emitters.
