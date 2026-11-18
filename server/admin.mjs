import { decodeListingPhoto, withListingPhoto } from './listing-photos.mjs';
import { isContentRemoved } from './ugc-moderation.mjs';
import { requireGuidelines } from './user-safety.mjs';
// This command runs only on the server. There is deliberately no public admin sign-up.
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {openDatabase,transaction,audit} from './core.mjs';
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
  requireGuidelines(db,row.owner_id);
  if(!photo)throw new Error('Supply an accurate, authorized WebP photo after checking ownership and the listing details.');
  const bytes=decodeListingPhoto(readFileSync(photo).toString('base64'));
  withListingPhoto(resolve('web'),bytes,image=>transaction(db,()=>{
   const current=db.prepare('SELECT status FROM garages WHERE id=?').get(gid);
   if(current?.status!=='pending'||isContentRemoved(db,'garage',gid))throw new Error('Listing changed or was removed. Review it before approval.');
   db.prepare('INSERT OR IGNORE INTO listing_photo_owners(image,user_id,created_at) VALUES(?,?,?)').run(image,row.owner_id,Date.now());
   db.prepare("UPDATE garages SET status='approved',image=? WHERE id=?").run(image,gid);audit(db,null,'moderator_approved',gid);
  }));
  console.log('Listing approved:',gid);
 }else if(['reject','archive'].includes(command)){
  const row=db.prepare('SELECT id FROM garages WHERE id=?').get(gid);if(!row)throw new Error('Listing not found.');
  if(db.prepare("SELECT id FROM reservations WHERE garage_id=? AND status='confirmed' AND ends_at>?").get(gid,Date.now()))throw new Error('Resolve upcoming reservations before archiving or rejecting this space.');
  db.prepare('UPDATE garages SET status=? WHERE id=?').run(command==='reject'?'rejected':'archived',gid);audit(db,null,'moderator_'+command,gid);console.log('Listing updated.');
 }else{console.log('Usage:\n  npm run admin -- pending\n  npm run admin -- approve LISTING_ID /absolute/accurate-photo.webp\n  npm run admin -- reject LISTING_ID\n  npm run admin -- archive LISTING_ID\n  npm run admin -- staff-list\n  npm run admin -- staff-grant ACCOUNT_EMAIL [admin|support]\n  npm run admin -- staff-revoke ACCOUNT_EMAIL');}
}catch(e){console.error(e.message);process.exitCode=1;}finally{db.close();}
