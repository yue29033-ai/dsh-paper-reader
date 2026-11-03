/**
 * dsh-paper-reader — application chunk (integration shell).
 *
 * Loads the three feature chunks lazily, then composes the reader:
 *   client.library.js     upload + IndexedDB paper library
 *   client.viewer.js      PDF.js page stack + selectable text layer
 *   client.annotations.js highlights, floating selection menu, notes, prompt
 *
 * Owns: library↔reader routing, zoom, floating-menu placement/clamping,
 * highlight/note/ask flows, notes panel, toasts, and the last-opened-paper
 * memory. See docs/INTERFACES.md §4.
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  chunk: 'client.app.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STRINGS = {
      zh: {
        title: '论文阅读器',
        back: '返回论文库',
        page: '第 {n} / {total} 页',
        zoomIn: '放大',
        zoomOut: '缩小',
        zoomFit: '适应宽度',
        notes: '笔记与高亮',
        highlight: '高亮',
        addNote: '添加笔记',
        ask: '在会话中提问',
        highlighted: '已高亮选中文字',
        noteSaved: '笔记已保存',
        askAdded: '提问已填入会话输入框',
        askFailed: '无法写入会话输入框，请确认当前会话可用',
        loadingPaper: '正在打开论文…',
        loadingReader: '正在加载阅读器…',
        chunkError: '阅读器组件加载失败',
        retry: '重试',
        openError: '论文读取失败',
        notesCount: '{n} 条标注',
        menuLabel: '选中文字操作',
      },
      en: {
        title: 'Paper Reader',
        back: 'Back to library',
        page: 'Page {n} / {total}',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        zoomFit: 'Fit width',
        notes: 'Notes & highlights',
        highlight: 'Highlight',
        addNote: 'Add note',
        ask: 'Ask in chat',
        highlighted: 'Highlighted the selection',
        noteSaved: 'Note saved',
        askAdded: 'Question added to the chat input',
        askFailed: 'Could not write to the chat input; check the session',
        loadingPaper: 'Opening paper…',
        loadingReader: 'Loading reader…',
        chunkError: 'Reader components failed to load',
        retry: 'Retry',
        openError: 'Could not read this paper',
        notesCount: '{n} annotations',
        menuLabel: 'Selection actions',
      },
    };

    /**
     * Translate one shell string.
     * @param lang - active UI language.
     * @param key - dictionary key.
     * @param params - `{name}` template parameters.
     * @returns localized text.
     */
    function t(lang, key, params) {
      const dict = STRINGS[lang] || STRINGS.en;
      const template = dict[key] !== undefined ? dict[key] : STRINGS.en[key] !== undefined ? STRINGS.en[key] : key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }

    /** Last-opened paper memory key prefix (per Session). */
    const LAST_PAPER_PREFIX = 'dsh-paper-reader:last-paper:v1:';

    /** One shared empty annotation store used while no paper is open (stable hooks). */
    const EMPTY_ANNOTATION_SNAPSHOT = { highlights: [], notes: [] };
    const EMPTY_STORE = {
      getSnapshot: () => EMPTY_ANNOTATION_SNAPSHOT,
      subscribe: () => () => {},
    };

    /**
     * Load the three feature chunks once per page session.
     * @returns promise of `{ viewer, annotations, library }` exports.
     */
    let chunkPromise;
    function loadChunks() {
      if (chunkPromise === undefined) {
        chunkPromise = Promise.all([
          require.async('./client.viewer.js'),
          require.async('./client.annotations.js'),
          require.async('./client.library.js'),
        ]).then(([viewer, annotations, library]) => ({ viewer, annotations, library }));
      }
      return chunkPromise;
    }

    /** Small inline icon (16px stroke glyph). */
    function Icon(props) {
      return h(
        'svg',
        {
          width: props.size || 16,
          height: props.size || 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        props.paths.map((d, i) => h('path', { key: i, d })),
      );
    }

    const ICON = {
      back: ['M10 3.5L5.5 8l4.5 4.5'],
      plus: ['M8 3.5v9M3.5 8h9'],
      minus: ['M3.5 8h9'],
      fit: ['M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3'],
      note: ['M4.5 2.5h5l2 2v9h-7z', 'M6.2 6h3.6M6.2 8.4h3.6'],
      highlight: ['M3 12.5h10', 'M5 9.5l4.8-4.8 1.5 1.5L6.5 11z', 'M8.6 3.4l1.5 1.5'],
      chat: ['M3 3.5h10v7H8l-3 2.5v-2.5H3z'],
    };

    /** Header icon button with a tooltip title. */
    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dpr-ibtn' + (props.active ? ' dpr-ibtn-active' : ''),
          title: props.label,
          'aria-label': props.label,
          disabled: props.disabled,
          onClick: props.onClick,
          'data-action': props.action,
        },
        h(Icon, { paths: props.paths, size: props.size || 16 }),
        props.badge > 0 ? h('span', { className: 'dpr-badge' }, String(props.badge)) : null,
      );
    }

    /** The reader's own stylesheet (theme tokens only). */
    function ShellStyle() {
      return h('style', {
        dangerouslySetInnerHTML: {
          __html: `
.dpr-shell{display:flex;flex-direction:column;height:100%;min-height:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
.dpr-topbar{display:flex;align-items:center;gap:6px;min-height:40px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:0 0 auto;background:var(--dsw-alias-bg-base);}
.dpr-topbar-title{flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px;}
.dpr-topbar-sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);margin-left:6px;flex:0 0 auto;}
.dpr-topbar-spacer{flex:1;}
.dpr-ibtn{appearance:none;position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;}
.dpr-ibtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dpr-ibtn:disabled{opacity:.4;cursor:default;}
.dpr-ibtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}
.dpr-ibtn-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}
.dpr-badge{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:600;}
.dpr-zoom{display:flex;align-items:center;gap:2px;flex:0 0 auto;}
.dpr-zoom-label{min-width:38px;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dpr-main{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;}
.dpr-libwrap{flex:1;min-height:0;overflow:auto;}
.dpr-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;}
.dpr-spinner{width:20px;height:20px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dpr-spin .8s linear infinite;}
@keyframes dpr-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dpr-spinner{animation-duration:2.4s}}
.dpr-errorbox{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin:16px;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}
.dpr-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;padding:7px 10px;border-radius:8px;cursor:pointer;}
.dpr-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dpr-readerpane{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);}
.dpr-menu{position:absolute;z-index:30;display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 20px rgba(0,0,0,.18);}
.dpr-menu-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;padding:7px 9px;border-radius:7px;cursor:pointer;white-space:nowrap;}
.dpr-menu-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dpr-menu-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-1px;}
.dpr-menu-sep{width:1px;height:16px;background:var(--dsw-alias-border-l3);margin:0 2px;}
.dpr-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:40;max-width:85%;padding:7px 12px;border-radius:9px;background:var(--dsw-alias-toast-bg,#1f2329);color:var(--dsw-alias-toast-label,#fff);font-size:12px;line-height:1.4;box-shadow:0 6px 20px rgba(0,0,0,.22);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dpr-toast[data-tone="error"]{background:var(--dsw-alias-state-error-primary,#d9534f);color:#fff;}
.dpr-noteoverlay{position:absolute;inset:0;z-index:50;background:rgba(15,18,22,.16);display:flex;align-items:flex-start;justify-content:center;padding-top:48px;}
.dpr-noteswrap{position:absolute;top:0;right:0;bottom:0;z-index:35;width:min(300px,88%);border-left:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:-8px 0 24px rgba(0,0,0,.12);display:flex;flex-direction:column;}
`,
        },
      });
    }

    /** Full-pane loading state. */
    function Loading(props) {
      return h(
        'div',
        { className: 'dpr-loading' },
        h('span', { className: 'dpr-spinner', 'aria-hidden': 'true' }),
        h('span', null, props.label),
      );
    }

    /** Error state with a retry action. */
    function ErrorBox(props) {
      return h(
        'div',
        { className: 'dpr-errorbox', role: 'alert' },
        h('div', null, props.message),
        props.onRetry !== undefined
          ? h('button', { type: 'button', className: 'dpr-btn', onClick: props.onRetry }, props.retryLabel)
          : null,
      );
    }

    /**
     * Clamp the floating menu inside the reader pane.
     * @param anchor - selection viewport anchor.
     * @param container - reader pane client rect.
     * @returns absolute style inside the pane.
     */
    function menuStyleFor(anchor, container) {
      const MENU_WIDTH = 320;
      const MENU_HEIGHT = 40;
      const left = Math.max(6, Math.min(anchor.right - container.left - MENU_WIDTH + 12, container.width - MENU_WIDTH - 6));
      let top = anchor.bottom - container.top + 8;
      if (top + MENU_HEIGHT > container.height - 8) top = Math.max(6, anchor.top - container.top - MENU_HEIGHT - 8);
      return { left: Math.max(6, left), top };
    }

    /**
     * The composition shell once every feature chunk has loaded.
     * @param props - `{ core, lang, chunks }`.
     * @returns the app.
     */
    function PaperReaderShell(props) {
      const { core, lang, chunks } = props;
      const { PdfViewer } = chunks.viewer;
      const { createAnnotationStore, HighlightLayer, NoteComposer, NotesPanel, buildAskPrompt } = chunks.annotations;
      const { createPaperStore, PaperLibrary } = chunks.library;

      const store = React.useMemo(() => createPaperStore(), []);
      React.useEffect(() => {
        store.init();
      }, [store]);
      const papersSnap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

      const [active, setActive] = React.useState(null);
      const [bytes, setBytes] = React.useState(null);
      const [opening, setOpening] = React.useState(false);
      const [openError, setOpenError] = React.useState(null);
      const [zoom, setZoom] = React.useState(1);
      const [page, setPage] = React.useState(1);
      const [pageCount, setPageCount] = React.useState(0);
      const [selection, setSelection] = React.useState(null);
      const [menu, setMenu] = React.useState(null);
      const [composer, setComposer] = React.useState(null);
      const [notesOpen, setNotesOpen] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const readerRef = React.useRef(null);
      const viewerApi = React.useRef(null);
      const toastTimer = React.useRef(null);

      const lastPaperKey = LAST_PAPER_PREFIX + String(core.sessionId || 'session');
      const activeId = active === null ? '' : active.id;

      /** Show a transient status line above the document. */
      const showToast = React.useCallback((text, tone) => {
        setToast({ text, tone: tone || 'info' });
        if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 2400);
      }, []);
      React.useEffect(
        () => () => {
          if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
        },
        [],
      );

      /**
       * Open one paper from the library.
       * @param meta - paper metadata.
       */
      const openPaper = React.useCallback(
        async (meta) => {
          setActive(meta);
          setBytes(null);
          setOpening(true);
          setOpenError(null);
          setZoom(1);
          setPage(1);
          setPageCount(0);
          setSelection(null);
          setMenu(null);
          setComposer(null);
          setNotesOpen(false);
          try {
            window.localStorage.setItem(lastPaperKey, meta.id);
          } catch {
            /* memory is best-effort */
          }
          try {
            const data = await store.getBytes(meta.id);
            setBytes(data);
          } catch (error) {
            console.error('[dsh-paper-reader] failed to read paper', error);
            setOpenError(t(lang, 'openError'));
          } finally {
            setOpening(false);
          }
        },
        [store, lastPaperKey, lang],
      );

      // Restore the last opened paper for this Session once the library loads.
      const restoredRef = React.useRef(false);
      React.useEffect(() => {
        if (restoredRef.current || !papersSnap.loaded || papersSnap.papers.length === 0) return;
        restoredRef.current = true;
        let saved = null;
        try {
          saved = window.localStorage.getItem(lastPaperKey);
        } catch {
          saved = null;
        }
        if (saved === null) return;
        const meta = papersSnap.papers.find((paper) => paper.id === saved);
        if (meta !== undefined) openPaper(meta);
      }, [papersSnap.loaded, papersSnap.papers.length, lastPaperKey, openPaper]);

      // Annotation store for the open paper (stable empty store otherwise).
      const annotationStore = React.useMemo(
        () => (active === null ? EMPTY_STORE : createAnnotationStore(active.id)),
        [active === null, activeId, createAnnotationStore],
      );
      const annotations = React.useSyncExternalStore(
        annotationStore.subscribe,
        annotationStore.getSnapshot,
        annotationStore.getSnapshot,
      );

      // Escape closes transient UI.
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (composer !== null) {
            setComposer(null);
            return;
          }
          if (menu !== null) {
            setMenu(null);
            return;
          }
          if (notesOpen) setNotesOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [composer, menu, notesOpen]);

      // Clicking outside the floating menu closes it (selection itself persists).
      React.useEffect(() => {
        if (menu === null) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('.dpr-menu') !== null) return;
          setMenu(null);
        };
        window.addEventListener('mousedown', onDown, true);
        return () => window.removeEventListener('mousedown', onDown, true);
      }, [menu]);

      /** Return to the library and forget the open paper for this Session. */
      const goLibrary = React.useCallback(() => {
        setActive(null);
        setBytes(null);
        setOpening(false);
        setOpenError(null);
        setSelection(null);
        setMenu(null);
        setComposer(null);
        setNotesOpen(false);
        try {
          window.localStorage.removeItem(lastPaperKey);
        } catch {
          /* memory is best-effort */
        }
      }, [lastPaperKey]);

      /** Clear the DOM text selection and the floating menu. */
      const clearSelection = React.useCallback(() => {
        if (viewerApi.current !== null && typeof viewerApi.current.clearTextSelection === 'function') {
          viewerApi.current.clearTextSelection();
        }
        setSelection(null);
        setMenu(null);
      }, []);

      /** Highlight the current selection. */
      const onHighlight = React.useCallback(() => {
        if (selection === null) return;
        annotationStore.addHighlight({
          page: selection.page,
          rects: selection.rects.map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })),
          text: selection.text,
          color: 'yellow',
        });
        clearSelection();
        showToast(t(lang, 'highlighted'));
      }, [selection, annotationStore, clearSelection, showToast, lang]);

      /** Open the note composer for the current selection. */
      const onAddNote = React.useCallback(() => {
        if (selection === null) return;
        setComposer({ page: selection.page, quote: selection.text });
        setMenu(null);
      }, [selection]);

      /** Save the note (plus its highlight) from the composer. */
      const saveNote = React.useCallback(
        (text) => {
          if (composer === null) return;
          const highlight =
            selection !== null
              ? annotationStore.addHighlight({
                  page: selection.page,
                  rects: selection.rects.map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })),
                  text: selection.text,
                  color: 'yellow',
                })
              : null;
          annotationStore.addNote({
            page: composer.page,
            quote: composer.quote,
            text,
            highlightId: highlight !== null ? highlight.id : undefined,
          });
          setComposer(null);
          clearSelection();
          showToast(t(lang, 'noteSaved'));
        },
        [composer, selection, annotationStore, clearSelection, showToast, lang],
      );

      /** Put the localized prompt into the Session composer. */
      const onAsk = React.useCallback(() => {
        if (selection === null || active === null) return;
        const prompt = buildAskPrompt({
          lang,
          title: active.title || active.name,
          page: selection.page,
          text: selection.text,
        });
        const ok = core.askInSession(prompt);
        clearSelection();
        showToast(ok ? t(lang, 'askAdded') : t(lang, 'askFailed'), ok ? 'info' : 'error');
        if (ok) core.focusComposer();
      }, [selection, active, lang, buildAskPrompt, core, clearSelection, showToast]);

      /** Viewer reports a new text selection; park the floating menu above it. */
      const onSelection = React.useCallback((next) => {
        setSelection(next);
        if (next === null) {
          setMenu(null);
          return;
        }
        const container = readerRef.current;
        if (container === null) return;
        setMenu({ style: menuStyleFor(next.anchor, container.getBoundingClientRect()) });
      }, []);

      /** Jump the viewer to a page (notes panel). */
      const jumpTo = React.useCallback((targetPage) => {
        if (viewerApi.current !== null && typeof viewerApi.current.scrollToPage === 'function') {
          viewerApi.current.scrollToPage(targetPage);
        }
        setNotesOpen(false);
      }, []);

      const highlightsFor = React.useCallback(
        (pageNumber) => annotations.highlights.filter((highlight) => highlight.page === pageNumber),
        [annotations],
      );

      const renderPageOverlay = React.useCallback(
        (pageNumber) => h(HighlightLayer, { page: pageNumber, highlights: highlightsFor(pageNumber) }),
        [HighlightLayer, highlightsFor],
      );

      const annotationCount = annotations.highlights.length + annotations.notes.length;
      const libraryView = active === null;

      return h(
        'div',
        { className: 'dpr-shell', 'data-paper-reader': 'shell' },
        h(ShellStyle, null),
        h(
          'header',
          { className: 'dpr-topbar' },
          libraryView
            ? h('span', { className: 'dpr-topbar-title', 'data-testid': 'dpr-title' }, t(lang, 'title'))
            : h(IconButton, { paths: ICON.back, label: t(lang, 'back'), onClick: goLibrary, action: 'back' }),
          libraryView ? null : h('span', { className: 'dpr-topbar-title', title: active.name }, active.title || active.name),
          libraryView
            ? null
            : h('span', { className: 'dpr-topbar-sub', 'data-testid': 'dpr-page' }, t(lang, 'page', { n: page, total: pageCount || '…' })),
          libraryView ? null : h('div', { className: 'dpr-topbar-spacer' }),
          libraryView
            ? null
            : h(
                'div',
                { className: 'dpr-zoom' },
                h(IconButton, {
                  paths: ICON.minus,
                  label: t(lang, 'zoomOut'),
                  onClick: () => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 100) / 100)),
                  action: 'zoom-out',
                }),
                h('span', { className: 'dpr-zoom-label', 'data-testid': 'dpr-zoom' }, `${Math.round(zoom * 100)}%`),
                h(IconButton, {
                  paths: ICON.plus,
                  label: t(lang, 'zoomIn'),
                  onClick: () => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 100) / 100)),
                  action: 'zoom-in',
                }),
                h(IconButton, { paths: ICON.fit, label: t(lang, 'zoomFit'), onClick: () => setZoom(1), action: 'zoom-fit' }),
              ),
          libraryView
            ? null
            : h(IconButton, {
                paths: ICON.note,
                label: t(lang, 'notes'),
                badge: annotationCount,
                active: notesOpen,
                onClick: () => setNotesOpen((open) => !open),
                action: 'notes',
              }),
        ),
        h(
          'main',
          { className: 'dpr-main' },
          libraryView
            ? h('div', { className: 'dpr-libwrap' }, h(PaperLibrary, { lang, store, onOpen: openPaper }))
            : h(
                'div',
                { className: 'dpr-readerpane', ref: readerRef, 'data-testid': 'dpr-readerpane' },
                opening || bytes === null
                  ? openError !== null
                    ? h(ErrorBox, { message: openError })
                    : h(Loading, { label: t(lang, 'loadingPaper') })
                  : h(PdfViewer, {
                      bytes,
                      vendorBase: core.vendorBase,
                      lang,
                      zoom,
                      renderPageOverlay,
                      apiRef: viewerApi,
                      onDocumentReady: (info) => setPageCount(info.numPages),
                      onPageChange: (nextPage) => setPage(nextPage),
                      onSelection,
                    }),
                menu !== null && selection !== null
                  ? h(
                      'div',
                      { className: 'dpr-menu', style: menu.style, role: 'menu', 'aria-label': t(lang, 'menuLabel') },
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'menuitem',
                          className: 'dpr-menu-btn',
                          'data-action': 'highlight',
                          onClick: (event) => {
                            event.stopPropagation();
                            onHighlight();
                          },
                        },
                        h(Icon, { paths: ICON.highlight, size: 14 }),
                        t(lang, 'highlight'),
                      ),
                      h('span', { className: 'dpr-menu-sep', 'aria-hidden': 'true' }),
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'menuitem',
                          className: 'dpr-menu-btn',
                          'data-action': 'note',
                          onClick: (event) => {
                            event.stopPropagation();
                            onAddNote();
                          },
                        },
                        h(Icon, { paths: ICON.note, size: 14 }),
                        t(lang, 'addNote'),
                      ),
                      h('span', { className: 'dpr-menu-sep', 'aria-hidden': 'true' }),
                      h(
                        'button',
                        {
                          type: 'button',
                          role: 'menuitem',
                          className: 'dpr-menu-btn',
                          'data-action': 'ask',
                          onClick: (event) => {
                            event.stopPropagation();
                            onAsk();
                          },
                        },
                        h(Icon, { paths: ICON.chat, size: 14 }),
                        t(lang, 'ask'),
                      ),
                    )
                  : null,
                composer !== null
                  ? h(
                      'div',
                      {
                        className: 'dpr-noteoverlay',
                        onMouseDown: (event) => {
                          if (event.target === event.currentTarget) setComposer(null);
                        },
                      },
                      h(NoteComposer, {
                        lang,
                        quote: composer.quote,
                        page: composer.page,
                        onSave: saveNote,
                        onCancel: () => setComposer(null),
                      }),
                    )
                  : null,
                notesOpen
                  ? h(
                      'div',
                      { className: 'dpr-noteswrap' },
                      h(NotesPanel, {
                        lang,
                        store: annotationStore,
                        onJump: jumpTo,
                        onClose: () => setNotesOpen(false),
                      }),
                    )
                  : null,
                toast !== null ? h('div', { className: 'dpr-toast', 'data-tone': toast.tone }, toast.text) : null,
              ),
        ),
      );
    }

    /**
     * App entry: load the feature chunks, then mount the shell.
     * @param props - `{ core, lang }`.
     * @returns the reader app.
     */
    function PaperReaderApp(props) {
      const { core, lang } = props;
      const [chunks, setChunks] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [attempt, setAttempt] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setError(null);
        loadChunks()
          .then((loaded) => {
            if (alive) setChunks(loaded);
          })
          .catch((loadError) => {
            console.error('[dsh-paper-reader] feature chunks failed to load', loadError);
            if (alive) setError(loadError);
          });
        return () => {
          alive = false;
        };
      }, [attempt]);

      if (error !== null) {
        return h(
          'div',
          { className: 'dpr-shell' },
          h(ShellStyle, null),
          h(ErrorBox, {
            message: t(lang, 'chunkError') + ' — ' + String(error.message || error),
            retryLabel: t(lang, 'retry'),
            onRetry: () => setAttempt((n) => n + 1),
          }),
        );
      }
      if (chunks === null) {
        return h('div', { className: 'dpr-shell' }, h(ShellStyle, null), h(Loading, { label: t(lang, 'loadingReader') }));
      }
      return h(PaperReaderShell, { core, lang, chunks });
    }

    return { PaperReaderApp };
  },
});
