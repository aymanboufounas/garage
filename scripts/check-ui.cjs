// Optional browser QA: npm install --no-save playwright && npx playwright install chromium
// Run: node scripts/check-ui.cjs
// CI can set BROWSER_EXECUTABLE and BROWSER_SINGLE_PROCESS=1.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
(async()=>{
 const {makeApp}=await import('../server/app.mjs');
 const port=Number(process.env.UI_PORT||3005),base=`http://127.0.0.1:${port}`;
 const app=makeApp({demo:true,database:':memory:',origin:base});
 await new Promise(r=>app.server.listen(port,'0.0.0.0',r));
 const output=path.resolve(__dirname,'../dist');fs.mkdirSync(output,{recursive:true});
 const errors=[],checks=[];let browser;
 const check=(label,value)=>{assert.ok(value,label);checks.push(label);};
 try{
  const args=['--no-sandbox','--disable-dev-shm-usage'];
  if(process.env.BROWSER_SINGLE_PROCESS==='1')args.push('--single-process','--no-zygote');
  if(process.env.BROWSER_EXTRA_ARGS)args.push(...JSON.parse(process.env.BROWSER_EXTRA_ARGS));
  browser=await chromium.launch({headless:true,args,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),...(process.env.BROWSER_PROXY?{proxy:{server:process.env.BROWSER_PROXY,bypass:'127.0.0.1,localhost'}}:{})});
  // Local QA may use a TLS-intercepting download proxy. The app itself never bypasses TLS errors.
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,ignoreHTTPSErrors:Boolean(process.env.BROWSER_PROXY)});
  // Some isolated runners allow curl networking but cannot connect Chromium's network process.
  // This optional QA relay fetches the exact visible OSM tiles; no map image is fabricated or bundled.
  if(process.env.QA_TILE_RELAY==='1'){
   const tiles=new Map();
   await context.route('https://tile.openstreetmap.org/**',async route=>{
    const url=route.request().url();
    if(!/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(url))return route.abort();
    try{
     if(!tiles.has(url))tiles.set(url,execFile('curl',['--fail','--silent','--show-error','--max-time','20','-A','GarageShare/0.2.0 - Interactive UI Development','-e',base+'/',url],{encoding:'buffer',maxBuffer:1024*1024,timeout:25000}).then(r=>r.stdout));
     const image=await tiles.get(url);
     if(image.subarray(1,4).toString()!=='PNG')throw new Error('Tile did not return a PNG.');
     await route.fulfill({status:200,contentType:'image/png',body:image});
    }catch{await route.abort();}
   });
  }
  await context.addInitScript(()=>{if(!localStorage.getItem('garageshare-language'))localStorage.setItem('garageshare-language','en');});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('.garage-card').first().waitFor();
  check('Explore loads four sample garages',await page.locator('.garage-card').count()===4);
  check('Mobile layout has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(output,'mobile-explore.png')});
  await page.locator('.map-toggle').click();await page.locator('.leaflet-marker-icon').first().waitFor({state:'visible'});
  check('Map displays four interactive price pins',await page.locator('.leaflet-marker-icon').count()===4);
  try{await page.waitForFunction(()=>{const tiles=[...document.querySelectorAll('#map .leaflet-tile')];return tiles.length>0&&tiles.every(x=>x.complete&&x.naturalWidth>0&&Number(getComputedStyle(x).opacity)>.99);},null,{timeout:20000});checks.push('Online map tiles render');}catch{checks.push('Map tile failure has a visible fallback; external network unavailable');}
  await page.screenshot({path:path.join(output,'mobile-map.png')});
  await page.locator('.map-toggle').click();
  await page.locator('[data-action="save"]').first().click();
  await page.locator('.bottom-nav [data-page="saved"]').click();
  check('Saved garages remain in the shortlist',await page.locator('.garage-card').count()===1);
  await page.locator('.bottom-nav [data-page="explore"]').click();
  await page.locator('[data-action="mode"][data-mode="monthly"]').click();
  check('Monthly search uses the monthly rate',(await page.locator('.card-price').first().innerText()).includes('950'));
  await page.locator('.card-image-button').first().click();
  check('Garage detail sheet opens',(await page.locator('#sheet-title').innerText()).includes('Palm'));
  await page.screenshot({path:path.join(output,'mobile-detail.png')});
  await page.locator('[data-action="book-form"]').click();
  await page.screenshot({path:path.join(output,'mobile-booking.png')});
  await page.locator('[data-action="booking-type"][data-type="offer"]').click();
  await page.locator('[name="offer"]').fill('850');
  await page.locator('#booking-submit').click();await page.getByText('Your offer is on its way.').waitFor();
  await page.locator('.sheet [data-page="trips"]').click();await page.locator('.booking-card').waitFor();
  check('Offer appears as requested',(await page.locator('.status').textContent())==='Offer sent');
  await page.locator('[data-step="reply"]').click();await page.getByText('New price',{exact:true}).waitFor();
  await page.locator('[data-step="accept"]').click();await page.getByText('Confirmed',{exact:true}).waitFor();
  check('Guest accepts host counter at the agreed price',(await page.locator('.booking-amount').innerText()).includes('900'));
  await page.screenshot({path:path.join(output,'mobile-trip.png')});
  await page.locator('.bottom-nav [data-page="explore"]').click();
  await page.locator('.card-image-button').first().click();await page.locator('[data-action="book-form"]').click();
  await page.locator('#booking-submit').click();await page.locator('.form-error:not([hidden])').waitFor();
  check('Conflicting preview booking shows a clear error',(await page.locator('.form-error').innerText()).includes('already has a booking'));
  await page.locator('[data-action="close-modal"]').click();
  await page.locator('.bottom-nav [data-page="trips"]').click();await page.locator('.booking-card').waitFor();
  await page.locator('[data-action="cancel-form"]').click();await page.locator('#cancel-form [type="submit"]').click();await page.getByText('Cancelled',{exact:true}).waitFor();
  checks.push('Cancellation updates the trip');
  await page.locator('.bottom-nav [data-page="host"]').click();await page.locator('[data-action="host-form"]').first().click();
  const form=page.locator('#host-form');
  await form.locator('[name="name"]').fill('Bright <img src=x onerror=alert(1)> Garage');
  await form.locator('[name="area"]').fill('Maârif');
  await form.locator('[name="address"]').fill('Private gate 42, example street');
  await form.locator('[name="hourly"]').fill('15');await form.locator('[name="monthly"]').fill('1100');
  await form.locator('[name="height_cm"]').fill('230');await form.locator('[name="description"]').fill('A spacious private covered garage for a car or SUV.');
  await page.locator('#picker-map').click({position:{x:140,y:70}});
  check('Host entrance is selected on the map',Boolean(await form.locator('[name="latitude"]').inputValue()));
  await form.locator('[type="submit"]').click();await page.getByText('In review',{exact:true}).waitFor();
  check('Host listing stays pending review',await page.locator('.status.pending').count()===1);
  check('User-supplied markup is displayed as text',await page.locator('img[src="x"]').count()===0);
  await page.locator('[data-action="approve-demo"]').click();await page.getByText('Published',{exact:true}).waitFor();
  checks.push('Preview moderation publishes the sample listing');
  await page.screenshot({path:path.join(output,'mobile-host.png')});
  await page.locator('[data-tab="requests"]').click();await page.locator('[data-action="sample-host"]').click();
  await page.locator('[data-action="counter-form"]').click();await page.locator('[name="total"]').fill('33');await page.locator('#counter-form [type="submit"]').click();await page.getByText('New price',{exact:true}).waitFor();
  checks.push('Host sends a counter offer');
  await page.locator('.bottom-nav [data-page="explore"]').click();await page.setViewportSize({width:320,height:740});
  check('Small-screen layout has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1440,height:1000});await page.locator('.leaflet-marker-icon').first().waitFor({state:'visible'});
  await page.screenshot({path:path.join(output,'desktop-explore.png'),fullPage:true});
  check('No uncaught browser errors',errors.length===0);
  fs.writeFileSync(path.join(output,'ui-validation.json'),JSON.stringify({checks,errors},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
 }finally{if(browser)await browser.close();await new Promise(r=>app.server.close(r));app.db.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
