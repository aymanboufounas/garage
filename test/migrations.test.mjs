import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase,id} from '../server/core.mjs';

test('additive compliance migrations preserve existing identities, garage and booking records and can reopen',t=>{
 const dir=mkdtempSync(join(tmpdir(),'garage-migration-')),file=join(dir,'old.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let db=new DatabaseSync(file);db.exec(readFileSync(new URL('../server/schema.sql',import.meta.url),'utf8'));
 const host=id(),renter=id(),garage=id(),booking=id(),now=Date.now();
 for(const [uid,name] of [[host,'Original host'],[renter,'Original renter']])db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(uid,name,name.replaceAll(' ','')+'@example.com','original-hash-fixture',now);
 db.prepare('INSERT INTO garages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(garage,host,'Original garage','Casablanca','Centre','Original private gate',33.57,-7.58,1200,95000,230,'suv',1,'Original garage description','/assets/garage-placeholder.svg','approved',now);
 db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(booking,garage,renter,'hourly',now+86400000,now+90000000,1,1200,'confirmed',null,now,now,'original-booking-key');
 const before={user:db.prepare('SELECT * FROM users WHERE id=?').get(host),garage:db.prepare('SELECT * FROM garages WHERE id=?').get(garage),booking:db.prepare('SELECT * FROM reservations WHERE id=?').get(booking)};db.close();
 db=openDatabase(file);assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,3);
 assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(host),before.user);assert.deepEqual(db.prepare('SELECT * FROM garages WHERE id=?').get(garage),before.garage);assert.deepEqual(db.prepare('SELECT * FROM reservations WHERE id=?').get(booking),before.booking);db.close();
 db=openDatabase(file);assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,3);assert.deepEqual(db.prepare('SELECT * FROM reservations WHERE id=?').get(booking),before.booking);db.close();
});
