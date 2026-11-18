import { createServer } from 'node:http';
import { readFile, stat, lstat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import {localizeError,requestLanguage} from '../web/errors.js';
import { ApiError,id,hash,passwordHash,passwordMatches,openDatabase,transaction,text,integer,cities,interval,noOverlap,limit,audit,checkedRequestKey,hasArrivalAccess } from './core.mjs';
import { dealsRoute } from './deals.mjs';
import { staffRole, supportRoute } from './support.mjs';
import { requireModerator, moderationRoute } from './moderation.mjs';
import { adminOperationsRoute } from './admin-operations.mjs';
import { createWebAssets } from './web-assets.mjs';
import { decodeListingPhoto, requireHostPhotoListing, submitHostPhoto, withListingPhoto } from './listing-photos.mjs';
import { chatRoute } from './chat.mjs';
import { browseGarages, calendarRoute } from './availability.mjs';
import { garageReviews, reviewsRoute } from './reviews.mjs';
import { makeGoogleAuth } from './google-auth.mjs';
import { assertAccountActive, accountState, accountDeletionRoute } from './account-lifecycle.mjs';
import { GUIDELINES_VERSION, requireGuidelines, requireInteractionAllowed, safetyRoute } from './user-safety.mjs';
import { ugcModerationRoute } from './ugc-moderation.mjs';
import { publicPolicyConfig, PUBLIC_POLICY_PAGES } from './public-policies.mjs';
import { uploadedPhotoAccess } from './photo-access.mjs';

const MAX_BODY=16000, HOUR=3600000;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.woff2':'font/woff2','.json':'application/json'};
const sampleImage='/assets/garages/garage-01.webp';
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};

export function makeApp(options={}) {
  const db=options.db||openDatabase(options.database||resolve('data/garageshare.sqlite'));
  const web=resolve(options.web||new URL('../web',import.meta.url).pathname);
  const webAssets=createWebAssets(web);
  const production=Boolean(options.production), demo=Boolean(options.demo);
  const origin=new URL(options.origin||'http://localhost:3000').origin;
  const trustedProxy=options.trustedProxy||'';
  if(trustedProxy&&!isIP(trustedProxy))throw new Error('TRUST_PROXY_IP must be one exact proxy IP address.');
  if(production&&new URL(origin).protocol!=='https:') throw new Error('Production APP_ORIGIN must use HTTPS.');
  const google=demo?null:makeGoogleAuth({db,origin,config:options.google,request:options.googleFetch});
  const cookieName=production?'__Host-garageshare':'garageshare_session';
  function safeUser(user) {
    if (!user || accountState(db,user.id)==='deleted') return null;
    const state=accountState(db,user.id);
    const googleConnected=google&&Boolean(db.prepare('SELECT 1 FROM google_identities WHERE user_id=?').get(user.id));
    return { id: user.id, name: user.name, email: user.email, staff_role: state==='active'?staffRole(db, user.id):undefined, account_state:state,
      google_connected: google ? googleConnected : undefined };
  }
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
  function readCookie(req,name) {
    return (req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(`${name}=`))?.slice(name.length+1);
  }
  function session(req,res) {
    const token=readCookie(req,cookieName);
    const now=Date.now();
    let found=token&&/^[a-f0-9]{64}$/.test(token)?db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>? AND last_seen>?').get(hash(token),now,now-30*60000):null;
    if(found?.user_id && accountState(db,found.user_id)==='deleted') { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(found.token_hash); found=null; }
    if(found) { db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now,found.token_hash); return found; }
    limit(db,`session:${clientIP(req)}`,60,60000);
    const fresh=randomBytes(32).toString('hex');
    found={token_hash:hash(fresh),user_id:null,csrf:randomBytes(32).toString('hex'),created_at:now,last_seen:now,expires_at:now+12*HOUR};
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,created_at,last_seen) VALUES(?,?,?,?,?,?)').run(found.token_hash,null,found.csrf,found.expires_at,now,now);
    cookie(res,fresh); return found;
  }
  function signIn(res,oldSession,selectUserId) {
    const token=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex'),now=Date.now();
    const userId=transaction(db,()=>{
      const uid=selectUserId();
      if(accountState(db,uid)==='deleted') throw new ApiError('Sign in to continue.',401);
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(oldSession.token_hash);
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(hash(token),uid,csrf,now+12*HOUR,now,now);
      return uid;
    });
    cookie(res,token);
    return {user:safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(userId)),csrf};
  }
  function requireUser(s,allowSuspended=false) {
    const user=s.user_id&&db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
    if(!user) throw new ApiError('Sign in to continue.',401);
    if(!allowSuspended || accountState(db,user.id)!=='suspended') assertAccountActive(db,user.id);
    return user;
  }
  async function body(req, maximum=MAX_BODY) {
    if(req.headers['content-type']?.split(';')[0]!=='application/json') throw new ApiError('Send JSON.',415);
    if(Number(req.headers['content-length'])>maximum) throw new ApiError('Request too large.',413);
    let size=0, chunks=[];
    for await(const chunk of req) { size+=chunk.length; if(size>maximum) throw new ApiError('Request too large.',413); chunks.push(chunk); }
    let result;
    try { result=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('Invalid JSON.'); }
    if(!result||typeof result!=='object'||Array.isArray(result)) throw new ApiError('Send a JSON object.');
    if(req.authenticatedSession) {
      const current=db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>? AND last_seen>?').get(req.authenticatedSession.token_hash,Date.now(),Date.now()-30*60000);
      if(!current || current.user_id!==req.authenticatedSession.user_id) throw new ApiError('Sign in to continue.',401);
      requireUser(req.authenticatedSession,req.allowSuspended);
    }
    return result;
  }
  const server=createServer(async(req,res)=>{
    headers(res);
    try {
      const url=new URL(req.url,origin), path=url.pathname;
      if(google?.appLinks.length&&req.method==='GET'&&path==='/.well-known/assetlinks.json') return reply(res,google.appLinks);
      if(google&&path.startsWith('/auth/google/')) {
        limit(db,`google-browser:${clientIP(req)}`,60,60000);
        return await google.browser(req,res,url,readCookie,readCookie(req,cookieName),requestLanguage(req.headers['accept-language']));
      }
      if(req.method==='GET'&&path==='/api/legal') return reply(res,publicPolicyConfig(options.legal||{}));
      if(path.startsWith('/api/')) {
        limit(db,`api:${clientIP(req)}`,240,60000);
        if(req.method==='GET'&&path==='/api/config') return reply(res,{demo,timezone:'Africa/Casablanca',currency:'MAD',payment_mode:'pay_on_arrival',cities,
          google_sign_in:Boolean(google),google_android:Boolean(google?.appLinks.length),guidelines_version:GUIDELINES_VERSION,moderation_mode:'reported_content_human_review'});
        if(!['GET','POST'].includes(req.method)) { res.setHeader('Allow','GET, POST'); throw new ApiError('Method not allowed.',405); }
        const s=session(req,res), ip=clientIP(req);
        db.prepare("UPDATE reservations SET status='expired',updated_at=? WHERE status IN ('requested','countered') AND expires_at<=?").run(Date.now(),Date.now());
        if(req.method==='GET'&&path==='/api/session') return reply(res,{user:safeUser(s.user_id&&db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id)),csrf:s.csrf});
        if(req.method==='GET'&&path==='/api/garages') {
          return reply(res,browseGarages(db,url.searchParams));
        }
        const publicReview=path.match(/^\/api\/garages\/([a-f0-9]{32})\/reviews$/);
        if(req.method==='GET'&&publicReview)return reply(res,garageReviews(db,publicReview[1]));
        if(req.method==='POST') {
          if(req.headers.origin!==origin) throw new ApiError('Request origin is not allowed.',403);
          if(!equal(req.headers['x-csrf-token'],s.csrf)) throw new ApiError('Your session expired. Refresh and try again.',403);
        }
        if(demo) throw new ApiError('This preview uses sample data. Switch to a live installation to create real accounts or bookings.',409);
        if(req.method==='POST'&&['/api/auth/google/start','/api/auth/google/finish'].includes(path)) {
          if(!google) throw new ApiError('Google sign-in is unavailable.',404);
          limit(db,`google-auth:${ip}`,40,15*60000);
          const data=await body(req);
          if(path.endsWith('/start')) return reply(res,google.prepare(s,data,requestLanguage(req.headers['accept-language'])));
          return reply(res,signIn(res,s,()=>google.finish(s,data.proof)));
        }
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
            audit(db,uid,'register',uid); return reply(res,signIn(res,s,()=>uid),201);
          }
          const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
          if(!(await passwordMatches(password,user?.password_hash||await dummyHash))||!user?.password_hash) throw new ApiError('Email or password is incorrect.',401);
          const current=db.prepare('SELECT email,password_hash FROM users WHERE id=?').get(user.id);
          if(!current || current.email!==user.email || current.password_hash!==user.password_hash) throw new ApiError('Email or password is incorrect.',401);
          audit(db,user.id,'login',user.id);return reply(res,signIn(res,s,()=>user.id));
        }
        if(req.method==='POST'&&path==='/api/logout') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
          res.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${production?'; Secure':''}`);
          return reply(res,{ok:true});
        }
        req.allowSuspended=/^\/api\/(?:account\/(?:deletion|delete)|support\/|safety\/notices$)/.test(path);
        const user=requireUser(s,req.allowSuspended);
        req.authenticatedSession=s;
        if(/^\/api\/account\/(?:deletion|delete)$/.test(path)) return reply(res,await accountDeletionRoute(db,web,user,s,req.method,path,req.method==='POST'?await body(req):{}));
        if(path==='/api/safety/reports'||path==='/api/safety/notices'||/^\/api\/staff\/reports(?:\/|$)/.test(path)) return reply(res,ugcModerationRoute(db,user,req.method,path,url.searchParams,req.method==='POST'?await body(req):{}));
        if(/^\/api\/safety\//.test(path)) return reply(res,safetyRoute(db,user,req.method,path,url.searchParams,req.method==='POST'?await body(req):{}));
        if (/^\/api\/host\/calendar(?:\/|$)/.test(path)) {
          return reply(res, calendarRoute(db, user.id, req.method, path, url.searchParams, req.method === 'POST' ? await body(req) : {}));
        }
        if (/^\/api\/reviews(?:\/|$)/.test(path)) {
          if(req.method==='POST') requireGuidelines(db,user.id);
          return reply(res, reviewsRoute(db, user.id, req.method, path, req.method === 'POST' ? await body(req) : {}));
        }
        if (/^\/api\/chat(?:\/|$)/.test(path)) {
          return reply(res, chatRoute(db, user.id, req.method, path, url.searchParams, req.method === 'POST' ? await body(req) : {}));
        }
        if (/^\/api\/(?:host\/)?deals(?:\/|$)/.test(path)) {
          return reply(res, dealsRoute(db, user.id, req.method, path, req.method === 'POST' ? await body(req) : {}));
        }
        if (/^\/api\/staff\/(?:overview|users|reservations|managed-garages)(?:\/|$)/.test(path)) {
          requireModerator(db, user);
          limit(db, `admin-operations:${user.id}`, 120, 60000);
          return reply(res, await adminOperationsRoute(db, user, req.method, path, url.searchParams,
            req.method === 'POST' ? await body(req) : {}));
        }
        if (/^\/api\/staff\/garages(?:\/|$)/.test(path)) {
          requireModerator(db, user);
          limit(db, `moderation:${user.id}`, 60, 60000);
          const upload = /^\/api\/staff\/garages\/[a-f0-9]{32}\/approve$/.test(path);
          return reply(res, moderationRoute(db, web, user, req.method, path, url.searchParams,
            req.method === 'POST' ? await body(req, upload ? 7*1024*1024 : MAX_BODY) : {}));
        }
        if (/^\/api\/(?:support|staff)\//.test(path)) {
          return reply(res, supportRoute(db, user, req.method, path, url.searchParams, req.method === 'POST' ? await body(req) : {}));
        }
        const hostPhoto = path.match(/^\/api\/host\/garages\/([a-f0-9]{32})\/photo$/);
        if(req.method==='POST'&&hostPhoto) {
          requireGuidelines(db,user.id);
          requireHostPhotoListing(db, user, hostPhoto[1]);
          limit(db, `listing-photo:${user.id}`, 10, HOUR);
          return reply(res, submitHostPhoto(db, web, user, hostPhoto[1], await body(req, 7*1024*1024)));
        }
        if(req.method==='GET'&&path==='/api/host/garages') return reply(res,{garages:db.prepare('SELECT * FROM garages WHERE owner_id=? ORDER BY created_at DESC').all(user.id)});
        if(req.method==='POST'&&path==='/api/host/garages') {
          requireGuidelines(db,user.id);
          limit(db,`listing:${user.id}`,10,HOUR);
          const data=await body(req,7*1024*1024),name=text(data,'name',3,100),city=text(data,'city',2,60),area=text(data,'area',2,100),address=text(data,'address',5,220),description=text(data,'description',10,1500);
          if(!cities.includes(city)) throw new ApiError('Choose a supported city.');
          const hourly=integer(data.hourly_cents,100,100000,'hourly price'),monthly=integer(data.monthly_cents,10000,10000000,'monthly price'),height=integer(data.height_cm,140,500,'entrance height in cm');
          if(!['compact','suv','van'].includes(data.vehicle_size)||typeof data.covered!=='boolean') throw new ApiError('Check vehicle size and cover.');
          if(typeof data.latitude!=='number'||!Number.isFinite(data.latitude)||data.latitude<27.5||data.latitude>36||typeof data.longitude!=='number'||!Number.isFinite(data.longitude)||data.longitude< -14||data.longitude> -0.8) throw new ApiError('Place your garage pin inside Morocco.');
          // No arbitrary external image URLs, SVG uploads, tracking images or server-side fetching.
          // Hosts own their photos; all uploads remain pending until administrator review.
          const gid=id(),bytes=Object.hasOwn(data,'photo_base64')?decodeListingPhoto(data.photo_base64):null;
          const result=withListingPhoto(web,bytes,uploadedImage=>transaction(db,()=>{
            const image=uploadedImage||'/assets/garage-placeholder.svg';
            if(uploadedImage)db.prepare('INSERT OR IGNORE INTO listing_photo_owners(image,user_id,created_at) VALUES(?,?,?)').run(image,user.id,Date.now());
            db.prepare('INSERT INTO garages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,user.id,name,city,area,address,data.latitude,data.longitude,hourly,monthly,height,data.vehicle_size,data.covered?1:0,description,image,'pending',Date.now());
            audit(db,user.id,'listing_submitted',gid);return {id:gid,status:'pending',image};
          }));
          return reply(res,result,201);
        }
        if(req.method==='GET'&&['/api/reservations','/api/host/reservations'].includes(path)) {
          const host=path.includes('/host/');
          const rows=db.prepare(`SELECT r.*,g.name,g.city,g.area,g.image,g.address,g.latitude,g.longitude,g.owner_id,u.name AS guest_name,o.name AS owner_name FROM reservations r JOIN garages g ON g.id=r.garage_id JOIN users u ON u.id=r.guest_id JOIN users o ON o.id=g.owner_id WHERE ${host?'g.owner_id':'r.guest_id'}=? ORDER BY r.created_at DESC LIMIT 200`).all(user.id);
          return reply(res,{reservations:rows.map(row=>{
            const out={...row};
            // Hosts already know their own entrance. Guests get access information only for a confirmed, ongoing or upcoming stay.
            if(!host&&!hasArrivalAccess(row)) { delete out.address;delete out.latitude;delete out.longitude; }
            delete out.request_key;return out;
          })});
        }
        const arrival=path.match(/^\/api\/reservations\/([a-f0-9]{32})\/arrival$/);
        if(req.method==='GET'&&arrival) {
          const row=db.prepare(`SELECT r.status,r.ends_at,g.name AS garage_name,g.address,g.latitude,g.longitude
            FROM reservations r JOIN garages g ON g.id=r.garage_id WHERE r.id=? AND r.guest_id=?`).get(arrival[1],user.id);
          if(!row)throw new ApiError('Reservation not found.',404);
          if(!hasArrivalAccess(row))throw new ApiError('Directions are available for confirmed bookings that have not ended.',409);
          const {garage_name,address,latitude,longitude}=row;
          return reply(res,{arrival:{garage_name,address,latitude,longitude}});
        }
        if(req.method==='POST'&&path==='/api/reservations') {
          limit(db,`book:${user.id}`,20,15*60000);
          const data=await body(req),key=checkedRequestKey(data);
          const previous=db.prepare('SELECT * FROM reservations WHERE guest_id=? AND request_key=?').get(user.id,key);
          if(previous) return reply(res,{reservation:previous},200);
          const period=interval(data),garage=db.prepare("SELECT * FROM garages WHERE id=? AND status='approved'").get(text(data,'garage_id',32,32));
          if(!garage) throw new ApiError('This garage is unavailable.',404);
          requireInteractionAllowed(db,user.id,garage.owner_id);
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
              requireInteractionAllowed(db,row.guest_id,row.owner_id);
              if(!isHost||row.status!=='requested') throw new ApiError('Only the host can counter a new offer.',403);
              const listed=(row.mode==='hourly'?row.hourly_cents:row.monthly_cents)*row.units;
              const total=integer(data.total_cents,Math.ceil(listed*0.6),listed*2,'counter offer');
              db.prepare("UPDATE reservations SET status='countered',total_cents=?,updated_at=? WHERE id=?").run(total,now,rid);
            } else {
              requireInteractionAllowed(db,row.guest_id,row.owner_id);
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
      try { decoded=decodeURIComponent(webAssets.staticPath(PUBLIC_POLICY_PAGES[path]||path)); } catch(error) {
        if(error instanceof ApiError) throw error;
        throw new ApiError('Invalid URL.',400);
      }
      const file=resolve(web,'.'+(decoded==='/'?'/index.html':decoded));
      if(!file.startsWith(web+sep)||decoded.split('/').some(p=>p.startsWith('.'))||!MIME[extname(file)]) throw new ApiError('Not found.',404);
      const photoDirectory=resolve(web,'assets/host-photos');
      if(file===photoDirectory || file.startsWith(photoDirectory+sep)) {
        const image='/assets/host-photos/'+file.slice(photoDirectory.length+1);
        const token=readCookie(req,cookieName);
        uploadedPhotoAccess(db,image,token);
        let photoInfo,directoryInfo,contents;
        try {
          [photoInfo,directoryInfo]=await Promise.all([lstat(file),lstat(photoDirectory)]);
          if(photoInfo.isSymbolicLink() || !photoInfo.isFile() || photoInfo.size>5*1024*1024 || directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error('Invalid photo.');
          if(req.method!=='HEAD') contents=await readFile(file);
        } catch { throw new ApiError('Not found.',404); }
        const access=uploadedPhotoAccess(db,image,token);
        if(access.audit_action) audit(db,access.user_id,access.audit_action,access.target_id);
        res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'no-store','Vary':'Cookie'});
        return res.end(req.method==='HEAD'?undefined:contents);
      }
      let info;
      try { info=await stat(file); } catch { throw new ApiError('Not found.',404); }
      if(!info.isFile()) throw new ApiError('Not found.',404);
      res.writeHead(200,{'Content-Type':MIME[extname(file)],'Cache-Control':extname(file)==='.html'?'no-store':['.js','.mjs','.css'].includes(extname(file))?'no-cache':'public, max-age=3600'});
      if(req.method==='HEAD') return res.end();
      const contents=await readFile(file);
      res.end(extname(file)==='.html'?webAssets.rewriteAdminHtml(contents.toString('utf8')):contents);
    } catch(error) {
      if(res.headersSent) { res.end();return; }
      const overlap=String(error.message).includes('reservation_overlap');
      const blocked=String(error.message).includes('garage_block_conflict');
      const status=error instanceof ApiError?error.status:overlap||blocked?409:500;
      if(status===500) console.error('GarageShare request failed:',error.code||error.name);
      const conflict=blocked?'The host has blocked this time. Choose another time.':'This time was just booked. Choose another time.';
      reply(res,{error:localizeError(error instanceof ApiError?error.message:overlap||blocked?conflict:'Service unavailable. Please try again.',requestLanguage(req.headers['accept-language']))},status);
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=60;
  return {server,db,origin};
}
