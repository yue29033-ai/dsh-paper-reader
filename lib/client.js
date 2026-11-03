/**
 * dsh-paper-reader — Client half (main bundle).
 *
 * Registers one page tab type on the shipped right Sidebar
 * (`ctx.sidebarRightTabs`) with a guide entry, and one body under the keyed
 * `sidebar.right.pane.tab` seat. The heavy UI lives in lazily-loaded sibling
 * chunks (`client.app.js`, `client.viewer.js`, `client.annotations.js`,
 * `client.library.js`) — the module system fetches those with
 * `require.async('./client.<name>.js')` only when the tab first opens.
 *
 * This bundle owns:
 *   - the plugin's own copy (tab title, guide card) in both shipped locales;
 *   - the per-Session `core` face handed to the app: Session id, PDF.js vendor
 *     base URL, and the "ask in session" composer insertion;
 *   - error isolation so a reader crash never blanks the Sidebar.
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Package id: also the tab type id, the body key, and the client bundle row id. */
    const PKG = 'dsh-paper-reader';
    /** Page tab kind: what `ctx.sidebarRight.openTab` names and the guide card opens. */
    const KIND = 'paper-reader';
    /** Same-origin base of the vendored PDF.js files served by the Host half. */
    const VENDOR_BASE = '/paper-reader/vendor/';

    /** This bundle's own copy. Feature chunks carry their own strings. */
    const STRINGS = {
      zh: {
        'tab.title': '论文阅读器',
        'guide.title': '论文阅读器',
        'guide.description': '上传论文并按原始排版完整阅读；选中文字即可高亮、记笔记或在会话中提问。',
        'body.loading': '正在加载阅读器…',
        'body.error': '论文阅读器加载失败',
        'body.retry': '重试',
      },
      en: {
        'tab.title': 'Paper Reader',
        'guide.title': 'Paper Reader',
        'guide.description': 'Upload a paper and read it with its original layout; select text to highlight it, note it, or ask about it in the chat.',
        'body.loading': 'Loading reader…',
        'body.error': 'The paper reader failed to load',
        'body.retry': 'Retry',
      },
    };

    /**
     * Read the active locale id.
     * @param ctx - client context carrying the locale service.
     * @returns `'zh'` for any Chinese locale, `'en'` otherwise.
     */
    function activeLang(ctx) {
      try {
        const id = String(ctx.locale.getLocale().active || 'en').toLowerCase();
        return id.startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    /**
     * Translate one main-bundle string in the current locale.
     * @param ctx - client context.
     * @param key - dictionary key.
     * @param params - `{name}` template parameters.
     * @returns localized text, falling back to English, then the key.
     */
    function tr(ctx, key, params) {
      const dict = STRINGS[activeLang(ctx)] || STRINGS.en;
      const template = dict[key] ?? STRINGS.en[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }

    /** Guide-card glyph (a paper sheet with a checked mark). */
    function GuideIcon() {
      return h(
        'svg',
        {
          width: 22,
          height: 22,
          viewBox: '0 0 22 22',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          x: 4.2,
          y: 2.6,
          width: 13.6,
          height: 16.8,
          rx: 2.4,
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        h('path', {
          d: 'M7.6 7.2h5.2M7.6 10.4h6.8M7.6 13.6h4.2',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 15.6, cy: 16.2, r: 3.4, fill: 'var(--dsw-alias-brand-primary, #4d6bfe)' }),
        h('path', {
          d: 'M14.2 16.2l1 1 1.9-2',
          stroke: '#fff',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** Error boundary: one reader crash shows a localized strip, never a blank panel. */
    class ReaderBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        console.error('[dsh-paper-reader] reader crashed', error, info);
      }

      render() {
        if (this.state.error === null) return this.props.children;
        return h(
          'div',
          { className: 'dpr-body-error', role: 'alert' },
          h('div', { className: 'dpr-body-error-text' }, this.props.message),
          h(
            'button',
            {
              type: 'button',
              className: 'dpr-btn',
              onClick: () => this.setState({ error: null }),
            },
            this.props.retryLabel,
          ),
        );
      }
    }

    /** Centered spinner shown while the app chunk arrives. */
    function LoadingState(props) {
      return h(
        'div',
        { className: 'dpr-loading' },
        h('span', { className: 'dpr-spinner', 'aria-hidden': 'true' }),
        h('span', null, props.label),
      );
    }

    /** Lazy-loaded application chunk. */
    let lazyApp;
    /** @returns the app chunk as a React.lazy component. */
    function appComponent() {
      if (lazyApp === undefined) {
        lazyApp = React.lazy(() =>
          require.async('./client.app.js').then((mod) => ({ default: mod.PaperReaderApp })),
        );
      }
      return lazyApp;
    }

    /**
     * One tab body: locale-subscribed shell around the lazily loaded app.
     * @param props - injected `core` share.
     * @returns the reader.
     */
    function PaperReaderBody(props) {
      const { core } = props;
      const ctx = core.ctx;
      const locale = React.useSyncExternalStore(
        (cb) => ctx.locale.subscribe(cb),
        () => ctx.locale.getLocale(),
        () => ctx.locale.getLocale(),
      );
      const lang = String(locale.active || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      const App = appComponent();
      return h(
        React.Fragment,
        null,
        h(ReaderStyle, null),
        h(
          ReaderBoundary,
          { message: tr(ctx, 'body.error'), retryLabel: tr(ctx, 'body.retry') },
          h(
            React.Suspense,
            { fallback: h(LoadingState, { label: tr(ctx, 'body.loading') }) },
            h(App, { core, lang }),
          ),
        ),
      );
    }

    /** Base styles every reader chunk builds on (theme tokens only). */
    function ReaderStyle() {
      return h('style', {
        'data-plugin': PKG,
        dangerouslySetInnerHTML: {
          __html: `
.dpr-root{all:initial;display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font:inherit;background:var(--dsw-alias-bg-base);}
.dpr-root *,.dpr-root *::before,.dpr-root *::after{box-sizing:border-box;}
.dpr-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;color:var(--dsw-alias-label-secondary);font-size:13px;}
.dpr-spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dpr-spin .8s linear infinite;}
@keyframes dpr-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dpr-spinner{animation-duration:2.4s}}
.dpr-body-error{display:flex;flex-direction:column;gap:10px;align-items:flex-start;margin:16px;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:13px;background:var(--dsw-alias-bg-layer-1);}
.dpr-btn{appearance:none;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;padding:6px 10px;border-radius:8px;cursor:pointer;}
.dpr-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dpr-btn:disabled{opacity:.5;cursor:default;}
`,
        },
      });
    }

    /**
     * Append text into one Session's composer draft.
     *
     * Mirrors dsh-better-sidebar's proven path: a chipless draft takes the
     * whole-string `setDraft`; a draft carrying reference/command chips must
     * take the span channel so the chips are not flattened into text.
     * @param ctx - client context.
     * @param sessionId - Session whose composer is appended to.
     * @param text - text to append.
     * @returns whether the draft was written.
     */
    function appendToDraft(ctx, sessionId, text) {
      try {
        const scope = ctx.sessions && typeof ctx.sessions.scope === 'function'
          ? ctx.sessions.scope(sessionId)
          : undefined;
        if (scope === undefined) return false;
        const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined;
        if (conversation === undefined || conversation.input === undefined) return false;
        const input = conversation.input.for(scope);
        if (input === undefined || input.state === undefined) return false;
        const snapshot = input.state.getSnapshot();
        const draft = typeof snapshot.draft === 'string' ? snapshot.draft : '';
        const lead = draft.trim() === '' ? '' : /\s$/.test(draft) ? '' : ' ';
        const occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : [];
        const hasChips = occurrences.length > 0 || snapshot.phase === 'claimed';
        if (hasChips) {
          if (snapshot.draftRev === undefined) return false;
          const at = appendDetectOffset(snapshot);
          if (at === undefined) return false;
          if (typeof scope.emit !== 'function') return false;
          scope.emit('slash/input-insert-text', {
            text: lead + text,
            span: { draftRev: snapshot.draftRev, start: at, end: at },
          });
        } else if (typeof input.setDraft === 'function') {
          input.setDraft(draft + lead + text);
        } else {
          return false;
        }
        try {
          if (typeof input.focus === 'function') input.focus();
        } catch {
          /* focus is best-effort */
        }
        return true;
      } catch (error) {
        console.warn('[dsh-paper-reader] composer append failed', error);
        return false;
      }
    }

    /**
     * Fold a clipboard-projection offset onto the detect projection (chips
     * collapse to one placeholder character).
     * @param draft - clipboard projection text.
     * @param occurrences - reference chip occurrences.
     * @param offset - clipboard offset.
     * @returns detect-projection offset.
     */
    function foldClipboardOffset(draft, occurrences, offset) {
      const target = Math.max(0, Math.min(offset, draft.length));
      let shrink = 0;
      for (const occurrence of occurrences) {
        const end = occurrence.offset + occurrence.length;
        if (target >= end) {
          shrink += occurrence.length - 1;
          continue;
        }
        if (target > occurrence.offset) return occurrence.offset - shrink + 1;
        break;
      }
      return target - shrink;
    }

    /**
     * Detect-projection offset that appends at the document end.
     * @param snapshot - input state snapshot.
     * @returns offset, or undefined when it cannot be derived.
     */
    function appendDetectOffset(snapshot) {
      const { draft, claim } = snapshot;
      const occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : [];
      const token =
        snapshot.phase === 'claimed' && claim !== undefined && typeof claim.token === 'string' && draft.startsWith(claim.token)
          ? claim.token
          : '';
      if (token === '') return foldClipboardOffset(draft, occurrences, draft.length);
      const rest = draft.slice(token.length);
      const offsetInRest = occurrences
        .filter((occurrence) => occurrence.offset >= token.length)
        .map((occurrence) => ({ offset: occurrence.offset - token.length, length: occurrence.length }));
      return 1 + foldClipboardOffset(rest, offsetInRest, rest.length);
    }

    /**
     * Build the per-Session face the reader needs.
     * @param ctx - client context.
     * @param sessionId - the Session this tab lives in.
     * @returns the core face.
     */
    function createCore(ctx, sessionId) {
      return {
        ctx,
        sessionId,
        vendorBase: VENDOR_BASE,
        askInSession: (text) => appendToDraft(ctx, sessionId, text),
        focusComposer: () => {
          try {
            const scope = ctx.sessions && ctx.sessions.scope ? ctx.sessions.scope(sessionId) : undefined;
            const conversation = scope !== undefined ? ctx.get('conversation') : undefined;
            const input = conversation !== undefined ? conversation.input.for(scope) : undefined;
            if (input !== undefined && typeof input.focus === 'function') input.focus();
          } catch {
            /* focus is best-effort */
          }
        },
      };
    }

    return {
      /** Required browser services; `conversation` is resolved lazily via ctx.get. */
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sessions'],
      /**
       * Register the page type, its guide card, and its body for this fiber.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: PKG,
              kind: KIND,
              title: () => tr(ctx, 'tab.title'),
              guide: [
                {
                  id: 'library',
                  order: 20,
                  title: () => tr(ctx, 'guide.title'),
                  description: () => tr(ctx, 'guide.description'),
                  icon: GuideIcon,
                },
              ],
            }),
          'paper-reader: tab type + guide card',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: PKG,
                  inject: (sessionId) => ({ core: createCore(ctx, sessionId) }),
                },
                PaperReaderBody,
              ),
            ),
          'paper-reader: tab body',
        );
      },
    };
  },
});
