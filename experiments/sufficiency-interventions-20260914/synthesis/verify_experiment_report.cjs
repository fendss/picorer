const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {chromium}=require('/Users/johnnychiu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const base=__dirname,out=path.join(base,'unified','qa');fs.mkdirSync(out,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(base,'unified/report-manifest.json'),'utf8'));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const ctx=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
 const requests=[],errors=[];await ctx.route(/https?:\/\//,r=>{requests.push(r.request().url());return r.abort();});
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(manifest.output).href);
 await page.evaluate(async()=>{await Promise.all([...document.images].map(i=>i.decode()));await document.fonts.ready;});
 const audit=await page.evaluate(()=>{
  const allText=document.body.textContent;
  const forbidden=['上次报告','上一次','上一版','旧报告','新旧','本次整理','软件来源','skill','复核记录','运行变更','内嵌文件目录','原报告'];
  const ids=[...document.querySelectorAll('[id]')].map(x=>x.id);
  return {title:document.title,figures:document.images.length,mainFigures:document.querySelectorAll('article img').length,
   forbiddenPhrases:forbidden.filter(s=>allText.includes(s)),duplicateIds:ids.filter((v,i)=>ids.indexOf(v)!==i),
   brokenAnchors:[...document.querySelectorAll('a[href^="#"]')].map(a=>a.getAttribute('href').slice(1)).filter(id=>!document.getElementById(id)),
   imageChecks:[...document.images].map(i=>({embedded:i.src.startsWith('data:image/png;base64,'),width:i.naturalWidth,alt:i.alt})),
   overflow:document.documentElement.scrollWidth>innerWidth};
 });
 if(audit.figures!==13||audit.mainFigures!==5||audit.forbiddenPhrases.length||audit.duplicateIds.length||audit.brokenAnchors.length||audit.overflow)throw Error(JSON.stringify(audit));
 await page.screenshot({path:path.join(out,'01-report.png')});
 for(let i=0;i<5;i++){
  await page.locator('article img').nth(i).scrollIntoViewIfNeeded();
  await page.locator('article img').nth(i).screenshot({path:path.join(out,`figure-${i+1}.png`)});
 }
 await page.getByRole('heading',{name:'5. 未检测到充分性信号在 R 之外的稳定答题预测收益',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(out,'02-prediction.png')});
 await page.locator('nav a[href="#statistics"]').click();await page.waitForFunction(()=>document.getElementById('statistics').open);
 audit.statisticsAnchorWorks=true;
 const promise=page.waitForEvent('download');await page.locator('#archive-download').click();
 const download=await promise;const zipPath=path.join(out,'data.zip');await download.saveAs(zipPath);
 audit.archiveSHA256=crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
 if(audit.archiveSHA256!==manifest.archive_sha256)throw Error('Archive checksum mismatch');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{location.hash='top';scrollTo(0,0);});
 await page.screenshot({path:path.join(out,'03-mobile.png')});
 await page.locator('#nav-toggle').click();audit.mobileMenuWorks=await page.locator('#nav-links').isVisible();
 audit.mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 audit.requests=requests;audit.errors=errors;
 if(errors.length||requests.length||audit.mobileOverflow||!audit.mobileMenuWorks)throw Error(JSON.stringify(audit));
 audit.status='passed';fs.writeFileSync(path.join(base,'unified/report-validation.json'),JSON.stringify(audit,null,2)+'\n');
 await browser.close();console.log(JSON.stringify({status:audit.status,figures:audit.figures,mainFigures:audit.mainFigures,forbiddenPhrases:audit.forbiddenPhrases,networkRequests:requests.length}));
})().catch(e=>{console.error(e);process.exit(1);});
