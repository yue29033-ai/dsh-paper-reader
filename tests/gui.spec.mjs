#!/usr/bin/env node
/**
 * dsh-paper-reader — real-GUI E2E against the Lead's dev DSH host.
 *
 *   node tests/gui.spec.mjs                      # zh + en matrices
 *   node tests/gui.spec.mjs --lang=zh            # one locale
 *   node tests/gui.spec.mjs --headed --keep
 *
 * Target: the isolated dev host on http://127.0.0.1:54001 with the plugin
 * installed (tokenized URL in /tmp/paperdev.url; `./scripts/dev-gui.sh url`
 * prints a fresh one, `restart` rotates it). This is the Lead's environment —
 * the user's desktop app is never touched.
 *
 * Flow per locale (each in its own persistent Chromium profile):
 *   1. open the tokenized URL (303 → signed cookie → GUI), dismiss onboarding;
 *   2. expand the right sidebar (`[aria-label="打开右侧边栏"]` zh /
 *      `[aria-label="Expand right sidebar"]` en), click the guide
 *      card 论文阅读器 / Paper Reader → tab opens, `[data-paper-reader]` mounts;
 *   3. upload a fixture through the real PaperLibrary, open it, assert the PDF
 *      rendered (painted canvases + text layer + page indicator);
 *   4. select text in the real text layer → floating menu with exactly three
 *      localized actions;
 *   5. highlight → toast + annotation badge; ask → toast + localized prompt in
 *      the real chat composer; note → composer → save → toast;
 *   6. notes panel rows + row jump changes the page indicator;
 *   7. zoom in / fit re-render without errors;
 *   8. reload in the same profile → paper list (IndexedDB) + annotations
 *      (localStorage) persist; open corrupt.pdf → localized reader error while
 *      the app stays alive.
 *
 * Screenshots: tests/screenshots/gui-<lang>-<step>.png
 * Summary:     tests/gui-last-run.json
 *
 * Exit code: 0 when every check passed, 1 on failures, 2 when the dev host is
 * not available (nothing to test, not a product failure).
 */
import { loadPlaywright } from './playwright.mjs';
const { chromium } = loadPlaywright();
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TESTS_DIR, '..');
const SCREENSHOT_DIR = path.join(TESTS_DIR, 'screenshots');
const DEV_ORIGIN = process.env.DSH_DEV_ORIGIN || 'http://127.0.0.1:54001';
const TOKEN_URL_FILE = process.env.DSH_DEV_URL_FILE || '/tmp/paperdev.url';
const FIXTURES = {
  paperEn: path.join(PROJECT_ROOT, 'fixtures', 'paper-en.pdf'),
  paperZh: path.join(PROJECT_ROOT, 'fixtures', 'paper-zh.pdf'),
  corrupt: path.join(PROJECT_ROOT, 'fixtures', 'corrupt.pdf'),
};
const UI = {
  zh: {
    locale: 'zh-CN',
    guideCard: '论文阅读器',
    tabTitle: '论文阅读器',
    menuLabels: ['高亮', '添加笔记', '在会话中提问'],
    highlightToast: /已高亮选中文字/,
    noteToast: /笔记已保存/,
    askToast: /提问已填入会话输入框/,
    pageLabel: /第 1 \/ \d+ 页/,
    libraryEmpty: /还没有论文/,
    askPrefix: '请阅读并解释这篇论文《',
    fixture: FIXTURES.paperZh,
    expectPages: 5,
  },
  en: {
    locale: 'en-US',
    guideCard: 'Paper Reader',
    tabTitle: 'Paper Reader',
    menuLabels: ['Highlight', 'Add note', 'Ask in chat'],
    highlightToast: /Highlighted the selection/,
    noteToast: /Note saved/,
    askToast: /Question added to the chat input/,
    pageLabel: /Page 1 \/ \d+/,
    libraryEmpty: /No papers yet/,
    askPrefix: 'Please read and explain the following excerpt from the paper "',
    fixture: FIXTURES.paperEn,
    expectPages: 3,
  },
};

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */
const argv = process.argv.slice(2);
const langFlag = argv.find((arg) => arg.startsWith('--lang='));
const LANGS = langFlag === undefined ? ['zh', 'en'] : langFlag.slice('--lang='.length).split(',');
const HEADED = argv.includes('--headed');
const KEEP_PROFILE = argv.includes('--keep');
for (const lang of LANGS) {
  if (!Object.prototype.hasOwnProperty.call(UI, lang)) {
    console.error(`invalid --lang=${lang} (expected zh or en)`);
    process.exit(2);
  }
}

/* ------------------------------------------------------------------------- *
 * Test runner
 * ------------------------------------------------------------------------- */
const results = [];
let currentLang = '(none)';
let currentSection = '(none)';

const color = (code, text) => (process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (text) => color('32', text);
const red = (text) => color('31', text);
const yellow = (text) => color('33', text);
const dim = (text) => color('2', text);

function section(lang, name) {
  currentLang = lang;
  currentSection = name;
  console.log(`\n${color('1', `gui[${lang}] · ${name}`)}`);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    results.push({ lang: currentLang, section: currentSection, name, status: 'pass', ms });
    console.log(`  ${green('✓')} ${name} ${dim(`(${ms}ms)`)}`);
  } catch (error) {
    const ms = Date.now() - started;
    const message = error instanceof Error ? error.stack || error.message : String(error);
    results.push({ lang: currentLang, section: currentSection, name, status: 'fail', ms, error: message });
    console.log(`  ${red('✗')} ${name} ${dim(`(${ms}ms)`)}`);
    console.log(red(message.split('\n').slice(0, 7).map((line) => '      ' + line).join('\n')));
  }
}

function skip(name, reason) {
  results.push({ lang: currentLang, section: currentSection, name, status: 'skip', reason });
  console.log(`  ${yellow('∼')} ${name} ${dim('(skipped: ' + reason + ')')}`);
}

class AssertionFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertionFailure(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new AssertionFailure(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertMatch(actual, pattern, message) {
  if (!pattern.test(String(actual))) throw new AssertionFailure(`${message}: ${JSON.stringify(String(actual).slice(0, 300))} does not match ${pattern}`);
}

async function screenshot(page, name) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const target = path.join(SCREENSHOT_DIR, name);
  await page.screenshot({ path: target });
  console.log(dim(`      screenshot → tests/screenshots/${name}`));
  return target;
}

/* ------------------------------------------------------------------------- *
 * Dev-host discovery
 * ------------------------------------------------------------------------- */
async function resolveTokenUrl() {
  const candidates = [];
  if (process.env.DSH_DEV_TOKEN_URL) candidates.push(process.env.DSH_DEV_TOKEN_URL);
  if (existsSync(TOKEN_URL_FILE)) {
    const fromFile = readFileSync(TOKEN_URL_FILE, 'utf8').trim();
    if (fromFile.startsWith('http')) candidates.push(fromFile);
  }
  if (candidates.length === 0) {
    const printed = spawnSync('./scripts/dev-gui.sh', ['url'], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
    const match = /(https?:\/\/[^\s]+)/.exec(String(printed.stdout || '') + String(printed.stderr || ''));
    if (match !== null) candidates.push(match[1]);
  }
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (response.status === 303 || response.status === 302 || response.status === 200) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * GUI helpers
 * ------------------------------------------------------------------------- */
const MODAL_CLOSE_LABELS = ['关闭', 'Close', '稍后再说', 'Later', '跳过', 'Skip'];
/** The GUI localizes the right-sidebar expand control's accessible name. */
const EXPAND_SIDEBAR_LABELS = ['打开右侧边栏', 'Expand right sidebar', '展开右侧边栏', 'Open right sidebar'];
const MODAL_PRIMARY_LABELS = ['继续', 'Continue', '知道了', 'Got it', '完成', 'Done'];
const DONT_ENABLE_LABELS = ['暂不启用', 'Not now'];

/**
 * Dismiss the onboarding/promo/login dialogs. The dev host has no credentials,
 * so the "开始使用" login prompt can show up; it is purely cosmetic for this
 * suite and every dialog offers a close control.
 */
async function dismissDialogs(page) {
  for (let round = 0; round < 8; round++) {
    const action = await page.evaluate(
      (labels) => {
        // Native <dialog open> overlays (e.g. the dsh-chat-import context
        // intro in the dev host) are modal and intercept all pointer events
        // without carrying role="dialog", so close them first.
        const nativeDialogs = Array.from(document.querySelectorAll('dialog[open]'));
        for (const dialog of nativeDialogs) {
          if (dialog.offsetParent === null && dialog.getBoundingClientRect().width === 0) continue;
          const buttons = Array.from(dialog.querySelectorAll('button'));
          const close = buttons.find((button) => {
            const label = (button.getAttribute('aria-label') || '').trim();
            const text = (button.innerText || '').trim();
            return labels.close.includes(label) || text === '×' || labels.close.includes(text);
          });
          if (close !== undefined) { close.click(); return 'native-close'; }
          if (typeof dialog.close === 'function') { dialog.close(); return 'native-dialog-close'; }
        }
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        // Popover-based dialogs (e.g. dsh-cost-meter's cost-display prompt) report
        // a null offsetParent, so measure the box instead of trusting offsetParent.
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter(isVisible);
        for (const dialog of dialogs) {
          const buttons = Array.from(dialog.querySelectorAll('button'));
          const byAria = buttons.find((button) => labels.close.includes((button.getAttribute('aria-label') || '').trim()));
          if (byAria !== undefined) {
            byAria.click();
            return 'close';
          }
          const byText = buttons.find((button) => labels.primary.includes((button.innerText || '').trim()));
          if (byText !== undefined) {
            byText.click();
            return 'primary';
          }
          const notNow = buttons.find((button) => labels.dontEnable.includes((button.innerText || '').trim()));
          if (notNow !== undefined) {
            notNow.click();
            return 'dont-enable';
          }
        }
        return null;
      },
      { close: MODAL_CLOSE_LABELS, primary: MODAL_PRIMARY_LABELS, dontEnable: DONT_ENABLE_LABELS },
    );
    await page.waitForTimeout(300);
    if (action === null) return;
  }
}

/** Ensure the session composer is on screen (the sidebar only exists with a session). */
async function ensureSession(page) {
  const composer = page.locator('[contenteditable="true"]').first();
  if ((await composer.count()) > 0 && (await composer.isVisible().catch(() => false))) return true;
  for (const label of ['新建会话', '新会话', 'New session', 'New chat']) {
    const button = page.getByRole('button', { name: label, exact: true }).first();
    if ((await button.count().catch(() => 0)) > 0 && (await button.isVisible().catch(() => false))) {
      await button.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      break;
    }
  }
  await page.waitForTimeout(1000);
  return (await page.locator('[contenteditable="true"]').count()) > 0;
}

/** Expand the right sidebar (or verify the guide is already visible). */
async function ensureGuideVisible(page, lang) {
  const label = UI[lang].guideCard;
  const hasGuide = () =>
    page.evaluate((guideLabel) => {
      return Array.from(document.querySelectorAll('*')).some(
        (el) => el.children.length === 0 && (el.textContent || '').trim() === guideLabel && !el.closest('[data-dockkit-tab]'),
      );
    }, label);
  if (await hasGuide()) return true;
  for (let attempt = 0; attempt < 8; attempt++) {
    await dismissDialogs(page);
    await page.evaluate((labels) => {
      const selector = labels.map((label) => `[aria-label="${label}"]`).join(',');
      const button = Array.from(document.querySelectorAll(selector)).find((el) => el.offsetParent !== null);
      if (button !== undefined) button.click();
    }, EXPAND_SIDEBAR_LABELS);
    await page.waitForTimeout(1500);
    if (await hasGuide()) return true;
  }
  return false;
}

/** Click the plugin's guide card and wait for the tab body. */
async function openReaderTab(page, lang) {
  const label = UI[lang].guideCard;
  const clicked = await page.evaluate((guideLabel) => {
    const nodes = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === guideLabel && !el.closest('[data-dockkit-tab]'),
    );
    if (nodes.length === 0) return false;
    const button = nodes[0].closest('button') || nodes[0];
    button.click();
    return true;
  }, label);
  assert(clicked, `guide card ${label} not found in the right sidebar`);
  await page.waitForSelector('[data-paper-reader="shell"]', { timeout: 30000 });
  return true;
}

/** Expand the right sidebar if a dockkit tab body is mounted but collapsed. */
async function expandSidebar(page) {
  await page.evaluate((labels) => {
    const selector = labels.map((label) => `[aria-label="${label}"]`).join(',');
    const button = Array.from(document.querySelectorAll(selector)).find((el) => el.offsetParent !== null);
    if (button !== undefined) button.click();
  }, EXPAND_SIDEBAR_LABELS);
  await page.waitForTimeout(1200);
}

/**
 * Get the paper-reader tab body on screen: use an already-restored tab when the
 * dockkit layout brings it back after reload, otherwise drive the guide card.
 */
async function ensureReaderTab(page, lang) {
  await dismissDialogs(page);
  if ((await page.locator('[data-paper-reader="shell"]').count()) > 0) {
    await expandSidebar(page);
    await page.waitForSelector('[data-paper-reader="shell"]', { state: 'visible', timeout: 20000 }).catch(() => {});
    return true;
  }
  const guideVisible = await ensureGuideVisible(page, lang);
  assert(guideVisible, `guide card "${UI[lang].guideCard}" is not visible in the right sidebar`);
  return openReaderTab(page, lang);
}

async function waitForRenderedCanvas(page, selector, timeout = 60000) {
  await page.waitForFunction(
    (canvasSelector) => {
      const candidates = Array.from(document.querySelectorAll(canvasSelector)).filter(
        (canvas) => canvas.width > 300 && canvas.height > 300,
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
    { timeout, polling: 200 },
  );
}

/** Select a run of text inside the real PDF text layer and fire selection events. */
async function selectTextInReader(page) {
  const result = await page.evaluate(() => {
    const layers = Array.from(document.querySelectorAll('[data-testid="dpr-readerpane"] [class*="textLayer"]'));
    for (const layer of layers) {
      const spans = Array.from(layer.querySelectorAll('span')).filter((span) => (span.textContent || '').trim().length > 3);
      if (spans.length >= 4 && spans[0].firstChild !== null && spans[3].firstChild !== null) {
        const range = document.createRange();
        range.setStart(spans[0].firstChild, 0);
        range.setEnd(spans[3].firstChild, Math.min(12, spans[3].firstChild.length));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        layer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        document.dispatchEvent(new Event('selectionchange'));
        return { ok: true, text: String(selection.toString()).trim().slice(0, 80), spans: spans.length };
      }
    }
    return { ok: false, layers: layers.length };
  });
  assert(result.ok, `could not select text in the reader (text layers: ${result.layers})`);
  assert(result.text.length > 0, 'selection produced empty text');
  return result;
}

async function clickAction(page, action) {
  await page.click(`.dpr-menu [data-action="${action}"]`);
}

/** Click a reader topbar icon button by its data-action. */
async function clickTopbar(page, action) {
  await page.click(`button[data-action="${action}"]`);
}

/**
 * Reconstruct the logical prompt text from the real Lexical composer.
 *
 * `innerText` of the Lexical DOM inserts renderer line breaks around empty
 * paragraphs (a blank line shows up as five newlines), so reading it would
 * report fake blank-line runs. The editor represents one logical line per
 * `<p>`, with `<p><br></p>` for an empty line — join the paragraph texts with
 * single newlines to get the actual draft string the app inserted.
 */
async function composerText(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    if (editor === null) return '';
    const paragraphs = Array.from(editor.querySelectorAll('p'));
    if (paragraphs.length > 0) {
      return paragraphs.map((paragraph) => (paragraph.innerText || '').replace(/\n+$/g, '')).join('\n').trim();
    }
    return (editor.innerText || '').trim();
  });
}

/** Scroll the PDF's own scrollport (the viewer's `.dpr-v-scrollport`) to a fraction. */
async function scrollReaderToFraction(page, fraction) {
  return page.evaluate((targetFraction) => {
    const pane = document.querySelector('[data-testid="dpr-readerpane"]');
    if (pane === null) return null;
    const scroller =
      pane.querySelector('[class*="dpr-v-scrollport"]') ||
      Array.from(pane.querySelectorAll('*')).find((el) => {
        const style = getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50;
      });
    if (!scroller) return null;
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * targetFraction);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      className: String(scroller.className),
    };
  }, fraction);
}

/* ------------------------------------------------------------------------- *
 * One locale matrix
 * ------------------------------------------------------------------------- */
async function runLocale(tokenUrl, lang) {
  const ui = UI[lang];
  const profileDir = mkdtempSync(path.join(os.tmpdir(), `dsh-gui-e2e-${lang}-`));
  console.log(dim(`\nprofile: ${profileDir} (persistent for this locale run)`));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: !HEADED,
    viewport: { width: 1680, height: 1050 },
    locale: ui.locale,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Ignore expected network noise from unrelated dev-host services.
    if (/net::ERR|favicon|Failed to load resource/i.test(text)) return;
    consoleErrors.push(text.slice(0, 300));
  });

  try {
    section(lang, 'open GUI');
    await test('tokenized URL authenticates and boots the GUI', async () => {
      await page.goto(tokenUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);
      await dismissDialogs(page);
      const state = await page.evaluate((labels) => {
        const selector = labels.map((label) => `[aria-label="${label}"]`).join(',');
        return {
          url: location.href,
          hasBody: document.body.innerText.trim().length > 20,
          composer: document.querySelectorAll('[contenteditable="true"]').length,
          sidebarToggle: document.querySelectorAll(selector).length,
        };
      }, EXPAND_SIDEBAR_LABELS);
      assert(state.hasBody, 'GUI body is empty');
      assert(!/^\d{3}$/.test(state.url), `unexpected URL after token auth: ${state.url}`);
      await ensureSession(page);
      await dismissDialogs(page);
      const toggles = await page.evaluate((labels) => {
        const selector = labels.map((label) => `[aria-label="${label}"]`).join(',');
        return document.querySelectorAll(selector).length;
      }, EXPAND_SIDEBAR_LABELS);
      assert(toggles > 0, 'right-sidebar expand control is missing after ensuring a session');
    });

    section(lang, 'right sidebar → paper reader tab');
    await test('right sidebar guide card opens the paper reader tab', async () => {
      await ensureReaderTab(page, lang);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="dpr-library"]') !== null || document.querySelector('[data-testid="dpr-readerpane"]') !== null,
        null,
        { timeout: 30000 },
      );
      const tab = await page.evaluate(() => ({
        tabs: Array.from(document.querySelectorAll('[data-dockkit-tab]')).map((el) => (el.innerText || '').trim()),
        root: document.querySelectorAll('[data-paper-reader="shell"]').length,
      }));
      assert(tab.root >= 1, 'paper reader tab body did not mount');
      assert(
        tab.tabs.some((title) => title.includes(ui.tabTitle)),
        `right-sidebar tab strip should show "${ui.tabTitle}", got ${JSON.stringify(tab.tabs)}`,
      );
      await screenshot(page, `gui-${lang}-tab.png`);
    });

    await test('fresh profile shows the empty paper library', async () => {
      await page.waitForSelector('[data-testid="dpr-library"]', { state: 'visible', timeout: 20000 });
      const empty = await page.locator('[data-testid="dpr-lib-empty"]').innerText();
      assertMatch(empty, ui.libraryEmpty, 'localized empty-state copy');
      assertEqual(await page.locator('[data-testid="dpr-lib-row"]').count(), 0, 'fresh profile should have no papers');
    });

    section(lang, 'upload + read');
    await test('uploading a PDF through the real library lists it', async () => {
      await page.locator('[data-testid="dpr-lib-file-input"]').setInputFiles(ui.fixture);
      await page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 30000 });
      const rowText = await page.locator('[data-testid="dpr-lib-row"]').first().innerText();
      assertMatch(rowText, /paper-(zh|en)/, 'row shows the paper title');
      assertMatch(rowText, /(KB|MB)/, 'row shows the formatted file size');
      await screenshot(page, `gui-${lang}-upload.png`);
    });

    await test('opening the paper renders the PDF (painted canvases, text layer, page count)', async () => {
      await page.click('[data-testid="dpr-lib-row-open"]');
      await page.waitForSelector('[data-testid="dpr-readerpane"]', { timeout: 30000 });
      await waitForRenderedCanvas(page, '[data-testid="dpr-readerpane"] canvas');
      await page.waitForFunction(
        (minPages) => document.querySelectorAll('[data-testid="dpr-readerpane"] [class*="textLayer"]').length >= minPages,
        1,
        { timeout: 30000 },
      );
      // The text layer is built asynchronously after the canvas; wait until the
      // first page's spans have actually populated before asserting sparsity.
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="dpr-readerpane"] [class*="textLayer"] span').length >= 100,
        null,
        { timeout: 30000 },
      ).catch(() => {});
      const state = await page.evaluate(() => ({
        painted: Array.from(document.querySelectorAll('[data-testid="dpr-readerpane"] canvas')).filter((canvas) => canvas.width > 300).length,
        textLayers: document.querySelectorAll('[data-testid="dpr-readerpane"] [class*="textLayer"]').length,
        spans: document.querySelectorAll('[data-testid="dpr-readerpane"] [class*="textLayer"] span').length,
        pageLabel: document.querySelector('[data-testid="dpr-page"]')?.innerText,
        zoom: document.querySelector('[data-testid="dpr-zoom"]')?.innerText,
      }));
      assert(state.painted >= 1, 'no painted page canvas');
      assert(state.textLayers >= 1, 'no text layer');
      assert(state.spans >= 100, `text layer is sparse (${state.spans} spans)`);
      assertMatch(state.pageLabel, ui.pageLabel, 'page indicator');
      assertEqual(state.zoom, '100%', 'initial zoom label');
      await screenshot(page, `gui-${lang}-reader.png`);
    });

    await test('host serves PDF.js from /paper-reader/vendor/ at the real page origin', async () => {
      const probe = await page.evaluate(async () => {
        const pdf = await fetch('/paper-reader/vendor/pdf.mjs', { cache: 'no-store' });
        const pdfText = await pdf.text();
        const worker = await fetch('/paper-reader/vendor/pdf.worker.mjs', { cache: 'no-store' });
        const workerText = await worker.text();
        return {
          pdfStatus: pdf.status,
          pdfType: pdf.headers.get('content-type'),
          pdfBytes: pdfText.length,
          pdfMarker: pdfText.includes('GlobalWorkerOptions'),
          workerStatus: worker.status,
          workerType: worker.headers.get('content-type'),
          workerBytes: workerText.length,
        };
      });
      assertEqual(probe.pdfStatus, 200, 'GET /paper-reader/vendor/pdf.mjs');
      assertMatch(probe.pdfType || '', /javascript/, 'pdf.mjs content-type');
      assert(probe.pdfBytes > 100000, `pdf.mjs body too small (${probe.pdfBytes} B)`);
      assert(probe.pdfMarker, 'pdf.mjs body should be the PDF.js module');
      assertEqual(probe.workerStatus, 200, 'GET /paper-reader/vendor/pdf.worker.mjs');
      assertMatch(probe.workerType || '', /javascript/, 'pdf.worker.mjs content-type');
      assert(probe.workerBytes > 100000, `pdf.worker.mjs body too small (${probe.workerBytes} B)`);
    });

    section(lang, 'selection menu + actions');
    await test('selecting text in the real text layer shows the 3-action floating menu', async () => {
      const selected = await selectTextInReader(page);
      await page.waitForSelector('.dpr-menu[role="menu"]', { timeout: 15000 });
      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.dpr-menu [role="menuitem"]')).map((button) => button.textContent.trim()),
      );
      assertEqual(JSON.stringify(labels), JSON.stringify(ui.menuLabels), `${lang} floating menu actions`);
      assert(selected.text.length > 0, 'selected text is empty');
      await screenshot(page, `gui-${lang}-menu.png`);
    });

    await test('highlighting shows the localized toast and increments the annotation badge', async () => {
      const badgeBefore = await page.evaluate(() => {
        const node = document.querySelector('[data-action="notes"] .dpr-badge');
        return node === null ? 0 : Number(node.textContent) || 0;
      });
      await clickAction(page, 'highlight');
      await page.waitForSelector('.dpr-toast', { timeout: 15000 });
      const toast = await page.locator('.dpr-toast').innerText();
      assertMatch(toast, ui.highlightToast, 'highlight toast');
      await page.waitForFunction(
        (previous) => {
          const node = document.querySelector('[data-action="notes"] .dpr-badge');
          return node !== null && (Number(node.textContent) || 0) > previous;
        },
        badgeBefore,
        { timeout: 15000 },
      );
      await page.waitForFunction(() => document.querySelector('.dpr-menu') === null, null, { timeout: 10000 });
    });

    await test('ask-in-chat appends the localized prompt to the real session composer', async () => {
      await selectTextInReader(page);
      await page.waitForSelector('.dpr-menu[role="menu"]', { timeout: 15000 });
      await clickAction(page, 'ask');
      await page.waitForSelector('.dpr-toast', { timeout: 15000 });
      const toast = await page.locator('.dpr-toast').innerText();
      assertMatch(toast, ui.askToast, 'ask toast');
      await page.waitForFunction(
        (prefix) => {
          const editor = document.querySelector('[contenteditable="true"]');
          return editor !== null && (editor.innerText || '').trim().startsWith(prefix);
        },
        ui.askPrefix,
        { timeout: 20000 },
      );
      const text = await composerText(page);
      assert(text.includes('> '), 'composer prompt should contain the "> " quote block');
      assert(/第 \d+ 页|page \d+/.test(text), 'composer prompt should name the page');
      assert(/paper-(zh|en)/.test(text), 'composer prompt should name the paper');
      const template = lang === 'zh'
        ? /请阅读并解释这篇论文《paper-zh》第 \d+ 页的以下内容，并回答我的问题：/
        : /Please read and explain the following excerpt from the paper "paper-en" \(page \d+\), then answer my question:/;
      assertMatch(text, template, 'composer prompt should match the contract template');
      assert(!/\n\s*\n\s*\n/.test(text), 'composer prompt must not contain \\n\\n\\n blank-line runs');
      await screenshot(page, `gui-${lang}-ask.png`);
    });

    await test('note composer saves a note and shows the localized toast', async () => {
      await selectTextInReader(page);
      await page.waitForSelector('.dpr-menu[role="menu"]', { timeout: 15000 });
      await clickAction(page, 'note');
      await page.waitForSelector('.dpr-a-note-input', { timeout: 15000 });
      const noteText = lang === 'zh' ? 'GUI 测试笔记：路由草图是关键贡献。' : 'GUI test note: the routing sketch is the key contribution.';
      await page.evaluate((text) => {
        const textarea = document.querySelector('.dpr-a-note-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }, noteText);
      await page.click('[data-dpr-action="note-save"]');
      await page.waitForSelector('.dpr-toast', { timeout: 15000 });
      const toast = await page.locator('.dpr-toast').innerText();
      assertMatch(toast, ui.noteToast, 'note toast');
      await page.waitForFunction(() => document.querySelector('.dpr-a-note-input') === null, null, { timeout: 10000 });
      await screenshot(page, `gui-${lang}-note.png`);
    });

    section(lang, 'notes panel, zoom, persistence, error state');
    await test('notes panel lists annotations and a row click jumps pages', async () => {
      await clickTopbar(page, 'notes');
      await page.waitForSelector('[data-dpr="notes-panel"] .dpr-a-row', { timeout: 15000 });
      const rows = await page.locator('[data-dpr="notes-panel"] .dpr-a-row').count();
      assert(rows >= 2, `notes panel should list the highlight + note, got ${rows} rows`);
      const pageBeforeScroll = await page.locator('[data-testid="dpr-page"]').innerText();
      const scrolled = await scrollReaderToFraction(page, 0.55);
      assert(scrolled !== null && scrolled.scrollTop > 0, `could not scroll the reader (${JSON.stringify(scrolled)})`);
      await page.waitForFunction(
        (previous) => document.querySelector('[data-testid="dpr-page"]')?.innerText !== previous,
        pageBeforeScroll,
        { timeout: 20000 },
      );
      const pageAfterScroll = await page.locator('[data-testid="dpr-page"]').innerText();
      await page.locator('[data-dpr="notes-panel"] .dpr-a-row').first().click();
      await page.waitForFunction(
        (previous) => document.querySelector('[data-testid="dpr-page"]')?.innerText !== previous,
        pageAfterScroll,
        { timeout: 20000 },
      );
      const pageAfterJump = await page.locator('[data-testid="dpr-page"]').innerText();
      assertMatch(pageAfterJump, /第 1 \/|Page 1 \//, 'row click should jump to the annotation page');
      await screenshot(page, `gui-${lang}-notes-panel.png`);
      await clickTopbar(page, 'notes');
    });

    await test('zoom in and fit-width re-render the canvases', async () => {
      const before = await page.evaluate(() => {
        const canvas = Array.from(document.querySelectorAll('[data-testid="dpr-readerpane"] canvas')).find((item) => item.width > 0);
        return {
          width: canvas === null ? 0 : canvas.width,
          cssWidth: canvas === null ? 0 : Math.round(canvas.getBoundingClientRect().width),
          zoom: document.querySelector('[data-testid="dpr-zoom"]')?.innerText,
        };
      });
      await clickTopbar(page, 'zoom-in');
      await page.waitForFunction(
        (previousWidth) => {
          const canvas = Array.from(document.querySelectorAll('[data-testid="dpr-readerpane"] canvas')).find((item) => item.width > 0);
          return canvas !== undefined && canvas.width > previousWidth;
        },
        before.width,
        { timeout: 30000 },
      );
      const zoomed = await page.evaluate(() => document.querySelector('[data-testid="dpr-zoom"]')?.innerText);
      assert(zoomed !== before.zoom, `zoom label should change (${before.zoom} → ${zoomed})`);
      await clickTopbar(page, 'zoom-fit');
      await page.waitForFunction(() => document.querySelector('[data-testid="dpr-zoom"]')?.innerText === '100%', null, { timeout: 20000 });
      const after = await page.evaluate(() => {
        const canvas = Array.from(document.querySelectorAll('[data-testid="dpr-readerpane"] canvas')).find((item) => item.width > 0);
        return canvas === null ? 0 : Math.round(canvas.getBoundingClientRect().width);
      });
      assert(Math.abs(after - before.cssWidth) <= 4, `fit-width should restore the page width (${before.cssWidth} → ${after})`);
      await screenshot(page, `gui-${lang}-zoom.png`);
    });

    await test('reload keeps the paper (IndexedDB) and annotations (localStorage)', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);
      await dismissDialogs(page);
      await ensureReaderTab(page, lang);
      await dismissDialogs(page);
      // The app restores the last opened paper from localStorage after a reload;
      // if for any reason it lands on the library, open the persisted row ourselves.
      const restored = await page
        .waitForSelector('[data-testid="dpr-readerpane"] canvas', { timeout: 45000 })
        .then(() => true)
        .catch(() => false);
      if (!restored) {
        await page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 30000 });
        // Click through the DOM: onboarding overlays from unrelated dev-host
        // plugins may still intercept pointer events right after a reload.
        await page.evaluate(() => {
          const open = document.querySelector('[data-testid="dpr-lib-row-open"]');
          if (open !== null) open.click();
        });
      }
      await waitForRenderedCanvas(page, '[data-testid="dpr-readerpane"] canvas');
      const badge = await page.evaluate(() => {
        const node = document.querySelector('[data-action="notes"] .dpr-badge');
        return node === null ? '0' : node.textContent;
      });
      assert(Number(badge) >= 1, `annotation badge should survive reload, got ${badge}`);
      await screenshot(page, `gui-${lang}-reload.png`);
      await clickTopbar(page, 'back');
      await page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 20000 });
      const rows = await page.locator('[data-testid="dpr-lib-row"]').count();
      assert(rows >= 1, 'uploaded paper should persist in IndexedDB after reload');
      const rowText = await page.locator('[data-testid="dpr-lib-row"]').first().innerText();
      assertMatch(rowText, /paper-(zh|en)/, 'persisted paper title');
    });

    await test('corrupt.pdf shows the localized reader error without breaking the app', async () => {
      // We should be back in the library view (the previous test clicked back);
      // re-expand the sidebar defensively if a collapsed panel hid the input.
      if ((await page.locator('[data-testid="dpr-lib-file-input"]').count()) === 0) {
        await expandSidebar(page);
      }
      await dismissDialogs(page);
      await page.waitForSelector('[data-testid="dpr-lib-file-input"]', { state: 'attached', timeout: 20000 });
      await page.locator('[data-testid="dpr-lib-file-input"]').setInputFiles(FIXTURES.corrupt);
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="dpr-lib-row"]').length >= 2,
        null,
        { timeout: 30000 },
      );
      await page.evaluate(() => {
        const open = document.querySelector('[data-testid="dpr-lib-row"] [data-testid="dpr-lib-row-open"]');
        if (open !== null) open.click();
      });
      await page.waitForSelector('[class*="dpr-v-error"]', { timeout: 30000 });
      const errorText = await page.locator('[class*="dpr-v-error"]').first().innerText();
      assertMatch(errorText, lang === 'zh' ? /无法打开这份 PDF/ : /Could not open this PDF/, 'localized reader error title');
      assertEqual(await page.locator('[data-paper-reader="shell"]').count(), 1, 'app shell should stay mounted after the parse error');
      await clickTopbar(page, 'back');
      await page.waitForSelector('[data-testid="dpr-lib-row"]', { timeout: 20000 });
      await screenshot(page, `gui-${lang}-corrupt.png`);
    });

    await test('GUI run produced no uncaught page errors', async () => {
      assert(pageErrors.length === 0, `page errors: ${JSON.stringify(pageErrors.slice(0, 5))}`);
      results.push({ lang, section: currentSection, name: 'console errors (informational)', status: 'info', consoleErrors: consoleErrors.slice(0, 10) });
    });
  } finally {
    await context.close().catch(() => {});
    if (!KEEP_PROFILE) {
      rmSync(profileDir, { recursive: true, force: true });
    } else {
      console.log(dim(`kept profile: ${profileDir}`));
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */
async function main() {
  const startedAt = Date.now();
  console.log(color('1', 'dsh-paper-reader real-GUI E2E'));
  console.log(dim(`  host:  ${DEV_ORIGIN}`));
  console.log(dim(`  langs: ${LANGS.join(', ')}`));
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const tokenUrl = await resolveTokenUrl();
  if (tokenUrl === null) {
    console.error(
      red(
        `\nthe dev GUI host is not reachable or the token URL is stale.\n` +
          `  Start/restart it with:  cd ${PROJECT_ROOT} && ./scripts/dev-gui.sh restart\n` +
          `  (the tokenized URL is written to ${TOKEN_URL_FILE})`,
      ),
    );
    process.exit(2);
  }
  console.log(dim(`  token: ${tokenUrl.replace(/token=[^&]+/, 'token=<redacted>')}`));

  for (const lang of LANGS) {
    console.log(color('1', `\n=== locale: ${lang} ===`));
    try {
      await runLocale(tokenUrl, lang);
    } catch (error) {
      results.push({ lang, section: 'locale-run', name: `${lang} matrix`, status: 'fail', error: String(error) });
      console.log(red(`  ✗ ${lang} matrix crashed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail');
  const skipped = results.filter((result) => result.status === 'skip');
  const durationMs = Date.now() - startedAt;

  console.log(`\n${color('1', 'summary')}`);
  console.log(`  passed:  ${green(String(passed))}`);
  console.log(`  failed:  ${failed.length === 0 ? '0' : red(String(failed.length))}`);
  if (skipped.length > 0) console.log(`  skipped: ${yellow(String(skipped.length))}`);
  console.log(`  time:    ${(durationMs / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.log(color('1', '\nfailures'));
    for (const failure of failed) {
      console.log(red(`  ✗ [${failure.lang}] ${failure.name}`));
      console.log(dim(String(failure.error).split('\n').slice(0, 8).join('\n')));
    }
  }

  const screenshots = existsSync(SCREENSHOT_DIR)
    ? (await import('node:fs')).readdirSync(SCREENSHOT_DIR).filter((name) => name.startsWith('gui-')).sort()
    : [];
  writeFileSync(
    path.join(TESTS_DIR, 'gui-last-run.json'),
    JSON.stringify(
      {
        host: DEV_ORIGIN,
        startedAt: new Date(startedAt).toISOString(),
        durationMs,
        results,
        screenshots: screenshots.map((name) => path.join('tests', 'screenshots', name)),
        profileMode: KEEP_PROFILE ? 'kept' : 'fresh-per-locale',
      },
      null,
      2,
    ) + '\n',
  );

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(red(`GUI E2E crashed: ${error instanceof Error ? error.stack || error.message : String(error)}`));
  process.exit(1);
});
