# dsh-paper-reader — test harness

Two independent suites, both plain Node scripts (no `@playwright/test`), driving the
locally installed Playwright + Google Chrome. Screenshots land in `tests/screenshots/`,
machine-readable summaries in `tests/last-run.json` (harness) and
`tests/gui-last-run.json` (real GUI).

## Prerequisites

Use Node.js and a locally installed Google Chrome. Install Playwright in the
project with `npm install --no-save playwright`, or reuse an existing DSH profile
installation (defaults to `~/.dsh/profiles/desktop`; override `DSH_HOME` and
`DSH_PROFILE`). The real-GUI helper currently targets the standard macOS DSH
installation and requires an existing desktop profile with this plugin mounted.

## Quick start

```bash
# Everything (standalone harness + real GUI against the dev host)
tests/run.sh

# Chunk-level only — no DSH Host, no auth, no install needed
node tests/harness.spec.mjs                 # all pages
node tests/harness.spec.mjs --only=viewer   # one section
node tests/harness.spec.mjs --headed        # watch it run

# Real GUI only — requires the Lead's isolated dev host on :54001
node tests/gui.spec.mjs                     # zh + en matrices
node tests/gui.spec.mjs --lang=zh
node tests/gui.spec.mjs --headed --keep     # keep the browser profile
```

`tests/run.sh` forwards extra arguments to both scripts; use `SKIP_GUI=1` or
`GUI_ONLY=1` to run one of them.

## Standalone harness (`tests/harness.spec.mjs`)

Starts `harness/serve.mjs` on `127.0.0.1:7812` (or reuses one already running) and
drives the scenario pages under `harness/pages/`. `harness/shim.js` fakes
`window.__ModuleLoader__` with the real module-system semantics (lazy factory
registration, memoized materialization, duplicate-registration errors,
`require.async('./client.<name>.js')` chunk loading, React from the UMD bundles in
`harness/umd/`).

| Section | Covers |
|---|---|
| `infra` | server routes + MIME (js/mjs/pdf/html/css/wasm), 404 + traversal rejection, shim registration/require semantics |
| `viewer` | painted canvas pixels, text layer spans, normalized `Selection` payload (page + 0..1 rects + anchor), Escape/apiRef clearing, zoom re-render, `scrollToPage`, `renderPageOverlay`, CJK fixture, corrupt-PDF localized error |
| `annotations` | 3-action menu exact zh/en labels, menu placement, highlight + reload persistence, note composer (disabled empty/whitespace save, Ctrl+Enter), notes panel rows/delete, ask prompt zh/en + template + truncation, corrupt localStorage tolerance |
| `library` | upload → row, open → stored bytes (`%PDF-`), reload persistence (IndexedDB), inline two-step delete, non-PDF error zh/en, corrupt-header acceptance |
| `integration` | `client.app.js` mounted with the fake `core`: seeded library, open paper, PDF render, menu actions, toasts, annotation badge, ask-in-session prompt, reload restore, notes panel, `client.js` apply() registrations |

Fixtures come from `fixtures/` (see `fixtures/README.md`; regenerate with
`node fixtures/src/make-fixtures.mjs`).

## Real GUI (`tests/gui.spec.mjs`)

Targets the isolated dev host the Lead boots with the **same plugin/profile config
as the desktop app**:

```bash
./scripts/dev-gui.sh restart   # after lib/*.js changes; prints a fresh tokenized URL
```

The tokenized URL is read from `/tmp/paperdev.url` (env overrides:
`DSH_DEV_TOKEN_URL`, `DSH_DEV_ORIGIN`, `DSH_DEV_URL_FILE`). The token URL 303s and
sets the auth cookie; each locale runs in its own persistent Chromium profile.

Verified per locale (`zh`, `en`), 15 checks each:

1. tokenized URL boots the GUI, onboarding modals dismissed;
2. `+`/expand right sidebar → guide card 论文阅读器 / Paper Reader → tab opens
   (`[data-paper-reader]` mounts, dockkit tab title localized);
3. empty library on a fresh profile → upload fixture → row → open → PDF rendered
   (painted canvases, text layer, page indicator, 100% zoom);
4. real text-layer selection → floating menu with exactly three localized actions;
5. highlight → localized toast + annotation badge; ask → localized prompt with the
   contract template lands in the real Lexical session composer (no `\n\n\n` runs);
   note → composer → save → toast;
6. notes panel lists annotations, row click jumps pages;
7. zoom in / fit-width re-render;
8. reload keeps the paper (IndexedDB) and annotations (localStorage);
9. corrupt.pdf → localized reader error while the app stays alive;
10. `/paper-reader/vendor/pdf.mjs` + `pdf.worker.mjs` served from the real page
    origin with `text/javascript`;
11. no uncaught page errors.

## Notes

- The user's running desktop app (`http://127.0.0.1:53715`) cannot be driven:
  `/` requires an auth cookie we cannot obtain (and will not brute-force). The
  plugin's Host route on that real profile was checked directly:
  `curl http://127.0.0.1:53715/paper-reader/vendor/pdf.mjs` → `200
  text/javascript` (860,384 B) while `/` → `401`. GUI-level behavior is verified on
  the dev host, which shares the plugin/profile configuration.
- The GUI matrix needs Chrome; the harness suite currently reuses an already
  listening server on :7812 if present (handy while iterating on a chunk).
