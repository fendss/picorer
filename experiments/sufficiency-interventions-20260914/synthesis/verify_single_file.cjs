const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('/Users/johnnychiu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const root = __dirname;
  const artifact = path.join(root, 'Picorer-Sufficiency-完整实验资料.html');
  const qa = path.join(root, 'single-file-qa');
  fs.mkdirSync(qa, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const externalRequests = [], errors = [];
  await context.route(/https?:\/\//, route => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(artifact).href, { waitUntil: 'load' });
  await page.evaluate(async () => { await Promise.all([...document.images].map(i => i.decode())); await document.fonts.ready; });
  const audit = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
    return {
      title: document.title,
      images: [...document.images].map(i => ({ alt: i.alt, width: i.naturalWidth, height: i.naturalHeight, embedded: i.src.startsWith('data:image/png;base64,') })),
      brokenAnchors: [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')).filter(h => !document.getElementById(decodeURIComponent(h.slice(1)))),
      duplicateIds: ids.filter((v,i) => ids.indexOf(v) !== i),
      externalDependencies: [...document.querySelectorAll('img[src],script[src],link[href],iframe[src]')].map(n => n.getAttribute('src') || n.getAttribute('href')).filter(v => /^(file:|https?:|\/)/.test(v)),
      tableCount: document.querySelectorAll('.data-table').length,
      desktopOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  if (audit.images.length !== 17 || audit.tableCount !== 51 || audit.brokenAnchors.length || audit.duplicateIds.length || audit.externalDependencies.length) throw new Error(JSON.stringify(audit));
  await page.screenshot({ path: path.join(qa, '01-overview.png') });
  await page.getByRole('heading', { name: '3. 实验一：标准证据本身会提高充分性信号', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(qa, '02-evidence-section.png') });
  const preview = page.locator('article > p img').nth(2);
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(qa, '03-preview-figure.png') });
  await page.locator('nav a[href="#previous-report"]').click();
  audit.oldAppendixOpened = await page.locator('#previous-report').evaluate(e => e.open);
  const oldFigure = page.locator('#previous-report img').nth(0);
  await oldFigure.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(qa, '04-old-report.png') });
  // An anchor to a table nested in two collapsed sections must open both ancestors.
  const tableAnchor = await page.locator('article a[href^="#table-"]').first().getAttribute('href');
  await page.evaluate(h => { document.querySelectorAll('details').forEach(d => d.open=false);location.hash=h; }, tableAnchor);
  await page.waitForFunction(h => {
    const target = document.getElementById(h.slice(1));
    return target.open && target.closest('#statistics').open;
  }, tableAnchor);
  audit.tableAnchorOpensAncestors = true;
  await page.locator(tableAnchor).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(qa, '05-statistics.png') });
  await page.locator('#expand-all').click();
  const supplementary = page.locator('#supplementary-figures img');
  for (let i=0; i<await supplementary.count(); i++) {
    await supplementary.nth(i).scrollIntoViewIfNeeded();
    await supplementary.nth(i).screenshot({ path: path.join(qa, `supplement-${String(i+1).padStart(2,'0')}.png`) });
  }
  // The embedded ZIP must download without file or network dependencies.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#archive-download').click();
  const download = await downloadPromise;
  const archivePath = path.join(qa, 'download-check.zip');
  await download.saveAs(archivePath);
  const downloaded = fs.readFileSync(archivePath);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'single-file-manifest.json'), 'utf8'));
  audit.downloadSHA256 = crypto.createHash('sha256').update(downloaded).digest('hex');
  if (audit.downloadSHA256 !== manifest.zip_sha256) throw new Error('Downloaded archive hash differs');
  // Test a narrow viewport and preserve a visual check.
  await page.locator('#collapse-all').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { location.hash='top';scrollTo(0,0); });
  audit.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.screenshot({ path: path.join(qa, '06-mobile.png') });
  await page.locator('#nav-toggle').click();
  audit.mobileTocWorks = await page.locator('#nav-links').isVisible();
  if (!audit.mobileTocWorks) throw new Error('Mobile navigation did not open');
  audit.externalRequests = externalRequests;
  audit.browserErrors = errors;
  if (errors.length || externalRequests.length || audit.desktopOverflow || audit.mobileOverflow) throw new Error(JSON.stringify(audit));
  audit.status = 'passed';
  audit.manualVisualReview = 'Screenshots generated; reviewed separately before delivery.';
  fs.writeFileSync(path.join(root, 'single-file-validation.json'), JSON.stringify(audit,null,2)+'\n');
  await browser.close();
  console.log(JSON.stringify({ status:audit.status, images:audit.images.length, tables:audit.tableCount, brokenAnchors:audit.brokenAnchors.length, networkRequests:externalRequests.length, downloadedBytes:downloaded.length }));
})().catch(err => { console.error(err); process.exit(1); });
