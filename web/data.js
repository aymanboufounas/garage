import {endAt} from './icons.js';
import {language,localizedField} from './i18n.js';
let csrf='', isDemo=false, preview={garages:[],reservations:[]}, samples=[];
const key='garageshare-preview-v1';
const uid=()=>globalThis.crypto?.randomUUID?.().replaceAll('-','')||Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
const save=()=>{try{localStorage.setItem(key,JSON.stringify(preview));}catch{throw new Error('Your device storage is full or unavailable.');}};
async function api(path,method='GET',data) {
 const result=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:{'Accept-Language':language(),...(method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{})},body:data?JSON.stringify(data):undefined});
 let value;try{value=await result.json();}catch{throw new Error('The server could not respond. Try again.');}
 if(!result.ok) throw new Error(value.error||'Something went wrong. Try again.');
 if(value.csrf)csrf=value.csrf;return value;
}
const demoUser={id:'preview-user',name:'Explorer',email:'preview@garageshare.local'};
export const repo={
 get demo(){return isDemo;},
 async init(){
  const [config,session]=await Promise.all([api('/config'),api('/session')]);
  isDemo=config.demo===true;csrf=session.csrf;
  if(isDemo){
   samples=await (await fetch('/assets/demo.json')).json();
   try{const stored=JSON.parse(localStorage.getItem(key));if(stored&&Array.isArray(stored.garages)&&Array.isArray(stored.reservations)) preview=stored;}catch{}
  }
  return {demo:isDemo,user:isDemo?demoUser:session.user};
 },
 async garages(){return isDemo?[...samples,...preview.garages.filter(g=>g.status==='approved')]: (await api('/garages')).garages;},
 async signIn(data,register){if(isDemo)return demoUser;return (await api(register?'/register':'/login','POST',data)).user;},
 async signOut(){if(!isDemo)await api('/logout','POST',{});},
 async listings(){return isDemo?preview.garages:(await api('/host/garages')).garages;},
 async createListing(data){
  if(!isDemo)return api('/host/garages','POST',data);
  const garage={...data,id:uid(),owner_id:demoUser.id,owner_name:demoUser.name,status:'pending',image:'/assets/garage-placeholder.svg',is_demo:true};
  preview.garages.push(garage);save();return garage;
 },
 async approveDemo(gid){if(!isDemo)return;const g=preview.garages.find(g=>g.id===gid);if(g){g.status='approved';save();}},
 async reservations(host=false){
  if(!isDemo)return (await api(host?'/host/reservations':'/reservations')).reservations;
  const now=Date.now();preview.reservations.forEach(r=>{if(['requested','countered'].includes(r.status)&&r.expires_at<=now)r.status='expired';});
  return preview.reservations.filter(r=>host?r.owner_id===demoUser.id:r.guest_id===demoUser.id).slice().reverse();
 },
 async reserve(g,data){
  if(!isDemo)return (await api('/reservations','POST',{...data,garage_id:g.id})).reservation;
  if(g.owner_id===demoUser.id)throw new Error('You cannot book your own garage.');
  const start=Date.parse(data.starts_at),end=endAt(start,data.units,data.mode);
  if(start<Date.now()+60000)throw new Error('Choose a start at least one minute ahead.');
  if(!Number.isInteger(data.units)||data.units<1||data.units>(data.mode==='hourly'?168:12))throw new Error('Choose a valid duration.');
  if(preview.reservations.some(r=>r.garage_id===g.id&&r.status==='confirmed'&&r.starts_at<end&&r.ends_at>start))throw new Error('Your preview already has a booking for this time.');
  const total=(data.mode==='hourly'?g.hourly_cents:g.monthly_cents)*data.units;
  if(data.action==='offer'&&(data.total_cents<total*0.6||data.total_cents>total*2))throw new Error('Your offer must be between 60% and 200% of the listed total.');
  const reservation={id:uid(),garage_id:g.id,guest_id:demoUser.id,owner_id:g.owner_id,name:g.name,city:g.city,area:g.area,image:g.image,owner_name:g.owner_name,guest_name:demoUser.name,starts_at:start,ends_at:end,mode:data.mode,units:data.units,total_cents:data.action==='offer'?data.total_cents:total,listed_cents:total,status:data.action==='offer'?'requested':'confirmed',expires_at:Math.min(Date.now()+86400000,start),is_demo:true};
  preview.reservations.push(reservation);save();return reservation;
 },
 async reservationAction(rid,action,data={}){
  if(!isDemo)return (await api(`/reservations/${rid}/${action}`,'POST',data)).reservation;
  const r=preview.reservations.find(r=>r.id===rid);if(!r)throw new Error('Reservation not found.');
  if(action==='reply'){r.status='countered';r.total_cents=Math.round((r.total_cents+r.listed_cents)/2/100)*100;}
  else if(action==='cancel')r.status='cancelled';
  else if(action==='decline')r.status='declined';
  else if(action==='counter'){if(!Number.isInteger(data.total_cents)||data.total_cents<Math.ceil(r.listed_cents*.6)||data.total_cents>r.listed_cents*2)throw new Error('Choose a total between 60% and 200% of the listed total.');r.total_cents=data.total_cents;r.status='countered';}
  else if(action==='accept'){
   if(preview.reservations.some(x=>x.id!==r.id&&x.garage_id===r.garage_id&&x.status==='confirmed'&&x.starts_at<r.ends_at&&x.ends_at>r.starts_at))throw new Error('This time is already reserved.');
   r.status='confirmed';
  }
  save();return r;
 },
 async sampleHostRequest(){
  if(!isDemo)return;
  const gid='preview-host-garage';
  if(!preview.garages.find(g=>g.id===gid))preview.garages.push({...samples[0],id:gid,name:'Your sample garage',name_fr:'Votre garage de démonstration',name_ar:'مرآبك التجريبي',owner_id:demoUser.id,owner_name:demoUser.name,status:'approved',is_demo:true});
  const start=Math.ceil((Date.now()+48*3600000)/3600000)*3600000;
  preview.reservations.push({id:uid(),garage_id:gid,guest_id:'sample-guest',owner_id:demoUser.id,name:'Your sample garage',city:'Casablanca',area:'Maârif',image:samples[0].image,guest_name:'Salma (sample guest)',guest_name_fr:'Salma (locataire fictive)',guest_name_ar:'سلمى (مستأجرة تجريبية)',starts_at:start,ends_at:start+3*3600000,mode:'hourly',units:3,total_cents:3000,listed_cents:3600,status:'requested',expires_at:Date.now()+86400000,is_demo:true});save();
 },
 resetDemo(){if(isDemo){preview={garages:[],reservations:[]};save();}}
};
export const requestKey=uid;
