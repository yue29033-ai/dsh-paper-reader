# dsh-paper-reader — test fixtures

Small, locally generated files used by both test suites
(`tests/harness.spec.mjs` and `tests/gui.spec.mjs`). Everything here is produced
from local HTML by headless Chrome — no network, no third-party PDFs, all under
the 3 MB fixture budget.

| File | Size | What it is |
|---|---|---|
| `paper-en.pdf` | ~430 KiB, 3 pp | Letter, two-column article: serif body + sans headings, inline SVG figure, data table, math-ish symbols, references page. |
| `paper-zh.pdf` | ~830 KiB, 5 pp | A4 Chinese paper: Songti body / PingFang headings, mixed Latin, several font sizes, figure, table, references. |
| `corrupt.pdf` | < 1 KiB | Has a `%PDF-1.7` header but no valid body — PDF.js throws `InvalidPDFException`. The paper library accepts it (header validation only); the viewer must show its localized parse-error block. |
| `not-a-paper.txt` | < 1 KiB | Plain text without a `%PDF-` header — the library upload validation must reject it with a localized "not a PDF" error. |

Sources live next to the generator in `fixtures/src/`:

```bash
# Regenerate the PDFs + bad files (uses the local Chrome/Chromium/Edge).
node fixtures/src/make-fixtures.mjs
# Use a specific browser binary:
node fixtures/src/make-fixtures.mjs --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Both PDFs are generated with:
`--headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf=… file://…`.

Regenerate after changing the source HTML; the suites assert fixture sizes are
under 3 MB and start with `%PDF-`.
