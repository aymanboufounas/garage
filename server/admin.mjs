// This command runs only on the server. There is deliberately no public admin sign-up.
import {resolve,basename} from 'node:path';
import {readFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {openDatabase,transaction,audit,id} from './core.mjs';
const db=openDatabase(resolve(process.env.DATA_DIR||'data','garageshare.sqlite'));
const [command,gid,photo]=process.argv.slice(2);
try {
 if(command==='staff-list'){
  console.table(db.prepare('SELECT u.email,u.name,s.role FROM staff_members s JOIN users u ON u.id=s.user_id ORDER BY u.email').all());
 }else if(command==='staff-grant'||command==='staff-revoke'){
  const email=(gid||'').trim().toLowerCase();
  const role=photo||'support';
  if(!email||(command==='staff-grant'&&!['admin','support'].includes(role)))throw new Error('Supply an existing account email and the admin or support role.');
  const user=db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if(!user)throw new Error('Account not found.');
  transaction(db,()=>{
   if(command==='staff-grant'){
    db.prepare('INSERT INTO staff_members (user_id,role) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role').run(user.id,role);
   }else{
    db.prepare('DELETE FROM staff_members WHERE user_id=?').run(user.id);
   }
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
   audit(db,null,command==='staff-grant'?`staff_granted_${role}`:'staff_revoked',user.id);
  });
  console.log(command==='staff-grant'?`Staff access granted (${role}). Sign in again.`:'Staff access revoked.');
 }else if(command==='pending'){
  console.table(db.prepare("SELECT id,name,city,area,status FROM garages WHERE status='pending'").all());
 }else if(command==='approve'){
  if(!/^[a-f0-9]{32}$/.test(gid||''))throw new Error('Supply a listing ID from the pending command.');
  const row=db.prepare("SELECT * FROM garages WHERE id=? AND status='pending'").get(gid);
  if(!row)throw new Error('Pending listing not found.');
  if(!photo)throw new Error('Supply an accurate, authorized WebP photo after checking ownership and the listing details.');
  const bytes=readFileSync(photo);
  if(bytes.length>5*1024*1024||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WEBP')throw new Error('Use a valid WebP photo under 5 MB. Re-encode it to remove metadata.');
  const directory=resolve('web/assets/host-photos');mkdirSync(directory,{recursive:true});
  const name=id()+'.webp';copyFileSync(photo,resolve(directory,name));
  transaction(db,()=>{db.prepare("UPDATE garages SET status='approved',image=? WHERE id=?").run('/assets/host-photos/'+name,gid);audit(db,null,'moderator_approved',gid);});
  console.log('Listing approved:',gid);
 }else if(['reject','archive'].includes(command)){
  const row=db.prepare('SELECT id FROM garages WHERE id=?').get(gid);if(!row)throw new Error('Listing not found.');
  if(db.prepare("SELECT id FROM reservations WHERE garage_id=? AND status='confirmed' AND ends_at>?").get(gid,Date.now()))throw new Error('Resolve upcoming reservations before archiving or rejecting this space.');
  db.prepare('UPDATE garages SET status=? WHERE id=?').run(command==='reject'?'rejected':'archived',gid);audit(db,null,'moderator_'+command,gid);console.log('Listing updated.');
 }else{console.log('Usage:\n  npm run admin -- pending\n  npm run admin -- approve LISTING_ID /absolute/accurate-photo.webp\n  npm run admin -- reject LISTING_ID\n  npm run admin -- archive LISTING_ID\n  npm run admin -- staff-list\n  npm run admin -- staff-grant ACCOUNT_EMAIL [admin|support]\n  npm run admin -- staff-revoke ACCOUNT_EMAIL');}
}catch(e){console.error(e.message);process.exitCode=1;}finally{db.close();}
