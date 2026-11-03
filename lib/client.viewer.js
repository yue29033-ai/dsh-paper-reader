/**
 * dsh-paper-reader — PDF viewer chunk (owner: viewer).
 *
 * Renders one PDF with the vendored PDF.js 6.x as its original layout: a
 * vertical page stack with a selectable per-page text layer, fit-width scaling
 * multiplied by the app's zoom, device-pixel-ratio-aware canvases, lazy page
 * rendering near the viewport, and normalized selection payloads for the
 * floating selection menu.
 *
 * Contract: `docs/INTERFACES.md` §1 (frozen). This chunk owns only
 * `lib/client.viewer.js`; it exports `{ PdfViewer }` and depends on nothing but
 * `react`. PDF.js itself is loaded on demand from the Host's
 * `/paper-reader/vendor/` route (`vendorBase` prop), never bundled here.
 *
 * Layout/ownership notes:
 *   - React owns the page shells, viewport and error states.
 *   - PDF.js owns the canvas bitmap and the text-layer spans; they are created
 *     imperatively inside refs owned by the component tree.
 *   - Render tasks are cancelled (and awaited) on zoom, on page disposal and
 *     before a page is re-rendered; a serialized per-page queue guarantees one
 *     canvas is never targeted by two render tasks at once.
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  chunk: 'client.viewer.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Gap between two page sheets and outer inset of the page stack, CSS px. */
    const GAP = 12;
    const INSET = 12;

    /** Fill page gaps / inset with the page sheets' own white sheet color. */
    const PAGE_BACKGROUND = '#ffffff';

    /** Hard guard on one canvas bitmap (16.7 Mpx ≈ a 4096² canvas). */
    const MAX_CANVAS_PIXELS = 16777216;

    /** Pages farther than this from the scrollport are not rendered yet. */
    const RENDER_MARGIN_PX = 1200;

    /** A page that left the render margin keeps its bitmap this long. */
    const DISPOSE_DELAY_MS = 1200;

    /** Zoom changes settle before redrawing (coalesces trackpad bursts). */
    const ZOOM_SETTLE_MS = 80;

    /** Selection re-read debounce while the pointer is still dragging. */
    const SELECTION_DEBOUNCE_MS = 60;

    /** Estimated page aspect ratio (height / width) before a size is known. */
    const FALLBACK_RATIO = 3 / 4;

    /** Upper bound on pages whose real size is measured eagerly. */
    const MAX_MEASURED_PAGES = 400;

    /** UI copy; every user-visible string lives here, keyed by `lang`. */
    const STRINGS = {
      zh: {
        loading: '正在加载 PDF…',
        emptyDoc: '这个 PDF 没有可显示的页面。',
        loadErrorTitle: '无法打开这份 PDF',
        invalidPdf: '这个文件不是有效的 PDF，或已经损坏。',
        passwordPdf: '这个 PDF 有密码保护，暂不支持打开。',
        loadErrorGeneric: '解析 PDF 时出现了问题。',
        loadErrorDetail: '错误信息：{message}',
        pageError: '这一页暂时无法显示',
        pageErrorHint: '可以滚动到其他页面继续阅读。',
        ariaLabel: '论文页面',
      },
      en: {
        loading: 'Loading PDF…',
        emptyDoc: 'This PDF has no pages to display.',
        loadErrorTitle: 'Could not open this PDF',
        invalidPdf: 'This file is not a valid PDF, or it is damaged.',
        passwordPdf: 'This PDF is password-protected and cannot be opened.',
        loadErrorGeneric: 'Something went wrong while parsing the PDF.',
        loadErrorDetail: 'Details: {message}',
        pageError: 'This page could not be displayed',
        pageErrorHint: 'Scroll to another page to keep reading.',
        ariaLabel: 'Paper pages',
      },
    };

    /**
     * Translate one viewer string.
     * @param lang - `'zh'` or `'en'`.
     * @param key - dictionary key.
     * @param params - optional `{name}` template parameters.
     * @returns localized text, falling back to English, then the key.
     */
    function tr(lang, key, params) {
      const dict = STRINGS[lang] || STRINGS.en;
      const template = dict[key] !== undefined ? dict[key] : STRINGS.en[key] !== undefined ? STRINGS.en[key] : key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }

    /**
     * Truncate long runtime error text so it cannot dominate the error block.
     * @param value - raw text.
     * @param limit - maximum code units kept.
     * @returns shortened text.
     */
    function truncate(value, limit) {
      const text = String(value === null || value === undefined ? '' : value);
      return text.length > limit ? text.slice(0, limit) + '…' : text;
    }

    /**
     * Normalize the vendor directory base so file names can be appended.
     * @param vendorBase - `vendorBase` prop.
     * @returns base URL ending in `/`.
     */
    function normalizeVendorBase(vendorBase) {
      const raw = typeof vendorBase === 'string' && vendorBase.length > 0 ? vendorBase : '/paper-reader/vendor/';
      return raw.charAt(raw.length - 1) === '/' ? raw : raw + '/';
    }

    /**
     * Clamp the app's zoom prop to a safe positive multiplier.
     * @param value - `zoom` prop (1 = fit width).
     * @returns finite zoom in `[0.1, 8]`.
     */
    function normalizeZoom(value) {
      const zoom = Number(value);
      if (!Number.isFinite(zoom) || zoom <= 0) return 1;
      return Math.min(8, Math.max(0.1, zoom));
    }

    /**
     * Read the device pixel ratio, capped so canvases stay allocatable.
     * @returns ratio in `[1, 4]` (fractional ratios are possible).
     */
    function readDevicePixelRatio() {
      const value = typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1;
      if (!Number.isFinite(value) || value <= 0) return 1;
      return Math.min(4, value);
    }

    /**
     * Copy the caller's PDF bytes before PDF.js transfers them to the worker.
     * The app owns the source array and must keep using it after mount.
     * @param bytes - `bytes` prop.
     * @returns owned copy, or `null` when the value is not byte-like.
     */
    function copyPdfBytes(bytes) {
      if (bytes === null || bytes === undefined) return null;
      try {
        if (typeof Uint8Array !== 'undefined' && bytes instanceof Uint8Array) return new Uint8Array(bytes);
        if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(bytes)) {
          return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }
      } catch (error) {
        console.warn('[dsh-paper-reader] PDF bytes could not be copied', error);
      }
      return null;
    }

    /**
     * Clamp a value into `[0, 1]` for normalized selection rectangles.
     * @param value - raw value.
     * @returns clamped value.
     */
    function clampNormalized(value) {
      if (!Number.isFinite(value)) return 0;
      if (value < 0) return 0;
      if (value > 1) return 1;
      return value;
    }

    /**
     * Normalize selected text: stable newlines, no NBSP, trimmed edges.
     * @param raw - `selection.toString()` output.
     * @returns normalized selection text.
     */
    function normalizeSelectionText(raw) {
      if (typeof raw !== 'string') return '';
      return raw.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    /**
     * Locate the page number a DOM node belongs to, requiring the node to be
     * inside a page's text layer (so selections outside text are ignored).
     * @param node - selection anchor/focus node.
     * @returns 1-based page number, or `0` when the node is not page text.
     */
    function pageNumberForNode(node) {
      if (node === null || node === undefined) return 0;
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (element === null || element === undefined) return 0;
      if (typeof element.closest !== 'function') return 0;
      const textHost = element.closest('.dpr-v-text-host');
      const pageElement = element.closest('.dpr-v-page');
      if (textHost === null || pageElement === null) return 0;
      if (!pageElement.contains(textHost)) return 0;
      const page = Number(pageElement.getAttribute('data-page'));
      return Number.isFinite(page) && page > 0 ? page : 0;
    }

    /**
     * Stable comparison key for a reported selection, used to suppress repeat
     * callbacks for the same geometry.
     * @param payload - computed `Selection`.
     * @returns JSON signature.
     */
    function selectionSignature(payload) {
      const rects = [];
      for (let index = 0; index < payload.rects.length; index += 1) {
        const rect = payload.rects[index];
        rects.push([
          rect.page,
          Math.round(rect.x * 1000) / 1000,
          Math.round(rect.y * 1000) / 1000,
          Math.round(rect.w * 1000) / 1000,
          Math.round(rect.h * 1000) / 1000,
        ]);
      }
      const anchor = payload.anchor;
      return JSON.stringify([
        payload.page,
        payload.text,
        rects,
        [Math.round(anchor.left), Math.round(anchor.right), Math.round(anchor.top), Math.round(anchor.bottom)],
      ]);
    }

    /** Module-name cache: one PDF.js import per vendor base per page session. */
    const pdfjsLoaders = new Map();

    /**
     * Load the vendored PDF.js ES module once per vendor base and configure its
     * module Worker. A failed import is evicted so a remount can retry.
     * @param vendorBase - normalized vendor base.
     * @returns promise for the PDF.js module namespace.
     */
    function loadPdfjs(vendorBase) {
      const base = normalizeVendorBase(vendorBase);
      const cached = pdfjsLoaders.get(base);
      if (cached !== undefined) return cached;
      const pending = import(base + 'pdf.mjs').then((pdfjs) => {
        try {
          pdfjs.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.mjs';
        } catch (error) {
          console.warn('[dsh-paper-reader] PDF.js worker could not be configured', error);
        }
        return pdfjs;
      });
      pdfjsLoaders.set(base, pending);
      pending.catch(() => {
        if (pdfjsLoaders.get(base) === pending) pdfjsLoaders.delete(base);
      });
      return pending;
    }

    /**
     * Classify a fatal document-load failure for the localized error block.
     * @param error - thrown value from `getDocument`/its promise.
     * @returns `{ kind, message? }` descriptor.
     */
    function describeLoadFailure(error) {
      const name = error !== null && error !== undefined && typeof error.name === 'string' ? error.name : '';
      if (name === 'InvalidPDFException' || name === 'MissingPDFException') return { kind: 'invalid' };
      if (name === 'PasswordException') return { kind: 'password' };
      if (name === 'AbortException') return { kind: 'aborted' };
      const message =
        error !== null && error !== undefined && typeof error.message === 'string' && error.message !== ''
          ? error.message
          : String(error === null || error === undefined ? '' : error);
      if (message === 'missing-pdf-bytes') return { kind: 'invalid' };
      return { kind: 'message', message: truncate(message, 400) };
    }

    /**
     * Measure the real page size of the remaining pages in the background so
     * placeholders keep the document's aspect ratio before a canvas arrives.
     * The returned array is merged into state without overwriting page sizes
     * the viewer already measured on screen.
     * @param documentProxy - loaded PDF document.
     * @param pageCount - document page count.
     * @param fallbackSize - page-1 size used for the initial estimate.
     * @param isDisposed - returns whether the owning effect is gone.
     * @returns exact sizes array, or `undefined` when nothing could be measured.
     */
    async function measureRemainingPages(documentProxy, pageCount, fallbackSize, isDisposed) {
      const limit = Math.min(pageCount, MAX_MEASURED_PAGES);
      if (limit < 2) return undefined;
      const exact = new Array(pageCount);
      for (let index = 0; index < pageCount; index += 1) exact[index] = fallbackSize;
      let changed = false;
      for (let pageNumber = 2; pageNumber <= limit; pageNumber += 1) {
        if (isDisposed()) return undefined;
        try {
          const page = await documentProxy.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          if (!(viewport.width > 0) || !(viewport.height > 0)) continue;
          const current = exact[pageNumber - 1];
          if (
            current === null ||
            current === undefined ||
            Math.abs(current.width - viewport.width) > 0.05 ||
            Math.abs(current.height - viewport.height) > 0.05
          ) {
            exact[pageNumber - 1] = { width: viewport.width, height: viewport.height };
            changed = true;
          }
        } catch (error) {
          /* Keep the page-1 estimate for this page; rendering will correct it. */
        }
      }
      if (!changed || isDisposed()) return undefined;
      return exact;
    }

    /** Viewer stylesheet: theme tokens for chrome, PDF neutrals for the sheet. */
    const STYLE_CSS = `
.dpr-v-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font-family:var(--dsw-font,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f2328);}
.dpr-v-root *,.dpr-v-root *::before,.dpr-v-root *::after{box-sizing:border-box;}
.dpr-v-scrollport{position:relative;flex:1;min-height:0;overflow:auto;background:var(--dsw-alias-bg-document-preview,#eceef1);overscroll-behavior:contain;}
html[data-theme="dark"] .dpr-v-scrollport,body[data-ds-dark-theme] .dpr-v-scrollport{background:var(--dsw-alias-bg-document-preview,#0d0d0d);}
.dpr-v-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:100%;padding:24px;color:var(--dsw-alias-label-secondary,#5b6470);font-size:13px;text-align:center;}
.dpr-v-status-text{max-width:320px;}
.dpr-v-spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3,#d5d9de);border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dpr-v-spin .8s linear infinite;}
@keyframes dpr-v-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dpr-v-spinner{animation-duration:2.4s}}
.dpr-v-error{display:flex;flex-direction:column;gap:8px;max-width:360px;margin:32px auto;padding:16px;border:1px solid var(--dsw-alias-border-l2,#dfe3e8);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 1px 2px rgba(15,23,42,.06);}
.dpr-v-error-title{font-size:13px;font-weight:600;color:var(--dsw-alias-state-error-primary,#c9353f);}
.dpr-v-error-reason{font-size:13px;color:var(--dsw-alias-label-secondary,#5b6470);word-break:break-word;}
.dpr-v-error-detail{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b939c);word-break:break-word;}
.dpr-v-stack{display:flex;flex-direction:column;align-items:center;gap:${GAP}px;width:max-content;min-width:100%;padding:${INSET}px;}
.dpr-v-page{position:relative;flex:0 0 auto;overflow:hidden;border-radius:2px;background:${PAGE_BACKGROUND};--scale-round-x:1px;--scale-round-y:1px;box-shadow:0 1px 2px rgba(15,23,42,.16),0 5px 18px rgba(15,23,42,.12);}
html[data-theme="dark"] .dpr-v-page,body[data-ds-dark-theme] .dpr-v-page{box-shadow:0 1px 2px rgba(0,0,0,.5),0 6px 22px rgba(0,0,0,.45);}
.dpr-v-canvas{position:absolute;top:0;left:0;z-index:0;display:block;width:100%;height:100%;}
.dpr-v-text-host{position:absolute;inset:0;z-index:1;}
.dpr-v-overlay{position:absolute;inset:0;z-index:2;pointer-events:none;}
.dpr-v-placeholder{position:absolute;inset:0;z-index:3;background:var(--dsw-alias-bg-skeleton,#e3e6ea);animation:dpr-v-pulse 1.8s ease-in-out infinite;}
html[data-theme="dark"] .dpr-v-placeholder,body[data-ds-dark-theme] .dpr-v-placeholder{background:var(--dsw-alias-bg-skeleton,#232323);}
@keyframes dpr-v-pulse{0%,100%{opacity:1}50%{opacity:.72}}
@media (prefers-reduced-motion: reduce){.dpr-v-placeholder{animation:none}}
.dpr-v-page-note{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:16px;text-align:center;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-secondary,#5b6470);font-size:13px;}
.dpr-v-page-note-hint{color:var(--dsw-alias-label-tertiary,#8b939c);font-size:12px;}
/* PDF.js v6 text layer geometry (required by TextLayer; scoped to this viewer). */
.dpr-v-page .textLayer{position:absolute;inset:0;overflow:clip;text-align:initial;line-height:1;letter-spacing:normal;word-spacing:normal;-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText;z-index:0;}
.dpr-v-page .textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;user-select:text;}
.dpr-v-page .textLayer > :not(.markedContent),.dpr-v-page .textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor)*var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));}
.dpr-v-page .textLayer .markedContent{display:contents;}
.dpr-v-page .textLayer{--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size));--min-font-size-inv:calc(1/var(--min-font-size));}
.dpr-v-page .textLayer ::selection{background:rgba(64,120,255,.28);color:transparent;}
.dpr-v-page .textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none;}
.dpr-v-page .textLayer.selecting .endOfContent{top:0;}
`;

    /**
     * One PDF page: placeholder, canvas, selectable text layer and the app's
     * overlay. Renders lazily near the viewport and discards far-away bitmaps.
     */
    function PdfPageView(props) {
      const { doc, pdfjs, pageNumber, pageDims, pageCssWidth, dpr, lang, overlay, scrollRootRef, registerPageEl, onMeasured } = props;

      const pageRef = React.useRef(null);
      const canvasRef = React.useRef(null);
      const textHostRef = React.useRef(null);
      const mountedRef = React.useRef(true);
      const renderRef = React.useRef({ gen: 0, task: null, textLayer: null, key: '', queue: Promise.resolve(), measured: null });
      const [near, setNear] = React.useState(false);
      const [rendered, setRendered] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const [measured, setMeasured] = React.useState(null);

      const cssWidth = Math.max(1, pageCssWidth);
      const ratio =
        measured !== null && measured.width > 0
          ? measured.height / measured.width
          : pageDims !== null && pageDims !== undefined && pageDims.width > 0
            ? pageDims.height / pageDims.width
            : FALLBACK_RATIO;
      const cssHeight = Math.max(1, cssWidth * ratio);

      /** Register/unregister this page's shell with the viewer for selection math. */
      const setPageElement = React.useCallback(
        (element) => {
          pageRef.current = element;
          registerPageEl(pageNumber, element);
        },
        [pageNumber, registerPageEl],
      );

      /** Cancel the in-flight render task and wait for PDF.js to release its canvas. */
      function cancelRenderTask() {
        const state = renderRef.current;
        const task = state.task;
        if (task === null) return Promise.resolve();
        state.task = null;
        try {
          task.cancel();
        } catch (error) {
          /* already settled */
        }
        return Promise.resolve(task.promise).catch(() => undefined);
      }

      /** Cancel the text layer (if any) and empty its host element. */
      function disposeTextLayer() {
        const state = renderRef.current;
        const layer = state.textLayer;
        state.textLayer = null;
        if (layer !== null) {
          try {
            layer.cancel();
          } catch (error) {
            /* already cancelled */
          }
        }
        if (textHostRef.current !== null) textHostRef.current.replaceChildren();
      }

      /** Discard this page's bitmap + text layer but keep its place in the stack. */
      async function discardBitmap() {
        const state = renderRef.current;
        if (!mountedRef.current) return;
        state.gen += 1;
        await cancelRenderTask();
        disposeTextLayer();
        state.key = '';
        state.measured = null;
        const canvas = canvasRef.current;
        if (canvas !== null) {
          canvas.width = 0;
          canvas.height = 0;
        }
        if (mountedRef.current) setRendered(false);
      }

      /**
       * Build the selectable text layer for one already-rendered page.
       * @param page - PDF.js page proxy.
       * @param viewport - the same viewport the canvas was rendered at.
       * @param gen - render generation this build belongs to.
       */
      async function buildTextLayer(page, viewport, gen) {
        const state = renderRef.current;
        const host = textHostRef.current;
        if (host === null) return;
        disposeTextLayer();
        if (state.gen !== gen || !mountedRef.current) return;
        const container = document.createElement('div');
        container.className = 'textLayer dpr-v-textLayer';
        container.style.setProperty('--total-scale-factor', String(viewport.scale));
        try {
          pdfjs.setLayerDimensions(container, viewport);
        } catch (error) {
          /* Fall back to the CSS inset:0 stretch from the stylesheet. */
        }
        let layer;
        try {
          layer = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
            container,
            viewport,
          });
        } catch (error) {
          console.warn('[dsh-paper-reader] text layer could not start', pageNumber, error);
          return;
        }
        state.textLayer = layer;
        host.replaceChildren(container);
        try {
          await layer.render();
        } catch (error) {
          if (state.gen !== gen || !mountedRef.current) return;
          if (error !== null && error !== undefined && error.name === 'AbortException') return;
          console.warn('[dsh-paper-reader] text layer failed', pageNumber, error);
          return;
        }
        if (state.gen !== gen || !mountedRef.current) return;
        const endOfContent = document.createElement('div');
        endOfContent.className = 'endOfContent';
        container.append(endOfContent);
      }

      /**
       * Render the page bitmap and text layer at the current fit/zoom scale.
       * @param gen - render generation this run belongs to.
       */
      async function performRender(gen) {
        const state = renderRef.current;
        if (!mountedRef.current || state.gen !== gen) return;
        let page;
        try {
          page = await doc.getPage(pageNumber);
        } catch (error) {
          if (state.gen === gen && mountedRef.current) setFailed(true);
          return;
        }
        if (state.gen !== gen || !mountedRef.current) return;
        let baseViewport;
        try {
          baseViewport = page.getViewport({ scale: 1 });
        } catch (error) {
          if (state.gen === gen && mountedRef.current) setFailed(true);
          return;
        }
        if (!(baseViewport.width > 0) || !(baseViewport.height > 0)) {
          if (state.gen === gen && mountedRef.current) setFailed(true);
          return;
        }
        const scale = pageCssWidth / baseViewport.width;
        let viewport;
        try {
          viewport = page.getViewport({ scale });
        } catch (error) {
          if (state.gen === gen && mountedRef.current) setFailed(true);
          return;
        }
        const key = `${scale.toFixed(5)}|${dpr}|${baseViewport.width.toFixed(2)}x${baseViewport.height.toFixed(2)}`;
        if (state.key === key && state.textLayer !== null) return;
        const canvas = canvasRef.current;
        if (canvas === null) return;
        await cancelRenderTask();
        if (state.gen !== gen || !mountedRef.current) return;

        let outputScale = dpr;
        const pixelArea = viewport.width * viewport.height * outputScale * outputScale;
        if (pixelArea > MAX_CANVAS_PIXELS) {
          outputScale = Math.max(0.5, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
        }
        const pixelWidth = Math.max(1, Math.floor(viewport.width * outputScale));
        const pixelHeight = Math.max(1, Math.floor(viewport.height * outputScale));
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

        let task;
        try {
          task = page.render({
            canvas,
            viewport,
            transform: [outputScale, 0, 0, outputScale, 0, 0],
          });
        } catch (error) {
          if (state.gen === gen && mountedRef.current) setFailed(true);
          return;
        }
        state.task = task;
        try {
          await task.promise;
        } catch (error) {
          if (state.task === task) state.task = null;
          if (state.gen !== gen || !mountedRef.current) return;
          if (error !== null && error !== undefined && error.name === 'RenderingCancelledException') return;
          console.warn('[dsh-paper-reader] page render failed', pageNumber, error);
          setFailed(true);
          return;
        }
        if (state.task === task) state.task = null;
        if (state.gen !== gen || !mountedRef.current) return;

        const baseSize = { width: baseViewport.width, height: baseViewport.height };
        const previous = state.measured;
        if (
          previous === null ||
          Math.abs(previous.width - baseSize.width) > 0.05 ||
          Math.abs(previous.height - baseSize.height) > 0.05
        ) {
          state.measured = baseSize;
          setMeasured(baseSize);
        }
        try {
          onMeasured(pageNumber, baseSize);
        } catch (error) {
          console.warn('[dsh-paper-reader] page measurement callback failed', error);
        }
        await buildTextLayer(page, viewport, gen);
        if (state.gen !== gen || !mountedRef.current) return;
        state.key = key;
        setFailed(false);
        setRendered(true);
      }

      /** Serialize render work per page so one canvas never has two render tasks. */
      function queueRender(gen) {
        const state = renderRef.current;
        const run = () => {
          if (!mountedRef.current || state.gen !== gen) return undefined;
          return performRender(gen);
        };
        state.queue = state.queue.then(run, run).catch((error) => {
          console.warn('[dsh-paper-reader] page render queue failed', pageNumber, error);
        });
      }

      // Lazy rendering: only pages near the scrollport get a bitmap.
      React.useEffect(() => {
        const element = pageRef.current;
        const root = scrollRootRef.current;
        if (element === null || typeof IntersectionObserver !== 'function') {
          setNear(true);
          return undefined;
        }
        const observer = new IntersectionObserver(
          (entries) => {
            for (let index = 0; index < entries.length; index += 1) {
              if (entries[index].isIntersecting) {
                setNear(true);
                return;
              }
            }
            setNear(false);
          },
          { root: root === undefined ? null : root, rootMargin: RENDER_MARGIN_PX + 'px 0px' },
        );
        observer.observe(element);
        return () => observer.disconnect();
      }, [scrollRootRef]);

      // Offscreen pages release their bitmap after a short delay; the shell and
      // its aspect ratio stay so the scroll position does not jump.
      React.useEffect(() => {
        if (near) return undefined;
        const timer = setTimeout(() => {
          void discardBitmap();
        }, DISPOSE_DELAY_MS);
        return () => clearTimeout(timer);
      }, [near]);

      // Redraw on zoom/size changes while near the viewport.
      React.useEffect(() => {
        if (!near || doc === null || pdfjs === null || !(pageCssWidth > 0)) return undefined;
        const state = renderRef.current;
        const gen = state.gen + 1;
        state.gen = gen;
        const timer = setTimeout(() => queueRender(gen), ZOOM_SETTLE_MS);
        return () => {
          clearTimeout(timer);
          if (state.gen === gen) state.gen = gen + 1;
          void cancelRenderTask();
        };
      }, [near, doc, pdfjs, pageCssWidth, dpr]);

      // Free everything on unmount.
      React.useEffect(
        () => () => {
          mountedRef.current = false;
          const state = renderRef.current;
          state.gen += 1;
          const task = state.task;
          state.task = null;
          if (task !== null) {
            try {
              task.cancel();
            } catch (error) {
              /* already settled */
            }
          }
          disposeTextLayer();
          const canvas = canvasRef.current;
          if (canvas !== null) {
            canvas.width = 0;
            canvas.height = 0;
          }
          registerPageEl(pageNumber, null);
        },
        [pageNumber, registerPageEl],
      );

      return h(
        'div',
        {
          className: 'dpr-v-page' + (rendered ? ' dpr-v-page--rendered' : '') + (failed ? ' dpr-v-page--failed' : ''),
          'data-page': pageNumber,
          style: { width: cssWidth + 'px', height: cssHeight + 'px' },
          ref: setPageElement,
          role: 'group',
          'aria-label': tr(lang, 'ariaLabel') + ' ' + pageNumber,
        },
        h('canvas', { className: 'dpr-v-canvas', ref: canvasRef, 'aria-hidden': 'true' }),
        h('div', { className: 'dpr-v-text-host', ref: textHostRef }),
        overlay === null || overlay === undefined ? null : h('div', { className: 'dpr-v-overlay' }, overlay),
        !rendered && !failed ? h('div', { className: 'dpr-v-placeholder', 'aria-hidden': 'true' }) : null,
        failed
          ? h(
              'div',
              { className: 'dpr-v-page-note', role: 'status' },
              h('span', null, tr(lang, 'pageError')),
              h('span', { className: 'dpr-v-page-note-hint' }, tr(lang, 'pageErrorHint')),
            )
          : null,
      );
    }

    /**
     * The PDF viewer: owns PDF.js loading, page layout and selection reporting.
     * @param props - `PdfViewer` props from docs/INTERFACES.md §1.
     * @returns the viewer element tree.
     */
    function PdfViewer(props) {
      const { bytes, apiRef, className, renderPageOverlay } = props;
      const vendorBase = normalizeVendorBase(props.vendorBase);
      const lang = props.lang === 'zh' ? 'zh' : 'en';
      const zoom = normalizeZoom(props.zoom);

      const [status, setStatus] = React.useState('loading');
      const [documentProxy, setDocumentProxy] = React.useState(null);
      const [pdfjsLib, setPdfjsLib] = React.useState(null);
      const [numPages, setNumPages] = React.useState(0);
      const [dims, setDims] = React.useState([]);
      const [errorInfo, setErrorInfo] = React.useState(null);
      const [innerWidth, setInnerWidth] = React.useState(0);
      const [dpr, setDpr] = React.useState(readDevicePixelRatio);

      const rootRef = React.useRef(null);
      const scrollRef = React.useRef(null);
      const pageElsRef = React.useRef([]);
      const layoutRef = React.useRef({ pages: [], totalHeight: 0 });
      const callbacksRef = React.useRef({});
      const handlersRef = React.useRef({});
      const reportedSelectionRef = React.useRef(null);
      const reportedSignatureRef = React.useRef(null);
      const currentPageRef = React.useRef(0);
      const mountedRef = React.useRef(true);

      // Deterministic page layout (stack coordinates) for scroll/selection math.
      const layout = React.useMemo(() => {
        const pages = [];
        let top = INSET;
        const width = innerWidth > 0 ? innerWidth * zoom : 0;
        for (let index = 0; index < numPages; index += 1) {
          const size = dims[index];
          const ratio =
            size !== null && size !== undefined && size.width > 0 ? size.height / size.width : FALLBACK_RATIO;
          const height = width > 0 ? width * ratio : 0;
          pages.push({ page: index + 1, top, height });
          top += height + GAP;
        }
        return { pages, totalHeight: pages.length === 0 ? 0 : top - GAP + INSET };
      }, [dims, innerWidth, numPages, zoom]);

      /** Keep page shells registered in order for selection geometry queries. */
      const registerPageEl = React.useCallback((pageNumber, element) => {
        const elements = pageElsRef.current;
        if (element === null || element === undefined) {
          if (elements.length >= pageNumber) elements[pageNumber - 1] = null;
          return;
        }
        elements[pageNumber - 1] = element;
      }, []);

      /** A render measured its real page size: correct the placeholder ratio. */
      const onMeasured = React.useCallback((pageNumber, size) => {
        setDims((previous) => {
          const index = pageNumber - 1;
          if (index < 0 || index >= previous.length) return previous;
          const current = previous[index];
          if (
            current !== null &&
            current !== undefined &&
            Math.abs(current.width - size.width) < 0.25 &&
            Math.abs(current.height - size.height) < 0.25
          ) {
            return previous;
          }
          const next = previous.slice();
          next[index] = { width: size.width, height: size.height };
          return next;
        });
      }, []);

      // Latest props for event handlers/effects that run outside render.
      React.useEffect(() => {
        layoutRef.current = layout;
        callbacksRef.current = {
          onDocumentReady: props.onDocumentReady,
          onPageChange: props.onPageChange,
          onSelection: props.onSelection,
        };
        handlersRef.current = {
          updateCurrentPage,
          reportSelection,
          refreshSelectionForScroll,
          clearTextSelection: clearTextSelectionImpl,
          scrollToPage: scrollToPageImpl,
        };
      });

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      // Load PDF.js + the document when the bytes or the vendor base change.
      React.useEffect(() => {
        let disposed = false;
        let loadingTask = null;
        pageElsRef.current = [];
        reportedSelectionRef.current = null;
        reportedSignatureRef.current = null;
        currentPageRef.current = 0;
        setStatus('loading');
        setDocumentProxy(null);
        setPdfjsLib(null);
        setNumPages(0);
        setDims([]);
        setErrorInfo(null);

        const load = async () => {
          if (bytes === null || bytes === undefined || (typeof bytes.byteLength === 'number' && bytes.byteLength === 0)) {
            throw new Error('missing-pdf-bytes');
          }
          const pdfjs = await loadPdfjs(vendorBase);
          if (disposed) return;
          const data = copyPdfBytes(bytes);
          if (data === null) throw new Error('missing-pdf-bytes');
          loadingTask = pdfjs.getDocument({
            data,
            cMapUrl: vendorBase + 'cmaps/',
            cMapPacked: true,
            standardFontDataUrl: vendorBase + 'standard_fonts/',
            wasmUrl: vendorBase + 'wasm/',
            iccUrl: vendorBase + 'iccs/',
            useSystemFonts: true,
          });
          const loaded = await loadingTask.promise;
          if (disposed) {
            try {
              await loaded.destroy();
            } catch (error) {
              /* already destroyed */
            }
            return;
          }
          const pageCount = loaded.numPages;
          let firstSize = null;
          if (pageCount > 0) {
            try {
              const firstPage = await loaded.getPage(1);
              const firstViewport = firstPage.getViewport({ scale: 1 });
              if (firstViewport.width > 0 && firstViewport.height > 0) {
                firstSize = { width: firstViewport.width, height: firstViewport.height };
              }
            } catch (error) {
              console.warn('[dsh-paper-reader] page 1 size unavailable', error);
            }
          }
          if (disposed) return;
          const estimated = new Array(pageCount);
          for (let index = 0; index < pageCount; index += 1) estimated[index] = firstSize;
          setPdfjsLib(pdfjs);
          setDocumentProxy(loaded);
          setNumPages(pageCount);
          setDims(estimated);
          setStatus('ready');
          const callbacks = callbacksRef.current;
          if (typeof callbacks.onDocumentReady === 'function') {
            try {
              callbacks.onDocumentReady({ numPages: pageCount });
            } catch (error) {
              console.warn('[dsh-paper-reader] onDocumentReady failed', error);
            }
          }
          void measureRemainingPages(loaded, pageCount, firstSize, () => disposed)
            .then((exact) => {
              if (disposed || exact === undefined) return;
              setDims((previous) => {
                if (previous.length !== exact.length) return previous;
                const next = previous.slice();
                for (let index = 0; index < next.length; index += 1) {
                  const current = next[index];
                  const isEstimate =
                    firstSize !== null &&
                    current !== null &&
                    current !== undefined &&
                    Math.abs(current.width - firstSize.width) < 0.05 &&
                    Math.abs(current.height - firstSize.height) < 0.05;
                  const isEmpty = current === null || current === undefined;
                  if ((isEstimate || isEmpty) && exact[index] !== null && exact[index] !== undefined) {
                    next[index] = exact[index];
                  }
                }
                return next;
              });
            })
            .catch((error) => {
              console.warn('[dsh-paper-reader] page measurement failed', error);
            });
        };

        load().catch((error) => {
          if (disposed) return;
          console.warn('[dsh-paper-reader] PDF load failed', error);
          setStatus('error');
          setErrorInfo(describeLoadFailure(error));
        });

        return () => {
          disposed = true;
          if (loadingTask !== null) {
            try {
              Promise.resolve(loadingTask.destroy()).catch(() => undefined);
            } catch (error) {
              /* already destroyed */
            }
          }
        };
      }, [bytes, vendorBase]);

      // Fit-width input: track the scrollport's content width.
      React.useEffect(() => {
        const scrollport = scrollRef.current;
        if (scrollport === null) return undefined;
        const measure = () => {
          const width = scrollport.clientWidth - INSET * 2;
          setInnerWidth(width > 0 ? width : 0);
        };
        measure();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure);
          observer.observe(scrollport);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, []);

      // Device pixel ratio changes (window moved between displays).
      React.useEffect(() => {
        const update = () => setDpr(readDevicePixelRatio());
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
      }, []);

      // Selection reporting listeners on the scrollport and the document.
      React.useEffect(() => {
        const scrollport = scrollRef.current;
        if (scrollport === null) return undefined;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const listenerOptions = controller !== null ? { signal: controller.signal } : undefined;
        let timer = 0;
        const flush = () => {
          timer = 0;
          const handlers = handlersRef.current;
          if (typeof handlers.reportSelection === 'function') handlers.reportSelection();
        };
        const schedule = () => {
          if (timer !== 0) clearTimeout(timer);
          timer = setTimeout(flush, SELECTION_DEBOUNCE_MS);
        };
        const flushNow = () => {
          if (timer !== 0) {
            clearTimeout(timer);
            timer = 0;
          }
          flush();
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          const handlers = handlersRef.current;
          if (typeof handlers.clearTextSelection === 'function') handlers.clearTextSelection();
        };
        scrollport.addEventListener('pointerup', flushNow, listenerOptions);
        scrollport.addEventListener('mouseup', flushNow, listenerOptions);
        document.addEventListener('selectionchange', schedule, listenerOptions);
        document.addEventListener('keydown', onKeyDown, listenerOptions);
        return () => {
          if (timer !== 0) clearTimeout(timer);
          if (controller !== null) {
            controller.abort();
          } else {
            scrollport.removeEventListener('pointerup', flushNow);
            scrollport.removeEventListener('mouseup', flushNow);
            document.removeEventListener('selectionchange', schedule);
            document.removeEventListener('keydown', onKeyDown);
          }
        };
      }, []);

      // Scroll: current page + selection anchor visibility, rAF-throttled.
      React.useEffect(() => {
        const scrollport = scrollRef.current;
        if (scrollport === null) return undefined;
        let frame = 0;
        const onScroll = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            const handlers = handlersRef.current;
            if (typeof handlers.updateCurrentPage === 'function') handlers.updateCurrentPage();
            if (typeof handlers.refreshSelectionForScroll === 'function') handlers.refreshSelectionForScroll();
          });
        };
        scrollport.addEventListener('scroll', onScroll, { passive: true });
        return () => {
          scrollport.removeEventListener('scroll', onScroll);
          if (frame !== 0) cancelAnimationFrame(frame);
        };
      }, []);

      // Report the page nearest the top once a document is laid out.
      React.useEffect(() => {
        if (status !== 'ready' || numPages === 0) return;
        const handlers = handlersRef.current;
        if (typeof handlers.updateCurrentPage === 'function') handlers.updateCurrentPage();
      }, [status, numPages, layout]);

      // Imperative API handed to the app through `apiRef`.
      React.useEffect(() => {
        if (apiRef === null || apiRef === undefined || typeof apiRef !== 'object') return undefined;
        const api = {
          scrollToPage(page) {
            const handlers = handlersRef.current;
            if (typeof handlers.scrollToPage === 'function') handlers.scrollToPage(page);
          },
          clearTextSelection() {
            const handlers = handlersRef.current;
            if (typeof handlers.clearTextSelection === 'function') handlers.clearTextSelection();
          },
        };
        apiRef.current = api;
        return () => {
          if (apiRef.current === api) apiRef.current = null;
        };
      }, [apiRef]);

      /** Report the page nearest the top of the scrollport, once per change. */
      function updateCurrentPage() {
        const scrollport = scrollRef.current;
        if (scrollport === null) return;
        const pages = layoutRef.current.pages;
        if (pages.length === 0) return;
        const scrollTop = scrollport.scrollTop;
        // A few px below the edge covers the stack inset; on a page boundary the
        // nearest page top also wins, so programmatic scrollToPage always reports
        // the page it moved to even when the browser rounds the scroll offset.
        const probe = scrollTop + 8;
        let page = 1;
        let bestDistance = Infinity;
        for (let index = 0; index < pages.length; index += 1) {
          const entry = pages[index];
          if (probe >= entry.top && probe < entry.top + entry.height) {
            page = entry.page;
            bestDistance = 0;
            break;
          }
          const distance = Math.abs(entry.top - scrollTop);
          if (distance < bestDistance) {
            bestDistance = distance;
            page = entry.page;
          }
        }
        if (page === currentPageRef.current) return;
        currentPageRef.current = page;
        const callbacks = callbacksRef.current;
        if (typeof callbacks.onPageChange === 'function') {
          try {
            callbacks.onPageChange(page);
          } catch (error) {
            console.warn('[dsh-paper-reader] onPageChange failed', error);
          }
        }
      }

      /** Scroll one page to the top of the scrollport (apiRef helper). */
      function scrollToPageImpl(requested) {
        const scrollport = scrollRef.current;
        const pages = layoutRef.current.pages;
        if (scrollport === null || pages.length === 0) return;
        const target = Number(requested);
        if (!Number.isFinite(target)) return;
        const index = Math.min(pages.length - 1, Math.max(0, Math.round(target) - 1));
        const top = Math.max(0, pages[index].top - 8);
        try {
          scrollport.scrollTo({ top, behavior: 'auto' });
        } catch (error) {
          scrollport.scrollTop = top;
        }
      }

      /** Clear the native selection when it belongs to this viewer. */
      function clearTextSelectionImpl() {
        const selection = window.getSelection();
        if (selection !== null && selection !== undefined && selection.rangeCount > 0) {
          try {
            const range = selection.getRangeAt(0);
            const root = rootRef.current;
            if (root !== null && (root.contains(range.startContainer) || root.contains(range.endContainer))) {
              selection.removeAllRanges();
            }
          } catch (error) {
            /* a stale range can throw; clearing the reported state still works */
          }
        }
        clearReportedSelection();
      }

      /** Notify the app that the viewer-owned selection is gone (once). */
      function clearReportedSelection() {
        if (reportedSelectionRef.current === null) return;
        reportedSelectionRef.current = null;
        reportedSignatureRef.current = null;
        const callbacks = callbacksRef.current;
        if (typeof callbacks.onSelection === 'function') {
          try {
            callbacks.onSelection(null);
          } catch (error) {
            console.warn('[dsh-paper-reader] onSelection failed', error);
          }
        }
      }

      /**
       * Compute the frozen `Selection` payload from the current DOM selection.
       * @returns payload, or `null` when there is no viewer-owned selection.
       */
      function computeSelectionPayload() {
        const scrollport = scrollRef.current;
        const root = rootRef.current;
        if (scrollport === null || root === null) return null;
        const selection = window.getSelection();
        if (selection === null || selection === undefined || selection.isCollapsed || selection.rangeCount === 0) return null;
        const pageEls = pageElsRef.current;
        if (pageEls.length === 0) return null;
        const range = selection.getRangeAt(0);
        if (pageNumberForNode(selection.anchorNode) === 0 || pageNumberForNode(selection.focusNode) === 0) return null;
        const text = normalizeSelectionText(selection.toString());
        if (text === '') return null;
        const scrollRect = scrollport.getBoundingClientRect();
        const scrollTop = scrollport.scrollTop;
        const layoutPages = layoutRef.current.pages;

        // Candidate pages: only those overlapping the selection's bounding box
        // (plus one neighbour for estimates that are not exact yet).
        let firstCandidate = -1;
        let lastCandidate = -1;
        if (layoutPages.length === pageEls.length) {
          const bound = range.getBoundingClientRect();
          const docTop = bound.top - scrollRect.top + scrollTop;
          const docBottom = bound.bottom - scrollRect.top + scrollTop;
          for (let index = 0; index < layoutPages.length; index += 1) {
            const entry = layoutPages[index];
            if (entry.top + entry.height >= docTop - 2 && entry.top <= docBottom + 2) {
              if (firstCandidate < 0) firstCandidate = index;
              lastCandidate = index;
            }
          }
        }
        if (firstCandidate < 0) {
          firstCandidate = 0;
          lastCandidate = pageEls.length - 1;
        } else {
          firstCandidate = Math.max(0, firstCandidate - 1);
          lastCandidate = Math.min(pageEls.length - 1, lastCandidate + 1);
        }

        const canvasRects = range.getClientRects();
        const rects = [];
        let anchor = null;
        const pageRects = new Map();
        const pageRectOf = (page) => {
          if (pageRects.has(page)) return pageRects.get(page);
          const element = pageEls[page - 1];
          const rect = element === null || element === undefined ? null : element.getBoundingClientRect();
          pageRects.set(page, rect);
          return rect;
        };

        for (let rectIndex = 0; rectIndex < canvasRects.length; rectIndex += 1) {
          const rect = canvasRects[rectIndex];
          if (!(rect.width > 0) || !(rect.height > 0)) continue;
          // The menu anchor is the last client rect still visible in the scrollport.
          const anchorLeft = Math.max(rect.left, scrollRect.left);
          const anchorRight = Math.min(rect.right, scrollRect.right);
          const anchorTop = Math.max(rect.top, scrollRect.top);
          const anchorBottom = Math.min(rect.bottom, scrollRect.bottom);
          if (anchorRight - anchorLeft > 0.5 && anchorBottom - anchorTop > 0.5) {
            anchor = { left: anchorLeft, right: anchorRight, top: anchorTop, bottom: anchorBottom };
          }
          for (let page = firstCandidate + 1; page <= lastCandidate + 1; page += 1) {
            const pageRect = pageRectOf(page);
            if (pageRect === null || pageRect === undefined) continue;
            if (rect.bottom <= pageRect.top + 0.25 || rect.top >= pageRect.bottom - 0.25) continue;
            if (rect.right <= pageRect.left + 0.25 || rect.left >= pageRect.right - 0.25) continue;
            const left = Math.max(rect.left, pageRect.left);
            const right = Math.min(rect.right, pageRect.right);
            const top = Math.max(rect.top, pageRect.top);
            const bottom = Math.min(rect.bottom, pageRect.bottom);
            const width = right - left;
            const height = bottom - top;
            if (!(width > 0) || !(height > 0)) continue;
            if (!(pageRect.width > 0) || !(pageRect.height > 0)) continue;
            rects.push({
              page,
              x: clampNormalized((left - pageRect.left) / pageRect.width),
              y: clampNormalized((top - pageRect.top) / pageRect.height),
              w: clampNormalized(width / pageRect.width),
              h: clampNormalized(height / pageRect.height),
            });
          }
        }
        if (anchor === null || rects.length === 0) return null;
        const page = rects[0].page;
        return { text, page, rects, anchor };
      }

      /** Recompute and publish the selection (deduplicated). */
      function reportSelection() {
        if (!mountedRef.current) return;
        const payload = computeSelectionPayload();
        const callbacks = callbacksRef.current;
        if (payload === null) {
          clearReportedSelection();
          return;
        }
        const signature = selectionSignature(payload);
        if (signature === reportedSignatureRef.current) return;
        reportedSelectionRef.current = payload;
        reportedSignatureRef.current = signature;
        if (typeof callbacks.onSelection === 'function') {
          try {
            callbacks.onSelection(payload);
          } catch (error) {
            console.warn('[dsh-paper-reader] onSelection failed', error);
          }
        }
      }

      /** Called on scroll: refresh the anchor or clear once it leaves the viewport. */
      function refreshSelectionForScroll() {
        if (reportedSelectionRef.current === null) return;
        const scrollport = scrollRef.current;
        const selection = window.getSelection();
        if (scrollport === null || selection === null || selection === undefined || selection.rangeCount === 0) {
          clearReportedSelection();
          return;
        }
        reportSelection();
      }

      const localized = (key, params) => tr(lang, key, params);

      /** Centered loading/empty status block inside the scrollport. */
      const statusContent = (text, kind) =>
        h(
          'div',
          { className: 'dpr-v-status', ['data-viewer-' + kind]: 'true' },
          kind === 'loading' ? h('span', { className: 'dpr-v-spinner', 'aria-hidden': 'true' }) : null,
          h('span', { className: 'dpr-v-status-text', role: 'status' }, text),
        );

      let content;
      if (status === 'loading') {
        content = statusContent(localized('loading'), 'loading');
      } else if (status === 'error') {
        const info = errorInfo === null || errorInfo === undefined ? { kind: 'invalid' } : errorInfo;
        let reason = localized('loadErrorGeneric');
        if (info.kind === 'invalid') reason = localized('invalidPdf');
        else if (info.kind === 'password') reason = localized('passwordPdf');
        content = h(
          'div',
          { className: 'dpr-v-error', role: 'alert', 'data-viewer-error': 'true' },
          h('div', { className: 'dpr-v-error-title' }, localized('loadErrorTitle')),
          h('div', { className: 'dpr-v-error-reason' }, reason),
          info.kind === 'message'
            ? h('div', { className: 'dpr-v-error-detail' }, localized('loadErrorDetail', { message: info.message }))
            : null,
        );
      } else if (numPages === 0) {
        content = statusContent(localized('emptyDoc'), 'empty');
      } else if (innerWidth <= 0 || documentProxy === null || pdfjsLib === null) {
        content = statusContent(localized('loading'), 'loading');
      } else {
        const pageCssWidth = innerWidth * zoom;
        const pageNodes = [];
        for (let index = 0; index < numPages; index += 1) {
          const pageNumber = index + 1;
          const size = dims[index];
          const ratio =
            size !== null && size !== undefined && size.width > 0 ? size.height / size.width : FALLBACK_RATIO;
          let overlayNode = null;
          if (typeof renderPageOverlay === 'function') {
            try {
              overlayNode = renderPageOverlay(pageNumber, { width: pageCssWidth, height: pageCssWidth * ratio });
            } catch (error) {
              console.warn('[dsh-paper-reader] renderPageOverlay failed', pageNumber, error);
              overlayNode = null;
            }
          }
          pageNodes.push(
            h(PdfPageView, {
              key: pageNumber,
              doc: documentProxy,
              pdfjs: pdfjsLib,
              pageNumber,
              pageDims: size === undefined ? null : size,
              pageCssWidth,
              dpr,
              lang,
              overlay: overlayNode,
              scrollRootRef: scrollRef,
              registerPageEl,
              onMeasured,
            }),
          );
        }
        content = h('div', { className: 'dpr-v-stack' }, pageNodes);
      }

      return h(
        'div',
        {
          className: 'dpr-v-root' + (typeof className === 'string' && className !== '' ? ' ' + className : ''),
          ref: rootRef,
          'data-paper-reader': 'viewer',
          'data-status': status,
          'data-num-pages': String(numPages),
        },
        h('style', { dangerouslySetInnerHTML: { __html: STYLE_CSS } }),
        h(
          'div',
          { className: 'dpr-v-scrollport', ref: scrollRef, 'aria-label': localized('ariaLabel') },
          content,
        ),
      );
    }

    return { PdfViewer };
  },
});
