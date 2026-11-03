# Chunk interface contracts (frozen)

All chunks are hand-written plain-JS ModuleLoader bundles (no JSX, no build).
Shared rules:

- Wrapper:
  ```js
  window.__ModuleLoader__.load({
    id: 'dsh-paper-reader',
    chunk: 'client.<area>.js',      // exactly the file name
    factory(require) { const React = require('react'); const h = React.createElement; … ; return { …exports }; },
  });
  ```
- No `import`/`export` statements, no require of DSH client packages (only `'react'`,
  lazily `react-dom` if unavoidable). No HTML strings from untrusted data.
- Every component renders `<style>` as its first child (plain string CSS, class
  prefixes below), colors/spacing from `--dsw-alias-*` tokens; document area may
  use PDF-specific neutrals only for the page sheet (see §5).
- All user-visible text localized with a private `STRINGS = { zh, en }` table and
  a `lang` prop (`'zh' | 'en'`). Never call the locale service inside a chunk.
- No DOM outside the component tree, no `document.body` appends, no reading
  other plugins' DOM. Positioned layers use `position:absolute` inside the
  reader's own relative container, or `position:fixed` only for the note dialog
  if needed.
- Chunk files must stay syntax-valid classic scripts (verify with
  `node --check lib/client.<area>.js`).

## Data model

```ts
type Lang = 'zh' | 'en';
interface PaperMeta { id: string; name: string; title: string; size: number; addedAt: number; }
interface Paper { meta: PaperMeta; bytes: Uint8Array; }
type HighlightColor = 'yellow' | 'green' | 'pink' | 'blue';
interface NormRect { x: number; y: number; w: number; h: number }  // 0..1 of page box, top-left origin
interface Highlight { id: string; page: number; rects: NormRect[]; text: string; color: HighlightColor;
                      noteId?: string; createdAt: number; }
interface Note { id: string; page: number; quote: string; text: string; highlightId?: string; createdAt: number; }
interface AnnotationSnapshot { highlights: Highlight[]; notes: Note[] }
interface Selection {
  text: string; page: number;                       // 1-based page number
  rects: { page: number; x: number; y: number; w: number; h: number }[]; // normalized like NormRect
  anchor: { left: number; right: number; top: number; bottom: number };   // viewport CSS px
}
```

## 1. `lib/client.viewer.js` — owner: viewer

Exports `{ PdfViewer }`.

```ts
PdfViewer(props: {
  bytes: Uint8Array;             // PDF bytes; component must copy before transfer if needed
  vendorBase: string;            // e.g. '/paper-reader/vendor/'
  lang: Lang;
  zoom: number;                  // 1 = fit width; app clamps 0.5–3
  renderPageOverlay?: (page: number, size: { width: number; height: number }) => React.ReactNode;
  onDocumentReady?: (info: { numPages: number }) => void;
  onPageChange?: (page: number) => void;
  onSelection?: (selection: Selection | null) => void;
  apiRef?: { current: null | { scrollToPage(page: number): void; clearTextSelection(): void } };
  className?: string;
})
```

Requirements:

1. Loads PDF.js once per page session with
   `await import(vendorBase + 'pdf.mjs')` (the Host half serves it),
   `pdfjs.GlobalWorkerOptions.workerSrc = vendorBase + 'pdf.worker.mjs'`,
   then `pdfjs.getDocument({ data, cMapUrl: vendorBase + 'cmaps/', cMapPacked: true,
   standardFontDataUrl: vendorBase + 'standard_fonts/', wasmUrl: vendorBase + 'wasm/' })`.
   Vendor base URL must be treated as a directory (append file names as above).
2. Renders the PDF as a vertical page stack (12px gaps, 12px inset) inside its
   own scrollport that fills the parent (`flex:1;min-height:0;overflow:auto`).
   Page sheet: white (light) / original colors, subtle shadow, theme-aware
   backdrop (light `#eceef1`, dark `#0d0d0d`). Page placeholder keeps layout
   (aspect ratio) before a canvas arrives.
3. Fit-width scale from the scrollport width (minus insets) × `zoom`; redraw on
   container resize (ResizeObserver) and on zoom; devicePixelRatio-aware canvas;
   cancel in-flight render tasks (`renderTask.cancel()`) and await them before
   disposing; pages render lazily when near the viewport (IntersectionObserver),
   and offscreen pages may be discarded but keep their place.
4. A per-page **text layer** for selection (PDF.js v6 API, see §6). Text stays
   transparent over the canvas so the document's own text stays crisp.
5. Selection reporting: while mounted, listen to `selectionchange`/`pointerup`/
   `mouseup` on its scrollport; when the selection is non-collapsed and its
   anchor is inside a page text layer, compute `Selection` (text normalized by
   `selection.toString()`; trim trailing/leading whitespace; page = affected
   page; normalized rects from `range.getClientRects()` intersected with the page
   box; anchor = last visible client rect of the range) and call
   `onSelection(sel)` (debounced ~60ms is fine, but must fire on pointerup).
   Call `onSelection(null)` when the selection collapses, moves outside,
   `apiRef.current.clearTextSelection()` is called, or the page scrolls so the
   selection anchor leaves the scrollport. `Escape` clears the selection.
6. `renderPageOverlay(page, {width, height})` is rendered inside each page box
   after the text layer (the app passes the highlight layer). The viewer must
   not depend on the annotations chunk.
7. `apiRef` (if provided) receives `{ scrollToPage(page), clearTextSelection() }`
   after mount; `onPageChange` reports the page nearest the top of the
   scrollport; `onDocumentReady` fires once with `{ numPages }`.
8. Class prefix `dpr-v-`; own `<style>` element; the text-layer CSS below must
   be included (it is required for PDF.js TextLayer geometry).
9. Errors: if the PDF cannot be parsed, render a localized error block with the
   error message (no throw from render); still satisfy prop callbacks.

## 2. `lib/client.annotations.js` — owner: annotations

Exports
`{ createAnnotationStore, HighlightLayer, SelectionMenu, NoteComposer, NotesPanel,
   buildAskPrompt, ANNOTATION_COLORS }`.

- `createAnnotationStore(paperId: string)` → store
  ```ts
  {
    getSnapshot(): AnnotationSnapshot;        // stable reference until a change
    subscribe(fn: () => void): () => void;
    addHighlight(h: Omit<Highlight, 'id' | 'createdAt' | 'noteId'> & { noteId?: string }): Highlight;
    removeHighlight(id: string): void;
    addNote(n: Omit<Note, 'id' | 'createdAt'>): Note;
    updateNote(id: string, patch: { text?: string }): void;
    removeNote(id: string): void;
  }
  ```
  Persists to `localStorage` key `dsh-paper-reader:annotations:v1:<paperId>`.
  Robust to missing/corrupt storage (fresh snapshot, keep working).
- `HighlightLayer({ page, highlights })` — absolute overlay (`inset:0`,
  `pointer-events:none`) painting normalized rects as rounded translucent
  fills; deterministic palette; no text blocking. (Highlights are not clickable;
  management happens in `NotesPanel`.)
- `SelectionMenu({ lang, style, onHighlight, onNote, onAsk, onClose })` —
  compact floating card with exactly three actions: 高亮 / 添加笔记 /
  在会话中提问 (en: Highlight / Add note / Ask in chat), icons optional,
  `role="menu"`, Escape → `onClose`, buttons stopPropagation so clicking does
  not clear the selection. `style` positions it (absolute, app-computed).
- `NoteComposer({ lang, quote, page, onSave(text: string), onCancel })` — small
  card/popover with the quote preview, a textarea (autoFocus, Cmd/Ctrl+Enter
  saves, Esc cancels), 保存/取消 (Save/Cancel) buttons, disabled save when
  empty, maxLength 4000.
- `NotesPanel({ lang, store, onJump(page: number), onClose })` — side panel
  listing notes and highlights (newest first), each row: color dot, page badge,
  quote (2-line clamp) and note text; row click → `onJump(page)`; delete button
  per row; empty state text; subscribes to the store.
- `buildAskPrompt({ lang, title, page, text })` → string. Exact defaults:
  - `zh`: `请阅读并解释这篇论文《{title}》第 {page} 页的以下内容，并回答我的问题：\n\n> {quote}\n\n我的问题：\n`
  - `en`: `Please read and explain the following excerpt from the paper "{title}" (page {page}), then answer my question:\n\n> {quote}\n\nMy question:\n`
  Quote normalized (collapse blank lines), truncated to 1600 chars with a
  localized ellipsis marker if longer.
- `ANNOTATION_COLORS`: ordered list `['yellow','green','pink','blue']` with
  fill values for both themes if needed.
- Class prefix `dpr-a-`.

## 3. `lib/client.library.js` — owner: library

Exports `{ createPaperStore, PaperLibrary, formatBytes }`.

- `createPaperStore()` → store (IndexedDB DB `dsh-paper-reader`, version 1,
  object store `papers`, keyPath `id`; record `{ id, name, title, size, addedAt, bytes }`):
  ```ts
  {
    getSnapshot(): { papers: PaperMeta[]; loaded: boolean; error?: string };
    subscribe(fn: () => void): () => void;
    init(): Promise<void>;                     // idempotent; loads list
    save(file: File): Promise<PaperMeta>;      // validates PDF (%PDF- header), max 100 MB
    getBytes(id: string): Promise<Uint8Array>;
    remove(id: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
  }
  ```
  The app calls `init()` once; store snapshots are reference-stable.
- `PaperLibrary({ lang, store, onOpen(meta) })` — the library view:
  - upload area: click opens native file input (`accept="application/pdf,.pdf"`),
    drag & drop anywhere over the panel; drag-over visual state;
  - validates and shows localized errors (not a PDF / too large / read failure);
  - list rows: title (basename without extension, or stored title), size
    (`formatBytes`), added date; click row → `onOpen(meta)`; delete button with
    inline confirm (two-step button, no `confirm()`); loading and empty states;
  - optional per-row "重命名" is not required.
- `formatBytes(n: number): string`.
- Class prefix `dpr-lib-`.

## 4. `lib/client.app.js` — owner: Lead (integration shell)

Composes the three chunks (lazy `require.async`), owns: library↔reader state,
zoom, selection→floating-menu positioning and clamping, highlight/note creation
flows, notes panel, ask-in-session prompt (uses `core.askInSession`), success/
failure toast, reader header (back, title, page x/y, zoom controls, notes
toggle). Not a teammate deliverable; do not edit.

## 5. Visual language

- Reader chrome inherits `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1/2`,
  `--dsw-alias-border-l2/l3`, `--dsw-alias-label-primary/secondary/tertiary`,
  `--dsw-alias-brand-primary`, `--dsw-alias-interactive-bg-hover`,
  `--dsw-alias-state-error-primary`, radius `10–12px`, 12–13px UI text.
- Document sheet keeps the paper's own colors; the surrounding page area uses
  a neutral light `#eceef1` / dark `#0b0b0b` so page shadows read.
- Toolbar buttons: 28–30px square icon buttons, 8px radius, hover fill token.
- Highlight fills: yellow `rgba(255,201,29,.32)`, green `rgba(52,199,89,.28)`,
  pink `rgba(255,105,180,.26)`, blue `rgba(64,156,255,.26)`.

## 6. PDF.js v6 notes (from the shipped dsh document-preview implementation)

```js
// page rendering (v6 renders straight into a canvas):
const viewport = page.getViewport({ scale });            // scale = fit*zoom
canvas.width  = Math.floor(viewport.width  * devicePixelRatio);
canvas.height = Math.floor(viewport.height * devicePixelRatio);
const task = page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
await task.promise;

// text layer:
const div = document.createElement('div');
div.className = 'textLayer dpr-v-textLayer';
div.style.setProperty('--total-scale-factor', String(viewport.scale));
pdfjs.setLayerDimensions(div, viewport);                 // exported by pdf.mjs
const textLayer = new pdfjs.TextLayer({
  textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
  container: div,
  viewport,
});
await textLayer.render();
// append an endOfContent div (class "endOfContent") after render for selection easing.
```

Required text-layer CSS (abridged from `vendor/pdf_viewer.css`; include verbatim):

```css
.textLayer{position:absolute;inset:0;overflow:clip;text-align:initial;line-height:1;
  letter-spacing:normal;word-spacing:normal;text-size-adjust:none;forced-color-adjust:none;
  transform-origin:0 0;caret-color:CanvasText;z-index:0;}
.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;
  transform-origin:0% 0%;user-select:text;}
.textLayer > :not(.markedContent),.textLayer .markedContent span:not(.markedContent){
  z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor)*var(--font-height));
  --scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));}
.textLayer .markedContent{display:contents;}
.textLayer{--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size));
  --min-font-size-inv:calc(1/var(--min-font-size));}
.textLayer ::selection{background:rgba(64,120,255,.28);color:transparent;}
.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none;}
```

## 7. Harness (owner: qa) — how chunks get exercised outside the GUI

`harness/serve.mjs` runs a local static server (port 7812) exposing:
`/lib/*` → `dsh-paper-reader/lib/*`, `/vendor/*` → `vendor/*`, `/harness/*`,
`/fixtures/*`. `harness/shim.js` installs a fake
`window.__ModuleLoader__` that registers `load({id, chunk, factory})` and lets
pages materialize a chunk with `window.__dprRequireChunk('./client.viewer.js')`,
providing `require('react')` from UMD builds loaded by the page. Scenario pages:
`harness/pages/viewer.html`, `annotations.html`, `library.html`, plus an
integration page that mounts `client.app.js` with a fake `core`.

Fixtures: at least one PDF with serif + sans + CJK text, an image figure, a
table, and a two-column layout (generate with headless Chrome print-to-PDF from
local HTML, or fetch an arXiv paper if the network allows). Keep fixtures small
(< 3 MB each unless a large-paper test is needed).
