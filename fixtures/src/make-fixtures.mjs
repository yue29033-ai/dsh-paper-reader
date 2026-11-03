#!/usr/bin/env node
/**
 * Regenerate the dsh-paper-reader test fixtures.
 *
 *   node fixtures/src/make-fixtures.mjs [--chrome <path>]
 *
 * - `paper-en.pdf`  — academic two-column paper: serif body + sans headings,
 *   inline SVG figure, table, math-ish symbols, references page.
 * - `paper-zh.pdf`  — Chinese paper with mixed Latin, several font sizes,
 *   figure + table, references.
 * - `not-a-paper.txt` — non-PDF upload for library validation tests.
 * - `corrupt.pdf`   — has a `%PDF-` header but is not parseable, for the
 *   viewer's malformed-document error state.
 *
 * PDFs are printed from the local HTML sources with headless Chrome so the
 * fixtures are fully reproducible with no network access.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(SRC_DIR, '..');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/**
 * Locate the Chrome binary (CLI flag wins, then the usual macOS bundles).
 * @param {string[]} argv
 * @returns {string}
 */
function findChrome(argv) {
  const flag = argv.indexOf('--chrome');
  if (flag >= 0 && argv[flag + 1] !== undefined) {
    const explicit = path.resolve(argv[flag + 1]);
    if (!existsSync(explicit)) throw new Error(`--chrome path does not exist: ${explicit}`);
    return explicit;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no Chrome binary found (tried: ${CHROME_CANDIDATES.join(', ')})`);
}

/**
 * Print one local HTML file to PDF with headless Chrome.
 * @param {string} chrome Chrome executable path
 * @param {string} htmlPath absolute HTML source path
 * @param {string} pdfPath absolute output path
 */
async function printToPdf(chrome, htmlPath, pdfPath) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'dpr-chrome-fixtures-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pdf-header-footer',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=8000',
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Chrome print-to-pdf timed out for ${path.basename(htmlPath)}`));
      }, 60000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Chrome exited ${code} for ${path.basename(htmlPath)}\n${stderr.slice(-2000)}`));
          return;
        }
        resolve(undefined);
      });
    });
    const info = await stat(pdfPath);
    if (info.size < 1024) throw new Error(`print-to-pdf produced a suspiciously small file: ${pdfPath} (${info.size} B)`);
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

const chrome = findChrome(process.argv);
console.log(`fixtures: chrome = ${chrome}`);

const jobs = [
  { html: 'paper-en.html', pdf: 'paper-en.pdf' },
  { html: 'paper-zh.html', pdf: 'paper-zh.pdf' },
];
for (const job of jobs) {
  const htmlPath = path.join(SRC_DIR, job.html);
  const pdfPath = path.join(FIXTURES_DIR, job.pdf);
  process.stdout.write(`fixtures: printing ${job.html} -> ${job.pdf} … `);
  await printToPdf(chrome, htmlPath, pdfPath);
  const info = await stat(pdfPath);
  console.log(`${(info.size / 1024).toFixed(1)} KiB`);
}

// Non-PDF upload: the library must reject it by its missing %PDF- header.
await writeFile(
  path.join(FIXTURES_DIR, 'not-a-paper.txt'),
  [
    'This file is not a PDF.',
    '',
    'It exists so the paper library upload validation can be tested with a',
    'real file that has no %PDF- header. The library should show a localized',
    '"not a PDF" error and keep the previous list unchanged.',
    '',
  ].join('\n'),
  'utf8',
);

// Parse-failure PDF: header present, body garbage (viewer error-state tests).
await writeFile(
  path.join(FIXTURES_DIR, 'corrupt.pdf'),
  Buffer.from(
    '%PDF-1.7\n' +
      '%\u00e2\u00e3\u00cf\u00d3\n' +
      'this fixture intentionally does not contain a valid PDF body.\n' +
      'It has the header so upload validation accepts it, but PDF.js cannot\n' +
      'parse it, which exercises the viewer malformed-document error state.\n' +
      'endstream\n',
    'latin1',
  ),
);

// Verify what we produced: header checks + sizes.
for (const name of ['paper-en.pdf', 'paper-zh.pdf', 'corrupt.pdf']) {
  const filePath = path.join(FIXTURES_DIR, name);
  const head = (await readFile(filePath)).subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') throw new Error(`${name} does not start with %PDF- (got ${JSON.stringify(head)})`);
}
console.log('fixtures: wrote not-a-paper.txt, corrupt.pdf');
console.log('fixtures: done');
