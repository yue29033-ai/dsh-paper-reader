#!/usr/bin/env node
/**
 * dsh-paper-reader — standalone harness E2E suite (no @playwright/test).
 *
 *   node tests/harness.spec.mjs              # everything
 *   node tests/harness.spec.mjs --only=viewer
 *   node tests/harness.spec.mjs --headed --keep-server
 *
 * What it does:
 *   1. starts (or reuses) `harness/serve.mjs` on 127.0.0.1:7812;
 *   2. launches the locally installed Chrome through the installed Playwright
 *      (`~/.dsh/profiles/desktop/node_modules/playwright`);
 *   3. drives the scenario pages under `harness/pages/` and asserts the chunk
 *      contracts from docs/INTERFACES.md §1–§3 and §7;
 *   4. writes screenshots to tests/screenshots/ and a machine-readable
 *      tests/last-run.json.
 *
 * Covered:
 *   infra      server routes/MIME/404/traversal, shim registration semantics
 *   viewer     PDF canvas pixels, text layer, selection payload, clear, zoom,
 *              page API, overlay hook, CJK fixture, corrupt-PDF error state
 *   annotations 3-action menu (zh/en), highlight → reload persistence, note
 *              composer + panel + delete, ask prompt language, corrupt storage
 *   library    upload → row, open → bytes, reload persistence, delete confirm,
 *              non-PDF error (zh/en), corrupt-header acceptance
 *   integration  client.app.js mounted with the fake core: seeded library,
 *              open paper, PDF renders, menu actions, ask-in-session, reload
 *              restore, plugin registration via client.js
 *
 * Exit code: 0 when every non-skipped check passed, 1 otherwise.
 */
import { spawn } from 'node:child_process';
import { loadPlaywright } from './playwright.mjs';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TESTS_DIR, '..');
const SCREENSHOT_DIR = path.join(TESTS_DIR, 'screenshots');
// Playwright can come from this project or the selected DSH profile.
const FIXTURES = {
  paperEn: path.join(PROJECT_ROOT, 'fixtures', 'paper-en.pdf'),
  paperZh: path.join(PROJECT_ROOT, 'fixtures', 'paper-zh.pdf'),
  corrupt: path.join(PROJECT_ROOT, 'fixtures', 'corrupt.pdf'),
  notAPaper: path.join(PROJECT_ROOT, 'fixtures', 'not-a-paper.txt'),
};
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter((candidate) => typeof candidate === 'string' && candidate !== '');

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */
const argv = process.argv.slice(2);
const onlyFlag = argv.find((arg) => arg.startsWith('--only='));
const ONLY = onlyFlag === undefined ? null : onlyFlag.slice('--only='.length).split(',');
const HEADED = argv.includes('--headed');
const KEEP_SERVER = argv.includes('--keep-server');
const portFlagIndex = argv.indexOf('--port');
const PORT = portFlagIndex >= 0 ? Number(argv[portFlagIndex + 1]) : 7812;
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error(`invalid --port ${argv[portFlagIndex + 1]}`);
  process.exit(2);
}
const ORIGIN = `http://127.0.0.1:${PORT}`;
const shouldRun = (section) => ONLY === null || ONLY.includes(section) || ONLY.includes('all');

/* ------------------------------------------------------------------------- *
 * Tiny test runner
 * ------------------------------------------------------------------------- */
const results = [];
let currentSection = '(none)';

function color(code, text) {
  return process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
}
const green = (text) => color('32', text);
const red = (text) => color('31', text);
const yellow = (text) => color('33', text);
const dim = (text) => color('2', text);

function section(name) {
  currentSection = name;
  console.log(`\n${color('1', name)}`);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    results.push({ section: currentSection, name, status: 'pass', ms });
    console.log(`  ${green('✓')} ${name} ${dim(`(${ms}ms)`)}`);
  } catch (error) {
    const ms = Date.now() - started;
    const message = error instanceof Error ? error.stack || error.message : String(error);
    results.push({ section: currentSection, name, status: 'fail', ms, error: message });
    console.log(`  ${red('✗')} ${name} ${dim(`(${ms}ms)`)}`);
    console.log(red(message.split('\n').slice(0, 6).map((line) => '      ' + line).join('\n')));
  }
}

function skip(name, reason) {
  results.push({ section: currentSection, name, status: 'skip', reason });
  console.log(`  ${yellow('∼')} ${name} ${dim('(skipped: ' + reason + ')')}`);
}

class AssertionFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertionFailure(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionFailure(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMatch(actual, pattern, message) {
  if (!pattern.test(String(actual))) {
    throw new AssertionFailure(`${message}: ${JSON.stringify(String(actual).slice(0, 300))} does not match ${pattern}`);
  }
}

function assertInRange(value, min, max, message) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
    throw new AssertionFailure(`${message}: expected number in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
}

function assertArrayLength(value, expected, message) {
  if (!Array.isArray(value)) throw new AssertionFailure(`${message}: not an array (${typeof value})`);
  if (value.length !== expected) {
    throw new AssertionFailure(`${message}: expected ${expected} entries, got ${value.length} (${JSON.stringify(value).slice(0, 200)})`);
  }
}

/* ------------------------------------------------------------------------- *
 * Static server management
 * ------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeHarness(origin) {
  try {
    const response = await fetch(`${origin}/harness/shim.js`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes('__dprRequireChunk') && text.includes('__ModuleLoader__');
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probeHarness(ORIGIN)) {
    console.log(dim(`reusing harness server already listening on ${ORIGIN}`));
    return { owned: false, stop: async () => {} };
  }
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'harness', 'serve.mjs'), '--quiet', '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2000).then(() => child.kill('SIGKILL')),
    ]);
  };
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`harness server exited early (code ${child.exitCode}): ${stderr.slice(-2000)}`);
    }
    if (await probeHarness(ORIGIN)) {
      console.log(dim(`started harness server on ${ORIGIN}`));
      return { owned: true, stop };
    }
    await sleep(100);
  }
  await stop();
  throw new Error('harness server did not become ready within 12s');
}

/* ------------------------------------------------------------------------- *
 * Browser helpers
 * ------------------------------------------------------------------------- */
let browser = null;

async function launchBrowser() {
  const { chromium } = loadPlaywright();
  const launchOptions = { headless: !HEADED, args: ['--disable-dev-shm-usage'] };
  const executablePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch (channelError) {
    if (executablePath === undefined) throw channelError;
    console.log(dim(`chrome channel launch failed, using executablePath ${executablePath}`));
    return chromium.launch({ ...launchOptions, executablePath });
  }
}

/**
 * One isolated browser context + page. A fresh context starts with empty
 * localStorage/IndexedDB, which is the clean state the scenarios expect.
 */
async function newBrowserPage(label, contextOptions = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    ...contextOptions,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  page.on('crash', () => pageErrors.push('page crashed'));
  return { label, context, page, pageErrors };
}

function harnessUrl(pageFile, query) {
  const suffix = query === undefined || query === '' ? '' : `?${query}`;
  return `${ORIGIN}/harness/pages/${pageFile}${suffix}`;
}

/** Navigate to a scenario page and wait until its probe settles into a final state. */
async function openScenario(page, pageFile, query, timeout = 45000) {
  await page.goto(harnessUrl(pageFile, query), { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(
    () => {
      const probe = window.__dprProbe;
      return probe !== undefined && (probe.state === 'running' || probe.state === 'missing-chunk' || probe.state === 'fatal');
    },
    null,
    { timeout },
  );
  return page.evaluate(() => window.__dprProbe);
}

async function screenshot(page, name) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const target = path.join(SCREENSHOT_DIR, name);
  await page.screenshot({ path: target });
  console.log(dim(`      screenshot → tests/screenshots/${name}`));
  return target;
}

/** Fail on uncaught page errors (missing-chunk 404s are handled states, not errors). */
function assertNoPageErrors(pageErrors) {
  assert(pageErrors.length === 0, `uncaught page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
}

const TEXT_LAYER_SELECTOR = '[class*="textLayer"]';

async function waitForTextLayer(page, minimum = 10, timeout = 30000) {
  await page.waitForFunction(
    (min) => {
      const layer = document.querySelector('[class*="textLayer"]');
      return layer !== null && layer.querySelectorAll('span').length >= min;
    },
    minimum,
    { timeout },
  );
}

/** Select a run of text inside the PDF text layer and trigger the selection events. */
async function selectTextInPdf(page, spanIndex = 2) {
  const result = await page.evaluate((wantedIndex) => {
    const layer = document.querySelector('[class*="textLayer"]');
    if (layer === null) return { ok: false, reason: 'no text layer' };
    const candidates = Array.from(layer.querySelectorAll('span')).filter((span) => span.textContent && span.textContent.trim().length > 2);
    if (candidates.length === 0) return { ok: false, reason: 'no text spans' };
    const span = candidates[Math.min(wantedIndex, candidates.length - 1)];
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const options = { bubbles: true, cancelable: true, view: window };
    span.dispatchEvent(new PointerEvent('pointerup', options));
    span.dispatchEvent(new MouseEvent('mouseup', options));
    return { ok: true, text: span.textContent, spanCount: candidates.length };
  }, spanIndex);
  assert(result.ok, `could not select PDF text: ${result.reason}`);
  return result;
}

/**
 * Wait until at least one real page canvas has been painted. Page shells create
 * their `<canvas>` with default 300x150 dimensions, and PDF.js sizes the bitmap
 * and clears it to white before drawing the page content — so neither "a canvas
 * exists" nor "the canvas is page-sized" proves a render. Poll a sparse pixel
 * sample until the canvas carries actual ink.
 */
async function waitForRenderedCanvas(page, selector = 'canvas', timeout = 45000) {
  await page.waitForFunction(
    (canvasSelector) => {
      const candidates = Array.from(document.querySelectorAll(canvasSelector)).filter(
        (canvas) => canvas.width > 400 && canvas.height > 400,
      );
      for (const canvas of candidates) {
        const context = canvas.getContext('2d');
        if (context === null) continue;
        let pixels;
        try {
          pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch {
          continue;
        }
        let ink = 0;
        const stride = 4 * 97;
        for (let index = 0; index < pixels.length; index += stride) {
          if (pixels[index + 3] === 0) continue;
          const lum = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
          if (lum < 240) {
            ink += 1;
            if (ink > 40) return true;
          }
        }
      }
      return false;
    },
    selector,
    { timeout, polling: 150 },
  );
}

/** Pixel statistics for the largest page canvas: proves the PDF actually rendered. */
async function canvasStats(page, selector = 'canvas') {
  return page.evaluate((canvasSelector) => {
    const canvases = Array.from(document.querySelectorAll(canvasSelector)).filter((canvas) => canvas.width > 0 && canvas.height > 0);
    if (canvases.length === 0) return { count: 0 };
    canvases.sort((left, right) => right.width * right.height - left.width * left.height);
    const canvas = canvases[0];
    const context = canvas.getContext('2d');
    if (context === null) return { count: canvases.length, error: 'no 2d context' };
    let pixels;
    try {
      pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (error) {
      return { count: canvases.length, error: String(error) };
    }
    let nonWhite = 0;
    let total = 0;
    let minLum = 255;
    let maxLum = 0;
    let alpha = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      total += 1;
      if (pixels[index + 3] === 0) continue;
      alpha += 1;
      const lum = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
      if (lum < 250) nonWhite += 1;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }
    return {
      count: canvases.length,
      width: canvas.width,
      height: canvas.height,
      nonWhiteRatio: alpha === 0 ? 0 : nonWhite / alpha,
      alphaRatio: total === 0 ? 0 : alpha / total,
      minLum,
      maxLum,
    };
  }, selector);
}

function assertCanvasRendered(stats, label) {
  assert(stats.count >= 1, `${label}: no page canvas found`);
  assert(stats.error === undefined, `${label}: canvas read failed: ${stats.error}`);
  assert(stats.width > 400 && stats.height > 400, `${label}: canvas too small (${stats.width}x${stats.height})`);
  assert(stats.alphaRatio > 0.9, `${label}: canvas mostly transparent (alphaRatio ${stats.alphaRatio})`);
  assert(stats.nonWhiteRatio > 0.003, `${label}: canvas looks blank (non-white pixel ratio ${stats.nonWhiteRatio})`);
  assert(stats.maxLum - stats.minLum > 100, `${label}: canvas has no ink contrast (${stats.minLum}..${stats.maxLum})`);
}

/** Read the viewer scenario's normalized selection payload. */
async function waitForSelection(page, timeout = 15000) {
  await page.waitForFunction(() => window.__dprProbe !== undefined && window.__dprProbe.selection !== null, null, { timeout });
  return page.evaluate(() => window.__dprProbe.selection);
}

function assertSelectionPayload(selection) {
  assert(selection !== null && typeof selection === 'object', 'selection payload is not an object');
  assert(typeof selection.text === 'string' && selection.text.trim().length > 0, 'selection.text is empty');
  assert(Number.isInteger(selection.page) && selection.page >= 1, `selection.page invalid: ${JSON.stringify(selection.page)}`);
  assert(Array.isArray(selection.rects) && selection.rects.length >= 1, 'selection.rects is empty');
  for (const rect of selection.rects) {
    assertEqual(rect.page, selection.page, 'selection rect page must match selection.page');
    assertInRange(rect.x, 0, 1, 'selection rect x');
    assertInRange(rect.y, 0, 1, 'selection rect y');
    assertInRange(rect.w, 0, 1, 'selection rect w');
    assertInRange(rect.h, 0, 1, 'selection rect h');
    assert(rect.w > 0 && rect.h > 0, 'selection rect has no area');
  }
  const anchor = selection.anchor;
  assert(anchor !== null && typeof anchor === 'object', 'selection.anchor missing');
  for (const key of ['left', 'right', 'top', 'bottom']) assertInRange(anchor[key], -100000, 100000, `selection anchor ${key}`);
  assert(anchor.right >= anchor.left && anchor.bottom >= anchor.top, 'selection anchor is inverted');
}

/* ------------------------------------------------------------------------- *
 * Section: infrastructure (server + shim semantics)
 * ------------------------------------------------------------------------- */
async function sectionInfra() {
  section('infra · static server');
  await test('server serves lib/vendor/harness/fixtures with correct MIME', async () => {
    const checks = [
      ['/lib/client.js', 'text/javascript'],
      ['/lib/client.app.js', 'text/javascript'],
      ['/harness/shim.js', 'text/javascript'],
      ['/harness/umd/react.production.min.js', 'text/javascript'],
      ['/harness/pages/viewer.html', 'text/html'],
      ['/harness/harness.css', 'text/css'],
      ['/vendor/pdf.mjs', 'text/javascript'],
      ['/vendor/pdf.worker.mjs', 'text/javascript'],
      ['/vendor/pdf_viewer.css', 'text/css'],
      ['/vendor/wasm/openjpeg.wasm', 'application/wasm'],
      ['/fixtures/paper-en.pdf', 'application/pdf'],
    ];
    for (const [route, expectedType] of checks) {
      const response = await fetch(ORIGIN + route);
      assertEqual(response.status, 200, `GET ${route}`);
      const contentType = response.headers.get('content-type') || '';
      assert(contentType.startsWith(expectedType), `GET ${route}: content-type ${contentType} should start with ${expectedType}`);
      await response.arrayBuffer();
    }
  });

  await test('fixtures are valid: header %PDF-, sized, corrupt fixture unparseable', async () => {
    for (const [name, fixture] of [['paper-en', FIXTURES.paperEn], ['paper-zh', FIXTURES.paperZh]]) {
      const bytes = readFileSync(fixture);
      assertEqual(bytes.subarray(0, 5).toString('latin1'), '%PDF-', `${name} header`);
      assert(bytes.length > 50 * 1024, `${name} is unexpectedly small (${bytes.length} B)`);
      assert(bytes.length < 3 * 1024 * 1024, `${name} exceeds the 3 MB fixture budget (${bytes.length} B)`);
    }
    assertEqual(readFileSync(FIXTURES.corrupt).subarray(0, 5).toString('latin1'), '%PDF-', 'corrupt.pdf header');
    assert(!readFileSync(FIXTURES.notAPaper).subarray(0, 5).toString('latin1').startsWith('%PDF-'), 'not-a-paper.txt must not look like a PDF');
  });

  await test('server returns 404 for unknown paths and blocks traversal', async () => {
    // Note: the WHATWG URL parser normalizes plain `%2e%2e/` dot segments away
    // before the request, so the traversal cases use an encoded separator
    // (`..%2f`) which survives into the request pathname and must be rejected.
    const notFound = ['/nope', '/lib/missing-file.js', '/fixtures/does-not-exist.pdf', '/lib/..%2Fdocs/BRIEF.md', '/vendor/..%2Fharness/shim.js', '/harness/..%2F..%2Fdocs/BRIEF.md'];
    for (const route of notFound) {
      const response = await fetch(ORIGIN + route);
      assertEqual(response.status, 404, `GET ${route} should be 404 (got ${response.status})`);
      await response.arrayBuffer();
    }
  });

  await test('server rejects non-GET/HEAD methods', async () => {
    const response = await fetch(ORIGIN + '/harness/shim.js', { method: 'POST' });
    assertEqual(response.status, 405, 'POST should be 405');
    await response.arrayBuffer();
  });

  section('infra · __ModuleLoader__ shim semantics');
  const { context, page, pageErrors } = await newBrowserPage('shim');
  try {
    await openScenario(page, 'annotations.html', 'lang=zh&paper=shim-probe');
    const state = await page.evaluate(() => window.__dprModules());
    assert(state.registered.includes('dsh-paper-reader/client.annotations.js'), `chunk registration key missing: ${JSON.stringify(state.registered)}`);
    assert(state.materialized.includes('dsh-paper-reader/client.annotations.js'), 'chunk was not materialized');

    await test('shim: duplicate registration throws like the real module system', async () => {
      const message = await page.evaluate(() => {
        try {
          window.__ModuleLoader__.load({ id: 'dsh-paper-reader', chunk: 'client.annotations.js', factory() {} });
          return 'no-throw';
        } catch (error) {
          return String(error && error.message ? error.message : error);
        }
      });
      assertMatch(message, /duplicate factory registration/, 'duplicate registration must throw');
    });

    await test('shim: unknown require throws a loud module-table error', async () => {
      const message = await page.evaluate(() => {
        try {
          window.__dprRequire('not-a-platform-module');
          return 'no-throw';
        } catch (error) {
          return String(error && error.message ? error.message : error);
        }
      });
      assertMatch(message, /missed the module table/, 'unknown require must throw');
    });

    await test('shim: require("react") resolves the UMD React and materialization is memoized', async () => {
      const result = await page.evaluate(async () => {
        const React = window.__dprRequire('react');
        const first = await window.__dprRequireChunk('./client.annotations.js');
        const second = await window.__dprRequireChunk('./client.annotations.js');
        return {
          createElement: typeof React.createElement,
          sameExports: first === second,
          version: React.version,
        };
      });
      assertEqual(result.createElement, 'function', 'require("react").createElement');
      assertEqual(result.sameExports, true, 'chunk exports must be memoized');
      assertMatch(result.version, /^18\./, 'React UMD major version');
    });

    await test('shim: missing chunk rejects with a clear load error', async () => {
      const message = await page.evaluate(async () => {
        try {
          await window.__dprRequireChunk('./client.not-a-real-chunk.js');
          return 'no-throw';
        } catch (error) {
          return String(error && error.message ? error.message : error);
        }
      });
      assertMatch(message, /failed to load|404/, 'missing chunk should reject with a load error');
    });

    await test('shim: missing-chunk state is graceful (no uncaught page errors)', async () => {
      assertNoPageErrors(pageErrors);
    });
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: viewer chunk
 * ------------------------------------------------------------------------- */
async function sectionViewer() {
  section('viewer · client.viewer.js');
  const { context, page, pageErrors } = await newBrowserPage('viewer');
  try {
    const probe = await openScenario(page, 'viewer.html', 'fixture=/fixtures/paper-en.pdf&lang=zh');
    if (probe.state === 'missing-chunk') {
      skip('viewer scenario (all checks)', 'client.viewer.js not built yet');
      return;
    }
    assert(probe.state === 'running', `viewer page failed: ${JSON.stringify(probe)}`);

    await test('viewer: document ready, page count, fixture bytes handed to PdfViewer', async () => {
      await page.waitForFunction(() => window.__dprProbe.ready === true, null, { timeout: 45000 });
      const state = await page.evaluate(() => window.__dprProbe);
      assert(state.numPages >= 2, `expected a multi-page fixture, got ${state.numPages} pages`);
      assertEqual(state.bytesLength, statSync(FIXTURES.paperEn).size, 'PdfViewer received a different byte length than the fixture');
    });

    await test('viewer: first page canvas is non-blank (pixel sampling)', async () => {
      await waitForRenderedCanvas(page);
      const stats = await canvasStats(page);
      assertCanvasRendered(stats, 'paper-en page 1');
      await screenshot(page, 'viewer-en.png');
    });

    await test('viewer: text layer spans exist for selection', async () => {
      await waitForTextLayer(page, 20);
      const text = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('[class*="textLayer"] span'));
        return { count: spans.length, sample: spans.slice(0, 12).map((span) => span.textContent).join(' ') };
      });
      assert(text.count >= 20, `expected a populated text layer, got ${text.count} spans`);
      assert(text.sample.trim().length > 0, 'text layer spans are empty');
    });

    await test('viewer: selecting text reports a normalized Selection payload', async () => {
      await waitForTextLayer(page, 5);
      const selected = await selectTextInPdf(page, 2);
      assert(selected.text.trim().length > 0, 'selected text is empty');
      const selection = await waitForSelection(page);
      assertSelectionPayload(selection);
      await screenshot(page, 'viewer-selection.png');
    });

    await test('viewer: Escape clears the selection (onSelection(null))', async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__dprProbe.selection === null, null, { timeout: 10000 });
    });

    await test('viewer: apiRef.clearTextSelection() clears the selection', async () => {
      await selectTextInPdf(page, 3);
      await waitForSelection(page);
      const apiShape = await page.evaluate(() => {
        const api = window.__dprViewerApi.current;
        return { scrollToPage: typeof api.scrollToPage, clearTextSelection: typeof api.clearTextSelection };
      });
      assertEqual(apiShape.scrollToPage, 'function', 'apiRef.scrollToPage');
      assertEqual(apiShape.clearTextSelection, 'function', 'apiRef.clearTextSelection');
      await page.evaluate(() => {
        window.getSelection().removeAllRanges();
        window.__dprViewerApi.current.clearTextSelection();
      });
      await page.waitForFunction(() => window.__dprProbe.selection === null, null, { timeout: 10000 });
    });

    await test('viewer: renderPageOverlay hook receives page boxes', async () => {
      await page.waitForSelector('[data-testid="overlay-page-2"]', { timeout: 15000 });
      const size = await page.getAttribute('[data-testid="overlay-page-2"]', 'data-page-size');
      assertMatch(size, /^\d+x\d+$/, 'overlay page size');
    });

    await test('viewer: apiRef.scrollToPage(2) reports onPageChange(2)', async () => {
      await page.evaluate(() => window.__dprViewerApi.current.scrollToPage(2));
      await page.waitForFunction(() => window.__dprProbe.currentPage === 2, null, { timeout: 15000 });
    });

    await test('viewer: zoom prop changes the rendered canvas size', async () => {
      await waitForRenderedCanvas(page);
      const before = await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas')).filter((canvas) => canvas.width > 0 && canvas.height > 0);
        canvases.sort((left, right) => right.width * right.height - left.width * left.height);
        return canvases.length === 0 ? null : { width: canvases[0].width, height: canvases[0].height, zoom: window.__dprProbe.zoom };
      });
      assert(before !== null, 'no rendered canvas before zoom');
      await page.click('[data-testid="zoom-in"]');
      await page.waitForFunction(
        (previousWidth) => {
          const canvases = Array.from(document.querySelectorAll('canvas')).filter((canvas) => canvas.width > 0);
          return canvases.some((canvas) => canvas.width > previousWidth);
        },
        before.width,
        { timeout: 20000 },
      );
      const after = await page.evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas')).filter((canvas) => canvas.width > 0);
        canvases.sort((left, right) => right.width * right.height - left.width * left.height);
        return { width: canvases[0].width, zoom: window.__dprProbe.zoom };
      });
      assert(after.zoom > before.zoom, `zoom probe did not increase (${before.zoom} → ${after.zoom})`);
      assert(after.width > before.width, 'canvas width did not grow with zoom');
    });

    await test('viewer: CJK fixture renders with selectable CJK text', async () => {
      const cjkPage = await context.newPage();
      try {
        const cjkProbe = await openScenario(cjkPage, 'viewer.html', 'fixture=/fixtures/paper-zh.pdf&lang=zh');
        assert(cjkProbe.state === 'running', `CJK viewer page failed: ${JSON.stringify(cjkProbe)}`);
        await cjkPage.waitForFunction(() => window.__dprProbe.ready === true, null, { timeout: 45000 });
        await waitForRenderedCanvas(cjkPage);
        const stats = await canvasStats(cjkPage);
        assertCanvasRendered(stats, 'paper-zh page 1');
        await waitForTextLayer(cjkPage, 10);
        const hasCjk = await cjkPage.evaluate(() =>
          Array.from(document.querySelectorAll('[class*="textLayer"] span')).some((span) => /[\u4e00-\u9fff]/.test(span.textContent)),
        );
        assert(hasCjk, 'CJK fixture text layer contains no CJK characters');
        assertNoPageErrors(pageErrors);
        await screenshot(cjkPage, 'viewer-zh.png');
      } finally {
        await cjkPage.close();
      }
    });

    await test('viewer: corrupt PDF renders a localized error state instead of crashing', async () => {
      const corruptPage = await context.newPage();
      const corruptErrors = [];
      corruptPage.on('pageerror', (error) => corruptErrors.push(String(error)));
      try {
        const corruptProbe = await openScenario(corruptPage, 'viewer.html', 'fixture=/fixtures/corrupt.pdf&lang=zh');
        assertEqual(corruptProbe.state, 'running', 'corrupt-PDF page did not reach the running state');
        await corruptPage.waitForSelector('[class*="dpr-v-error"]', { timeout: 20000 });
        const state = await corruptPage.evaluate(() => ({
          ready: window.__dprProbe.ready,
          mountText: (document.getElementById('mount')?.innerText ?? '').trim(),
          canvasCount: document.querySelectorAll('canvas').length,
          pageErrors: window.__dprProbe.errors,
        }));
        assertEqual(state.ready, false, 'corrupt PDF must not report a ready document');
        assert(state.mountText.length > 0, 'corrupt PDF left an empty reader pane (expected localized error block)');
        assertMatch(state.mountText, /pdf/i, 'corrupt PDF error block should mention PDF');
        assertEqual(state.pageErrors.length, 0, `corrupt PDF produced page errors: ${JSON.stringify(state.pageErrors)}`);
        assertEqual(state.canvasCount, 0, 'corrupt PDF should not render a page canvas');
        assertEqual(corruptErrors.length, 0, `corrupt PDF threw uncaught errors: ${JSON.stringify(corruptErrors)}`);
        await screenshot(corruptPage, 'viewer-corrupt.png');
      } finally {
        await corruptPage.close();
      }
    });

    await test('viewer scenario: no uncaught page errors', async () => {
      assertNoPageErrors(pageErrors);
    });
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: annotations chunk
 * ------------------------------------------------------------------------- */
async function sectionAnnotations() {
  section('annotations · client.annotations.js');
  const paperId = `harness-e2e-${Date.now()}`;
  const { context, page, pageErrors } = await newBrowserPage('annotations');
  try {
    const probe = await openScenario(page, 'annotations.html', `lang=zh&paper=${paperId}`);
    if (probe.state === 'missing-chunk') {
      skip('annotations scenario (all checks)', 'client.annotations.js not built yet');
      return;
    }
    assert(probe.state === 'running', `annotations page failed: ${JSON.stringify(probe)}`);
    await page.waitForFunction(() => window.__dprAnnotations !== undefined, null, { timeout: 15000 });

    const readSnapshot = () => page.evaluate(() => window.__dprAnnotations.store.getSnapshot());
    const waitForMenu = () => page.waitForSelector('.dpr-a-menu[role="menu"]', { timeout: 10000 });
    const menuLabels = () =>
      page.evaluate(() => Array.from(document.querySelectorAll('.dpr-a-menu [role="menuitem"]')).map((button) => button.textContent.trim()));
    const waitForAnnotationCounts = (highlights, notes, timeout = 10000) =>
      page.waitForFunction(
        (expected) => {
          const snapshot = window.__dprAnnotations.store.getSnapshot();
          return snapshot.highlights.length >= expected.highlights && snapshot.notes.length >= expected.notes;
        },
        { highlights, notes },
        { timeout },
      );

    await test('annotations: exports exactly the documented API', async () => {
      const exports = await page.evaluate(() => Object.keys(window.__dprAnnotations).filter((key) => key !== 'store' && key !== 'storageKey'));
      assert(exports.includes('buildAskPrompt') && exports.includes('ANNOTATION_COLORS'), `exports: ${JSON.stringify(exports)}`);
      const chunkExports = await page.evaluate(() => window.__dprProbe.exports.sort());
      const expected = ['ANNOTATION_COLORS', 'HighlightLayer', 'NoteComposer', 'NotesPanel', 'SelectionMenu', 'buildAskPrompt', 'createAnnotationStore'].sort();
      assertEqual(chunkExports.join(','), expected.join(','), 'chunk export list');
    });

    await test('annotations: ANNOTATION_COLORS is the ordered four-color palette', async () => {
      const colors = await page.evaluate(() => window.__dprAnnotations.ANNOTATION_COLORS);
      assertEqual(JSON.stringify(colors), JSON.stringify(['yellow', 'green', 'pink', 'blue']), 'ANNOTATION_COLORS');
    });

    await test('annotations: buildAskPrompt default templates are localized (zh/en)', async () => {
      const prompts = await page.evaluate(() => ({
        zh: document.querySelector('[data-testid="prompt-zh"]').textContent,
        en: document.querySelector('[data-testid="prompt-en"]').textContent,
      }));
      assert(prompts.zh.startsWith('请阅读并解释这篇论文《'), `zh prompt prefix: ${JSON.stringify(prompts.zh.slice(0, 40))}`);
      assertMatch(prompts.zh, /第 3 页的以下内容，并回答我的问题：/, 'zh prompt page clause');
      assertMatch(prompts.zh, /\n\n> /, 'zh prompt should quote with "> "');
      assertMatch(prompts.zh, /我的问题：/, 'zh prompt question tail');
      assert(prompts.en.startsWith('Please read and explain the following excerpt from the paper "'), `en prompt prefix: ${JSON.stringify(prompts.en.slice(0, 60))}`);
      assertMatch(prompts.en, /\(page 3\), then answer my question:/, 'en prompt page clause');
      assertMatch(prompts.en, /My question:/, 'en prompt question tail');
      for (const [name, prompt] of [['zh', prompts.zh], ['en', prompts.en]]) {
        assert(!/\n\s*\n\s*\n/.test(prompt), `${name} prompt must not contain \\n\\n\\n blank-line runs`);
      }
    });

    await test('annotations: long quotes are truncated with a localized marker', async () => {
      const result = await page.evaluate(() => {
        const prompt = window.__dprPromptLong;
        return { length: prompt.length, hasMarker: /（内容已截断）|\(truncated\)|…/.test(prompt) };
      });
      assert(result.length < 2100, `truncated prompt is unexpectedly long (${result.length})`);
      assert(result.hasMarker, 'truncated prompt is missing the ellipsis marker');
    });

    await test('annotations: selecting text shows the 3-action menu with exact zh labels', async () => {
      const selected = await page.evaluate(() => window.__dprSelectInPage(0, 90));
      assertEqual(selected, true, 'programmatic selection helper');
      await waitForMenu();
      const labels = await menuLabels();
      assertArrayLength(labels, 3, 'selection menu actions');
      assertEqual(JSON.stringify(labels), JSON.stringify(['高亮', '添加笔记', '在会话中提问']), 'zh selection menu labels');
      const ariaLabel = await page.getAttribute('.dpr-a-menu', 'aria-label');
      assert(typeof ariaLabel === 'string' && ariaLabel.length > 0, 'selection menu aria-label is missing');
      await screenshot(page, 'annotations-menu-zh.png');
    });

    await test('annotations: menu is positioned inside the paper page (absolute style)', async () => {
      const inside = await page.evaluate(() => {
        const menu = document.querySelector('.dpr-a-menu');
        const pageEl = document.getElementById('harness-a-page');
        if (menu === null || pageEl === null) return { ok: false, reason: 'missing element' };
        const menuRect = menu.getBoundingClientRect();
        const pageRect = pageEl.getBoundingClientRect();
        return {
          ok: menuRect.left >= pageRect.left - 2 && menuRect.right <= pageRect.right + 2 && menuRect.top >= pageRect.top - 2,
          position: getComputedStyle(menu).position,
        };
      });
      assertEqual(inside.position, 'absolute', 'menu CSS position');
      assert(inside.ok, 'menu is not positioned inside the paper page');
    });

    await test('annotations: 高亮 adds a highlight, paints it, and closes the menu', async () => {
      await page.click('.dpr-a-menu [data-dpr-action="highlight"]');
      await page.waitForFunction(() => window.__dprAnnotations.store.getSnapshot().highlights.length === 1, null, { timeout: 10000 });
      await page.waitForSelector('[data-testid="highlight-layer-wrap"] .dpr-a-hl-rect', { timeout: 10000 });
      const rectCount = await page.locator('[data-testid="highlight-layer-wrap"] .dpr-a-hl-rect').count();
      assert(rectCount >= 1, `highlight layer painted ${rectCount} rects`);
      const menuVisible = await page.locator('.dpr-a-menu').count();
      assertEqual(menuVisible, 0, 'selection menu should close after highlighting');
      const selectionAtAction = await page.evaluate(() => window.__dprProbe.selectionAtAction);
      assert(
        typeof selectionAtAction === 'string' && selectionAtAction.trim().length > 0,
        'clicking a menu action must not clear the DOM selection before the action runs',
      );
      const highlight = (await readSnapshot()).highlights[0];
      assertEqual(highlight.page, 1, 'highlight page');
      assert(typeof highlight.text === 'string' && highlight.text.length > 0, 'highlight text');
      assertEqual(highlight.color, 'yellow', 'default highlight color');
      assert(Array.isArray(highlight.rects) && highlight.rects.length >= 1, 'highlight rects');
    });

    await test('annotations: highlight persists in localStorage across reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__dprProbe.state === 'running' && window.__dprAnnotations !== undefined, null, { timeout: 20000 });
      await page.waitForSelector('[data-testid="highlight-layer-wrap"] .dpr-a-hl-rect', { timeout: 10000 });
      const snapshot = await readSnapshot();
      assertEqual(snapshot.highlights.length, 1, 'highlight count after reload');
      const stored = await page.evaluate(() => {
        const raw = window.localStorage.getItem('dsh-paper-reader:annotations:v1:' + window.__dprProbe.paperId);
        return raw === null ? null : JSON.parse(raw);
      });
      assert(stored !== null && Array.isArray(stored.highlights), 'annotations are not persisted under the contract localStorage key');
    });

    await test('annotations: Escape closes the menu and onClose clears the selection', async () => {
      await page.evaluate(() => window.__dprSelectInPage(0, 60));
      await waitForMenu();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('.dpr-a-menu') === null, null, { timeout: 10000 });
    });

    await test('annotations: note composer (disabled empty save, Ctrl+Enter saves, panel lists it)', async () => {
      await page.evaluate(() => window.__dprSelectInPage(0, 60));
      await waitForMenu();
      await page.click('.dpr-a-menu [data-dpr-action="note"]');
      await page.waitForSelector('.dpr-a-note-input', { timeout: 10000 });
      const disabled = await page.getAttribute('[data-dpr-action="note-save"]', 'disabled');
      assert(disabled !== null, 'save button should be disabled while the note is empty');
      await page.fill('.dpr-a-note-input', '   ');
      const whitespaceDisabled = await page.getAttribute('[data-dpr-action="note-save"]', 'disabled');
      assert(whitespaceDisabled !== null, 'save button should stay disabled for whitespace-only notes');
      const quoteText = await page.locator('.dpr-a-note-quote').textContent();
      assert(quoteText.trim().length > 0, 'note composer does not preview the selected quote');
      const noteText = 'Harness note: the routing sketch is the key contribution.';
      await page.fill('.dpr-a-note-input', noteText);
      const disabledAfter = await page.getAttribute('[data-dpr-action="note-save"]', 'disabled');
      assert(disabledAfter === null, 'save button should enable once text exists');
      await page.press('.dpr-a-note-input', 'Control+Enter');
      await page.waitForFunction(() => window.__dprAnnotations.store.getSnapshot().notes.length === 1, null, { timeout: 10000 });
      await page.waitForFunction(
        (expected) => Array.from(document.querySelectorAll('.dpr-a-row-note')).some((node) => node.textContent.includes(expected)),
        noteText,
        { timeout: 10000 },
      );
      const note = (await readSnapshot()).notes[0];
      assertEqual(note.page, 1, 'note page');
      assertEqual(note.text, noteText, 'note text');
      await screenshot(page, 'annotations-note.png');
    });

    await test('annotations: note persists across reload and appears in the notes panel', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__dprProbe.state === 'running' && window.__dprProbe.annotations !== undefined, null, { timeout: 20000 });
      const snapshot = await readSnapshot();
      assertEqual(snapshot.highlights.length, 1, 'highlight count after reload');
      assertEqual(snapshot.notes.length, 1, 'note count after reload');
      await page.waitForSelector('[data-testid="highlight-layer-wrap"] .dpr-a-hl-rect', { timeout: 10000 });
      const repaintedRects = await page.locator('[data-testid="highlight-layer-wrap"] .dpr-a-hl-rect').count();
      assert(repaintedRects >= 1, 'highlight layer should repaint persisted highlight rects after reload');
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.dpr-a-row-note')).some((node) => node.textContent.includes('routing sketch')),
        null,
        { timeout: 10000 },
      );
      const panelRows = await page.locator('.dpr-a-row').count();
      assert(panelRows >= 2, `notes panel should list the highlight and the note rows after reload, got ${panelRows}`);
    });

    await test('annotations: ask action records the zh prompt (language follows UI)', async () => {
      await page.evaluate(() => window.__dprSelectInPage(0, 80));
      await waitForMenu();
      await page.click('.dpr-a-menu [data-dpr-action="ask"]');
      await page.waitForFunction(() => window.__dprProbe.askedText !== null, null, { timeout: 10000 });
      const asked = await page.evaluate(() => window.__dprProbe.askedText);
      assert(asked.startsWith('请阅读并解释这篇论文《'), `zh ask prompt prefix: ${JSON.stringify(asked.slice(0, 40))}`);
      assertMatch(asked, /第 1 页的以下内容/, 'zh ask prompt should name the selected page');
      assertMatch(asked, /\n\n> /, 'zh ask prompt should quote the selection with "> "');
      assertEqual(await page.locator('.dpr-a-menu').count(), 0, 'menu should close after ask');
    });

    await test('annotations: live language switch updates menu labels and ask prompt language', async () => {
      await page.evaluate(() => window.__dprSetLang('en'));
      await page.waitForFunction(() => window.__dprProbe.lang === 'en', null, { timeout: 10000 });
      await page.evaluate(() => window.__dprSelectInPage(0, 70));
      await waitForMenu();
      const labels = await menuLabels();
      assertEqual(JSON.stringify(labels), JSON.stringify(['Highlight', 'Add note', 'Ask in chat']), 'en selection menu labels after live switch');
      await page.click('.dpr-a-menu [data-dpr-action="ask"]');
      await page.waitForFunction(() => window.__dprProbe.askCalls >= 2, null, { timeout: 10000 });
      const asked = await page.evaluate(() => window.__dprProbe.askedText);
      assert(asked.startsWith('Please read and explain the following excerpt from the paper "'), `en ask prompt prefix: ${JSON.stringify(asked.slice(0, 60))}`);
      await screenshot(page, 'annotations-en.png');
    });

    await test('annotations: deleting rows empties the panel and persists after reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__dprProbe.state === 'running' && window.__dprProbe.annotations !== undefined, null, { timeout: 20000 });
      let rows = await page.locator('.dpr-a-row').count();
      assert(rows >= 1, 'expected annotation rows before deleting');
      while (rows > 0) {
        await page.locator('.dpr-a-row [data-dpr-action="delete-row"]').first().click();
        const previous = rows;
        await page.waitForFunction(
          (expected) => document.querySelectorAll('.dpr-a-row').length < expected,
          previous,
          { timeout: 10000 },
        );
        rows = await page.locator('.dpr-a-row').count();
      }
      const snapshot = await readSnapshot();
      assertEqual(snapshot.highlights.length, 0, 'highlights after delete');
      assertEqual(snapshot.notes.length, 0, 'notes after delete');
      await page.waitForSelector('[data-dpr="notes-empty"]', { timeout: 10000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__dprProbe.state === 'running' && window.__dprProbe.annotations !== undefined, null, { timeout: 20000 });
      const afterReload = await readSnapshot();
      assertEqual(afterReload.highlights.length + afterReload.notes.length, 0, 'annotations should stay deleted after reload');
    });

    await test('annotations: corrupt localStorage is tolerated (fresh empty store, page still works)', async () => {
      await page.evaluate(() => window.__dprCorruptStorage());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__dprProbe.state === 'running' && window.__dprAnnotations !== undefined, null, { timeout: 20000 });
      const snapshot = await readSnapshot();
      assertEqual(snapshot.highlights.length, 0, 'corrupt storage should yield an empty highlight list');
      assertEqual(snapshot.notes.length, 0, 'corrupt storage should yield an empty note list');
      await page.evaluate(() => window.__dprResetAnnotations());
    });

    await test('annotations scenario: no uncaught page errors', async () => {
      assertNoPageErrors(pageErrors);
    });
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: library chunk
 * ------------------------------------------------------------------------- */
async function sectionLibrary() {
  section('library · client.library.js');
  const { context, page, pageErrors } = await newBrowserPage('library');
  try {
    const probe = await openScenario(page, 'library.html', 'lang=zh');
    if (probe.state === 'missing-chunk') {
      skip('library scenario (all checks)', 'client.library.js not built yet');
      return;
    }
    assert(probe.state === 'running', `library page failed: ${JSON.stringify(probe)}`);
    await page.waitForSelector('[data-testid="dpr-library"]', { timeout: 15000 });

    const fileInput = '[data-testid="dpr-lib-file-input"]';
    const rowCount = () => page.locator('[data-testid="dpr-lib-row"]').count();

    await test('library: exports the 3 documented API names and formatBytes probes', async () => {
      const exports = await page.evaluate(() => window.__dprProbe.exports.slice().sort());
      assertEqual(exports.join(','), 'PaperLibrary,createPaperStore,formatBytes', 'chunk exports');
      const samples = await page.evaluate(() => window.__dprProbe.formatBytes);
      assertEqual(samples['0'], '0 B', 'formatBytes(0)');
      assertEqual(samples['1024'], '1 KB', 'formatBytes(1024)');
      assertEqual(samples['1536'], '1.5 KB', 'formatBytes(1536)');
      assertEqual(samples['1048576'], '1 MB', 'formatBytes(1048576)');
    });

    await test('library: empty state + upload paper-en.pdf creates a row with size', async () => {
      await page.waitForSelector('[data-testid="dpr-lib-empty"]', { timeout: 15000 });
      await page.setInputFiles(fileInput, FIXTURES.paperEn);
      await page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 20000 });
      assertEqual(await rowCount(), 1, 'paper row count after upload');
      const rowText = await page.locator('[data-testid="dpr-lib-row"]').first().innerText();
      assertMatch(rowText, /paper-en/, 'row should show the paper title');
      assertMatch(rowText, /(KB|MB)/, 'row should show the formatted size');
      await screenshot(page, 'library-list.png');
    });

    await test('library: opening a row returns the stored PDF bytes', async () => {
      await page.click('[data-testid="dpr-lib-row-open"]');
      await page.waitForFunction(() => window.__dprProbe.opened !== null, null, { timeout: 15000 });
      const opened = await page.evaluate(() => window.__dprProbe.opened);
      assertEqual(opened.header, '%PDF-', 'opened paper should start with %PDF-');
      assertEqual(opened.byteLength, statSync(FIXTURES.paperEn).size, 'opened byte length should match the fixture');
      const list = await page.evaluate(() => window.__dprProbe.snapshot.papers);
      assertEqual(list.length, 1, 'store list length');
      assertEqual(list[0].name, 'paper-en.pdf', 'stored paper name');
      assertEqual(list[0].size, statSync(FIXTURES.paperEn).size, 'stored paper size');
    });

    await test('library: uploaded paper persists across reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__dprProbe.state === 'running' && window.__dprProbe.snapshot.loaded === true, null, { timeout: 20000 });
      await page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 20000 });
      const papers = await page.evaluate(() => window.__dprProbe.snapshot.papers);
      assertEqual(papers.length, 1, 'paper should persist in IndexedDB across reload');
    });

    await test('library: delete uses an inline two-step confirm; cancel keeps the paper', async () => {
      await page.click('[data-testid="dpr-lib-delete"]');
      await page.waitForSelector('[data-testid="dpr-lib-confirm"]', { timeout: 10000 });
      await page.click('[data-testid="dpr-lib-confirm-cancel"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="dpr-lib-confirm"]') === null, null, { timeout: 10000 });
      assertEqual(await rowCount(), 1, 'cancel must keep the paper row');
      const pageErrorsInProbe = await page.evaluate(() => window.__dprProbe.errors.length);
      assertEqual(pageErrorsInProbe, 0, 'inline confirm flow must not raise page errors');
    });

    await test('library: confirming delete removes the paper and it stays gone after reload', async () => {
      await page.click('[data-testid="dpr-lib-delete"]');
      await page.waitForSelector('[data-testid="dpr-lib-confirm-delete"]', { timeout: 10000 });
      await page.click('[data-testid="dpr-lib-confirm-delete"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="dpr-lib-row"]').length === 0, null, { timeout: 15000 });
      await page.waitForSelector('[data-testid="dpr-lib-empty"]', { timeout: 10000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__dprProbe.state === 'running' && window.__dprProbe.snapshot.loaded === true, null, { timeout: 20000 });
      assertEqual(await rowCount(), 0, 'deleted paper should not reappear after reload');
    });

    await test('library: non-PDF upload shows the localized error and keeps the list unchanged', async () => {
      await page.setInputFiles(fileInput, FIXTURES.notAPaper);
      await page.waitForSelector('[data-testid="dpr-lib-error"]', { timeout: 15000 });
      const errorText = await page.locator('[data-testid="dpr-lib-error"]').innerText();
      assertMatch(errorText, /PDF/, 'zh non-PDF error should mention PDF');
      assertMatch(errorText, /这不是 PDF 文件/, `unexpected zh error copy: ${JSON.stringify(errorText)}`);
      assertEqual(await rowCount(), 0, 'invalid upload must not add a row');
      await screenshot(page, 'library-error.png');
      await page.click('[data-testid="dpr-lib-error-close"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="dpr-lib-error"]') === null, null, { timeout: 10000 });
    });

    await test('library: corrupt.pdf is accepted by header validation (parse errors are viewer-owned)', async () => {
      await page.setInputFiles(fileInput, FIXTURES.corrupt);
      await page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 20000 });
      assertEqual(await rowCount(), 1, 'corrupt.pdf has a %PDF- header, so the library stores it');
      await page.click('[data-testid="dpr-lib-row-open"]');
      await page.waitForFunction(() => window.__dprProbe.opened !== null, null, { timeout: 15000 });
      const opened = await page.evaluate(() => window.__dprProbe.opened);
      assertEqual(opened.header, '%PDF-', 'corrupt.pdf bytes should be stored intact');
    });

    await test('library: English UI copy (empty state + non-PDF error)', async () => {
      const enContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
      const enPage = await enContext.newPage();
      const enErrors = [];
      enPage.on('pageerror', (error) => enErrors.push(String(error)));
      try {
        const enProbe = await openScenario(enPage, 'library.html', 'lang=en');
        assertEqual(enProbe.state, 'running', 'en library page state');
        await enPage.waitForSelector('[data-testid="dpr-lib-empty"]', { timeout: 15000 });
        const emptyText = await enPage.locator('[data-testid="dpr-lib-empty"]').innerText();
        assertMatch(emptyText, /No papers yet/, 'en empty state copy');
        await enPage.setInputFiles('[data-testid="dpr-lib-file-input"]', FIXTURES.notAPaper);
        await enPage.waitForSelector('[data-testid="dpr-lib-error"]', { timeout: 15000 });
        const errorText = await enPage.locator('[data-testid="dpr-lib-error"]').innerText();
        assertMatch(errorText, /not a PDF/, `en non-PDF error copy: ${JSON.stringify(errorText)}`);
        assertEqual(enErrors.length, 0, `en library page errors: ${JSON.stringify(enErrors)}`);
        await screenshot(enPage, 'library-en.png');
      } finally {
        await enContext.close();
      }
    });

    await test('library scenario: no uncaught page errors', async () => {
      assertNoPageErrors(pageErrors);
    });
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------- *
 * Section: integration (client.app.js mounted with fake core)
 * ------------------------------------------------------------------------- */
async function sectionIntegration() {
  section('integration · client.app.js + client.js');
  const { context, page, pageErrors } = await newBrowserPage('integration');
  try {
    await page.goto(harnessUrl('integration.html', 'lang=zh'), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(
      () => {
        const probe = window.__dprProbe;
        if (probe === undefined) return false;
        return probe.mounted === true || probe.state === 'missing-chunk' || probe.state === 'fatal' || document.querySelector('.dpr-shell') !== null;
      },
      null,
      { timeout: 45000 },
    );
    const probe = await page.evaluate(() => window.__dprProbe);
    if (probe.state === 'missing-chunk') {
      skip('integration scenario (all checks)', `missing chunk: ${probe.missingChunk}`);
      return;
    }

    const chunkReady = await page.evaluate(async () => {
      try {
        const app = await window.__dprRequireChunk('./client.app.js');
        const viewer = await window.__dprRequireChunk('./client.viewer.js');
        return { ok: typeof app.PaperReaderApp === 'function' && typeof viewer.PdfViewer === 'function' };
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) };
      }
    });
    if (!chunkReady.ok) {
      skip('integration scenario (all checks)', `client.viewer.js not built yet (${chunkReady.reason})`);
      return;
    }

    const waitForShell = () => page.waitForSelector('.dpr-shell', { timeout: 30000 });
    const waitForSeededRow = () => page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 30000 });

    await test('integration: app mounts with the fake core and seeds the fixture paper', async () => {
      await waitForShell();
      await waitForSeededRow();
      const state = await page.evaluate(() => ({ seeded: window.__dprProbe.seeded, appExports: window.__dprProbe.appExports }));
      assert(state.seeded !== null && state.seeded.seeded === true, `fixture paper was not seeded: ${JSON.stringify(state.seeded)}`);
      assert(state.appExports.includes('PaperReaderApp'), `app exports: ${JSON.stringify(state.appExports)}`);
      const rowTitle = await page.locator('[data-testid="dpr-lib-row"]').first().innerText();
      assertMatch(rowTitle, /paper-en/, 'seeded paper should be listed');
    });

    await test('integration: opening the seeded paper renders the PDF in the reader', async () => {
      await page.click('[data-testid="dpr-lib-row-open"]');
      await page.waitForSelector('[data-testid="dpr-readerpane"]', { timeout: 30000 });
      await waitForRenderedCanvas(page, '[data-testid="dpr-readerpane"] canvas');
      const stats = await canvasStats(page, '[data-testid="dpr-readerpane"] canvas');
      assertCanvasRendered(stats, 'integration reader page 1');
      const pageLabel = await page.locator('[data-testid="dpr-page"]').innerText();
      assertMatch(pageLabel, /第 1 \/ \d+ 页/, `page indicator: ${JSON.stringify(pageLabel)}`);
      const zoomLabel = await page.locator('[data-testid="dpr-zoom"]').innerText();
      assertEqual(zoomLabel, '100%', 'initial zoom label');
      await screenshot(page, 'integration-reader.png');
    });

    await test('integration: selecting text in the reader shows the app floating menu (zh)', async () => {
      await waitForTextLayer(page, 10);
      await selectTextInPdf(page, 2);
      await page.waitForSelector('.dpr-menu[role="menu"]', { timeout: 15000 });
      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.dpr-menu [role="menuitem"]')).map((button) => button.textContent.trim()),
      );
      assertArrayLength(labels, 3, 'app selection menu actions');
      assertEqual(JSON.stringify(labels), JSON.stringify(['高亮', '添加笔记', '在会话中提问']), 'app menu zh labels');
      await screenshot(page, 'integration-menu-zh.png');
    });

    await test('integration: highlight creates a toast + annotation, notes panel lists it', async () => {
      await page.click('.dpr-menu [data-action="highlight"]');
      await page.waitForSelector('.dpr-toast', { timeout: 15000 });
      const toast = await page.locator('.dpr-toast').innerText();
      assertMatch(toast, /已高亮选中文字/, `highlight toast: ${JSON.stringify(toast)}`);
      await page.click('[data-action="notes"]');
      await page.waitForSelector('[data-dpr="notes-panel"] .dpr-a-row', { timeout: 15000 });
      const badge = await page.locator('[data-action="notes"] .dpr-badge').innerText();
      assert(Number(badge) >= 1, `notes badge should show the annotation count, got ${badge}`);
      await screenshot(page, 'integration-notes.png');
    });

    await test('integration: ask action sends the zh prompt through core.askInSession', async () => {
      await page.click('[data-action="notes"]');
      await page.waitForFunction(() => document.querySelector('[data-dpr="notes-panel"]') === null, null, { timeout: 10000 });
      await selectTextInPdf(page, 3);
      await page.waitForSelector('.dpr-menu[role="menu"]', { timeout: 15000 });
      await page.click('.dpr-menu [data-action="ask"]');
      await page.waitForFunction(() => window.__askedText !== null && window.__askedText !== undefined, null, { timeout: 10000 });
      const asked = await page.evaluate(() => window.__askedText);
      assert(asked.startsWith('请阅读并解释这篇论文《'), `zh ask prompt prefix: ${JSON.stringify(asked.slice(0, 40))}`);
      assert(asked.includes('paper-en'), 'ask prompt should name the open paper');
      await page.waitForSelector('.dpr-toast', { timeout: 15000 });
      const toast = await page.locator('.dpr-toast').innerText();
      assertMatch(toast, /提问已填入会话输入框/, `ask toast: ${JSON.stringify(toast)}`);
    });

    await test('integration: reload restores the last paper and its annotations', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.dpr-shell', { timeout: 30000 });
      await page.waitForSelector('[data-testid="dpr-readerpane"] canvas', { timeout: 45000 });
      const badge = await page.evaluate(() => {
        const node = document.querySelector('[data-action="notes"] .dpr-badge');
        return node === null ? '0' : node.textContent;
      });
      assert(Number(badge) >= 1, `annotation count should survive reload, got ${badge}`);
      const canvasPresent = await page.locator('[data-testid="dpr-readerpane"] canvas').count();
      assert(canvasPresent >= 1, 'restored reader has no canvas');
    });

    await test('integration: English UI uses English menu and ask prompt', async () => {
      const enContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
      const enPage = await enContext.newPage();
      const enErrors = [];
      enPage.on('pageerror', (error) => enErrors.push(String(error)));
      try {
        await enPage.goto(harnessUrl('integration.html', 'lang=en'), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await enPage.waitForSelector('.dpr-shell', { timeout: 45000 });
        await enPage.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 30000 });
        await enPage.click('[data-testid="dpr-lib-row-open"]');
        await enPage.waitForSelector('[data-testid="dpr-readerpane"] canvas', { timeout: 45000 });
        await waitForTextLayer(enPage, 10);
        await selectTextInPdf(enPage, 2);
        await enPage.waitForSelector('.dpr-menu[role="menu"]', { timeout: 15000 });
        const labels = await enPage.evaluate(() =>
          Array.from(document.querySelectorAll('.dpr-menu [role="menuitem"]')).map((button) => button.textContent.trim()),
        );
        assertEqual(JSON.stringify(labels), JSON.stringify(['Highlight', 'Add note', 'Ask in chat']), 'en app menu labels');
        await enPage.click('.dpr-menu [data-action="ask"]');
        await enPage.waitForFunction(() => window.__askedText !== null && window.__askedText !== undefined, null, { timeout: 10000 });
        const asked = await enPage.evaluate(() => window.__askedText);
        assert(asked.startsWith('Please read and explain the following excerpt from the paper "'), `en ask prompt prefix: ${JSON.stringify(asked.slice(0, 60))}`);
        assertEqual(enErrors.length, 0, `en integration page errors: ${JSON.stringify(enErrors)}`);
        await screenshot(enPage, 'integration-en.png');
      } finally {
        await enContext.close();
      }
    });

    await test('integration: client.js apply() registers the tab type, guide card and tab body', async () => {
      const pluginPage = await context.newPage();
      try {
        const pluginProbe = await openScenario(pluginPage, 'integration.html', 'plugin=1');
        assertEqual(pluginProbe.state, 'running', `plugin mode state: ${JSON.stringify(pluginProbe)}`);
        await pluginPage.waitForFunction(() => window.__dprProbe.plugin !== null, null, { timeout: 15000 });
        const plugin = await pluginPage.evaluate(() => window.__dprProbe.plugin);
        assertEqual(plugin.hasApply, true, 'client.js must export apply()');
        assertEqual(Array.isArray(plugin.inject), true, 'client.js inject list');
        for (const name of ['slots', 'locale', 'sidebarRightTabs', 'sessions']) {
          assert(plugin.inject.includes(name), `inject should include ${name} (got ${JSON.stringify(plugin.inject)})`);
        }
        assertArrayLength(plugin.tabs, 1, 'registered tab types');
        assertEqual(plugin.tabs[0].id, 'dsh-paper-reader', 'tab type id');
        assertEqual(plugin.tabs[0].kind, 'paper-reader', 'tab type kind');
        assertEqual(plugin.tabs[0].title, '论文阅读器', 'tab title (zh)');
        assertArrayLength(plugin.tabs[0].guide, 1, 'guide cards');
        assertEqual(plugin.tabs[0].guide[0].title, '论文阅读器', 'guide card title (zh)');
        assertMatch(plugin.tabs[0].guide[0].description, /上传论文/, 'guide card description (zh)');
        assertEqual(plugin.slots.length, 1, 'registered slot bodies');
        assertEqual(plugin.slots[0].name, 'sidebar.right.pane.tab', 'slot seat name');
        assertEqual(plugin.slots[0].key, 'dsh-paper-reader', 'slot key');
        await screenshot(pluginPage, 'integration-plugin.png');
      } finally {
        await pluginPage.close();
      }
    });

    await test('integration scenario: no uncaught page errors', async () => {
      assertNoPageErrors(pageErrors);
    });
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */
async function main() {
  const startedAt = Date.now();
  console.log(color('1', 'dsh-paper-reader harness E2E'));
  console.log(dim(`  project: ${PROJECT_ROOT}`));
  console.log(dim(`  origin:  ${ORIGIN}`));
  if (ONLY !== null) console.log(dim(`  only:    ${ONLY.join(',')}`));
  rmSync(path.join(TESTS_DIR, 'last-run.json'), { force: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let server = null;
  try {
    server = await ensureServer();
    browser = await launchBrowser();
    console.log(dim(`  browser: ${browser.version()}`));

    if (shouldRun('infra')) await sectionInfra();
    if (shouldRun('viewer')) await sectionViewer();
    if (shouldRun('annotations')) await sectionAnnotations();
    if (shouldRun('library')) await sectionLibrary();
    if (shouldRun('integration')) await sectionIntegration();
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    if (server !== null && !KEEP_SERVER) await server.stop();
  }

  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail');
  const skipped = results.filter((result) => result.status === 'skip');
  const durationMs = Date.now() - startedAt;

  console.log(`\n${color('1', 'summary')}`);
  console.log(`  passed:  ${green(String(passed))}`);
  console.log(`  failed:  ${failed.length === 0 ? '0' : red(String(failed.length))}`);
  if (skipped.length > 0) console.log(`  skipped: ${yellow(String(skipped.length))} ${dim(skipped.map((result) => result.name).join('; ').slice(0, 300))}`);
  console.log(`  time:    ${(durationMs / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.log(color('1', '\nfailures'));
    for (const failure of failed) {
      console.log(red(`  ✗ [${failure.section}] ${failure.name}`));
      console.log(dim(String(failure.error).split('\n').slice(0, 8).join('\n')));
    }
  }

  writeFileSync(
    path.join(TESTS_DIR, 'last-run.json'),
    JSON.stringify(
      {
        origin: ORIGIN,
        startedAt: new Date(startedAt).toISOString(),
        durationMs,
        results,
        screenshots: existsSync(SCREENSHOT_DIR) ? undefined : undefined,
      },
      null,
      2,
    ) + '\n',
  );

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(red(`harness E2E crashed: ${error instanceof Error ? error.stack || error.message : String(error)}`));
  process.exit(1);
});
