# dsh-paper-reader — project brief (shared team context)

> Read this before touching any file. It records the reconnaissance the Lead
> already did so nobody repeats it. Owner map and write scopes are at the end.

## 1. The user request

创建一个从右侧边栏进入的论文阅读器：

1. 从右侧边栏进入（DeepSeek Harness Web GUI 的 native right sidebar）；
2. 支持上传论文；
3. 完整保留原始排版、字体、图片及其他内容，不丢失信息；
4. 选中文字后显示悬浮菜单，提供三个选项：**高亮 / 添加笔记 / 在会话中提问**；
5. 默认提问 prompt 的语言应与界面语言一致（中文界面 → 中文 prompt；英文界面 → 英文 prompt）。

Deliverable: an installed, working right-sidebar tab in this DeepSeek Harness
profile (`desktop`), verified in the live GUI at http://127.0.0.1:53715.

## 2. Deployment facts (already verified)

- DSH desktop app version **0.2.1-rc.5**; web GUI URL `http://127.0.0.1:53715`
  (loopback web server, some routes need auth — `/paper-reader/vendor/*` will be
  a plugin route and should be reachable from the GUI page origin).
- DSH home: `~/.dsh`; profile: `~/.dsh/profiles/desktop`; profile config:
  `cordis.patch.yml` (+ `package.json` `dsh.profile.bundles`).
- The running Host has **HMR active** (`dsh-hmr` entry enabled because the
  desktop launcher supplies `profileContext`). Profile patch changes recompose
  live; client plugin code changes reach the open page through
  `dsh-client-hmr` + `dsh-client-modules` without a Host restart.
- The installed DSH implementation is inside
  `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`.
  This path is readable **only** by the Host's own file tools (read/grep in
  this session work); shell commands (`cat`, `node`, ripgrep binary) cannot
  open it. Do not attempt shell access.
- We extracted a read-only copy of every shipped DSH package and its docs to:
  - `~/Documents/.dsh-dev/asar/dsh/node_modules/@deepseek-ai/<pkg>/` — built
    `lib/*.js`, `README.md`, `README.zh.md` for every shipped package.
  - `~/Documents/.dsh-dev/sdk/pkg/*/package/lib/types/**` — official `.d.ts`
    type contracts for `dsh-client-ui-slots`, `dsh-client-ui-sidebar-right`,
    `dsh-client-ui-conversation`, `dsh-client-locale`, `dsh-client-store`,
    `dsh-client-ui-dockkit`, `dsh-client-ui-session`, and primitives.
  - Tarballs kept at `~/Documents/.dsh-dev/sdk/*.tgz`.
- The official plugin-authoring guide + templates live at
  `~/Documents/.dsh-dev/asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
  (`SKILL.md`, `references/*.md`, `templates/decoration/*`). Read
  `references/ui-plugin.md` and `references/practices.md` before writing UI code.
- The most useful reference implementation for the client API is the installed
  ecosystem plugin **dsh-better-sidebar** (source included!):
  `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/src/` — especially
  `src/client/conversation-draft.ts` (composer insertion), `src/client/index.tsx`
  (plugin apply), `src/index.ts` (Host route registration).
- Vendored **PDF.js 6.3.289** is already in this project at
  `dsh-paper-reader/vendor/` (`pdf.mjs`, `pdf.worker.mjs`, `standard_fonts/`,
  `cmaps/`, `wasm/`, `iccs/`, `pdf_viewer.css`, `PDFJS-LICENSE`). It is served
  by the Host half at same-origin **`/paper-reader/vendor/...`** (see
  `lib/index.js`).

## 3. Plugin architecture (how a client plugin loads)

A DSH client plugin package declares `dsh.client` (platform `web`,
`immediately`, `inject`) and exports `./client`. The Host scans enabled Loader
entries, builds a boot graph, and serves each built `lib/client.js` under
`/plugins`. The browser does **not** execute the file as a normal ESM page
module. Each artifact is a script that registers a lazy factory:

```js
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',                 // = package name, for the entry
  factory: (require) => {
    const React = require('react');        // platform seed table
    …
    return { inject: ['slots', …], apply(ctx) { … } };
  },
});
```

Lazy sibling chunks are package-local files named `client.<name>.js` and are
loaded with `require.async('./client.<name>.js')` (the module system fetches and
registers them relative to the package's bundle row). Their wrapper adds the
chunk name:

```js
window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  chunk: 'client.viewer.js',
  factory: (require) => { … return { PdfViewer }; },
});
```

The factory's `require` resolves only: React/react-dom/jsx-runtime, `zod`,
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
`@deepseek-ai/dsh-client-ui-dockkit` (the frozen platform table), plus other
loaded plugin package ids. **The shipped practice is to only `require('react')`
(or `react/jsx-runtime`)** and to reach DSH services through the Cordis context
(`ctx.slots`, `ctx.locale`, `ctx.sidebarRightTabs`, `ctx.sessions`,
`ctx.get('conversation')`). Do **not** require other DSH client packages as
modules.

There is **no bundler available** in this environment. Write plain modern JS
(no JSX) with `const h = React.createElement`. CSS: render a `<style>` element in
the component tree (styled with `--dsw-alias-*` theme tokens), or attach
`<style data-plugin="…">` at plugin `apply` time with `ctx.effect` cleanup.

## 4. Right-sidebar extension point (verified contracts)

Client plugin `apply(ctx)` with `inject: ['slots', 'locale', 'sidebarRightTabs', 'sessions']`
(`conversation` is fetched lazily with `ctx.get('conversation')`).

1. **Tab type** (page type: no `patterns`), registered inside `ctx.effect`:

```js
ctx.sidebarRightTabs.register({
  id: 'dsh-paper-reader',        // unique implementation id; body/title key
  kind: 'paper-reader',          // the page kind openTab() names
  title: () => '论文阅读器',      // thunk re-read on every use (locale-safe)
  guide: [{ id: 'library', order: 20,
            title: () => …, description: () => …, icon: GuideIcon }],
});
```

The shipped right sidebar is *per Session*, opened with the expand button in the
conversation header or the `+` control in the panel's tab strip. `+` opens the
**guide page**; each registered type's `guide` entries render as cards there;
picking one calls `tab.actions.openTab(kind, { replaceTab: true })`. That is the
"enter from the right sidebar" flow.

2. **Tab body** under the keyed slot (receives standard session props incl.
`sessionId`, session hooks, and the injected `core` face; `props.useTabInfo()`
gives the tab record/navigation/signal):

```js
ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-paper-reader',                       // = tab type id
  inject: (sessionId) => ({ core: createCore(ctx, sessionId) }),
}, PaperReaderBody);
```

Wrap the registration with
`ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(...)))`.

3. **Locale**: `ctx.locale.getLocale().active` is the UI language id (`zh`/`en`
plus external packs); subscribe with `ctx.locale.subscribe` +
`React.useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getLocale, same)`.
`ctx.locale.register(ns, { zh, en })` exists but this project keeps per-chunk
string tables keyed by the active language instead, so four writers can work on
disjoint files without sharing one dictionary. When the UI language changes the
locale snapshot changes and every reader component re-renders.

4. **Ask in session** (verified path, mirrored from dsh-better-sidebar): the
composer is a Lexical editor owned by the conversation service.

```js
const scope = ctx.sessions.scope(sessionId);          // client session Context
const conversation = ctx.get('conversation');          // lazily resolved service
const input = conversation.input.for(scope);           // SessionInput facade
const snap = input.state.getSnapshot();                // { draft, draftRev, occurrences, phase, claim }
if (no chips) input.setDraft(draft + lead + text);     // plain draft path
else scope.emit('slash/input-insert-text', { text, span: { draftRev, start: at, end: at } });
input.focus();                                         // return keyboard to composer
```

`lib/client.js` already implements this robustly as `core.askInSession(text)`.
The default prompt text (with paper title, page, quote) is built in the app chunk
in the UI language (zh for zh UI, en for en UI).

## 5. Install / verification path (Lead-owned)

The plugin is being installed as a **linked local package**:

- symlink `~/.dsh/profiles/desktop/node_modules/dsh-paper-reader` →
  `~/Documents/dsh-paper-reader`
- append a manual mount row to
  `~/.dsh/profiles/desktop/cordis.patch.yml`:
  `- insert: [{ id: paper-reader, name: dsh-paper-reader }]`
- HMR recomposes the profile and pushes the new client graph to the open page.

Iteration after install: edits in `~/Documents/dsh-paper-reader/lib/*.js` are
visible to the Host through the symlink; **touch `lib/client.js` after touching
only chunk files** (the HMR revision is stamped from `lib/client.js`) to force
the open page to reload the plugin. No profile writes are needed after install.

Verification: the GUI requires an auth token for `/` and `/api`, which is why QA
builds a **standalone harness** to exercise the chunks in Chromium via
Playwright. GUI-level visual verification is best-effort (auth research is a QA
task); Host-side activation and served bundles are verifiable directly.

## 6. Owner map / write scopes (do not write outside your scope)

| Owner | Files |
|---|---|
| Lead | `package.json`, `cordis.patch.yml`, `lib/index.js`, `lib/client.js`, `lib/client.app.js`, `locale/*`, `icon.svg`, `docs/*`, install/verify |
| viewer | `lib/client.viewer.js` |
| annotations | `lib/client.annotations.js` |
| library | `lib/client.library.js` |
| qa | `harness/*`, `tests/*`, `fixtures/*` |

Read `docs/INTERFACES.md` for the exact chunk contracts. Report progress and
blockers to the Lead with `send_message`; keep messages short and concrete.
