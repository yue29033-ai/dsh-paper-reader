/**
 * dsh-paper-reader — annotations chunk.
 *
 * Owner: annotations. Lazily pulled in by the app chunk with
 * `require.async('./client.annotations.js')`; this file is a hand-written
 * classic-script ModuleLoader bundle (no JSX, no imports, no build step).
 *
 * Public contract (frozen in `docs/INTERFACES.md` §2):
 *   createAnnotationStore(paperId) -> store persisted in localStorage
 *   HighlightLayer({ page, highlights })          page overlay painter
 *   SelectionMenu({ lang, style, onHighlight, onNote, onAsk, onClose })
 *   NoteComposer({ lang, quote, page, onSave, onCancel })
 *   NotesPanel({ lang, store, onJump, onClose })
 *   buildAskPrompt({ lang, title, page, text })   localized chat prompt
 *   ANNOTATION_COLORS                             ordered highlight colors
 *
 * The store owns no DOM and the components own no globals: each component
 * renders its own `<style>` element as its first child and every listener it
 * registers is removed on unmount.
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  chunk: 'client.annotations.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;

    /* ================================================================== *
     * 1. Constants
     * ================================================================== */

    /** localStorage key prefix; the paper id is appended verbatim. */
    const STORAGE_PREFIX = 'dsh-paper-reader:annotations:v1:';

    /** Ordered highlight palette. The stored `Highlight.color` is one of these ids. */
    const ANNOTATION_COLORS = Object.freeze(['yellow', 'green', 'pink', 'blue']);

    /** Highlight fills (translucent so the document text stays readable). `docs/INTERFACES.md` §5. */
    const COLOR_FILLS = Object.freeze({
      yellow: 'rgba(255,201,29,.32)',
      green: 'rgba(52,199,89,.28)',
      pink: 'rgba(255,105,180,.26)',
      blue: 'rgba(64,156,255,.26)',
    });

    /** Fallback color id for data with an unknown/absent color. */
    const DEFAULT_COLOR = 'yellow';

    /** Note textarea hard limit (contract). */
    const NOTE_MAX_LENGTH = 4000;

    /** Chat quote limit (contract): the excerpt inside the prompt is capped at this many chars. */
    const ASK_QUOTE_LIMIT = 1600;

    /** Empty store snapshot: a stable reference for stores with nothing to show. */
    const EMPTY_SNAPSHOT = Object.freeze({ highlights: Object.freeze([]), notes: Object.freeze([]) });

    /* ================================================================== *
     * 2. Localized copy (private table; the app passes `lang`)
     * ================================================================== */

    const STRINGS = {
      zh: {
        // Selection menu actions — the three actions are contract-exact.
        highlight: '高亮',
        addNote: '添加笔记',
        ask: '在会话中提问',
        menuLabel: '选中文字后的操作',
        highlightTitle: '高亮选中的文字',
        noteTitle: '为选中的文字添加笔记',
        askTitle: '就选中的内容在会话中提问',
        // Note composer
        noteCardTitle: '添加笔记',
        notePlaceholder: '写下你对这段内容的理解、疑问或备注…',
        noteInputLabel: '笔记内容',
        noteHint: '⌘/Ctrl + Enter 保存 · Esc 取消',
        noteNoQuote: '（无选中文本）',
        save: '保存',
        cancel: '取消',
        // Shared labels
        pageLabel: '第 {page} 页',
        countLabel: '{count}/{max}',
        // Notes panel
        panelTitle: '标注',
        panelCount: '{count} 条',
        closePanel: '关闭标注面板',
        emptyTitle: '还没有标注',
        emptyHint: '在论文中选中文字，即可高亮、添加笔记或在会话中提问。',
        deleteRow: '删除这条标注',
        jumpToPage: '跳转到第 {page} 页',
        // Ask prompt
        askTemplate:
          '请阅读并解释这篇论文《{title}》第 {page} 页的以下内容，并回答我的问题：\n\n{quote}\n\n我的问题：\n',
        askUntitled: '未命名论文',
        askTruncated: '…（内容已截断）',
      },
      en: {
        highlight: 'Highlight',
        addNote: 'Add note',
        ask: 'Ask in chat',
        menuLabel: 'Selection actions',
        highlightTitle: 'Highlight the selected text',
        noteTitle: 'Add a note to the selected text',
        askTitle: 'Ask about the selection in the chat',
        noteCardTitle: 'Add note',
        notePlaceholder: 'Write what you think, wonder, or want to remember about this passage…',
        noteInputLabel: 'Note text',
        noteHint: '⌘/Ctrl + Enter to save · Esc to cancel',
        noteNoQuote: '(no selected text)',
        save: 'Save',
        cancel: 'Cancel',
        pageLabel: 'Page {page}',
        countLabel: '{count}/{max}',
        panelTitle: 'Annotations',
        panelCount: '{count}',
        closePanel: 'Close annotations panel',
        emptyTitle: 'No annotations yet',
        emptyHint: 'Select text in the paper to highlight it, add a note, or ask about it in the chat.',
        deleteRow: 'Delete this annotation',
        jumpToPage: 'Jump to page {page}',
        askTemplate:
          'Please read and explain the following excerpt from the paper "{title}" (page {page}), then answer my question:\n\n{quote}\n\nMy question:\n',
        askUntitled: 'Untitled paper',
        askTruncated: '… (truncated)',
      },
    };

    /**
     * Resolve the string table for a `lang` prop (anything but `'zh'` is English).
     * @param {string} lang - `'zh'` or `'en'`.
     * @returns {object} the string table.
     */
    function table(lang) {
      return lang === 'zh' ? STRINGS.zh : STRINGS.en;
    }

    /**
     * Translate one key in the given UI language.
     * @param {string} lang - `'zh'` or `'en'`.
     * @param {string} key - string key.
     * @param {object} [params] - `{name}` template parameters.
     * @returns {string} localized text.
     */
    function t(lang, key, params) {
      const dict = table(lang);
      const template = typeof dict[key] === 'string' ? dict[key] : STRINGS.en[key] || key;
      if (params === undefined) return template;
      return fillTemplate(template, params);
    }

    /**
     * Fill `{name}` placeholders in a template (no `$` replacement surprises).
     * @param {string} template - template text.
     * @param {object} values - placeholder values.
     * @returns {string} filled text.
     */
    function fillTemplate(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
      );
    }

    /* ================================================================== *
     * 3. Small total helpers (never throw on malformed data)
     * ================================================================== */

    /**
     * Is a JSON value a plain object (not null/array)?
     * @param {unknown} value - candidate.
     * @returns {boolean} whether it is a plain object.
     */
    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /**
     * Coerce a value to a string, defaulting to `''`.
     * @param {unknown} value - candidate.
     * @returns {string} string form.
     */
    function asText(value) {
      return typeof value === 'string' ? value : '';
    }

    /**
     * Normalize a 1-based page number; invalid input becomes page 1.
     * @param {unknown} value - candidate.
     * @returns {number} positive integer.
     */
    function asPage(value) {
      const page = Math.floor(Number(value));
      return Number.isFinite(page) && page >= 1 ? page : 1;
    }

    /**
     * Normalize a highlight color id to the known palette.
     * @param {unknown} value - color id (or an object carrying one).
     * @returns {string} palette id.
     */
    function asColor(value) {
      const id = isObject(value) ? value.id : value;
      return ANNOTATION_COLORS.indexOf(id) !== -1 ? id : DEFAULT_COLOR;
    }

    /**
     * Clamp a number into 0..1.
     * @param {number} value - candidate.
     * @returns {number} clamped value.
     */
    function clamp01(value) {
      if (!Number.isFinite(value)) return 0;
      if (value < 0) return 0;
      if (value > 1) return 1;
      return value;
    }

    /**
     * Normalize one stored normalized rect; malformed rects are dropped.
     * @param {unknown} value - candidate rect.
     * @returns {{x:number,y:number,w:number,h:number}|null} rect or null.
     */
    function normalizeRect(value) {
      if (!isObject(value)) return null;
      const x = Number(value.x);
      const y = Number(value.y);
      const w = Number(value.w);
      const h = Number(value.h);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
      if (w <= 0 || h <= 0) return null;
      return { x, y, w, h };
    }

    /**
     * Sanitize one persisted highlight; unusable records are dropped.
     * @param {unknown} value - candidate record.
     * @returns {object|null} highlight or null.
     */
    function normalizeStoredHighlight(value) {
      if (!isObject(value)) return null;
      const id = asText(value.id);
      if (id === '') return null;
      const item = {
        id,
        page: asPage(value.page),
        rects: Array.isArray(value.rects) ? value.rects.map(normalizeRect).filter(Boolean) : [],
        text: asText(value.text),
        color: asColor(value.color),
        createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
      };
      const noteId = asText(value.noteId);
      if (noteId !== '') item.noteId = noteId;
      return item;
    }

    /**
     * Sanitize one persisted note; unusable records are dropped.
     * @param {unknown} value - candidate record.
     * @returns {object|null} note or null.
     */
    function normalizeStoredNote(value) {
      if (!isObject(value)) return null;
      const id = asText(value.id);
      if (id === '') return null;
      const item = {
        id,
        page: asPage(value.page),
        quote: asText(value.quote),
        text: asText(value.text),
        createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
      };
      const highlightId = asText(value.highlightId);
      if (highlightId !== '') item.highlightId = highlightId;
      return item;
    }

    /**
     * The browser localStorage, or null when storage is unavailable/forbidden.
     * @returns {Storage|null} storage handle.
     */
    function getStorage() {
      try {
        if (typeof window !== 'undefined' && window !== null && window.localStorage) return window.localStorage;
      } catch (error) {
        /* Safari private mode / sandboxed frame: treat as unavailable */
      }
      try {
        if (typeof globalThis !== 'undefined' && globalThis !== null && globalThis.localStorage) {
          return globalThis.localStorage;
        }
      } catch (error) {
        /* storage access denied */
      }
      return null;
    }

    /**
     * Generate a collision-resistant id.
     * @param {string} prefix - readable id prefix.
     * @returns {string} id.
     */
    function createId(prefix) {
      const scope = typeof globalThis !== 'undefined' ? globalThis : undefined;
      const cryptoObj = scope !== undefined ? scope.crypto : undefined;
      if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === 'function') {
        try {
          return `${prefix}_${cryptoObj.randomUUID()}`;
        } catch (error) {
          /* fall through to the random suffix */
        }
      }
      return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }

    /**
     * Read and sanitize one paper's snapshot from storage; a missing, corrupt or
     * forbidden record yields a fresh empty snapshot and never throws.
     * @param {string} storageKey - full localStorage key.
     * @returns {{highlights: object[], notes: object[]}} snapshot.
     */
    function readSnapshot(storageKey) {
      const storage = getStorage();
      if (storage === null) return { highlights: [], notes: [] };
      let raw;
      try {
        raw = storage.getItem(storageKey);
      } catch (error) {
        console.warn('[dsh-paper-reader] annotations: localStorage read failed', error);
        return { highlights: [], notes: [] };
      }
      if (typeof raw !== 'string' || raw === '') return { highlights: [], notes: [] };
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        console.warn('[dsh-paper-reader] annotations: corrupt storage record discarded', error);
        try {
          storage.removeItem(storageKey);
        } catch (removeError) {
          /* ignore: the next write replaces it */
        }
        return { highlights: [], notes: [] };
      }
      if (!isObject(parsed)) return { highlights: [], notes: [] };
      const highlights = Array.isArray(parsed.highlights)
        ? parsed.highlights.map(normalizeStoredHighlight).filter(Boolean)
        : [];
      const notes = Array.isArray(parsed.notes) ? parsed.notes.map(normalizeStoredNote).filter(Boolean) : [];
      return { highlights, notes };
    }

    /**
     * Persist one snapshot; quota/security failures are logged and swallowed so
     * the in-memory store keeps working.
     * @param {string} storageKey - full localStorage key.
     * @param {{highlights: object[], notes: object[]}} snapshot - snapshot to write.
     * @returns {boolean} whether the write succeeded.
     */
    function writeSnapshot(storageKey, snapshot) {
      const storage = getStorage();
      if (storage === null) return false;
      try {
        storage.setItem(storageKey, JSON.stringify(snapshot));
        return true;
      } catch (error) {
        console.warn('[dsh-paper-reader] annotations: could not persist annotations', error);
        return false;
      }
    }

    /**
     * Invoke an app callback without letting it break this component.
     * @param {unknown} fn - callback.
     * @param {unknown} [arg] - single argument.
     * @returns {void}
     */
    function safeCall(fn, arg) {
      if (typeof fn !== 'function') return;
      try {
        fn(arg);
      } catch (error) {
        console.error('[dsh-paper-reader] annotations: action failed', error);
      }
    }

    /* ================================================================== *
     * 4. Annotation store (localStorage backed)
     * ================================================================== */

    /**
     * Create the per-paper annotation store.
     *
     * The snapshot reference is stable until a mutation, so it can be read
     * through `React.useSyncExternalStore` directly. Every mutation writes the
     * whole snapshot to localStorage; storage failures never break the store.
     *
     * @param {string} paperId - owning paper id (forms the storage key).
     * @returns {{
     *   getSnapshot(): {highlights: object[], notes: object[]},
     *   subscribe(fn: Function): Function,
     *   addHighlight(input: object): object,
     *   removeHighlight(id: string): void,
     *   addNote(input: object): object,
     *   updateNote(id: string, patch: {text?: string}): void,
     *   removeNote(id: string): void,
     * }} store.
     */
    function createAnnotationStore(paperId) {
      const storageKey = STORAGE_PREFIX + String(paperId === undefined || paperId === null ? '' : paperId);
      /** @type {{highlights: object[], notes: object[]}} */
      let snapshot = readSnapshot(storageKey);
      const listeners = new Set();
      /** Highest createdAt seen so far; keeps creation order monotonic within one millisecond. */
      let lastCreatedAt = 0;
      for (const highlight of snapshot.highlights) {
        lastCreatedAt = Math.max(lastCreatedAt, Number(highlight.createdAt) || 0);
      }
      for (const note of snapshot.notes) {
        lastCreatedAt = Math.max(lastCreatedAt, Number(note.createdAt) || 0);
      }

      /**
       * Current timestamp, nudged forward so two annotations created in the same
       * millisecond still sort deterministically (newest first) in the panel.
       * @returns {number} strictly increasing creation stamp.
       */
      function stamp() {
        const now = Date.now();
        lastCreatedAt = now > lastCreatedAt ? now : lastCreatedAt + 1;
        return lastCreatedAt;
      }

      /**
       * Publish a new snapshot: swap the reference, persist, notify subscribers.
       * @param {{highlights: object[], notes: object[]}} next - next snapshot.
       * @returns {void}
       */
      function commit(next) {
        snapshot = next;
        writeSnapshot(storageKey, snapshot);
        const pending = Array.from(listeners);
        for (const listener of pending) {
          try {
            listener();
          } catch (error) {
            console.warn('[dsh-paper-reader] annotations: subscriber failed', error);
          }
        }
      }

      /**
       * @returns {{highlights: object[], notes: object[]}} current snapshot (reference stable until change).
       */
      function getSnapshot() {
        return snapshot;
      }

      /**
       * Subscribe to snapshot changes.
       * @param {Function} listener - called after every mutation.
       * @returns {Function} unsubscribe.
       */
      function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }

      /**
       * Remove a highlight; notes that pointed at it become standalone notes.
       * @param {string} id - highlight id.
       * @returns {void}
       */
      function removeHighlight(id) {
        const key = String(id);
        const highlights = snapshot.highlights.filter((highlight) => highlight.id !== key);
        let notes = snapshot.notes;
        if (notes.some((note) => note.highlightId === key)) {
          notes = notes.map((note) => {
            if (note.highlightId !== key) return note;
            const copy = Object.assign({}, note);
            delete copy.highlightId;
            return copy;
          });
        }
        if (highlights.length === snapshot.highlights.length && notes === snapshot.notes) return;
        commit({ highlights, notes });
      }

      /**
       * Append a highlight (id/createdAt assigned here; color defaults to the palette head).
       * @param {object} input - `{ page, rects, text, color?, noteId? }`.
       * @returns {object} the stored highlight.
       */
      function addHighlight(input) {
        const source = isObject(input) ? input : {};
        const highlight = {
          id: createId('hl'),
          page: asPage(source.page),
          rects: Array.isArray(source.rects) ? source.rects.map(normalizeRect).filter(Boolean) : [],
          text: asText(source.text),
          color: asColor(source.color),
          createdAt: stamp(),
        };
        const noteId = asText(source.noteId);
        if (noteId !== '') highlight.noteId = noteId;
        commit({ highlights: snapshot.highlights.concat([highlight]), notes: snapshot.notes });
        return highlight;
      }

      /**
       * Remove a note; a highlight that pointed at it loses its note link.
       * @param {string} id - note id.
       * @returns {void}
       */
      function removeNote(id) {
        const key = String(id);
        const notes = snapshot.notes.filter((note) => note.id !== key);
        let highlights = snapshot.highlights;
        if (highlights.some((highlight) => highlight.noteId === key)) {
          highlights = highlights.map((highlight) => {
            if (highlight.noteId !== key) return highlight;
            const copy = Object.assign({}, highlight);
            delete copy.noteId;
            return copy;
          });
        }
        if (notes.length === snapshot.notes.length && highlights === snapshot.highlights) return;
        commit({ highlights, notes });
      }

      /**
       * Append a note; a referenced highlight gets its `noteId` link (bidirectional invariant).
       * @param {object} input - `{ page, quote, text, highlightId? }`.
       * @returns {object} the stored note.
       */
      function addNote(input) {
        const source = isObject(input) ? input : {};
        const note = {
          id: createId('note'),
          page: asPage(source.page),
          quote: asText(source.quote),
          text: asText(source.text),
          createdAt: stamp(),
        };
        const highlightId = asText(source.highlightId);
        if (highlightId !== '') note.highlightId = highlightId;
        let highlights = snapshot.highlights;
        if (highlightId !== '') {
          const index = highlights.findIndex((highlight) => highlight.id === highlightId);
          if (index !== -1 && highlights[index].noteId !== note.id) {
            const owned = highlights.slice();
            owned[index] = Object.assign({}, highlights[index], { noteId: note.id });
            highlights = owned;
          }
        }
        commit({ highlights, notes: snapshot.notes.concat([note]) });
        return note;
      }

      /**
       * Patch a note's text (only `text` is patchable per contract).
       * @param {string} id - note id.
       * @param {{text?: string}} patch - fields to change.
       * @returns {void}
       */
      function updateNote(id, patch) {
        const key = String(id);
        const index = snapshot.notes.findIndex((note) => note.id === key);
        if (index === -1) return;
        const changes = isObject(patch) ? patch : {};
        const current = snapshot.notes[index];
        const text = typeof changes.text === 'string' ? changes.text : current.text;
        if (text === current.text) return;
        const notes = snapshot.notes.slice();
        notes[index] = Object.assign({}, current, { text });
        commit({ highlights: snapshot.highlights, notes });
      }

      return {
        getSnapshot,
        subscribe,
        addHighlight,
        removeHighlight,
        addNote,
        updateNote,
        removeNote,
      };
    }

    /* ================================================================== *
     * 5. Ask-in-chat prompt
     * ================================================================== */

    /**
     * Normalize a selection excerpt for the chat prompt.
     *
     * PDF text layers are hostile here: a drag selection can carry leading or
     * trailing blank lines, ideographic spaces (U+3000) used for CJK paragraph
     * indents, zero-width characters, form feeds and Unicode line separators.
     * The prompt needs one clean line per excerpt line and no blank lines, so
     * this normalizer:
     *
     *   1. unifies every line/paragraph separator (`\r\n?`, U+2028/U+2029) to `\n`;
     *   2. removes invisible format characters (ZWSP/ZWNJ/ZWJ/BOM/soft hyphen);
     *   3. folds every Unicode space/tab range (incl. NBSP, U+3000) to one space;
     *   4. trims each line and drops blank lines;
     *   5. keeps one `\n` between surviving lines and trims the result.
     *
     * Total for any input type; returns `''` for whitespace-only input.
     * @param {unknown} value - raw selection text.
     * @returns {string} normalized excerpt without blank lines.
     */
    function normalizeQuote(value) {
      let text = asText(value);
      if (text === '') return '';
      text = text
        .replace(/\r\n?/g, '\n')
        .replace(/[\u2028\u2029]/g, '\n')
        .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
        .replace(/[\t\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
        .replace(/ +/g, ' ');
      const lines = [];
      const parts = text.split('\n');
      for (const part of parts) {
        const line = part.trim();
        if (line !== '') lines.push(line);
      }
      return lines.join('\n');
    }

    /**
     * Cap the excerpt at the prompt limit, appending a localized marker.
     * @param {string} quote - normalized excerpt.
     * @param {string} lang - `'zh'` or `'en'`.
     * @returns {string} excerpt within `ASK_QUOTE_LIMIT`.
     */
    function truncateQuote(quote, lang) {
      if (quote.length <= ASK_QUOTE_LIMIT) return quote;
      const marker = table(lang).askTruncated;
      const room = Math.max(0, ASK_QUOTE_LIMIT - marker.length);
      return quote.slice(0, room).replace(/\s+$/, '') + marker;
    }

    /**
     * Build the default "ask in chat" prompt in the UI language.
     *
     * Templates (contract-exact):
     *   zh: 请阅读并解释这篇论文《{title}》第 {page} 页的以下内容，并回答我的问题：
     *       > {quote}
     *       我的问题：
     *   en: Please read and explain the following excerpt from the paper
     *       "{title}" (page {page}), then answer my question:
     *       > {quote}
     *       My question:
     *
     * Multi-line excerpts keep a `> ` blockquote prefix on every line; a
     * single-line excerpt is byte-identical to the contract template.
     *
     * @param {{lang?: string, title?: string, page?: number, text?: string}} input - prompt inputs.
     * @returns {string} the prompt text.
     */
    function buildAskPrompt(input) {
      const source = isObject(input) ? input : {};
      const lang = source.lang === 'zh' ? 'zh' : 'en';
      const strings = table(lang);
      const rawTitle = asText(source.title)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      const title = rawTitle !== '' ? rawTitle : strings.askUntitled;
      const page = asPage(source.page);
      const quote = truncateQuote(normalizeQuote(source.text), lang);
      const quoteBlock = quote
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n');
      return fillTemplate(strings.askTemplate, {
        title,
        page,
        quote: quoteBlock,
      });
    }

    /* ================================================================== *
     * 6. Icons (inline SVG, inherit currentColor)
     * ================================================================== */

    /**
     * Shared SVG frame.
     * @param {React.ReactNode} children - icon paths.
     * @param {number} size - square size in px.
     * @returns {React.ReactElement} svg element.
     */
    function iconFrame(children, size) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 14 14',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      );
    }

    /** Highlighter over a text line. */
    function IconHighlight() {
      return iconFrame(
        [
          h('path', {
            key: 'body',
            d: 'M9.1 2.2 11.8 4.9 6.2 10.5H3.5V7.8L9.1 2.2Z',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinejoin: 'round',
          }),
          h('path', {
            key: 'line',
            d: 'M2.2 12.6h9.6',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinecap: 'round',
          }),
        ],
        14,
      );
    }

    /** Note sheet with a pencil nib. */
    function IconNote() {
      return iconFrame(
        [
          h('path', {
            key: 'sheet',
            d: 'M3 2.6h5.4L11 5.2v6.2H3V2.6Z',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinejoin: 'round',
          }),
          h('path', {
            key: 'fold',
            d: 'M8.2 2.7v2.6h2.7',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinejoin: 'round',
          }),
          h('path', {
            key: 'lines',
            d: 'M4.9 7.6h4M4.9 9.6h2.6',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinecap: 'round',
          }),
        ],
        14,
      );
    }

    /** Chat bubble with dots. */
    function IconAsk() {
      return iconFrame(
        [
          h('path', {
            key: 'bubble',
            d: 'M12 6.9c0 2.2-2.2 3.9-4.9 3.9-.5 0-1-.06-1.5-.17L2.6 11.5l.9-2.1C2.8 8.7 2.2 7.9 2.2 6.9 2.2 4.7 4.4 3 7.1 3S12 4.7 12 6.9Z',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinejoin: 'round',
          }),
          h('path', {
            key: 'dots',
            d: 'M5 7h.01M7.1 7h.01M9.2 7h.01',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
        ],
        14,
      );
    }

    /** Trash can (panel row delete). */
    function IconTrash() {
      return h(
        'svg',
        {
          width: 13,
          height: 13,
          viewBox: '0 0 14 14',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M2.4 3.7h9.2M5.4 3.7V2.4h3.2v1.3M3.9 3.7l.4 7.9h5.4l.4-7.9',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** Close cross. */
    function IconClose(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 13;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 14 14',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    /** Empty-state annotation glyph. */
    function IconEmpty() {
      return h(
        'svg',
        {
          width: 30,
          height: 30,
          viewBox: '0 0 30 30',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          x: 5.5,
          y: 3.5,
          width: 17,
          height: 21,
          rx: 3,
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        h('path', {
          d: 'M9.5 9.5h7M9.5 13.5h9M9.5 17.5h5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 21.5, cy: 21.5, r: 4.2, fill: 'currentColor', opacity: 0.18 }),
      );
    }

    /* ================================================================== *
     * 7. Stylesheets (theme tokens; `--dsw-alias-*` with safe fallbacks)
     * ================================================================== */

    const HIGHLIGHT_CSS = `
.dpr-a-hl-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;}
.dpr-a-hl-rect{position:absolute;border-radius:2px;mix-blend-mode:multiply;}
`;

    const SELECTION_MENU_CSS = `
.dpr-a-menu{display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,#ffffff);color:var(--dsw-alias-label-primary,#111111);box-shadow:0 10px 28px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08);font-family:inherit;font-size:12px;line-height:1;}
.dpr-a-menu-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;margin:0;border:0;border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:12px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;}
.dpr-a-menu-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
.dpr-a-menu-btn:active{transform:translateY(.5px);}
.dpr-a-menu-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}
.dpr-a-menu-btn[data-dpr-action="ask"]{color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dpr-a-menu-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto;}
.dpr-a-menu-label{display:block;}
.dpr-a-menu-sep{flex:0 0 auto;width:1px;height:16px;margin:0 2px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}
`;

    const NOTE_COMPOSER_CSS = `
.dpr-a-note-card{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:min(380px,100%);max-height:100%;margin:0 auto;padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-2,#ffffff);color:var(--dsw-alias-label-primary,#111111);box-shadow:0 12px 36px rgba(0,0,0,.22);font-family:inherit;font-size:13px;overflow:auto;}
.dpr-a-note-head{display:flex;align-items:center;gap:8px;min-height:20px;}
.dpr-a-note-title{margin:0;font-size:13px;font-weight:600;line-height:1.4;}
.dpr-a-page-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#f3f4f6);color:var(--dsw-alias-label-secondary,#666666);font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dpr-a-note-quote{margin:0;padding:2px 0 2px 8px;border-left:2px solid var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-secondary,#555555);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden;}
.dpr-a-note-input{width:100%;min-height:96px;max-height:220px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#111111);font-family:inherit;font-size:13px;line-height:1.6;resize:vertical;outline:none;box-sizing:border-box;}
.dpr-a-note-input::placeholder{color:var(--dsw-alias-label-tertiary,#999999);}
.dpr-a-note-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dpr-a-note-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999999);font-size:11px;line-height:1.4;}
.dpr-a-note-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;}
.dpr-a-note-count{color:var(--dsw-alias-label-tertiary,#999999);font-size:11px;font-variant-numeric:tabular-nums;}
.dpr-a-note-actions{display:flex;align-items:center;gap:8px;}
.dpr-a-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;margin:0;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#111111);font-family:inherit;font-size:12px;font-weight:500;line-height:1;cursor:pointer;}
.dpr-a-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
.dpr-a-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}
.dpr-a-btn:disabled{opacity:.5;cursor:default;}
.dpr-a-btn:disabled:hover{background:var(--dsw-alias-bg-layer-1,#ffffff);}
.dpr-a-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#ffffff;}
.dpr-a-btn-primary:hover{background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(1.06);}
.dpr-a-btn-primary:disabled:hover{background:var(--dsw-alias-brand-primary,#4d6bfe);}
`;

    const NOTES_PANEL_CSS = `
.dpr-a-panel{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#111111);font-family:inherit;font-size:13px;}
.dpr-a-panel-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:40px;padding:0 8px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));}
.dpr-a-panel-title{margin:0;font-size:13px;font-weight:600;line-height:1.4;}
.dpr-a-panel-count{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#666666);font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;}
.dpr-a-panel-spacer{flex:1 1 auto;}
.dpr-a-icon-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;margin:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary,#999999);cursor:pointer;}
.dpr-a-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111111);}
.dpr-a-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}
.dpr-a-panel-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:4px;}
.dpr-a-row{position:relative;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid transparent;border-radius:10px;cursor:pointer;}
.dpr-a-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
.dpr-a-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-1px;}
.dpr-a-row:hover .dpr-a-row-delete,.dpr-a-row:focus-within .dpr-a-row-delete{opacity:1;}
.dpr-a-row-head{display:flex;align-items:center;gap:6px;min-height:18px;}
.dpr-a-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#bbbbbb);}
.dpr-a-page{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef0f3);color:var(--dsw-alias-label-secondary,#666666);font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dpr-a-row-spacer{flex:1 1 auto;}
.dpr-a-row-delete{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;margin:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999999);cursor:pointer;opacity:0;}
.dpr-a-row-delete:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-state-error-primary,#d92d20);}
.dpr-a-row-delete:focus-visible{opacity:1;outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}
.dpr-a-row-quote{margin:0;color:var(--dsw-alias-label-secondary,#555555);font-size:12px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;word-break:break-word;white-space:pre-wrap;}
.dpr-a-row-note{margin:0;color:var(--dsw-alias-label-primary,#111111);font-size:12px;line-height:1.55;word-break:break-word;white-space:pre-wrap;}
.dpr-a-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px 20px;text-align:center;color:var(--dsw-alias-label-tertiary,#999999);}
.dpr-a-empty-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary,#bbbbbb);}
.dpr-a-empty-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#666666);}
.dpr-a-empty-hint{margin:0;font-size:12px;line-height:1.6;}
`;

    /**
     * Render a constant stylesheet.
     * @param {string} css - CSS text.
     * @returns {React.ReactElement} style element.
     */
    function styleElement(css) {
      return h('style', {
        'data-plugin': 'dsh-paper-reader',
        'data-chunk': 'client.annotations.js',
        dangerouslySetInnerHTML: { __html: css },
      });
    }

    /**
     * Merge a base inline style with the caller's positioning style.
     * @param {object} base - base style.
     * @param {unknown} extra - caller style (from the app).
     * @returns {object} merged style.
     */
    function mergeStyle(base, extra) {
      if (!isObject(extra)) return base;
      return Object.assign({}, base, extra);
    }

    /* ================================================================== *
     * 8. HighlightLayer — normalized-rect overlay painter
     * ================================================================== */

    /**
     * Paint one page's highlights as translucent normalized rects.
     *
     * Rendered inside the viewer's page box (position:relative); the layer is
     * `pointer-events:none` so it never blocks text selection. Rects are
     * clamped to the page box so corrupt coordinates cannot bleed outside.
     *
     * @param {{page: number, highlights?: object[]}} props - page number and highlights.
     * @returns {React.ReactElement} overlay.
     */
    function HighlightLayer(props) {
      const source = isObject(props) ? props : {};
      const page = asPage(source.page);
      const highlights = Array.isArray(source.highlights) ? source.highlights : [];
      const rects = [];
      for (const highlight of highlights) {
        if (!isObject(highlight)) continue;
        if (asPage(highlight.page) !== page) continue;
        const color = asColor(highlight.color);
        const list = Array.isArray(highlight.rects) ? highlight.rects : [];
        for (let index = 0; index < list.length; index++) {
          const rect = normalizeRect(list[index]);
          if (rect === null) continue;
          const x = clamp01(rect.x);
          const y = clamp01(rect.y);
          const width = Math.min(clamp01(rect.w), 1 - x);
          const height = Math.min(clamp01(rect.h), 1 - y);
          if (width <= 0 || height <= 0) continue;
          rects.push({
            key: `${highlight.id}:${index}`,
            style: {
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${width * 100}%`,
              height: `${height * 100}%`,
              backgroundColor: COLOR_FILLS[color],
            },
          });
        }
      }
      return h(
        Fragment,
        null,
        styleElement(HIGHLIGHT_CSS),
        h(
          'div',
          { className: 'dpr-a-hl-layer', 'data-dpr': 'highlight-layer', 'aria-hidden': 'true' },
          rects.map((rect) =>
            h('div', {
              key: rect.key,
              className: 'dpr-a-hl-rect',
              'data-dpr': 'highlight-rect',
              style: rect.style,
            }),
          ),
        ),
      );
    }

    /* ================================================================== *
     * 9. SelectionMenu — the three-action floating card
     * ================================================================== */

    /**
     * One menu action button. Pointer/mouse defaults are cancelled and the
     * event is kept away from the viewer so clicking never clears the current
     * text selection before the action runs.
     * @param {object} options - icon, label, action id and handler.
     * @returns {React.ReactElement} button.
     */
    function buildMenuButton(options) {
      const stopDown = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      const stopUp = (event) => {
        event.stopPropagation();
      };
      return h(
        'button',
        {
          key: options.action,
          type: 'button',
          role: 'menuitem',
          className: 'dpr-a-menu-btn',
          'data-dpr-action': options.action,
          title: options.title,
          onPointerDown: stopUp,
          onMouseDown: stopDown,
          onMouseUp: stopUp,
          onPointerUp: stopUp,
          onClick: (event) => {
            event.stopPropagation();
            safeCall(options.onSelect);
          },
        },
        h('span', { className: 'dpr-a-menu-icon' }, h(options.icon, null)),
        h('span', { className: 'dpr-a-menu-label' }, options.label),
      );
    }

    /**
     * Floating selection menu with exactly three actions: highlight, add note,
     * ask in chat. `style` is app-computed and positions the card (absolute).
     * Escape closes it; the card is a `role="menu"` with real menuitem buttons.
     * @param {object} props - lang, style, onHighlight, onNote, onAsk, onClose.
     * @returns {React.ReactElement} the menu.
     */
    function SelectionMenu(props) {
      const source = isObject(props) ? props : {};
      const lang = source.lang;
      const menuRef = React.useRef(null);
      const latest = React.useRef(source);
      latest.current = source;

      React.useEffect(() => {
        /**
         * Escape is handled at the document level: the text selection (and
         * therefore focus) usually stays in the paper, not inside this card.
         * @param {KeyboardEvent} event - key event.
         * @returns {void}
         */
        function onKeyDown(event) {
          if (event.key !== 'Escape' && event.key !== 'Esc') return;
          event.preventDefault();
          event.stopPropagation();
          safeCall(latest.current.onClose);
        }
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, []);

      React.useEffect(() => {
        const node = menuRef.current;
        if (node === null) return;
        const first = node.querySelector('button');
        if (first === null) return;
        try {
          first.focus({ preventScroll: true });
        } catch (error) {
          /* older engines ignore the focus options argument */
        }
      }, []);

      /**
       * Roving focus between the three actions with the arrow keys.
       * @param {KeyboardEvent} event - key event.
       * @returns {void}
       */
      function onKeyDown(event) {
        const key = event.key;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
        const node = menuRef.current;
        if (node === null) return;
        const buttons = Array.prototype.slice.call(node.querySelectorAll('button'));
        if (buttons.length === 0) return;
        event.preventDefault();
        const active = document.activeElement;
        let index = buttons.indexOf(active);
        if (key === 'Home') {
          index = 0;
        } else if (key === 'End') {
          index = buttons.length - 1;
        } else if (key === 'ArrowLeft') {
          index = index <= 0 ? buttons.length - 1 : index - 1;
        } else {
          index = index < 0 || index >= buttons.length - 1 ? 0 : index + 1;
        }
        try {
          buttons[index].focus({ preventScroll: true });
        } catch (error) {
          buttons[index].focus();
        }
      }

      const actions = [
        {
          action: 'highlight',
          icon: IconHighlight,
          label: t(lang, 'highlight'),
          title: t(lang, 'highlightTitle'),
          onSelect: source.onHighlight,
        },
        {
          action: 'note',
          icon: IconNote,
          label: t(lang, 'addNote'),
          title: t(lang, 'noteTitle'),
          onSelect: source.onNote,
        },
        {
          action: 'ask',
          icon: IconAsk,
          label: t(lang, 'ask'),
          title: t(lang, 'askTitle'),
          onSelect: source.onAsk,
        },
      ];

      const children = [];
      for (let index = 0; index < actions.length; index++) {
        if (index === 2) {
          children.push(h('span', { key: 'separator', className: 'dpr-a-menu-sep', 'aria-hidden': 'true' }));
        }
        children.push(buildMenuButton(actions[index]));
      }

      return h(
        Fragment,
        null,
        styleElement(SELECTION_MENU_CSS),
        h(
          'div',
          {
            ref: menuRef,
            className: 'dpr-a-menu',
            role: 'menu',
            'aria-label': t(lang, 'menuLabel'),
            'aria-orientation': 'horizontal',
            'data-dpr': 'selection-menu',
            style: mergeStyle({ position: 'absolute', zIndex: 30, pointerEvents: 'auto' }, source.style),
            onKeyDown,
            onMouseDown: (event) => event.stopPropagation(),
            onPointerDown: (event) => event.stopPropagation(),
          },
          children,
        ),
      );
    }

    /* ================================================================== *
     * 10. NoteComposer — the note dialog
     * ================================================================== */

    /**
     * Small card for writing a note about the current selection.
     *
     * Layout-neutral by design: the app shell owns the modal overlay/scrim and
     * placement (it already renders this inside its own centered overlay), so
     * the component is just the card (`width:min(380px,100%)`, auto margins).
     * Autofocuses the textarea, saves on Cmd/Ctrl+Enter (and on the Save
     * button), cancels on Escape / the Cancel button. The Save button is
     * disabled while the trimmed text is empty; input is capped at 4000 chars.
     * @param {object} props - lang, quote, page, onSave, onCancel.
     * @returns {React.ReactElement} the card.
     */
    function NoteComposer(props) {
      const source = isObject(props) ? props : {};
      const lang = source.lang;
      const [text, setText] = React.useState('');
      const textareaRef = React.useRef(null);
      const latest = React.useRef(source);
      latest.current = source;

      React.useEffect(() => {
        /**
         * Escape cancels the dialog even when focus drifted to another control.
         * @param {KeyboardEvent} event - key event.
         * @returns {void}
         */
        function onKeyDown(event) {
          if (event.key !== 'Escape' && event.key !== 'Esc') return;
          event.preventDefault();
          event.stopPropagation();
          safeCall(latest.current.onCancel);
        }
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, []);

      React.useEffect(() => {
        const node = textareaRef.current;
        if (node === null) return;
        try {
          node.focus({ preventScroll: true });
        } catch (error) {
          node.focus();
        }
        const end = node.value.length;
        try {
          node.setSelectionRange(end, end);
        } catch (error) {
          /* selection API is best-effort */
        }
      }, []);

      const trimmed = text.trim();
      const page = asPage(source.page);
      const quote = asString(source.quote);
      const canSave = trimmed !== '';

      /**
       * Save the note when it has content.
       * @returns {void}
       */
      function save() {
        const value = text.trim();
        if (value === '') return;
        safeCall(latest.current.onSave, value);
      }

      /**
       * Cmd/Ctrl+Enter saves, matching the hint under the textarea.
       * @param {KeyboardEvent} event - key event from the textarea.
       * @returns {void}
       */
      function onTextareaKeyDown(event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }

      return h(
        Fragment,
        null,
        styleElement(NOTE_COMPOSER_CSS),
        h(
          'div',
          {
            className: 'dpr-a-note-card',
            'data-dpr': 'note-composer',
            role: 'dialog',
            'aria-label': t(lang, 'noteCardTitle'),
          },
            h(
              'div',
              { className: 'dpr-a-note-head' },
              h('h2', { className: 'dpr-a-note-title' }, t(lang, 'noteCardTitle')),
              h('span', { className: 'dpr-a-page-badge' }, t(lang, 'pageLabel', { page })),
            ),
            h('blockquote', { className: 'dpr-a-note-quote' }, quote !== '' ? quote : t(lang, 'noteNoQuote')),
            h('textarea', {
              ref: textareaRef,
              className: 'dpr-a-note-input',
              'data-dpr-input': 'note-text',
              value: text,
              placeholder: t(lang, 'notePlaceholder'),
              'aria-label': t(lang, 'noteInputLabel'),
              maxLength: NOTE_MAX_LENGTH,
              rows: 4,
              spellCheck: false,
              onChange: (event) => setText(event.target.value),
              onKeyDown: onTextareaKeyDown,
            }),
            h('p', { className: 'dpr-a-note-hint' }, t(lang, 'noteHint')),
            h(
              'div',
              { className: 'dpr-a-note-foot' },
              h(
                'span',
                { className: 'dpr-a-note-count' },
                t(lang, 'countLabel', { count: text.length, max: NOTE_MAX_LENGTH }),
              ),
              h(
                'div',
                { className: 'dpr-a-note-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-a-btn',
                    'data-dpr-action': 'note-cancel',
                    onClick: () => safeCall(latest.current.onCancel),
                  },
                  t(lang, 'cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-a-btn dpr-a-btn-primary',
                    'data-dpr-action': 'note-save',
                    disabled: !canSave,
                    onClick: save,
                  },
                  t(lang, 'save'),
                ),
              ),
            ),
        ),
      );
    }

    /* ================================================================== *
     * 11. NotesPanel — the side panel of notes + highlights
     * ================================================================== */

    /**
     * Coerce a value to a trimmed display string (kept for chips/quote text).
     * @param {unknown} value - candidate.
     * @returns {string} string form.
     */
    function asString(value) {
      return typeof value === 'string' ? value : '';
    }

    /**
     * `useSyncExternalStore` with a React 18 fallback so NotesPanel also works
     * on an older client React build.
     */
    const useExternalStore =
      typeof React.useSyncExternalStore === 'function'
        ? React.useSyncExternalStore
        : function useExternalStoreFallback(subscribe, getSnapshot) {
            const [state, setState] = React.useState(getSnapshot);
            React.useEffect(() => {
              const read = () => setState(getSnapshot());
              read();
              return subscribe(read);
            }, [subscribe, getSnapshot]);
            return state;
          };

    /**
     * Read a store snapshot reactively.
     * @param {object|null} store - annotation store (may be null).
     * @returns {{highlights: object[], notes: object[]}} snapshot.
     */
    function useStoreSnapshot(store) {
      const subscribe = React.useCallback(
        (listener) => (store && typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {}),
        [store],
      );
      const getSnapshot = React.useCallback(
        () => (store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : EMPTY_SNAPSHOT),
        [store],
      );
      return useExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /**
     * Fold a snapshot into display rows: a highlight and its linked note share
     * one row; standalone notes get a row of their own. Newest first.
     * @param {{highlights?: object[], notes?: object[]}} snapshot - store snapshot.
     * @returns {object[]} rows.
     */
    function buildAnnotationRows(snapshot) {
      const safe = isObject(snapshot) ? snapshot : EMPTY_SNAPSHOT;
      const highlights = Array.isArray(safe.highlights) ? safe.highlights.filter(isObject) : [];
      const notes = Array.isArray(safe.notes) ? safe.notes.filter(isObject) : [];
      const notesById = new Map();
      const notesByHighlight = new Map();
      const noteOrder = new Map();
      for (let index = 0; index < notes.length; index++) {
        const noteId = asString(notes[index].id);
        if (noteId !== '') noteOrder.set(noteId, index);
      }
      for (const note of notes) {
        if (asString(note.id) !== '') notesById.set(note.id, note);
        const highlightId = asString(note.highlightId);
        if (highlightId === '') continue;
        if (!notesByHighlight.has(highlightId)) notesByHighlight.set(highlightId, []);
        notesByHighlight.get(highlightId).push(note);
      }
      const rows = [];
      const consumedNoteIds = new Set();
      for (const highlight of highlights) {
        const id = asString(highlight.id);
        if (id === '') continue;
        const candidates = [];
        const directNoteId = asString(highlight.noteId);
        if (directNoteId !== '' && notesById.has(directNoteId)) candidates.push(notesById.get(directNoteId));
        const indirect = notesByHighlight.get(id);
        if (Array.isArray(indirect)) {
          for (const note of indirect) {
            if (candidates.indexOf(note) === -1) candidates.push(note);
          }
        }
        const note = candidates.length > 0 ? candidates[candidates.length - 1] : null;
        for (const candidate of candidates) {
          if (asString(candidate.id) !== '') consumedNoteIds.add(candidate.id);
        }
        const highlightTime = Number.isFinite(Number(highlight.createdAt)) ? Number(highlight.createdAt) : 0;
        const noteTime = note !== null && Number.isFinite(Number(note.createdAt)) ? Number(note.createdAt) : 0;
        const linkedNoteOrder = note !== null ? noteOrder.get(asString(note.id)) : undefined;
        rows.push({
          key: 'highlight:' + id,
          kind: 'highlight',
          highlight,
          note,
          page: asPage(highlight.page),
          color: asColor(highlight.color),
          quote: asString(highlight.text),
          noteText: note !== null ? asString(note.text) : '',
          createdAt: Math.max(highlightTime, noteTime),
          order: typeof linkedNoteOrder === 'number' ? linkedNoteOrder : rows.length,
        });
      }
      for (const note of notes) {
        const id = asString(note.id);
        if (id === '' || consumedNoteIds.has(id)) continue;
        rows.push({
          key: 'note:' + id,
          kind: 'note',
          highlight: null,
          note,
          page: asPage(note.page),
          color: null,
          quote: asString(note.quote),
          noteText: asString(note.text),
          createdAt: Number.isFinite(Number(note.createdAt)) ? Number(note.createdAt) : 0,
          order: typeof noteOrder.get(id) === 'number' ? noteOrder.get(id) : rows.length,
        });
      }
      rows.sort((left, right) => right.createdAt - left.createdAt || right.order - left.order);
      return rows;
    }

    /**
     * Side panel listing highlights and notes, newest first. Rows jump back to
     * their page, and each row can delete its annotation. Subscribes to the
     * store so panel content follows newly created highlights/notes.
     *
     * Layout-neutral: the component fills whatever sized, positioned container
     * the app shell provides (the shell owns the panel width, border and
     * shadow), so no absolute offsets are baked in.
     * @param {object} props - lang, store, onJump, onClose.
     * @returns {React.ReactElement} panel.
     */
    function NotesPanel(props) {
      const source = isObject(props) ? props : {};
      const lang = source.lang;
      const snapshot = useStoreSnapshot(source.store);
      const rows = buildAnnotationRows(snapshot);
      const latest = React.useRef(source);
      latest.current = source;

      /**
       * Delete one row's annotation(s): the highlight and its linked note.
       * @param {object} row - display row.
       * @returns {void}
       */
      function deleteRow(row) {
        const store = latest.current.store;
        if (!isObject(store)) return;
        if (row.highlight !== null && typeof store.removeHighlight === 'function') {
          safeCall(store.removeHighlight, row.highlight.id);
        }
        if (row.note !== null && typeof store.removeNote === 'function') {
          safeCall(store.removeNote, row.note.id);
        }
      }

      /**
       * Jump to the row's page.
       * @param {object} row - display row.
       * @returns {void}
       */
      function jumpTo(row) {
        safeCall(latest.current.onJump, row.page);
      }

      return h(
        Fragment,
        null,
        styleElement(NOTES_PANEL_CSS),
        h(
          'aside',
          { className: 'dpr-a-panel', 'data-dpr': 'notes-panel', 'aria-label': t(lang, 'panelTitle') },
          h(
            'header',
            { className: 'dpr-a-panel-head' },
            h('h2', { className: 'dpr-a-panel-title' }, t(lang, 'panelTitle')),
            h('span', { className: 'dpr-a-panel-count' }, t(lang, 'panelCount', { count: rows.length })),
            h('span', { className: 'dpr-a-panel-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dpr-a-icon-btn',
                'data-dpr-action': 'panel-close',
                title: t(lang, 'closePanel'),
                'aria-label': t(lang, 'closePanel'),
                onClick: () => safeCall(latest.current.onClose),
              },
              h(IconClose, { size: 13 }),
            ),
          ),
          rows.length === 0
            ? h(
                'div',
                { className: 'dpr-a-empty', 'data-dpr': 'notes-empty' },
                h('span', { className: 'dpr-a-empty-icon' }, h(IconEmpty, null)),
                h('p', { className: 'dpr-a-empty-title' }, t(lang, 'emptyTitle')),
                h('p', { className: 'dpr-a-empty-hint' }, t(lang, 'emptyHint')),
              )
            : h(
                'div',
                { className: 'dpr-a-panel-list' },
                rows.map((row) =>
                  h(
                    'div',
                    {
                      key: row.key,
                      className: 'dpr-a-row',
                      role: 'button',
                      tabIndex: 0,
                      'data-dpr-row': row.kind,
                      'data-page': String(row.page),
                      title: t(lang, 'jumpToPage', { page: row.page }),
                      onClick: () => jumpTo(row),
                      onKeyDown: (event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
                        event.preventDefault();
                        jumpTo(row);
                      },
                    },
                    h(
                      'div',
                      { className: 'dpr-a-row-head' },
                      h('span', {
                        className: 'dpr-a-dot',
                        'aria-hidden': 'true',
                        style: row.color !== null ? { backgroundColor: COLOR_FILLS[row.color] } : null,
                      }),
                      h('span', { className: 'dpr-a-page' }, t(lang, 'pageLabel', { page: row.page })),
                      h('span', { className: 'dpr-a-row-spacer' }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dpr-a-row-delete',
                          'data-dpr-action': 'delete-row',
                          title: t(lang, 'deleteRow'),
                          'aria-label': t(lang, 'deleteRow'),
                          onClick: (event) => {
                            event.stopPropagation();
                            deleteRow(row);
                          },
                        },
                        h(IconTrash, null),
                      ),
                    ),
                    row.quote !== '' ? h('p', { className: 'dpr-a-row-quote' }, row.quote) : null,
                    row.noteText !== '' ? h('p', { className: 'dpr-a-row-note' }, row.noteText) : null,
                  ),
                ),
              ),
        ),
      );
    }

    /* ================================================================== *
     * 12. Exports (frozen contract)
     * ================================================================== */

    return {
      createAnnotationStore,
      HighlightLayer,
      SelectionMenu,
      NoteComposer,
      NotesPanel,
      buildAskPrompt,
      ANNOTATION_COLORS,
    };
  },
});
