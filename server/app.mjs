import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import {localizeError,requestLanguage} from '../web/errors.js';
import { ApiError,id,hash,passwordHash,passwordMatches,openDatabase,transaction,text,integer,cities,interval,noOverlap,publicGarage,limit,audit } from './core.mjs';

const MAX_BODY=16000, HOUR=3600000;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.woff2':'font/woff2','.json':'application/json'};
const sampleImage='/assets/garages/garage-01.webp';
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const safeUser=u=>u?{id:u.id,name:u.name,email:u.email}:null;

export function makeApp(options={}) {
  const db=options.db||openDatabase(options.database||resolve('data/garageshare.sqlite'));
  const web=resolve(options.web||new URL('../web',import.meta.url).pathname);
  const production=Boolean(options.production), demo=Boolean(options.demo);
  const origin=new URL(options.origin||'http://localhost:3000').origin;
  const trustedProxy=options.trustedProxy||'';
  if(trustedProxy&&!isIP(trustedProxy))throw new Error('TRUST_PROXY_IP must be one exact proxy IP address.');
  if(production&&new URL(origin).protocol!=='https:') throw new Error('Production APP_ORIGIN must use HTTPS.');
  const cookieName=production?'__Host-garageshare':'garageshare_session';
  // A real hash ensures unknown accounts perform the same password work.
  const dummyHash=passwordHash(randomBytes(32).toString('hex'));
  function clientIP(req){const peer=req.socket.remoteAddress,forwarded=req.headers['x-real-ip'];return trustedProxy&&peer===trustedProxy&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:peer;}
  function headers(res) {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Permissions-Policy','geolocation=(self), camera=(), microphone=(), payment=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; font-src 'self'; connect-src 'self' https://tile.openstreetmap.org; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(production) res.setHeader('Strict-Transport-Security','max-age=31536000');
  }
  function reply(res,body,status=200) {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(body));
  }
  function cookie(res,token) {
    res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12*3600}${production?'; Secure':''}`);
  }
  function session(req,res) {
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    const now=Date.now();
    let found=token&&/^[a-f0-9]{64}$/.test(token)?db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>? AND last_seen>?').get(hash(token),now,now-30*60000):null;
    if(found) { db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now,found.token_hash); return found; }
    limit(db,`session:${clientIP(req)}`,60,60000);
    const fresh=randomBytes(32).toString('hex');
    found={token_hash:hash(fresh),user_id:null,csrf:randomBytes(32).toString('hex'),created_at:now,last_seen:now,expires_at:now+12*HOUR};
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,last_seen) VALUES(?,?,?,?,?,?)').run(found.token_hash,null,found.csrf,found.expires_at,now,now);
    cookie(res,fresh); return found;
  }
  function signIn(res,oldSession,userId) {
    const token=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex'),now=Date.now();
    transaction(db,()=>{
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(oldSession.token_hash);
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(hash(token),userId,csrf,now+12*HOUR,now,now);
    });
    cookie(res,token);
    return {user:safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(userId)),csrf};
  }
  function requireUser(s) {
    const user=s.user_id&&db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
    if(!user) throw new ApiError('Sign in to continue.',401);
    return user;
  }
  async function body(req) {
    if(req.headers['content-type']?.split(';')[0]!=='application/json') throw new ApiError('Send JSON.',415);
    if(Number(req.headers['content-length'])>MAX_BODY) throw new ApiError('Request too large.',413);
    let size=0, chunks=[];
    for await(const chunk of req) { size+=chunk.length; if(size>MAX_BODY) throw new ApiError('Request too large.',413); chunks.push(chunk); }
    let result;
    try { result=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('Invalid JSON.'); }
    if(!result||typeof result!=='object'||Array.isArray(result)) throw new ApiError('Send a JSON object.');
    return result;
  }
  const server=createServer(async(req,res)=>{
    headers(res);
    try {
      const url=new URL(req.url,origin), path=url.pathname;
      if(path.startsWith('/api/')) {
        limit(db,`api:${clientIP(req)}`,240,60000);
        if(req.method==='GET'&&path==='/api/config') return reply(res,{demo,timezone:'Africa/Casablanca',currency:'MAD',payment_mode:'pay_on_arrival',cities});
        if(!['GET','POST'].includes(req.method)) { res.setHeader('Allow','GET, POST'); throw new ApiError('Method not allowed.',405); }
        const s=session(req,res), ip=clientIP(req);
        db.prepare("UPDATE reservations SET status='expired',updated_at=? WHERE status IN ('requested','countered') AND expires_at<=?").run(Date.now(),Date.now());
        if(req.method==='GET'&&path==='/api/session') return reply(res,{user:safeUser(s.user_id&&db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id)),csrf:s.csrf});
        if(req.method==='GET'&&path==='/api/garages') {
          const city=url.searchParams.get('city');
          const rows=city?db.prepare("SELECT g.*,u.name AS owner_name FROM garages g JOIN users u ON u.id=g.owner_id WHERE g.status='approved' AND g.city=? ORDER BY g.created_at DESC LIMIT 200").all(city):db.prepare("SELECT g.*,u.name AS owner_name FROM garages g JOIN users u ON u.id=g.owner_id WHERE g.status='approved' ORDER BY g.created_at DESC LIMIT 200").all();
          return reply(res,{garages:rows.map(publicGarage)});
        }
        if(req.method==='POST') {
          if(req.headers.origin!==origin) throw new ApiError('Request origin is not allowed.',403);
          if(!equal(req.headers['x-csrf-token'],s.csrf)) throw new ApiError('Your session expired. Refresh and try again.',403);
        }
        if(demo) throw new ApiError('This preview uses sample data. Switch to a live installation to create real accounts or bookings.',409);
        if(req.method==='POST'&&['/api/register','/api/login'].includes(path)) {
          limit(db,`auth-ip:${ip}`,20,15*60000);
          const data=await body(req),email=text(data,'email',3,190).toLowerCase();
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('Enter a valid email.');
          limit(db,`auth-email:${email}`,12,15*60000);
          const password=data.password;
          if(typeof password!=='string'||password.length<12||password.length>128) throw new ApiError('Use a password of 12–128 characters.');
          if(path==='/api/register') {
            const name=text(data,'name',2,80), password_hash=await passwordHash(password), uid=id();
            try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(uid,name,email,password_hash,Date.now()); }
            catch(e) { if(e.code==='ERR_SQLITE_ERROR'&&String(e.message).includes('UNIQUE')) throw new ApiError('This email cannot be registered. Try signing in.',409); throw e; }
            audit(db,uid,'register',uid); return reply(res,signIn(res,s,uid),201);
          }
          const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
          if(!(await passwordMatches(password,user?.password_hash||await dummyHash))||!user) throw new ApiError('Email or password is incorrect.',401);
          audit(db,user.id,'login',user.id);return reply(res,signIn(res,s,user.id));
        }
        if(req.method==='POST'&&path==='/api/logout') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
          res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production?'; Secure':''}`);
          return reply(res,{ok:true});
        }
        const user=requireUser(s);
        if(req.method==='GET'&&path==='/api/host/garages') return reply(res,{garages:db.prepare('SELECT * FROM garages WHERE owner_id=? ORDER BY created_at DESC').all(user.id)});
        if(req.method==='POST'&&path==='/api/host/garages') {
          limit(db,`listing:${user.id}`,10,HOUR);
          const data=await body(req),name=text(data,'name',3,100),city=text(data,'city',2,60),area=text(data,'area',2,100),address=text(data,'address',5,220),description=text(data,'description',10,1500);
          if(!cities.includes(city)) throw new ApiError('Choose a supported city.');
          const hourly=integer(data.hourly_cents,100,100000,'hourly price'),monthly=integer(data.monthly_cents,10000,10000000,'monthly price'),height=integer(data.height_cm,140,500,'entrance height in cm');
          if(!['compact','suv','van'].includes(data.vehicle_size)||typeof data.covered!=='boolean') throw new ApiError('Check vehicle size and cover.');
          if(typeof data.latitude!=='number'||!Number.isFinite(data.latitude)||data.latitude<27.5||data.latitude>36||typeof data.longitude!=='number'||!Number.isFinite(data.longitude)||data.longitude< -14||data.longitude> -0.8) throw new ApiError('Place your garage pin inside Morocco.');
          // No arbitrary external image URLs, SVG uploads, tracking images or server-side fetching.
          // A moderation-approved photo can be assigned through the admin CLI.
          const gid=id();
          db.prepare('INSERT INTO garages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,user.id,name,city,area,address,data.latitude,data.longitude,hourly,monthly,height,data.vehicle_size,data.covered?1:0,description,'/assets/garage-placeholder.svg','pending',Date.now());
          audit(db,user.id,'listing_submitted',gid);return reply(res,{id:gid,status:'pending'},201);
        }
        if(req.method==='GET'&&['/api/reservations','/api/host/reservations'].includes(path)) {
          const host=path.includes('/host/');
          const rows=db.prepare(`SELECT r.*,g.name,g.city,g.area,g.image,g.address,g.latitude,g.longitude,g.owner_id,u.name AS guest_name,o.name AS owner_name FROM reservations r JOIN garages g ON g.id=r.garage_id JOIN users u ON u.id=r.guest_id JOIN users o ON o.id=g.owner_id WHERE ${host?'g.owner_id':'r.guest_id'}=? ORDER BY r.created_at DESC LIMIT 200`).all(user.id);
          return reply(res,{reservations:rows.map(row=>{
            const out={...row};
            // Hosts already know their own entrance. Guests get access information only for a confirmed, ongoing or upcoming stay.
            if(!host&&(row.status!=='confirmed'||row.ends_at<Date.now())) { delete out.address;delete out.latitude;delete out.longitude; }
            delete out.request_key;return out;
          })});
        }
        if(req.method==='POST'&&path==='/api/reservations') {
          limit(db,`book:${user.id}`,20,15*60000);
          const data=await body(req),key=text(data,'request_key',16,80);
          if(!/^[a-zA-Z0-9_-]+$/.test(key)) throw new ApiError('Invalid request key.');
          const previous=db.prepare('SELECT * FROM reservations WHERE guest_id=? AND request_key=?').get(user.id,key);
          if(previous) return reply(res,{reservation:previous},200);
          const period=interval(data),garage=db.prepare("SELECT * FROM garages WHERE id=? AND status='approved'").get(text(data,'garage_id',32,32));
          if(!garage) throw new ApiError('This garage is unavailable.',404);
          if(garage.owner_id===user.id) throw new ApiError('You cannot book your own garage.',409);
          const listed=(period.mode==='hourly'?garage.hourly_cents:garage.monthly_cents)*period.units;
          if(!['book','offer'].includes(data.action)) throw new ApiError('Choose book or propose a price.');
          const total=data.action==='offer'?integer(data.total_cents,Math.ceil(listed*0.6),listed*2,'offer between 60% and 200% of the listed total'):listed;
          const now=Date.now(),rid=id(),status=data.action==='offer'?'requested':'confirmed',expiry=status==='requested'?Math.min(now+24*HOUR,period.starts_at):null;
          transaction(db,()=>{
            noOverlap(db,garage.id,period.starts_at,period.ends_at);
            db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,garage.id,user.id,period.mode,period.starts_at,period.ends_at,period.units,total,status,expiry,now,now,key);
            audit(db,user.id,status==='requested'?'offer_submitted':'booking_confirmed',rid);
          });
          return reply(res,{reservation:db.prepare('SELECT * FROM reservations WHERE id=?').get(rid)},201);
        }
        const match=path.match(/^\/api\/reservations\/([a-f0-9]{32})\/(accept|counter|decline|cancel)$/);
        if(req.method==='POST'&&match) {
          const data=await body(req),[,rid,action]=match;
          const result=transaction(db,()=>{
            const row=db.prepare('SELECT r.*,g.owner_id,g.hourly_cents,g.monthly_cents FROM reservations r JOIN garages g ON g.id=r.garage_id WHERE r.id=? AND (r.guest_id=? OR g.owner_id=?)').get(rid,user.id,user.id);
            if(!row) throw new ApiError('Reservation not found.',404);
            const isHost=row.owner_id===user.id,now=Date.now();
            if(action==='cancel') {
              if(!['requested','countered','confirmed'].includes(row.status)||row.starts_at<=now) throw new ApiError('This reservation can no longer be cancelled here.',409);
              db.prepare("UPDATE reservations SET status='cancelled',updated_at=? WHERE id=?").run(now,rid);
            } else if(action==='decline') {
              if(!isHost||!['requested','countered'].includes(row.status)) throw new ApiError('This action is not available.',409);
              db.prepare("UPDATE reservations SET status='declined',updated_at=? WHERE id=?").run(now,rid);
            } else if(action==='counter') {
              if(!isHost||row.status!=='requested') throw new ApiError('Only the host can counter a new offer.',403);
              const listed=(row.mode==='hourly'?row.hourly_cents:row.monthly_cents)*row.units;
              const total=integer(data.total_cents,Math.ceil(listed*0.6),listed*2,'counter offer');
              db.prepare("UPDATE reservations SET status='countered',total_cents=?,updated_at=? WHERE id=?").run(total,now,rid);
            } else {
              if(!((isHost&&row.status==='requested')||(!isHost&&row.status==='countered'))) throw new ApiError('Only the other party can accept this offer.',403);
              if(row.expires_at<=now||row.starts_at<=now) throw new ApiError('This offer expired.',409);
              const available=db.prepare('SELECT status FROM garages WHERE id=?').get(row.garage_id);
              if(available?.status!=='approved') throw new ApiError('This garage is no longer available.',409);
              noOverlap(db,row.garage_id,row.starts_at,row.ends_at,row.id);
              db.prepare("UPDATE reservations SET status='confirmed',expires_at=NULL,updated_at=? WHERE id=?").run(now,rid);
            }
            audit(db,user.id,`reservation_${action}`,rid);
            return db.prepare('SELECT * FROM reservations WHERE id=?').get(rid);
          });
          return reply(res,{reservation:result});
        }
        throw new ApiError('Endpoint not found.',404);
      }
      if(!['GET','HEAD'].includes(req.method)) throw new ApiError('Method not allowed.',405);
      let decoded;
      try { decoded=decodeURIComponent(path); } catch { throw new ApiError('Invalid URL.',400); }
      const file=resolve(web,'.'+(decoded==='/'?'/index.html':decoded));
      if(!file.startsWith(web+sep)||decoded.split('/').some(p=>p.startsWith('.'))||!MIME[extname(file)]) throw new ApiError('Not found.',404);
      let info;
      try { info=await stat(file); } catch { throw new ApiError('Not found.',404); }
      if(!info.isFile()) throw new ApiError('Not found.',404);
      res.writeHead(200,{'Content-Type':MIME[extname(file)],'Cache-Control':extname(file)==='.html'?'no-store':'public, max-age=3600'});
      res.end(req.method==='HEAD'?undefined:await readFile(file));
    } catch(error) {
      if(res.headersSent) { res.end();return; }
      const overlap=String(error.message).includes('reservation_overlap');
      const status=error instanceof ApiError?error.status:overlap?409:500;
      if(status===500) console.error('GarageShare request failed:',error.code||error.name);
      reply(res,{error:localizeError(error instanceof ApiError?error.message:overlap?'This time was just booked. Choose another time.':'Service unavailable. Please try again.',requestLanguage(req.headers['accept-language']))},status);
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=60;
  return {server,db,origin};
}
