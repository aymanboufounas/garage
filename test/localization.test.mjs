import test from 'node:test';
import assert from 'node:assert/strict';
import {translationCatalog,setLanguage,t,duration,localizedField,cityName} from '../web/i18n.js';
import {errorCatalog,localizeError,requestLanguage} from '../web/errors.js';
import {makeApp} from '../server/app.mjs';

test('every UI message has complete English, French and Arabic values and matching parameters',()=>{
 for(const [key,row] of Object.entries(translationCatalog)){
  assert.equal(row.length,3,key);
  for(const value of row)assert.ok(typeof value==='string'&&value.trim(),key);
  const params=value=>[...value.matchAll(/\{(\w+)\}/g)].map(x=>x[1]).sort();
  assert.deepEqual(params(row[0]),params(row[1]),key+' French parameters');
  assert.deepEqual(params(row[0]),params(row[2]),key+' Arabic parameters');
 }
});
test('Arabic durations, localized sample data and user content retain correct semantics',()=>{
 setLanguage('ar');assert.equal(duration(1,'hourly'),'ساعة واحدة');assert.equal(duration(2,'hourly'),'ساعتان');assert.match(duration(3,'monthly'),/أشهر/);
 assert.equal(cityName('Nador'),'الناظور');assert.equal(localizedField({is_demo:false,name:'Mon garage',name_ar:'غير مستعمل'},'name'),'Mon garage');
 assert.equal(localizedField({is_demo:true,name:'Sample',name_ar:'تجريبي'},'name'),'تجريبي');
 setLanguage('fr');assert.equal(t('monthly'),'Au mois');assert.equal(duration(2,'monthly'),'2 mois');
 assert.equal(setLanguage('invalid'),false);assert.equal(t('monthly'),'Au mois');setLanguage('en');
});
test('known errors translate without changing protocol status or exposing private data',async t=>{
 for(const row of Object.values(errorCatalog))assert.ok(row[0]&&row[1]);
 assert.equal(requestLanguage('fr-MA,fr;q=0.9'),'fr');assert.equal(requestLanguage('ar-MA'),'ar');
 const app=makeApp({database:':memory:',origin:'http://localhost'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 for(const lang of ['fr','ar','en']){
  const res=await fetch(base+'/api/reservations',{headers:{'Accept-Language':lang}});assert.equal(res.status,401);
  assert.equal((await res.json()).error,localizeError('Sign in to continue.',lang));
 }
});
