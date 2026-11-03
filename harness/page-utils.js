/**
 * dsh-paper-reader test harness — shared page helpers.
 *
 * Loaded by every scenario page AFTER `shim.js` and the React UMD scripts and
 * BEFORE the page's own module script. Keeps the scenario pages small and makes
 * the machine-readable states uniform:
 *
 *   window.__dprProbe        — mutable probe object the Playwright script reads
 *   window.__dprHarness      — helper API (this file)
 *   document.body.dataset.harnessState — 'booting' | 'running' | 'missing-chunk' | 'fatal'
 *   window.__harnessErrors   — uncaught errors / unhandled rejections on the page
 */
(function installHarnessPageUtils() {
  'use strict';

  var params = new URLSearchParams(window.location.search);

  /** @type {{params: URLSearchParams, state: string, errors: string[], missingChunk: string|null, startedAt: number}} */
  var harness = {
    params: params,
    state: 'booting',
    errors: [],
    missingChunk: null,
    startedAt: Date.now(),
  };

  /** @type {Record<string, any>} */
  window.__dprProbe = {
    state: 'booting',
    errors: harness.errors,
    lang: params.get('lang') === 'en' ? 'en' : 'zh',
  };

  /** Optional dark theme for manual checks (`?theme=dark`). */
  if (params.get('theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  /** Record an uncaught page error (tests fail on unexpected entries). */
  function recordError(source, error) {
    var message = source + ': ' + (error instanceof Error ? error.stack || error.message : String(error));
    harness.errors.push(message);
    window.__dprProbe.errors = harness.errors;
    try {
      console.error('[harness] ' + message);
    } catch {
      /* console may be gone */
    }
  }

  window.addEventListener('error', function (event) {
    // Ignore resource load failures for optional assets (missing chunks are
    // reported by the chunk loader with a better message).
    if (event.target !== window && event.target !== null && event.target !== undefined) return;
    recordError('uncaught error', event.error !== undefined && event.error !== null ? event.error : event.message);
  });
  window.addEventListener('unhandledrejection', function (event) {
    recordError('unhandled rejection', event.reason);
  });

  /** Set the harness page state and mirror it on the probe + <body> dataset. */
  function setState(next) {
    harness.state = next;
    window.__dprProbe.state = next;
    document.body.dataset.harnessState = next;
  }

  /** Update the toolbar status line. */
  function status(text, kind) {
    var el = document.getElementById('harness-status');
    if (el === null) return;
    el.textContent = String(text);
    el.dataset.kind = kind === 'error' ? 'error' : 'info';
  }

  /** Render a boxed harness state into the mount point (replacing its content). */
  function showState(title, detail, nextState) {
    var mount = document.getElementById('mount');
    if (mount !== null) {
      mount.textContent = '';
      var box = document.createElement('div');
      box.className = 'harness-state';
      box.dataset.testid = nextState === 'missing-chunk' ? 'missing-chunk' : 'harness-fatal';
      var heading = document.createElement('h2');
      heading.textContent = title;
      box.appendChild(heading);
      var body = document.createElement('div');
      body.textContent = detail;
      box.appendChild(body);
      if (detail !== undefined && detail !== null && String(detail).length > 0) {
        var pre = document.createElement('pre');
        pre.className = 'harness-state-detail';
        pre.textContent = String(detail);
        box.appendChild(pre);
      }
      mount.appendChild(box);
    }
    setState(nextState);
    status(title, nextState === 'missing-chunk' ? 'error' : 'error');
    if (nextState === 'missing-chunk') harness.missingChunk = String(title);
    window.__dprProbe.state = nextState;
  }

  /**
   * Show the graceful "chunk does not exist yet" state.
   * Teammates' chunk files land over the course of the project; pages must still
   * boot and report a clear state instead of a blank screen.
   */
  function missingChunk(chunkName, error) {
    var message = error instanceof Error ? error.message : String(error);
    showState(
      'Chunk not available: ' + chunkName,
      message + '\n\nThe page is fine — /lib/' + chunkName + ' is not ready yet.',
      'missing-chunk',
    );
    window.__dprProbe.missingChunk = chunkName;
    window.__dprProbe.missingChunkError = message;
    console.warn('[harness] chunk missing: ' + chunkName + ' — ' + message);
  }

  /** Show an unrecoverable harness/page error (a real failure, unlike a missing chunk). */
  function fatal(title, error) {
    showState(title, error instanceof Error ? error.stack || error.message : String(error), 'fatal');
  }

  /** Update the debug probe panel with one labelled value. */
  function debug(label, value) {
    var probe = document.getElementById('probe');
    var text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (probe !== null) {
      probe.hidden = false;
      probe.textContent = '[' + label + '] ' + text;
    }
    window.__dprProbe.lastDebug = { label: label, value: text };
  }

  /** Set a status line from a probe value. */
  function refreshStatus() {
    try {
      status(JSON.stringify(window.__dprProbe), 'info');
    } catch {
      status('probe unreadable', 'error');
    }
  }

  /**
   * Fetch a fixture and return its bytes.
   * @param {string} url fixture URL (`/fixtures/...`)
   * @returns {Promise<Uint8Array>}
   */
  async function fetchFixture(url) {
    var response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('fixture fetch failed: ' + response.status + ' ' + url);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Build the element tree for a probe-aware error boundary (classic script; use `new`). */
  function ErrorBoundary(React) {
    var h = React.createElement;
    function Boundary(props) {
      var _React$useState = React.useState(null);
      var error = _React$useState[0];
      var setError = _React$useState[1];
      if (error !== null) {
        return h(
          'div',
          { className: 'harness-state', 'data-testid': 'render-error' },
          h('h2', null, 'Render error'),
          h('pre', { className: 'harness-state-detail' }, String(error && error.stack ? error.stack : error)),
        );
      }
      return h('div', { className: 'harness-fill' }, props.children);
    }
    return Boundary;
  }

  /** Tiny assertion helper used by pages for self-diagnosis (tests assert on probe). */
  function expect(condition, message) {
    if (!condition) {
      var error = new Error('harness page assertion failed: ' + message);
      recordError('page assertion', error);
      throw error;
    }
  }

  harness.setState = setState;
  harness.status = status;
  harness.showState = showState;
  harness.missingChunk = missingChunk;
  harness.fatal = fatal;
  harness.debug = debug;
  harness.refreshStatus = refreshStatus;
  harness.fetchFixture = fetchFixture;
  harness.recordError = recordError;
  harness.expect = expect;
  harness.ErrorBoundary = ErrorBoundary;
  harness.h = null; // pages set this after React is available

  window.__dprHarness = harness;
  setState('booting');
  document.body.dataset.harnessState = 'booting';
})();
