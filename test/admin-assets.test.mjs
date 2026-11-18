import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, cpSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeApp} from '../server/app.mjs';
import {createWebAssets} from '../server/web-assets.mjs';

async function setup(t) {
 const web=mkdtempSync(join(tmpdir(),'garage-assets-'));
 cpSync(new URL('../web',import.meta.url),web,{recursive:true});
 const app=makeApp({database:':memory:',web});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();rmSync(web,{recursive:true,force:true});});
 return {web,app,base};
}

test('admin entry points and their transitive imports share a content-versioned namespace',async t=>{
 const {base}=await setup(t);
 const page=await fetch(base+'/admin.html');assert.equal(page.headers.get('cache-control'),'no-store');
 const html=await page.text();
 const entry=html.match(/src="(\/__assets\/([a-f0-9]{16})\/admin\.js)"/);
 assert.ok(entry,'HTML must bypass already-fresh cached admin.js');
 const prefix=`/__assets/${entry[2]}/`;
 assert.ok(html.includes(`href="${prefix}admin.css"`));
 assert.ok(html.includes(`href="${prefix}style.css"`));
 const hostHtml=await fetch(base+'/').then(r=>r.text());
 assert.ok(hostHtml.includes(`src="${prefix}app.js"`),'host workflow modules share the current deployment revision');
 const source=await fetch(base+entry[1]);assert.equal(source.status,200);assert.equal(source.headers.get('cache-control'),'no-cache');
 const javascript=await source.text();assert.match(javascript,/\.\/i18n\.js/);
 const translationURL=new URL('./i18n.js',base+entry[1]);
 assert.equal(translationURL.pathname,prefix+'i18n.js');
 const catalog=await fetch(translationURL).then(r=>r.text());
 assert.match(catalog,/\.\.\.adminShellCopy/);
 const shellURL=new URL('./admin-shell-copy.js',translationURL);
 const shell=await fetch(shellURL).then(r=>r.text());assert.match(shell,/adminNavigation/);
 assert.equal((await fetch(base+prefix+'assets/vendor/fonts/manrope-latin-wght-normal.woff2')).status,200,'CSS relative fonts work through the namespace');
 const head=await fetch(base+entry[1],{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('asset revisions follow code changes and stale or unsafe namespace paths stay blocked',async t=>{
 const {web,base}=await setup(t);
 const before=createWebAssets(web);
 writeFileSync(join(web,'admin-shell-copy.js'),"export const adminShellCopy={adminNavigation:['Updated','Actualisé','تحديث']};\n");
 const after=createWebAssets(web);assert.notEqual(before.version,after.version);
 assert.equal((await fetch(base+after.prefix+'i18n.js')).status,404,'running instance must not serve another revision as current');
 for(const suffix of ['admin.html','../server/core.mjs','%2e%2e/server/core.mjs','.env','%2eenv']) {
  assert.equal((await fetch(base+before.prefix+suffix)).status,404,suffix);
 }
 assert.equal((await fetch(base+'/__assets/invalid/i18n.js')).status,404);
 assert.equal((await fetch(base+'/__assets/0000000000000000/i18n.js')).status,404);
});
