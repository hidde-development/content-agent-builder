#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// Smoke-test voor de Goldfizh Content Agent Builder.
// Vangt drie klassen bugs vóór de gebruiker de agent hoeft te deployen:
//
//   1. Syntax-fouten in index.html zelf
//   2. Syntax-fouten in de GEGENEREERDE lib/api/tools-bestanden
//   3. RUNTIME bugs in de gegenereerde frontend (ReferenceError, TypeError)
//      door de hoofdfuncties daadwerkelijk uit te voeren in een sandbox.
//
// Punt 3 is wat node --check niet vangt. Voorbeelden van bugs die hier
// uit zouden komen vóór ze op productie verschijnen:
//   - "rep is not defined" (variabele hernoemd, één plek vergeten)
//   - "Cannot read properties of null" (DOM-id wijziging niet doorgevoerd)
//   - "x.split is not a function" (verkeerd type aan een functie meegegeven)
//
// Gebruik:  node scripts/smoke-test.js
// Exit-code: 0 als alles OK, 1 als er minstens één test faalt.
// ──────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');

const INDEX_HTML = path.resolve(__dirname, '..', 'index.html');
const RED = '\x1b[31m', GREEN = '\x1b[32m', GREY = '\x1b[90m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';

let totalChecks = 0;
let failed = 0;

function ok(label) {
  totalChecks++;
  console.log(`  ${GREEN}✓${RESET} ${GREY}${label}${RESET}`);
}
function fail(label, err) {
  totalChecks++;
  failed++;
  console.log(`  ${RED}✗ ${label}${RESET}`);
  if (err) console.log(`    ${RED}${err.message || err}${RESET}`);
}

// ── 1. Builder-script extraheren ──────────────────────────────────────────
function extractBuilderScript() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Geen <script>-block gevonden in index.html');
  return m[1];
}

// ── 2. Mock-DOM voor sandbox-execution ────────────────────────────────────
// Minimale stubs zodat document.getElementById e.d. niet crashen. We zijn
// niet uit op CORRECT DOM-gedrag — we willen alleen weten of de code
// ÜBERHAUPT door zijn happy-path heen komt zonder ReferenceErrors.
function makeFakeDom() {
  const fakeEl = {
    addEventListener: () => {},
    removeEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    innerHTML: '',
    children: [],
    appendChild: () => {},
    removeChild: () => {},
    querySelector: () => fakeEl,
    querySelectorAll: () => [],
    closest: () => fakeEl,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    focus: () => {},
    click: () => {},
    nextElementSibling: null,
    parentNode: null,
  };
  // self-referential nextElementSibling om toggleResult/toggleReport te overleven
  fakeEl.nextElementSibling = {
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
  };
  fakeEl.parentNode = fakeEl;

  return {
    document: {
      getElementById: () => fakeEl,
      querySelectorAll: () => [],
      querySelector: () => fakeEl,
      createElement: () => fakeEl,
      addEventListener: () => {},
      body: fakeEl,
    },
    window: {
      addEventListener: () => {},
      __SHEET_PAGES__: null,
      location: { href: 'https://example.com', pathname: '/' },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: {
      clipboard: {
        writeText: () => Promise.resolve(),
        write: () => Promise.resolve(),
      },
    },
    alert: () => {},
    console: console,
    fetch: () => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
      json: () => Promise.resolve({}),
    }),
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise,
    ClipboardItem: function ClipboardItem() {},
    Blob: function Blob() {},
    URL: URL,
    AbortController: function AbortController() {
      return { abort: () => {}, signal: { aborted: false } };
    },
    setInterval: setInterval,
    clearInterval: clearInterval,
  };
}

// ── 3. Builder uitvoeren in sandbox, generators ophalen ───────────────────
function setupBuilderContext() {
  const builderJs = extractBuilderScript();
  const sandbox = makeFakeDom();
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(builderJs, ctx, { timeout: 5000 });
  } catch (err) {
    throw new Error('Builder kan niet worden geladen: ' + err.message);
  }
  return { ctx, sandbox };
}

// ── 4. Gegenereerde bestanden produceren en syntax-checken ────────────────
function generateAllArtifacts(ctx) {
  const cfg = { client: 'Test', agency: 'Goldfizh', baseDomain: 'https://test.nl' };
  const cmsConfig = { platform: 'andere' };

  const artifacts = {};
  const fns = [
    // Tools
    ['tool_fetch_url.js',    () => ctx.lcGenToolFetchUrl()],
    ['tool_consolidate.js',  () => ctx.lcGenToolConsolidate()],
    ['tool_write_page.js',   () => ctx.lcGenToolWritePage()],
    ['tool_revise_page.js',  () => ctx.lcGenToolRevisePage()],
    ['tool_validate.js',     () => ctx.lcGenToolValidate()],
    ['tool_load_knowledge.js', () => ctx.lcGenToolLoadKnowledge()],
    ['tool_publish_cms.js',  () => ctx.lcGenToolPublishCms(cmsConfig)],
    ['tool_parse_input.js',  () => ctx.lcGenToolParseInput()],
    ['tool_map_redirects.js', () => ctx.lcGenToolMapRedirects()],
    ['tool_export_redirects.js', () => ctx.lcGenToolExportRedirects('vercel')],
    ['tool_cms_read.js',     () => ctx.lcGenToolCmsRead(cmsConfig)],
    ['tool_excel_export.js', () => ctx.lcGenToolExcelExport()],
    ['tool_excel_import.js', () => ctx.lcGenToolExcelImport()],
    ['tool_cms_bulk_write.js', () => ctx.lcGenToolCmsBulkWrite(cmsConfig)],
    ['tools_index.js',       () => ctx.lcGenToolsIndex(false)],
    // Lib + API
    ['lib_review.js',        () => ctx.lcGenLibReview(['legal'])],
    ['api_agent.js',         () => ctx.lcGenApiAgent(true)],
    ['api_publish.js',       () => ctx.lcGenApiPublish(cmsConfig)],
    ['api_migrate.js',       () => ctx.lcGenApiMigrate()],
    ['api_redirects.js',     () => ctx.lcGenApiRedirects('vercel')],
    ['api_cms_export.js',    () => ctx.lcGenApiCmsExport(cmsConfig)],
    ['api_cms_import.js',    () => ctx.lcGenApiCmsImport(cmsConfig)],
  ];

  for (const [name, gen] of fns) {
    try {
      artifacts[name] = gen();
    } catch (err) {
      fail(`Generator faalt: ${name}`, err);
    }
  }
  return artifacts;
}

function checkArtifactSyntax(artifacts) {
  // node --check via child_process — werkt voor zowel CommonJS als ES-modules
  // (deze tools gebruiken import/export, dus vm.Script slaagt niet).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  try {
    for (const [name, content] of Object.entries(artifacts)) {
      const tmpFile = path.join(tmpDir, name);
      fs.writeFileSync(tmpFile, content);
      try {
        // --input-type detection door extensie .mjs forceren bij ESM-content
        const isModule = /\bimport\b|\bexport\b/.test(content);
        const checkFile = isModule ? tmpFile.replace(/\.js$/, '.mjs') : tmpFile;
        if (isModule) fs.renameSync(tmpFile, checkFile);
        execFileSync('node', ['--check', checkFile], { stdio: 'pipe' });
        ok(`Syntax: ${name}`);
      } catch (err) {
        const msg = (err.stderr ? err.stderr.toString() : err.message).split('\n').slice(0, 3).join(' ');
        fail(`Syntax: ${name}`, new Error(msg));
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 5. Gegenereerde frontend uitvoeren + hoofdfuncties aanroepen ──────────
// Dit is waar de echte runtime-bugs aan het licht komen.
function smokeTestFrontend(ctx, variantLabel, lcGenFrontendArgs) {
  let frontendOut;
  try {
    frontendOut = ctx.lcGenFrontend.apply(null, lcGenFrontendArgs);
  } catch (err) {
    fail(`lcGenFrontend(${variantLabel})`, err);
    return;
  }

  const start = frontendOut.lastIndexOf('<script>');
  const end = frontendOut.lastIndexOf('</script>');
  if (start < 0 || end < 0) {
    fail(`lcGenFrontend(${variantLabel}): geen <script>-block in output`);
    return;
  }
  const frontendJs = frontendOut.substring(start + 8, end);

  // Sandbox voor de gegenereerde frontend
  const feSandbox = makeFakeDom();
  const feCtx = vm.createContext(feSandbox);
  try {
    vm.runInContext(frontendJs, feCtx, { timeout: 5000 });
    ok(`Frontend top-level loadt (${variantLabel})`);
  } catch (err) {
    fail(`Frontend top-level (${variantLabel})`, err);
    return; // verdere tests zinloos
  }

  // Hoofdfuncties met realistische mock-data aanroepen
  const tests = [
    ['renderVerdict (groen)', () => feCtx.renderVerdict({
      verdict: 'green',
      reports: { seo: { flags: [], summary: 'alles ok' } },
      summary: 'Klaar voor publicatie',
    })],
    ['renderVerdict (oranje, geen revisie)', () => feCtx.renderVerdict({
      verdict: 'orange',
      reports: { seo: { flags: [{ severity: 'revise', issue: 'meta-titel kort', suggestion: 'verleng' }], summary: 'klein punt' } },
    })],
    ['renderVerdict (oranje + revisie)', () => feCtx.renderVerdict({
      verdict: 'orange',
      revised: true,
      reports: { seo: { flags: [], summary: 'verwerkt' } },
      initialReports: { seo: { flags: [{ severity: 'revise', issue: 'meta-titel kort' }], summary: 'origineel' } },
    })],
    ['renderVerdict (rood + revisie + post-review)', () => feCtx.renderVerdict({
      verdict: 'red',
      revised: true,
      reports: { seo: { flags: [{ severity: 'blocker', issue: 'nog open' }], summary: 'nog ruimte' } },
      initialReports: { seo: { flags: [{ severity: 'blocker', issue: 'nog open' }, { severity: 'blocker', issue: 'opgelost' }], summary: 'origineel' } },
    })],
    ['renderVerdict (multi-critic)', () => feCtx.renderVerdict({
      verdict: 'orange',
      reports: {
        seo: { flags: [{ severity: 'revise', issue: 'a' }], summary: 's1' },
        brand: { flags: [{ severity: 'optional', issue: 'b' }], summary: 's2' },
        strategy: { flags: [], summary: 's3' },
        legal: { flags: [{ severity: 'blocker', issue: 'c' }], summary: 's4' },
      },
    })],
    ['renderMetaFields (volledig)', () => feCtx.renderMetaFields({
      meta_title: 'Title', meta_description: 'Desc', slug: 'slug',
    })],
    ['renderMetaFields (leeg)', () => feCtx.renderMetaFields({})],
    ['renderMetaFields (alleen title)', () => feCtx.renderMetaFields({ title: 'Case title' })],
    ['renderMd (heading + lijst + link)', () => feCtx.renderMd('# H1\n\n- item\n\n[link](/x)')],
    ['renderMd (lege string)', () => feCtx.renderMd('')],
    ['addResultItem (succes)', () => feCtx.addResultItem({
      url: '/x', success: true, content: '# H1', page: { meta_title: 't', meta_description: 'd', slug: 's' },
    })],
    ['addResultItem (succes, geen meta)', () => feCtx.addResultItem({
      url: '/y', success: true, content: 'body',
    })],
    ['addResultItem (fout)', () => feCtx.addResultItem({ url: '/x', success: false, error: 'oops' })],
    ['addResultItem (succes + warnings)', () => feCtx.addResultItem({
      url: '/x', success: true, content: 'b', page: {}, warnings: ['w1'],
    })],
    ['initSheetPicker (geen data)', () => feCtx.initSheetPicker()],
    ['copyRichOrMd (markdown)', () => feCtx.copyRichOrMd('# H')],
    ['copyOutput', () => feCtx.copyOutput('w-content')],
    ['copyAllMeta', () => feCtx.copyAllMeta()],
  ];

  for (const [name, fn] of tests) {
    try {
      const result = fn();
      // Sommige zijn async — als ze een Promise retourneren, vang rejections ook
      if (result && typeof result.then === 'function') {
        // Promise: fire-and-forget — we tracken alleen sync errors hier
      }
      ok(`${variantLabel}: ${name}`);
    } catch (err) {
      fail(`${variantLabel}: ${name}`, err);
    }
  }
}

// ── 6. Main ───────────────────────────────────────────────────────────────
function main() {
  console.log(`${YELLOW}Goldfizh Content Agent — smoke-test${RESET}\n`);

  // 1. Builder zelf
  console.log(`${YELLOW}[1] Builder index.html${RESET}`);
  let builder;
  try {
    builder = setupBuilderContext();
    ok('Builder script laadt');
  } catch (err) {
    fail('Builder script laadt', err);
    summary();
    process.exit(1);
  }

  // 2. Alle generatoren produceren output
  console.log(`\n${YELLOW}[2] Generatoren produceren output${RESET}`);
  const artifacts = generateAllArtifacts(builder.ctx);
  for (const name of Object.keys(artifacts)) ok(`Gen: ${name}`);

  // 3. Gegenereerde JS heeft valide syntax
  console.log(`\n${YELLOW}[3] Syntax-check gegenereerde JS${RESET}`);
  checkArtifactSyntax(artifacts);

  // 4. Runtime smoke-test op gegenereerde frontend (3 varianten)
  console.log(`\n${YELLOW}[4] Runtime smoke-test gegenereerde frontend${RESET}`);
  const variants = [
    ['no-mig+review', [
      { client: 'X', agency: 'Y', baseDomain: 'https://x.nl' },
      { platform: 'andere' },
      { enabled: false },
      { enabled: true, domainCritics: ['legal'] },
    ]],
    ['mig+webflow+review', [
      { client: 'X', agency: 'Y', baseDomain: 'https://x.nl' },
      { platform: 'webflow' },
      { enabled: true, redirectFormat: 'vercel' },
      { enabled: true, domainCritics: ['legal', 'medical'] },
    ]],
    ['no-review', [
      { client: 'X', agency: 'Y', baseDomain: 'https://x.nl' },
      { platform: 'andere' },
      { enabled: false },
      { enabled: false },
    ]],
  ];

  for (const [label, args] of variants) {
    console.log(`  ${GREY}-- variant: ${label} --${RESET}`);
    smokeTestFrontend(builder.ctx, label, args);
  }

  summary();
}

function summary() {
  console.log(`\n${YELLOW}── Samenvatting ──${RESET}`);
  const passed = totalChecks - failed;
  if (failed === 0) {
    console.log(`${GREEN}✓ Alle ${totalChecks} checks geslaagd${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}✗ ${failed} van ${totalChecks} checks faalden${RESET}`);
    console.log(`${GREY}${passed} geslaagd, ${failed} gefaald${RESET}`);
    process.exit(1);
  }
}

main();
