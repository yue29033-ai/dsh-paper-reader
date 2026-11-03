/**
 * dsh-paper-reader test harness — fake `window.__ModuleLoader__`.
 *
 * The real DSH web shell installs a queue-registration facade, then materializes
 * `@deepseek-ai/dsh-client-modules`, which replaces `__ModuleLoader__.load` with
 * live registration and serves each plugin bundle from `/plugins`. The harness
 * has no Host, so this shim reproduces the browser-side semantics that the
 * chunks actually depend on, with one adaptation: local chunk scripts are
 * fetched from `/lib/` instead of a Host `/plugins/<id>/...` route.
 *
 * Semantics mirrored from `@deepseek-ai/dsh-client-modules` (`ClientModuleSystem`):
 *
 *   - `__ModuleLoader__.load({id, chunk?, factory})` only REGISTERS a factory.
 *     Bundle side effects run at materialization, not at script execution.
 *   - Internal module id: the owner id, or `<owner>/<chunk>` for a package-local
 *     chunk. A duplicate registration throws (a script executed twice).
 *   - Materialization runs `factory(require)` and memoizes its exports. A
 *     require cycle is fatal (factory-form CJS cannot deliver partial exports).
 *   - `require(spec)` resolution order: platform seed table → materialized
 *     record → registered factory (materialize recursively) → throw loudly.
 *   - `require.async('./client.<name>.js')` fetches that package-local chunk,
 *     registers it, then materializes it once. Non-relative specifiers resolve
 *     through the same table.
 *   - Platform seeds are the frozen shared modules; the harness provides
 *     `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime` and
 *     `react/jsx-dev-runtime` from the UMD globals the page loaded.
 *
 * Harness-only affordances (not part of the real contract):
 *   - `window.__dprRequireChunk('./client.viewer.js')` loads + materializes one
 *     chunk of owner `dsh-paper-reader` (also `'./client.js'` loads the entry).
 *   - `window.__dprRequire('react')` and `window.__dprModules()` for debugging.
 *
 * Load order in a page: `/harness/shim.js`, then the React UMD scripts, then
 * page code that calls `__dprRequireChunk`.
 */
(function installHarnessModuleLoader() {
  'use strict';

  /** The package id every chunk in this plugin registers under. */
  var OWNER = 'dsh-paper-reader';
  /** Real system's package-local chunk name pattern. */
  var CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
  /** Script fetch timeout: a hung/absent chunk should fail a test, not stall it. */
  var SCRIPT_TIMEOUT_MS = 15000;

  /** Registered factories: id -> { factory, owner, chunk }. */
  var factories = new Map();
  /** Materialized modules: id -> { id, exports, edges }. */
  var loadCache = new Map();
  /** Re-entrancy guard for require cycles. */
  var materializing = new Set();
  /** Bundle URLs whose script has executed once (real system's executedBundleUrls). */
  var executedBundleUrls = new Set();

  /** Strip the `/client` suffix the real system applies to package specifiers. */
  function stripClientSuffix(spec) {
    return spec.endsWith('/client') ? spec.slice(0, -7) : spec;
  }

  /** Internal module-table key for one package-local chunk. */
  function chunkId(ownerId, fileName) {
    return ownerId + '/' + fileName;
  }

  /** Describe a thrown value the way the real system does. */
  function describeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  /** A React UMD global that must exist before materialization. */
  function reactGlobal(name) {
    var value = window[name];
    if (value === undefined) {
      throw new Error(
        'harness: window.' + name + ' is missing — load /harness/umd/react.production.min.js' +
          (name === 'ReactDOM' ? ' and react-dom.production.min.js' : '') +
          ' before materializing a chunk',
      );
    }
    return value;
  }

  /**
   * The platform seed table. Getters defer UMD-global reads until require time,
   * because pages load the UMD scripts after this shim.
   */
  var seed = new Map([
    ['react', function () { return reactGlobal('React'); }],
    ['react-dom', function () { return reactGlobal('ReactDOM'); }],
    ['react-dom/client', function () {
      var ReactDOM = reactGlobal('ReactDOM');
      if (typeof ReactDOM.createRoot !== 'function') {
        throw new Error('harness: ReactDOM.createRoot is missing — a React 18 UMD build is required');
      }
      return { createRoot: ReactDOM.createRoot.bind(ReactDOM), hydrateRoot: ReactDOM.hydrateRoot.bind(ReactDOM) };
    }],
    ['react/jsx-runtime', function () {
      var React = reactGlobal('React');
      return {
        jsx: function (type, props, key) { return React.createElement(type, withKey(props, key)); },
        jsxs: function (type, props, key) { return React.createElement(type, withKey(props, key)); },
        Fragment: React.Fragment,
      };
    }],
    ['react/jsx-dev-runtime', function () {
      var React = reactGlobal('React');
      return {
        jsxDEV: function (type, props, key) { return React.createElement(type, withKey(props, key)); },
        Fragment: React.Fragment,
      };
    }],
  ]);

  /** Copy a jsx-runtime `key` into the props object React.createElement expects. */
  function withKey(props, key) {
    if (key === undefined || props === null || props === undefined) return props;
    if (Object.prototype.hasOwnProperty.call(props, 'key')) return props;
    var copy = {};
    for (var name in props) {
      if (Object.prototype.hasOwnProperty.call(props, name)) copy[name] = props[name];
    }
    copy.key = key;
    return copy;
  }

  /** Register one bundle factory; mirrors ClientModuleSystem.register. */
  function register(registration) {
    if (registration === null || typeof registration !== 'object') {
      throw new Error('harness: __ModuleLoader__.load(registration) requires an object');
    }
    if (typeof registration.id !== 'string' || registration.id === '') {
      throw new Error('harness: __ModuleLoader__.load requires a string id');
    }
    if (typeof registration.factory !== 'function') {
      throw new Error('harness: __ModuleLoader__.load requires a factory function (id ' + registration.id + ')');
    }
    var ownerId = stripClientSuffix(registration.id);
    if (registration.chunk !== undefined && !CLIENT_CHUNK.test(registration.chunk)) {
      throw new Error('harness: invalid package-local chunk ' + JSON.stringify(registration.chunk));
    }
    var id = registration.chunk === undefined ? ownerId : chunkId(ownerId, registration.chunk);
    if (factories.has(id)) {
      throw new Error(
        'harness: duplicate factory registration for "' + id + '" (bundle executed twice without invalidate?)',
      );
    }
    factories.set(id, { factory: registration.factory, owner: ownerId, chunk: registration.chunk });
  }

  /** Build the synchronous module-table require plus its async chunk operation. */
  function makeRequire(ownerId) {
    var require = function requireSpec(spec) {
      if (typeof spec !== 'string') throw new Error('harness: require(spec) needs a string, got ' + typeof spec);
      if (seed.has(spec)) return seed.get(spec)();
      var id = stripClientSuffix(spec);
      var record = loadCache.get(id);
      if (record !== undefined) return record.exports;
      if (factories.has(id)) return materialize(id, ownerId).exports;
      throw new Error(
        'harness: require("' + spec + '") missed the module table — not a platform seed word, ' +
          'not a materialized module, and no registered package factory',
      );
    };
    require.async = function requireAsync(spec) {
      if (typeof spec !== 'string') {
        return Promise.reject(new Error('harness: require.async(spec) needs a string, got ' + typeof spec));
      }
      if (spec.slice(0, 2) !== './') return importModule(spec);
      var fileName = spec.slice(2);
      if (!CLIENT_CHUNK.test(fileName)) {
        return Promise.reject(new Error('harness: invalid relative chunk request ' + JSON.stringify(spec)));
      }
      return importChunk(ownerId, fileName);
    };
    return require;
  }

  /** Materialize a registered factory (synchronous; memoized in loadCache). */
  function materialize(id, ownerId) {
    var existing = loadCache.get(id);
    if (existing !== undefined) return existing;
    var registered = factories.get(id);
    if (registered === undefined) throw new Error('harness: no registered factory for "' + id + '"');
    if (materializing.has(id)) {
      throw new Error('harness: require cycle through "' + id + '" (factory-form CJS cannot deliver partial exports)');
    }
    materializing.add(id);
    try {
      var edges = new Set();
      var record = {
        id: id,
        exports: registered.factory(makeRequire(ownerId === undefined ? registered.owner : ownerId, edges)),
        edges: edges,
      };
      loadCache.set(id, record);
      return record;
    } finally {
      materializing.delete(id);
    }
  }

  /** Resolve a relative chunk script URL for the harness (`/lib/<file>`). */
  function chunkUrl(fileName) {
    return '/lib/' + fileName;
  }

  /** Transport one chunk script: inject a classic <script>, resolve on load. */
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      if (executedBundleUrls.has(url)) {
        reject(new Error('harness: bundle script ' + url + ' already executed without registering the chunk'));
        return;
      }
      var script = document.createElement('script');
      script.async = true;
      script.src = url;
      var timer = window.setTimeout(function () {
        script.remove();
        reject(new Error('harness: timeout loading bundle script ' + url));
      }, SCRIPT_TIMEOUT_MS);
      script.addEventListener('load', function () {
        window.clearTimeout(timer);
        executedBundleUrls.add(url);
        script.remove();
        resolve();
      }, { once: true });
      script.addEventListener('error', function () {
        window.clearTimeout(timer);
        script.remove();
        reject(new Error('harness: bundle script ' + url + ' failed to load (404 or syntax error)'));
      }, { once: true });
      document.head.append(script);
    });
  }

  /** Load, register, and materialize one package-local chunk (mirrors importChunk). */
  function importChunk(ownerId, fileName) {
    var id = chunkId(ownerId, fileName);
    var cached = loadCache.get(id);
    if (cached !== undefined) return Promise.resolve(cached.exports);
    var pending = factories.has(id)
      ? Promise.resolve()
      : loadScript(chunkUrl(fileName));
    return pending.then(function () {
      if (!factories.has(id)) {
        throw new Error(
          'harness: /lib/' + fileName + ' loaded without registering "' + id + '" via __ModuleLoader__.load',
        );
      }
      return materialize(id, ownerId).exports;
    });
  }

  /** Load a non-relative specifier: seed, materialized module, or registered factory. */
  function importModule(specifier) {
    return Promise.resolve().then(function () {
      if (seed.has(specifier)) return seed.get(specifier)();
      var id = stripClientSuffix(specifier);
      var record = loadCache.get(id);
      if (record !== undefined) return record.exports;
      if (factories.has(id)) return materialize(id).exports;
      throw new Error('harness: cannot resolve "' + specifier + '" — not a seed word and not registered');
    });
  }

  /**
   * Load + materialize one chunk of this plugin by file name.
   * `'./client.js'` (the package entry, registered without a chunk field) is a
   * harness affordance for exercising `client.js`'s apply().
   */
  function requireEntryChunk(fileName) {
    if (fileName === 'client.js') {
      if (loadCache.has(OWNER)) return Promise.resolve(loadCache.get(OWNER).exports);
      var pending = factories.has(OWNER) ? Promise.resolve() : loadScript('/lib/client.js');
      return pending.then(function () {
        if (!factories.has(OWNER)) {
          throw new Error('harness: /lib/client.js loaded without registering "' + OWNER + '"');
        }
        return materialize(OWNER).exports;
      });
    }
    return importChunk(OWNER, fileName);
  }

  /** One-line diagnostics for debug pages and failing tests. */
  function moduleState() {
    return {
      owner: OWNER,
      registered: Array.from(factories.keys()),
      materialized: Array.from(loadCache.keys()),
      executedScripts: Array.from(executedBundleUrls),
    };
  }

  // The facade. `create()` is a boot-time Host/Web-carrier call; there is no
  // Host here, so it fails loudly instead of silently pretending to boot.
  var loader = {
    load: register,
    create: function create() {
      throw new Error('harness: __ModuleLoader__.create() is not available — the harness installs live registration directly');
    },
  };

  window.__ModuleLoader__ = loader;
  window.__dprRequireChunk = function (spec) {
    if (typeof spec !== 'string' || spec.slice(0, 2) !== './') {
      return Promise.reject(new Error('harness: __dprRequireChunk expects a "./client.<name>.js" spec, got ' + String(spec)));
    }
    return requireEntryChunk(spec.slice(2));
  };
  window.__dprRequire = function (spec) {
    return makeRequire(OWNER)(spec);
  };
  window.__dprModules = moduleState;
  window.__dprShim = { owner: OWNER, chunkId: chunkId, stripClientSuffix: stripClientSuffix, version: 1 };
})();
