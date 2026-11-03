/**
 * dsh-paper-reader — paper library chunk (upload / IndexedDB persistence / list).
 *
 * Lazy sibling chunk of the plugin client bundle. Loaded with
 * `require.async('./client.library.js')`; exports `{ createPaperStore,
 * PaperLibrary, formatBytes }`.
 *
 * Responsibilities:
 *   - `createPaperStore()`: IndexedDB-backed paper store (DB `dsh-paper-reader`
 *     v1, object store `papers`, keyPath `id`). Records are
 *     `{ id, name, title, size, addedAt, bytes }`; the public snapshot only
 *     exposes metadata (`PaperMeta`). Snapshots are reference-stable.
 *   - `PaperLibrary({ lang, store, onOpen })`: upload drop zone + native file
 *     picker, localized validation errors, paper rows (title / size / date),
 *     click to open, two-step inline delete confirmation, loading + empty
 *     states. Designed to stay usable at a ~320 px right-sidebar width.
 *   - `formatBytes(n)`: human readable byte size used by the row meta line.
 *
 * All copy lives in the private `STRINGS` table and is selected by the `lang`
 * prop (`'zh' | 'en'`); the locale service is never touched here. Styling uses
 * `--dsw-alias-*` theme tokens only, under the `dpr-lib-` class prefix.
 *
 * Store errors carry a stable `.code` (`'not-pdf' | 'too-large' |
 * 'read-failed' | 'storage-unavailable' | 'not-found' | 'invalid-title'`) so the
 * view can localize them without parsing messages.
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  chunk: 'client.library.js',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** IndexedDB database name shared with any other reader code. */
    const DB_NAME = 'dsh-paper-reader';
    /** IndexedDB schema version; bump only for a migration. */
    const DB_VERSION = 1;
    /** Object store holding one record per uploaded paper. */
    const STORE_NAME = 'papers';
    /** Hard upload cap: 100 MB. */
    const MAX_PAPER_BYTES = 100 * 1024 * 1024;
    /** `%PDF-` file header, the canonical PDF magic number. */
    const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

    const STRINGS = {
      zh: {
        uploadAria: '上传论文 PDF',
        uploadTitle: '上传论文',
        uploadHint: '点击选择 PDF，或将文件拖到这里',
        uploadDrop: '松开即可导入 PDF',
        uploading: '正在导入…',
        uploadBusyHint: '正在保存到论文库',
        loading: '正在加载论文库…',
        emptyTitle: '还没有论文',
        emptyHint: '上传 PDF 后，就能在这里打开并阅读。',
        papersCount: '{count} 篇论文',
        papersCountOne: '{count} 篇论文',
        ariaList: '论文列表',
        delete: '删除',
        confirmDelete: '删除',
        cancel: '取消',
        confirmHint: '确定删除这篇论文？',
        errorNotPdf: '这不是 PDF 文件，请选择 PDF 格式的论文。',
        errorTooLarge: '文件超过 100 MB，无法导入。',
        errorRead: '读取文件失败，请重试。',
        errorStorage: '浏览器存储不可用，论文无法保存。',
        errorUnknown: '导入失败，请重试。',
        errorDismiss: '关闭',
      },
      en: {
        uploadAria: 'Upload a paper (PDF)',
        uploadTitle: 'Upload a paper',
        uploadHint: 'Click to choose a PDF, or drop one here',
        uploadDrop: 'Release to import the PDF',
        uploading: 'Importing…',
        uploadBusyHint: 'Saving to your library…',
        loading: 'Loading your library…',
        emptyTitle: 'No papers yet',
        emptyHint: 'Upload a PDF and it will appear here, ready to read.',
        papersCount: '{count} papers',
        papersCountOne: '1 paper',
        ariaList: 'Paper list',
        delete: 'Delete',
        confirmDelete: 'Delete',
        cancel: 'Cancel',
        confirmHint: 'Delete this paper?',
        errorNotPdf: 'That file is not a PDF. Please choose a PDF paper.',
        errorTooLarge: 'That file is larger than 100 MB and can’t be imported.',
        errorRead: 'Couldn’t read the file. Please try again.',
        errorStorage: 'Browser storage is unavailable, so papers can’t be saved.',
        errorUnknown: 'Import failed. Please try again.',
        errorDismiss: 'Dismiss',
      },
    };

    /**
     * Translate one library string.
     * @param lang - `'zh'` or `'en'`.
     * @param key - string key.
     * @param params - optional `{name}` template parameters.
     * @returns localized text; falls back to Chinese, then to the key.
     */
    function translate(lang, key, params) {
      const dict = STRINGS[lang] || STRINGS.zh;
      let template = dict[key];
      if (template === undefined) template = STRINGS.zh[key];
      if (template === undefined) template = key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }

    /**
     * Build a store error carrying a stable machine-readable code.
     * @param code - error code consumed by the view.
     * @param message - developer-facing English message.
     * @param cause - optional underlying error.
     * @returns the error.
     */
    function makeStoreError(code, message, cause) {
      const error = new Error(message || code);
      error.name = 'PaperStoreError';
      error.code = code;
      if (cause !== undefined) error.cause = cause;
      return error;
    }

    /**
     * Read an error's stable code, defaulting to `'unknown'`.
     * @param error - thrown value.
     * @returns the code string.
     */
    function errorCodeOf(error) {
      if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code !== '') {
        return error.code;
      }
      return 'unknown';
    }

    /**
     * Format a byte count with binary units, e.g. `1536` → `1.5 KB`.
     * @param n - byte count.
     * @returns human readable size.
     */
    function formatBytes(n) {
      const value = typeof n === 'number' && Number.isFinite(n) ? n : 0;
      if (value <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let amount = value;
      let unit = 0;
      while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
      }
      if (unit === 0) return `${Math.round(amount)} B`;
      const rounded = Math.round(amount * 10) / 10;
      return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} ${units[unit]}`;
    }

    /** Cached `Intl.DateTimeFormat` instances, one per language. */
    const DATE_FORMATTERS = new Map();

    /**
     * Format a stored timestamp as a short local date.
     * @param timestamp - epoch milliseconds.
     * @param lang - `'zh'` or `'en'`.
     * @returns localized date, or an empty string when unusable.
     */
    function formatDate(timestamp, lang) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '';
      try {
        let formatter = DATE_FORMATTERS.get(lang);
        if (formatter === undefined) {
          formatter = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
            year: 'numeric',
            month: lang === 'zh' ? 'numeric' : 'short',
            day: 'numeric',
          });
          DATE_FORMATTERS.set(lang, formatter);
        }
        return formatter.format(new Date(timestamp));
      } catch (error) {
        const date = new Date(timestamp);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${date.getFullYear()}-${month}-${day}`;
      }
    }

    /**
     * Whether a byte array starts with the `%PDF-` magic header.
     * @param bytes - candidate PDF bytes.
     * @returns true when the header matches.
     */
    function hasPdfMagic(bytes) {
      if (bytes === null || bytes === undefined || bytes.length < PDF_MAGIC.length) return false;
      for (let index = 0; index < PDF_MAGIC.length; index += 1) {
        if (bytes[index] !== PDF_MAGIC[index]) return false;
      }
      return true;
    }

    /**
     * Read a `File`/`Blob` into a fresh `Uint8Array`.
     * @param file - browser File (or a blob-like object exposing `arrayBuffer`).
     * @returns the file bytes.
     */
    async function readFileBytes(file) {
      if (file !== null && typeof file === 'object' && typeof file.arrayBuffer === 'function') {
        try {
          const buffer = await file.arrayBuffer();
          return new Uint8Array(buffer);
        } catch (error) {
          /* fall through to the FileReader path */
        }
      }
      if (file !== null && typeof file === 'object' && typeof file.slice === 'function' && typeof FileReader !== 'undefined') {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result;
            if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
            else reject(makeStoreError('read-failed', 'Could not read the file'));
          };
          reader.onerror = () => reject(makeStoreError('read-failed', 'Could not read the file', reader.error));
          try {
            reader.readAsArrayBuffer(file);
          } catch (error) {
            reject(makeStoreError('read-failed', 'Could not read the file', error));
          }
        });
      }
      throw makeStoreError('read-failed', 'Could not read the file');
    }

    /**
     * Normalize any structured-cloned bytes value into an independent `Uint8Array`.
     * IndexedDB may hand back a `Uint8Array`, another view, or an `ArrayBuffer`.
     * @param value - stored bytes value.
     * @returns a copy of the bytes, or null when the value is not byte data.
     */
    function toUint8Array(value) {
      if (value === null || value === undefined) return null;
      if (value instanceof Uint8Array) return new Uint8Array(value);
      if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value.slice(0));
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      }
      if (Array.isArray(value)) return Uint8Array.from(value);
      return null;
    }

    /**
     * Generate an opaque paper id.
     * @returns a unique id string.
     */
    function newPaperId() {
      try {
        if (typeof crypto !== 'undefined' && crypto !== null && typeof crypto.randomUUID === 'function') {
          return `paper-${crypto.randomUUID()}`;
        }
      } catch (error) {
        /* fall through to the time+random id */
      }
      return `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    /**
     * Derive the display title from a file name: basename without `.pdf`.
     * @param name - original file name.
     * @returns title candidate (never empty).
     */
    function titleFromName(name) {
      const raw = typeof name === 'string' ? name : '';
      const basename = raw.split(/[\\/]/).pop() || raw;
      const withoutExtension = basename.replace(/\.pdf$/i, '').trim();
      if (withoutExtension !== '') return withoutExtension;
      const fallback = basename.trim();
      return fallback !== '' ? fallback : 'paper';
    }

    /**
     * Project one IndexedDB record onto its public metadata shape.
     * @param record - stored paper record.
     * @returns `PaperMeta`.
     */
    function recordToMeta(record) {
      const value = record !== null && typeof record === 'object' ? record : {};
      const name = typeof value.name === 'string' && value.name !== '' ? value.name : String(value.id || 'paper');
      const title = typeof value.title === 'string' && value.title.trim() !== '' ? value.title.trim() : titleFromName(name);
      return {
        id: typeof value.id === 'string' && value.id !== '' ? value.id : String(value.id || ''),
        name,
        title,
        size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : 0,
        addedAt: typeof value.addedAt === 'number' && Number.isFinite(value.addedAt) ? value.addedAt : 0,
      };
    }

    /**
     * Sort papers newest first (stable tie-break by title).
     * @param a - first paper meta.
     * @param b - second paper meta.
     * @returns comparator result.
     */
    function comparePapers(a, b) {
      if (b.addedAt !== a.addedAt) return b.addedAt - a.addedAt;
      return String(a.title).localeCompare(String(b.title));
    }

    /**
     * Open (and on first use create) the library database.
     * @returns promise of an open `IDBDatabase`.
     */
    function openDatabase() {
      return new Promise((resolve, reject) => {
        let factory = null;
        try {
          factory = typeof indexedDB === 'undefined' ? null : indexedDB;
        } catch (error) {
          factory = null;
        }
        if (factory === null || factory === undefined) {
          reject(makeStoreError('storage-unavailable', 'IndexedDB is not available'));
          return;
        }
        let request;
        try {
          request = factory.open(DB_NAME, DB_VERSION);
        } catch (error) {
          reject(makeStoreError('storage-unavailable', 'Could not open paper storage', error));
          return;
        }
        let settled = false;
        /** Settle exactly once (open + blocked events can race). */
        function finish(callback, value) {
          if (settled) return;
          settled = true;
          callback(value);
        }
        request.onupgradeneeded = () => {
          const database = request.result;
          try {
            if (!database.objectStoreNames.contains(STORE_NAME)) {
              database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
          } catch (error) {
            finish(reject, makeStoreError('storage-unavailable', 'Could not prepare paper storage', error));
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          try {
            database.onversionchange = () => {
              try {
                database.close();
              } catch (error) {
                /* the database is already gone */
              }
            };
          } catch (error) {
            /* onversionchange is a best-effort guard */
          }
          finish(resolve, database);
        };
        request.onerror = () => {
          finish(reject, makeStoreError('storage-unavailable', 'Could not open paper storage', request.error));
        };
        request.onblocked = () => {
          finish(reject, makeStoreError('storage-unavailable', 'Paper storage is blocked by another tab'));
        };
      });
    }

    /**
     * Run one request inside a fresh transaction and resolve when it commits.
     * @param database - open database handle.
     * @param mode - `'readonly'` or `'readwrite'`.
     * @param run - receives the object store, returns the request to await.
     * @returns the request result after the transaction commits.
     */
    function runTransaction(database, mode, run) {
      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = database.transaction(STORE_NAME, mode);
        } catch (error) {
          reject(makeStoreError('storage-unavailable', 'Could not start paper storage transaction', error));
          return;
        }
        let settled = false;
        let result;
        /** Settle exactly once (request error also aborts the transaction). */
        function finish(callback, value) {
          if (settled) return;
          settled = true;
          callback(value);
        }
        transaction.oncomplete = () => finish(resolve, result);
        transaction.onerror = () => {
          finish(reject, makeStoreError('storage-unavailable', 'Paper storage transaction failed', transaction.error));
        };
        transaction.onabort = () => {
          finish(reject, makeStoreError('storage-unavailable', 'Paper storage transaction was aborted', transaction.error));
        };
        let request;
        try {
          request = run(transaction.objectStore(STORE_NAME));
        } catch (error) {
          try {
            transaction.abort();
          } catch (abortError) {
            /* already finished */
          }
          finish(reject, makeStoreError('storage-unavailable', 'Could not access paper storage', error));
          return;
        }
        if (request !== null && typeof request === 'object' && 'onsuccess' in request) {
          request.onsuccess = () => {
            result = request.result;
          };
          request.onerror = () => {
            try {
              transaction.abort();
            } catch (abortError) {
              /* already finished */
            }
            finish(reject, makeStoreError('storage-unavailable', 'Paper storage request failed', request.error));
          };
        } else {
          result = request;
        }
      });
    }

    /**
     * Create an IndexedDB-backed paper store.
     *
     * Snapshot shape: `{ papers: PaperMeta[], loaded: boolean, error?: string }`.
     * `error` is a stable code string (`'storage-unavailable'`) rather than a
     * localized sentence; the view owns the copy.
     *
     * @returns the paper store.
     */
    function createPaperStore() {
      /** @type {{papers: Array<{id:string,name:string,title:string,size:number,addedAt:number}>, loaded: boolean, error?: string}} */
      let snapshot = { papers: [], loaded: false };
      /** @type {Set<() => void>} */
      const listeners = new Set();
      /** @type {Promise<IDBDatabase> | null} */
      let databasePromise = null;
      /** @type {Promise<void> | null} */
      let initPromise = null;

      /**
       * Publish a new snapshot when anything actually changed (reference
       * stability keeps `useSyncExternalStore` render loops away).
       * @param papers - next paper metadata list.
       * @param loaded - whether the initial load finished.
       * @param error - optional error code; pass undefined to clear it.
       */
      function commit(papers, loaded, error) {
        const next = error === undefined ? { papers, loaded } : { papers, loaded, error };
        if (next.papers === snapshot.papers && next.loaded === snapshot.loaded && next.error === snapshot.error) {
          return;
        }
        snapshot = next;
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch (error2) {
            console.error('[dsh-paper-reader] library subscriber failed', error2);
          }
        }
      }

      /**
       * Get the open database, opening it lazily and retrying after failures.
       * @returns promise of the database.
       */
      function getDatabase() {
        if (databasePromise === null) {
          databasePromise = openDatabase().catch((error) => {
            databasePromise = null;
            throw error;
          });
        }
        return databasePromise;
      }

      /**
       * Load the paper list once; idempotent and never rejects (failures land
       * in the snapshot `error` code so the app keeps rendering).
       * @returns completion promise.
       */
      function init() {
        if (initPromise !== null) return initPromise;
        initPromise = (async () => {
          try {
            const database = await getDatabase();
            const records = await runTransaction(database, 'readonly', (store) => store.getAll());
            const papers = (Array.isArray(records) ? records : [])
              .map(recordToMeta)
              .filter((paper) => paper.id !== '')
              .sort(comparePapers);
            commit(papers, true, undefined);
          } catch (error) {
            initPromise = null;
            console.warn('[dsh-paper-reader] could not load the paper library', error);
            commit([], true, 'storage-unavailable');
          }
        })();
        return initPromise;
      }

      /**
       * Validate and persist one uploaded file.
       * @param file - browser `File` selected or dropped by the user.
       * @returns the stored paper metadata.
       */
      async function save(file) {
        if (file === null || typeof file !== 'object') {
          throw makeStoreError('read-failed', 'No file provided');
        }
        const declaredSize = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : -1;
        if (declaredSize > MAX_PAPER_BYTES) {
          throw makeStoreError('too-large', 'The file is larger than 100 MB');
        }
        const bytes = await readFileBytes(file);
        if (bytes.length > MAX_PAPER_BYTES) {
          throw makeStoreError('too-large', 'The file is larger than 100 MB');
        }
        if (!hasPdfMagic(bytes)) {
          throw makeStoreError('not-pdf', 'The file is not a PDF');
        }
        if (!snapshot.loaded) await init();
        const database = await getDatabase();
        const rawName = typeof file.name === 'string' ? file.name.trim() : '';
        const name = rawName !== '' ? rawName : `paper-${Date.now()}.pdf`;
        const meta = {
          id: newPaperId(),
          name,
          title: titleFromName(name),
          size: bytes.length,
          addedAt: Date.now(),
        };
        const record = {
          id: meta.id,
          name: meta.name,
          title: meta.title,
          size: meta.size,
          addedAt: meta.addedAt,
          bytes,
        };
        await runTransaction(database, 'readwrite', (store) => store.put(record));
        const remaining = snapshot.papers.filter((paper) => paper.id !== meta.id);
        commit([meta, ...remaining], true, undefined);
        return { id: meta.id, name: meta.name, title: meta.title, size: meta.size, addedAt: meta.addedAt };
      }

      /**
       * Read a stored paper's bytes (fresh copy, safe to transfer).
       * @param id - paper id.
       * @returns PDF bytes.
       */
      async function getBytes(id) {
        if (typeof id !== 'string' || id === '') throw makeStoreError('not-found', 'Paper not found');
        const database = await getDatabase();
        const record = await runTransaction(database, 'readonly', (store) => store.get(id));
        if (record === null || record === undefined) throw makeStoreError('not-found', 'Paper not found');
        const bytes = toUint8Array(record.bytes);
        if (bytes === null || bytes.length === 0) {
          throw makeStoreError('read-failed', 'Stored paper data is missing');
        }
        return bytes;
      }

      /**
       * Delete one paper.
       * @param id - paper id.
       * @returns completion promise.
       */
      async function remove(id) {
        if (typeof id !== 'string' || id === '') throw makeStoreError('not-found', 'Paper not found');
        const database = await getDatabase();
        await runTransaction(database, 'readwrite', (store) => store.delete(id));
        const index = snapshot.papers.findIndex((paper) => paper.id === id);
        if (index >= 0) {
          const papers = snapshot.papers.filter((paper) => paper.id !== id);
          commit(papers, snapshot.loaded, snapshot.error);
        }
      }

      /**
       * Rename one paper (the stored PDF title, not the file name).
       * @param id - paper id.
       * @param title - new display title.
       * @returns completion promise.
       */
      async function rename(id, title) {
        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        if (cleanTitle === '') throw makeStoreError('invalid-title', 'The title must not be empty');
        if (typeof id !== 'string' || id === '') throw makeStoreError('not-found', 'Paper not found');
        const database = await getDatabase();
        const record = await runTransaction(database, 'readonly', (store) => store.get(id));
        if (record === null || record === undefined) throw makeStoreError('not-found', 'Paper not found');
        const updated = { ...record, title: cleanTitle };
        await runTransaction(database, 'readwrite', (store) => store.put(updated));
        const papers = snapshot.papers.map((paper) =>
          paper.id === id ? { ...paper, title: cleanTitle } : paper,
        );
        commit(papers, snapshot.loaded, snapshot.error);
      }

      return {
        /** @returns the current stable snapshot. */
        getSnapshot() {
          return snapshot;
        },
        /**
         * Subscribe to snapshot changes.
         * @param listener - called after every committed change.
         * @returns unsubscribe function.
         */
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {};
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        init,
        save,
        getBytes,
        remove,
        rename,
      };
    }

    /** Upload glyph (arrow into a tray) for the drop zone. */
    function UploadIcon() {
      return h(
        'svg',
        { width: 22, height: 22, viewBox: '0 0 22 22', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M11 14.2V4.8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M7.5 8.2 11 4.7l3.5 3.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4.5 13.4v2.3a1.8 1.8 0 0 0 1.8 1.8h9.4a1.8 1.8 0 0 0 1.8-1.8v-2.3',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    /** Small paper-sheet glyph used in rows and the empty state. */
    function PaperIcon() {
      return h(
        'svg',
        { width: 15, height: 18, viewBox: '0 0 15 18', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M1.8 2.6c0-.9.7-1.6 1.6-1.6h5.5l4.3 4.3v10.1c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6V2.6Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.6 1.2v4.2h4.2',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4.6 9.4h5.8M4.6 12.2h4.2',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
        }),
      );
    }

    /** Trash glyph for the row delete control. */
    function TrashIcon() {
      return h(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.8 4.4h10.4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M6.2 4.4V3.1c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.3',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M4.3 4.4 4.9 12.6c0 .6.5 1 1 1h4.2c.6 0 1-.4 1-1l.6-8.2',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** Close glyph for dismissing the error banner. */
    function CloseIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.4 2.4 9.6 9.6M9.6 2.4 2.4 9.6',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * Map a store error code to its localized string key.
     * @param code - stable error code.
     * @returns `STRINGS` key.
     */
    function errorTextKey(code) {
      switch (code) {
        case 'not-pdf':
          return 'errorNotPdf';
        case 'too-large':
          return 'errorTooLarge';
        case 'read-failed':
          return 'errorRead';
        case 'storage-unavailable':
          return 'errorStorage';
        default:
          return 'errorUnknown';
      }
    }

    /**
     * Whether a drag event carries files.
     * @param event - drag event.
     * @returns true when `DataTransfer.types` or the file list contains files.
     */
    function isFileDrag(event) {
      const dataTransfer = event !== null && typeof event === 'object' ? event.dataTransfer : null;
      if (dataTransfer === null || dataTransfer === undefined) return false;
      const types = dataTransfer.types;
      if (types !== null && types !== undefined && typeof types.length === 'number') {
        for (let index = 0; index < types.length; index += 1) {
          if (types[index] === 'Files') return true;
        }
      }
      return !!(dataTransfer.files && dataTransfer.files.length > 0);
    }

    /**
     * The library view.
     *
     * @param props - `{ lang, store, onOpen(meta) }`.
     * @returns the library panel.
     */
    function PaperLibrary(props) {
      const lang = props.lang === 'en' ? 'en' : 'zh';
      const providedStore = props.store;
      const fallbackStoreRef = React.useRef(null);
      if ((providedStore === undefined || providedStore === null) && fallbackStoreRef.current === null) {
        fallbackStoreRef.current = createPaperStore();
      }
      const store = providedStore === undefined || providedStore === null ? fallbackStoreRef.current : providedStore;
      const onOpen = props.onOpen;

      const subscribe = React.useCallback((listener) => store.subscribe(listener), [store]);
      const readSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
      const snapshot = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

      const [dragging, setDragging] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      /** @type {[{code: string} | null, Function]} */
      const [error, setError] = React.useState(null);
      const [confirmId, setConfirmId] = React.useState(null);
      const [removingId, setRemovingId] = React.useState(null);
      const inputRef = React.useRef(null);
      const dragDepthRef = React.useRef(0);
      const mountedRef = React.useRef(true);

      /** Localize one string in the component language. */
      function tr(key, params) {
        return translate(lang, key, params);
      }

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      React.useEffect(() => {
        let cancelled = false;
        Promise.resolve()
          .then(() => store.init())
          .catch((initError) => {
            if (!cancelled) console.warn('[dsh-paper-reader] paper library init rejected', initError);
          });
        return () => {
          cancelled = true;
        };
      }, [store]);

      React.useEffect(() => {
        if (snapshot.error !== undefined && snapshot.error !== null) {
          setError((current) => (current === null ? { code: snapshot.error } : current));
        }
      }, [snapshot.error]);

      React.useEffect(() => {
        if (confirmId === null) return undefined;
        const timer = setTimeout(() => {
          if (mountedRef.current) setConfirmId(null);
        }, 6000);
        return () => clearTimeout(timer);
      }, [confirmId]);

      const importFiles = React.useCallback(
        async (files) => {
          const list = [];
          if (files !== null && files !== undefined && typeof files.length === 'number') {
            for (let index = 0; index < files.length; index += 1) {
              const file = files[index];
              if (file !== null && file !== undefined) list.push(file);
            }
          }
          if (list.length === 0) return;
          setBusy(true);
          setError(null);
          let firstFailure = null;
          for (const file of list) {
            try {
              await store.save(file);
            } catch (saveError) {
              if (firstFailure === null) firstFailure = saveError;
            }
          }
          if (!mountedRef.current) return;
          setBusy(false);
          if (firstFailure !== null) setError({ code: errorCodeOf(firstFailure) });
        },
        [store],
      );

      const openPicker = React.useCallback(() => {
        const input = inputRef.current;
        if (input === null || input === undefined) return;
        try {
          input.value = '';
        } catch (resetError) {
          /* a read-only value is still clickable */
        }
        if (typeof input.click === 'function') input.click();
      }, []);

      const onInputChange = React.useCallback(
        (event) => {
          const target = event !== null && event !== undefined ? event.target : null;
          const files = target !== null && target !== undefined ? target.files : null;
          importFiles(files);
          if (target !== null && target !== undefined) {
            try {
              target.value = '';
            } catch (resetError) {
              /* re-selecting the same file still works in most browsers */
            }
          }
        },
        [importFiles],
      );

      const onDragEnter = (event) => {
        event.preventDefault();
        if (!isFileDrag(event)) return;
        dragDepthRef.current += 1;
        if (!dragging) setDragging(true);
      };

      const onDragOver = (event) => {
        event.preventDefault();
        if (!isFileDrag(event)) return;
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
          try {
            event.dataTransfer.dropEffect = 'copy';
          } catch (dropEffectError) {
            /* read-only dataTransfer in synthetic events */
          }
        }
        if (!dragging) {
          dragDepthRef.current = Math.max(dragDepthRef.current, 1);
          setDragging(true);
        }
      };

      const onDragLeave = (event) => {
        event.preventDefault();
        if (!isFileDrag(event)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
      };

      const onDragEnd = () => {
        dragDepthRef.current = 0;
        setDragging(false);
      };

      const onDrop = (event) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        if (busy) return;
        const dataTransfer = event.dataTransfer;
        if (dataTransfer === null || dataTransfer === undefined) return;
        const files = dataTransfer.files;
        if (files !== null && files !== undefined && files.length > 0) importFiles(files);
      };

      const openPaper = (meta) => {
        setConfirmId(null);
        if (typeof onOpen !== 'function') return;
        try {
          onOpen(meta);
        } catch (openError) {
          console.error('[dsh-paper-reader] opening a paper failed', openError);
        }
      };

      const confirmDelete = async (meta) => {
        if (removingId !== null) return;
        setRemovingId(meta.id);
        setError(null);
        try {
          await store.remove(meta.id);
          if (mountedRef.current) {
            setConfirmId(null);
            setRemovingId(null);
          }
        } catch (removeError) {
          if (mountedRef.current) {
            setConfirmId(null);
            setRemovingId(null);
            setError({ code: errorCodeOf(removeError) });
          }
        }
      };

      const papers = Array.isArray(snapshot.papers) ? snapshot.papers : [];
      const loaded = snapshot.loaded === true;
      const errorMessage = error === null ? null : tr(errorTextKey(error.code));
      const countLabel =
        papers.length === 1 && lang === 'en'
          ? tr('papersCountOne')
          : tr('papersCount', { count: papers.length });

      /**
       * Render one paper row.
       * @param meta - paper metadata.
       * @returns list row element.
       */
      function renderRow(meta) {
        const confirming = confirmId === meta.id;
        const removing = removingId === meta.id;
        const fullTitle = typeof meta.title === 'string' && meta.title !== '' ? meta.title : meta.name;
        return h(
          'li',
          {
            key: meta.id,
            className: 'dpr-lib-row',
            'data-testid': 'dpr-lib-row',
            'data-paper-id': meta.id,
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dpr-lib-row-open',
              onClick: () => openPaper(meta),
              title: fullTitle,
              'data-testid': 'dpr-lib-row-open',
            },
            h('span', { className: 'dpr-lib-row-icon', 'aria-hidden': 'true' }, h(PaperIcon, null)),
            h(
              'span',
              { className: 'dpr-lib-row-text' },
              h('span', { className: 'dpr-lib-row-title' }, fullTitle),
              h(
                'span',
                { className: 'dpr-lib-row-meta' },
                h('span', { className: 'dpr-lib-row-size' }, formatBytes(meta.size)),
                h('span', { className: 'dpr-lib-row-sep', 'aria-hidden': 'true' }, '·'),
                h('span', { className: 'dpr-lib-row-date' }, formatDate(meta.addedAt, lang)),
              ),
            ),
          ),
          confirming
            ? h(
                'span',
                { className: 'dpr-lib-confirm', 'data-testid': 'dpr-lib-confirm' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-lib-confirm-delete',
                    onClick: () => confirmDelete(meta),
                    disabled: removing,
                    title: tr('confirmHint'),
                    'aria-label': tr('confirmHint'),
                    'data-testid': 'dpr-lib-confirm-delete',
                  },
                  removing ? h('span', { className: 'dpr-lib-spinner dpr-lib-spinner-sm', 'aria-hidden': 'true' }) : tr('confirmDelete'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-lib-confirm-cancel',
                    onClick: () => setConfirmId(null),
                    disabled: removing,
                    'data-testid': 'dpr-lib-confirm-cancel',
                  },
                  tr('cancel'),
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dpr-lib-row-delete',
                  onClick: () => setConfirmId(meta.id),
                  title: tr('delete'),
                  'aria-label': tr('delete'),
                  'data-testid': 'dpr-lib-delete',
                },
                h(TrashIcon, null),
              ),
        );
      }

      let body;
      if (!loaded) {
        body = h(
          'div',
          { className: 'dpr-lib-loading', 'data-testid': 'dpr-lib-loading' },
          h('span', { className: 'dpr-lib-spinner', 'aria-hidden': 'true' }),
          h('span', null, tr('loading')),
        );
      } else if (papers.length === 0) {
        body = h(
          'div',
          { className: 'dpr-lib-empty', 'data-testid': 'dpr-lib-empty' },
          h('span', { className: 'dpr-lib-empty-icon', 'aria-hidden': 'true' }, h(PaperIcon, null)),
          h('span', { className: 'dpr-lib-empty-title' }, tr('emptyTitle')),
          h('span', { className: 'dpr-lib-empty-hint' }, tr('emptyHint')),
        );
      } else {
        body = h(
          React.Fragment,
          null,
          h('div', { className: 'dpr-lib-count', 'data-testid': 'dpr-lib-count' }, countLabel),
          h(
            'ul',
            {
              className: 'dpr-lib-list',
              'aria-label': tr('ariaList'),
              'data-testid': 'dpr-lib-list',
            },
            papers.map(renderRow),
          ),
        );
      }

      return h(
        'div',
        {
          className: 'dpr-lib-root',
          'data-testid': 'dpr-library',
          'data-lang': lang,
          'data-dragging': dragging ? 'true' : 'false',
          'data-loaded': loaded ? 'true' : 'false',
          onDragEnter,
          onDragOver,
          onDragLeave,
          onDrop,
          onDragEnd,
        },
        h('style', {
          'data-plugin': 'dsh-paper-reader-platform-library',
          dangerouslySetInnerHTML: { __html: LIBRARY_CSS },
        }),
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: 'application/pdf,.pdf',
          className: 'dpr-lib-file-input',
          onChange: onInputChange,
          'data-testid': 'dpr-lib-file-input',
          tabIndex: -1,
          'aria-hidden': 'true',
        }),
        h(
          'button',
          {
            type: 'button',
            className: `dpr-lib-dropzone${dragging ? ' dpr-lib-dropzone-active' : ''}`,
            onClick: openPicker,
            disabled: busy,
            'data-testid': 'dpr-lib-upload',
            'aria-label': tr('uploadAria'),
          },
          h(
            'span',
            { className: 'dpr-lib-drop-icon', 'aria-hidden': 'true' },
            busy ? h('span', { className: 'dpr-lib-spinner' }) : h(UploadIcon, null),
          ),
          h(
            'span',
            { className: 'dpr-lib-drop-title' },
            busy ? tr('uploading') : dragging ? tr('uploadDrop') : tr('uploadTitle'),
          ),
          h('span', { className: 'dpr-lib-drop-hint' }, busy ? tr('uploadBusyHint') : tr('uploadHint')),
        ),
        errorMessage === null
          ? null
          : h(
              'div',
              { className: 'dpr-lib-error', role: 'alert', 'data-testid': 'dpr-lib-error' },
              h('span', { className: 'dpr-lib-error-text' }, errorMessage),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dpr-lib-error-close',
                  onClick: () => setError(null),
                  title: tr('errorDismiss'),
                  'aria-label': tr('errorDismiss'),
                  'data-testid': 'dpr-lib-error-close',
                },
                h(CloseIcon, null),
              ),
            ),
        body,
      );
    }

    /** Library panel styles: `--dsw-alias-*` tokens only, `dpr-lib-` prefix. */
    const LIBRARY_CSS = `
.dpr-lib-root{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;height:100%;min-height:0;padding:12px;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.4;}
.dpr-lib-root *,.dpr-lib-root *::before,.dpr-lib-root *::after{box-sizing:border-box;}
.dpr-lib-file-input{display:none;}
.dpr-lib-dropzone{appearance:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:0 0 auto;width:100%;min-width:0;margin:0;padding:16px 12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;text-align:center;cursor:pointer;transition:background .15s ease,border-color .15s ease;}
.dpr-lib-dropzone:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);}
.dpr-lib-dropzone:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.dpr-lib-dropzone:disabled{cursor:default;opacity:.9;}
.dpr-lib-dropzone-active,.dpr-lib-dropzone-active:hover:not(:disabled){border-style:solid;border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);}
.dpr-lib-drop-icon{display:flex;align-items:center;justify-content:center;height:22px;color:var(--dsw-alias-brand-primary);}
.dpr-lib-drop-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.35;overflow-wrap:anywhere;}
.dpr-lib-drop-hint{max-width:230px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.45;overflow-wrap:anywhere;}
.dpr-lib-spinner{display:inline-block;width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary);animation:dpr-lib-spin .8s linear infinite;}
.dpr-lib-spinner-sm{width:11px;height:11px;border-width:1.5px;}
@keyframes dpr-lib-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dpr-lib-spinner{animation-duration:2.6s}}
.dpr-lib-error{display:flex;align-items:flex-start;gap:8px;flex:0 0 auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;}
.dpr-lib-error-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}
.dpr-lib-error-close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;margin:0;padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;}
.dpr-lib-error-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dpr-lib-error-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.dpr-lib-loading{display:flex;align-items:center;justify-content:center;gap:8px;flex:1 1 auto;min-height:80px;padding:18px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;}
.dpr-lib-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1 1 auto;min-height:120px;padding:16px 8px;text-align:center;color:var(--dsw-alias-label-tertiary);}
.dpr-lib-empty-icon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;margin-bottom:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);}
.dpr-lib-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.dpr-lib-empty-hint{max-width:240px;font-size:11.5px;line-height:1.55;overflow-wrap:anywhere;}
.dpr-lib-count{flex:0 0 auto;padding:0 2px;font-size:11px;color:var(--dsw-alias-label-tertiary);}
.dpr-lib-list{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;margin:0;padding:0 0 2px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;list-style:none;}
.dpr-lib-row{display:flex;align-items:center;gap:2px;min-width:0;border-radius:10px;scrollbar-width:thin;}
.dpr-lib-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dpr-lib-row-open{appearance:none;display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;margin:0;padding:8px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;}
.dpr-lib-row-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.dpr-lib-row-icon{display:flex;align-items:center;justify-content:center;flex:none;width:24px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);}
.dpr-lib-row-text{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;}
.dpr-lib-row-title{display:block;max-width:100%;overflow:hidden;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;}
.dpr-lib-row-meta{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
.dpr-lib-row-size{flex:none;}
.dpr-lib-row-sep{flex:none;}
.dpr-lib-row-date{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.dpr-lib-row-delete{appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;margin:0;padding:0;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;}
.dpr-lib-row-delete:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dpr-lib-row-delete:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.dpr-lib-confirm{display:inline-flex;align-items:center;gap:4px;flex:none;padding-right:2px;}
.dpr-lib-confirm-delete,.dpr-lib-confirm-cancel{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;margin:0;padding:4px 7px;border:1px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1.2;white-space:nowrap;cursor:pointer;}
.dpr-lib-confirm-delete{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}
.dpr-lib-confirm-delete:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.dpr-lib-confirm-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dpr-lib-confirm-delete:focus-visible,.dpr-lib-confirm-cancel:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.dpr-lib-confirm-delete:disabled,.dpr-lib-confirm-cancel:disabled{opacity:.6;cursor:default;}
@media (max-width:380px){.dpr-lib-root{padding:10px;gap:8px;}.dpr-lib-dropzone{padding:14px 10px;}.dpr-lib-drop-hint{max-width:100%;}.dpr-lib-row-open{padding:7px;gap:7px;}.dpr-lib-row-delete{width:26px;height:26px;}}
`;

    return { createPaperStore, PaperLibrary, formatBytes };
  },
});
