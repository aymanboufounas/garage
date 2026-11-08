import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export class ApiError extends Error {
  constructor(message, status=422) { super(message); this.status=status; }
}
export const id = () => randomBytes(16).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
const derive = promisify(scrypt);
const scryptOptions = { N:32768, r:8, p:1, maxmem:64*1024*1024 };
export async function passwordHash(password) {
  const salt=randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password,salt,64,scryptOptions)).toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  const [,salt,expected]=stored.split('$');
  if (!salt || !expected) return false;
  const actual=await derive(password,salt,64,scryptOptions), original=Buffer.from(expected,'hex');
  return original.length===actual.length && timingSafeEqual(original,actual);
}
export function openDatabase(filename) {
  if (filename!==':memory:') { mkdirSync(dirname(filename),{recursive:true,mode:0o700}); }
  const db=new DatabaseSync(filename);
  db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  return db;
}
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result=action(); db.exec('COMMIT'); return result; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
}
export function text(data,key,min=1,max=120) {
  const value=data[key];
  if (typeof value!=='string' || value.trim().length<min || value.trim().length>max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) throw new ApiError(`Check ${key.replaceAll('_',' ')}.`);
  return value.trim();
}
export function integer(value,min,max,label='number') {
  if (typeof value!=='number' || !Number.isSafeInteger(value) || value<min || value>max) throw new ApiError(`Choose a valid ${label}.`);
  return value;
}
export function checkedRequestKey(data) {
  const key=text(data,'request_key',16,80);
  if(!/^[a-zA-Z0-9_-]+$/.test(key)) throw new ApiError('Invalid request key.');
  return key;
}
export const cities=['Casablanca','Rabat','Marrakech','Tangier','Nador','Fes','Meknes'];
const zone='Africa/Casablanca';
const zoned=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function parts(at) {
  return Object.fromEntries(zoned.formatToParts(at).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
}
export function addCalendarMonths(at, months) {
  const p=parts(at), month=p.month-1+months;
  const year=p.year+Math.floor(month/12), m=(month%12)+1;
  const day=Math.min(p.day,new Date(Date.UTC(year,m,0)).getUTCDate());
  const wall=Date.UTC(year,m-1,day,p.hour,p.minute,p.second);
  let candidate=wall;
  for(let i=0;i<5;i++) {
    const c=parts(candidate);
    const difference=wall-Date.UTC(c.year,c.month-1,c.day,c.hour,c.minute,c.second);
    if(difference===0) return candidate;
    candidate+=difference;
  }
  throw new ApiError('This end time falls in a clock change. Choose another start time.');
}
export function interval(input,now=Date.now()) {
  const mode=input.mode;
  if(!['hourly','monthly'].includes(mode)) throw new ApiError('Choose hourly or monthly.');
  if(typeof input.starts_at!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(input.starts_at)) throw new ApiError('Choose a valid start time with a timezone.');
  const [year,month,day]=input.starts_at.slice(0,10).split('-').map(Number);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||Number(input.starts_at.slice(11,13))>23||Number(input.starts_at.slice(14,16))>59)throw new ApiError('Choose a valid calendar date and time.');
  const start=Date.parse(input.starts_at);
  if(!Number.isFinite(start) || start<now+60000 || start>now+366*86400000) throw new ApiError('Choose a start at least one minute ahead, within the next year.');
  const units=integer(input.units,1,mode==='hourly'?168:12,mode==='hourly'?'number of hours (1–168)':'number of months (1–12)');
  const end=mode==='hourly'? start+units*3600000:addCalendarMonths(start,units);
  return {mode,units,starts_at:start,ends_at:end};
}
export function noOverlap(db,garage,start,end,exclude='') {
  if(db.prepare("SELECT id FROM reservations WHERE garage_id=? AND status='confirmed' AND starts_at<? AND ends_at>? AND id<>? LIMIT 1").get(garage,end,start,exclude)) throw new ApiError('This garage was just booked for that time. Choose another time.',409);
}
export function publicGarage(row) {
  // About 400 m precision; private entrance and exact pin are disclosed after confirmation.
  return {
    id:row.id, name:row.name, city:row.city, area:row.area,
    latitude:Math.round(row.latitude/0.004)*0.004, longitude:Math.round(row.longitude/0.004)*0.004,
    hourly_cents:row.hourly_cents, monthly_cents:row.monthly_cents, height_cm:row.height_cm,
    vehicle_size:row.vehicle_size, covered:Boolean(row.covered), description:row.description,
    image:row.image, status:row.status, owner_name:row.owner_name||'GarageShare host', is_demo:false
  };
}
export function limit(db,key,max,windowMs,now=Date.now()) {
  const k=hash(key);
  db.prepare('INSERT INTO rate_limits(key,hits,resets_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN resets_at<=? THEN 1 ELSE hits+1 END,resets_at=CASE WHEN resets_at<=? THEN ? ELSE resets_at END').run(k,now+windowMs,now,now,now+windowMs);
  const result=db.prepare('SELECT hits FROM rate_limits WHERE key=?').get(k);
  if(result.hits>max) throw new ApiError('Too many requests. Please try again later.',429);
}
export function audit(db,actor,action,target) {
  db.prepare('INSERT INTO audit(actor_id,action,target_id,created_at) VALUES(?,?,?,?)').run(actor,action,target,Date.now());
}
