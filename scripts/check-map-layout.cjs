// Regression checks for map controls occluded by navigation and WebView resize.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const {makeApp}=await import('../server/app.mjs');
 const base='http://127.0.0.1:'+Number(process.env.MAP_UI_PORT||3007);
 const app=makeApp({demo:true,database:':memory:',origin:base});
 await new Promise(resolve=>app.server.listen(Number(new URL(base).port),'0.0.0.0',resolve));
 const output=path.resolve(__dirname,'../dist');fs.mkdirSync(output,{recursive:true});
 const checks=[],errors=[];let browser;
 const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
 try{
  const args=['--no-sandbox','--disable-dev-shm-usage'];
  if(process.env.BROWSER_SINGLE_PROCESS==='1')args.push('--single-process','--no-zygote');
  if(process.env.BROWSER_EXTRA_ARGS)args.push(...JSON.parse(process.env.BROWSER_EXTRA_ARGS));
  browser=await chromium.launch({headless:true,args,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:360,height:800},deviceScaleFactor:2});
  await context.route('https://tile.openstreetmap.org/**',route=>route.abort());
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.locator('.garage-card').first().waitFor();
  for(const lang of ['en','fr','ar']){
   await page.locator('#language').selectOption(lang);
   await page.evaluate(()=>document.fonts.ready);
   check(lang+': upright headline',await page.locator('.hero-accent').evaluate(el=>getComputedStyle(el).fontStyle)==='normal');
   if(lang!=='ar')check(lang+': clean sans serif title',await page.locator('.hero h1').evaluate(el=>getComputedStyle(el).fontFamily.includes('DM')));
   check(lang+': Map is inline above the results heading',await page.locator('.explore-toolbar .map-toggle').evaluate(button=>{
    const rect=button.getBoundingClientRect(),results=document.querySelector('#result-count').closest('.section-line');
    return rect.height>=44&&rect.left>=0&&rect.right<=innerWidth&&rect.bottom<=results.getBoundingClientRect().top;
   }));
   await page.evaluate(()=>window.scrollTo(0,Math.min(240,document.documentElement.scrollHeight-innerHeight)));
   await page.locator('.map-toggle').scrollIntoViewIfNeeded();
   const before=await page.evaluate(()=>window.scrollY);
   await page.locator('.map-toggle').click();
   await page.waitForFunction(()=>document.body.classList.contains('map-open'));
   await page.waitForFunction(()=>document.querySelector('#map').getBoundingClientRect().height>100);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const geometry=()=>page.evaluate(()=>{
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right};};
    return {button:rect('.map-toggle'),nav:rect('.bottom-nav'),map:rect('#map'),header:rect('.header'),viewport:visualViewport.height,scroll:scrollY,heroVisible:document.querySelector('.explore-main').getBoundingClientRect().height>0};
   });
   let g=await geometry();
   check(lang+': map button above bottom navigation',g.button.bottom<=g.nav.top-10);
   check(lang+': complete button visible',g.button.top>=g.map.top&&g.button.height>=44&&g.button.left>=0&&g.button.right<=360);
   check(lang+': map exactly fills available app area',Math.abs(g.map.top-g.header.bottom)<=1&&Math.abs(g.map.bottom-g.nav.top)<=1);
   check(lang+': navigation at visible viewport bottom',Math.abs(g.nav.bottom-g.viewport)<=1);
   check(lang+': scroll does not expose the hero behind map',g.scroll===0&&!g.heroVisible);
   const pinsInside=await page.locator('.leaflet-marker-icon').evaluateAll(markers=>{
    const map=document.querySelector('#map').getBoundingClientRect();
    return {map:map.toJSON(),pins:markers.map(marker=>marker.getBoundingClientRect().toJSON()),inside:markers.length===4&&markers.every(marker=>{const r=marker.getBoundingClientRect();return r.left>=map.left&&r.right<=map.right&&r.top>=map.top&&r.bottom<=map.bottom;})};
   });
   assert.ok(pinsInside.inside,JSON.stringify(pinsInside));
   checks.push(lang+': nearby price pins stay inside the map after opening');
   const box=await page.locator('.map-toggle').boundingBox();
   check(lang+': map button receives touches',await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('.map-toggle')),{x:box.x+box.width/2,y:box.y+box.height/2}));
   await page.screenshot({path:path.join(output,`map-fixed-${lang}.png`)});
   // Emulate a modern WebView whose visual viewport is shorter than its layout
   // viewport, as occurs when system UI or the keyboard changes its bounds.
   await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>650});visualViewport.dispatchEvent(new Event('resize'));});
   await page.waitForFunction(()=>Math.abs(document.querySelector('.bottom-nav').getBoundingClientRect().bottom-650)<2);
   g=await geometry();check(lang+': visual viewport resize keeps controls visible',g.button.bottom<g.nav.top&&Math.abs(g.nav.bottom-650)<2);
   await page.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
   await page.waitForFunction(()=>Math.abs(document.querySelector('.bottom-nav').getBoundingClientRect().bottom-visualViewport.height)<2);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   check(lang+': viewport changes preserve the selected map area',await page.locator('.leaflet-marker-icon').evaluateAll(markers=>{
    const map=document.querySelector('#map').getBoundingClientRect();
    return markers.every(marker=>{const r=marker.getBoundingClientRect();return r.left>=map.left&&r.right<=map.right&&r.top>=map.top&&r.bottom<=map.bottom;});
   }));
   await page.locator('.map-toggle').click();
   check(lang+': closing map restores list scroll',Math.abs(await page.evaluate(()=>scrollY)-before)<=1);
  }
  // Input focus must survive keyboard/visual-viewport resize notifications.
  await page.locator('#search').fill('');await page.locator('#search').focus();
  await page.evaluate(()=>visualViewport.dispatchEvent(new Event('resize')));
  check('viewport resize preserves input focus',await page.locator('#search').evaluate(el=>el===document.activeElement));
  await page.locator('#search').fill('no garage matches this query');
  await page.locator('#search').blur();await page.locator('.map-toggle').click();
  check('map explains why there are no pins',await page.locator('#map-empty').isVisible()&&await page.locator('.leaflet-marker-icon').count()===0);
  await page.setViewportSize({width:360,height:480});
  await page.waitForFunction(()=>Math.abs(document.querySelector('.bottom-nav').getBoundingClientRect().bottom-480)<2);
  check('compact phone height preserves map button',await page.evaluate(()=>document.querySelector('.map-toggle').getBoundingClientRect().bottom<document.querySelector('.bottom-nav').getBoundingClientRect().top));
  await page.setViewportSize({width:1000,height:700});
  await page.waitForFunction(()=>!document.body.classList.contains('map-open'));
  check('desktop resize exits mobile map layout',await page.locator('.explore-main').isVisible());
  check('no uncaught layout errors',errors.length===0);
  fs.writeFileSync(path.join(output,'map-layout-validation.json'),JSON.stringify({passed:checks.length,checks,errors},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
 }finally{if(browser)await browser.close();await new Promise(resolve=>app.server.close(resolve));app.db.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
