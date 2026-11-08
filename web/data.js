import {endAt} from './icons.js';
import {language,localizedField} from './i18n.js';
import { quoteChatOpen, reservationChatOpen } from './chat-policy.js';
const emptyPreview=()=>({garages:[],reservations:[],deals:[],tickets:[],chats:[],blocks:[],reviews:[]});
let csrf='', isDemo=false, preview=emptyPreview(), samples=[];
const key='garageshare-preview-v1';
const uid=()=>globalThis.crypto?.randomUUID?.().replaceAll('-','')||Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
const save=()=>{try{localStorage.setItem(key,JSON.stringify(preview));}catch{throw new Error('Your device storage is full or unavailable.');}};
export async function api(path,method='GET',data) {
 const result=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:{'Accept-Language':language(),...(method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{})},body:data?JSON.stringify(data):undefined});
 let value;try{value=await result.json();}catch{throw new Error('The server could not respond. Try again.');}
 if(!result.ok) {
  const error=new Error(value.error||'Something went wrong. Try again.');
  error.status=result.status;
  throw error;
 }
 if(value.csrf)csrf=value.csrf;return value;
}
const demoUser={id:'preview-user',name:'Explorer',email:'preview@garageshare.local'};
const day=86400000;

function overlaps(row, period) {
 return row.starts_at<period.ends_at&&row.ends_at>period.starts_at;
}

function previewConflict(garageId, period, exclude='') {
 if(preview.reservations.some(row=>row.garage_id===garageId&&row.id!==exclude&&row.status==='confirmed'&&overlaps(row,period))) {
  return 'Your preview already has a booking for this time.';
 }
 if(preview.blocks.some(row=>row.garage_id===garageId&&overlaps(row,period))) {
  return 'The host has blocked this time. Choose another time.';
 }
 return null;
}

function checkPreviewAvailability(garageId, period, exclude='') {
 const conflict=previewConflict(garageId,period,exclude);
 if(conflict)throw new Error(conflict);
}

function previewDeal(id) {
 const deal=preview.deals.find(row=>row.id===id);
 if(!deal)throw new Error('Price request not found.');
 if(deal.status==='open'&&deal.expires_at<=Date.now())deal.status='expired';
 return deal;
}

function previewTicket(id) {
 const ticket=preview.tickets.find(row=>row.id===id);
 if(!ticket)throw new Error('Support ticket not found.');
 return ticket;
}

function sampleHostGarage() {
 const gid='preview-host-garage';
 let garage=preview.garages.find(g=>g.id===gid);
 if(!garage){
  garage={...samples[0],id:gid,name:'Your sample garage',name_fr:'Votre garage de démonstration',name_ar:'مرآبك التجريبي',owner_id:demoUser.id,owner_name:demoUser.name,status:'approved',is_demo:true};
  preview.garages.push(garage);
 }
 return garage;
}

function previewQuote(garage) {
 return {
  id:uid(),garage_id:garage.id,owner_id:garage.owner_id,owner_name:garage.owner_name,
  name:garage.name,name_fr:garage.name_fr,name_ar:garage.name_ar,area:garage.area,
  covered:garage.covered,vehicle_size:garage.vehicle_size,is_demo:true,
  status:'invited',total_cents:null
 };
}

function previewChatContext(kind, id) {
 const booking=kind==='reservation'?preview.reservations.find(row=>row.id===id):null;
 if(kind==='reservation'&&(!booking||![booking.guest_id,booking.owner_id].includes(demoUser.id))) {
  throw new Error('Conversation not found.');
 }
 const deal=kind==='quote'?preview.deals.find(row=>row.quotes.some(q=>q.id===id))
  :preview.deals.find(row=>row.reservation_id===id);
 const quote=deal?.quotes.find(q=>kind==='quote'?q.id===id:q.garage_id===booking.garage_id);
 if(quote){
  const host=quote.owner_id===demoUser.id;
  if(!host&&deal.guest_id!==demoUser.id)throw new Error('Conversation not found.');
  const selected=preview.reservations.find(r=>r.id===deal.reservation_id&&r.garage_id===quote.garage_id);
  return {kind:'quote',id:quote.id,garage_name:localizedField(quote,'name'),
   peer_name:host?'Salma':quote.owner_name,role:host?'host':'renter',writable:quoteChatOpen(quote,deal,selected)};
 }
 if(!booking)throw new Error('Conversation not found.');
 const host=booking.owner_id===demoUser.id;
 return {kind:'reservation',id,garage_name:localizedField(booking,'name'),
  peer_name:host?localizedField(booking,'guest_name'):booking.owner_name,
  role:host?'host':'renter',writable:reservationChatOpen(booking)};
}

function previewChat(context, create=false) {
 let thread=preview.chats.find(row=>row.kind===context.kind&&row.id===context.id);
 if(!thread&&create){
  thread={kind:context.kind,id:context.id,messages:[],updated_at:Date.now()};
  preview.chats.push(thread);
 }
 return thread;
}

function addPreviewMessage(thread, data) {
 const now=Date.now();
 const message={seq:(thread.messages.at(-1)?.seq||0)+1,created_at:now,read_at:null,...data};
 thread.messages.push(message);thread.updated_at=now;save();
 return message;
}

const chatPath=(kind,id)=>`/chat/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
const calendarPath=id=>`/host/calendar/${encodeURIComponent(id)}`;

function previewOwnedGarage(id) {
 const garage=preview.garages.find(row=>row.id===id&&row.owner_id===demoUser.id);
 if(!garage)throw new Error('Garage calendar not found.');
 return garage;
}

function previewReviewStay(id) {
 const row=preview.reservations.find(item=>item.id===id&&[item.owner_id,item.guest_id].includes(demoUser.id));
 if(!row)throw new Error('Reservation not found.');
 return row;
}

function previewReviewView(stay) {
 const role=stay.owner_id===demoUser.id?'host':'renter';
 const now=Date.now(),deadline=stay.ends_at+14*day;
 const rows=preview.reviews.filter(row=>row.reservation_id===stay.id);
 const mine=rows.find(row=>row.role===role)||null;
 const other=rows.find(row=>row.role!==role&&row.publish_at<=now)||null;
 return {reservation_id:stay.id,garage_name:localizedField(stay,'name'),role,deadline,mine,other,
  can_review:stay.status==='confirmed'&&stay.ends_at<=now&&now<deadline&&!mine,
  published:Boolean(mine&&mine.publish_at<=now)};
}

function addPreviewReview(stay,role,rating,comment,sample=false) {
 const now=Date.now();
 const other=preview.reviews.find(row=>row.reservation_id===stay.id&&row.role!==role);
 if(other)other.publish_at=now;
 preview.reviews.push({reservation_id:stay.id,garage_id:stay.garage_id,role,rating,comment,sample,
  created_at:now,publish_at:other?now:stay.ends_at+14*day});
 save();
}

function previewPublicReviews(id) {
 return preview.reviews.filter(row=>row.garage_id===id&&row.role==='renter'&&row.publish_at<=Date.now());
}

export const repo={
 get demo(){return isDemo;},
 async init(){
  const [config,session]=await Promise.all([api('/config'),api('/session')]);
  isDemo=config.demo===true;csrf=session.csrf;
  if(isDemo){
   samples=await (await fetch('/assets/demo.json')).json();
   try{
    const stored=JSON.parse(localStorage.getItem(key));
    if(stored&&Array.isArray(stored.garages)&&Array.isArray(stored.reservations)) {
     preview={...stored};
     for(const field of ['deals','tickets','chats','blocks','reviews'])if(!Array.isArray(preview[field]))preview[field]=[];
    }
   }catch{}
  }
  return {demo:isDemo,user:isDemo?demoUser:session.user};
 },
 async garages(){
  if(!isDemo)return (await api('/garages')).garages;
  return [...samples,...preview.garages.filter(g=>g.status==='approved')].map(garage=>{
   const reviews=previewPublicReviews(garage.id),count=reviews.length;
   const rating=count?Math.round(reviews.reduce((sum,row)=>sum+row.rating,0)*10/count)/10:null;
   return {...garage,review_count:count,rating};
  });
 },
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
 async arrival(id){
  if(!isDemo)return (await api(`/reservations/${encodeURIComponent(id)}/arrival`)).arrival;
  const booking=preview.reservations.find(row=>row.id===id&&row.guest_id===demoUser.id);
  if(!booking)throw new Error('Reservation not found.');
  if(booking.status!=='confirmed'||booking.ends_at<=Date.now())throw new Error('Directions are available for confirmed bookings that have not ended.');
  const garage=[...samples,...preview.garages].find(row=>row.id===booking.garage_id);
  if(!garage)throw new Error('The garage entrance is unavailable.');
  return {garage_name:localizedField(booking,'name'),latitude:garage.latitude,longitude:garage.longitude,is_demo:true};
 },
 async reserve(g,data){
  if(!isDemo)return (await api('/reservations','POST',{...data,garage_id:g.id})).reservation;
  if(g.owner_id===demoUser.id)throw new Error('You cannot book your own garage.');
  const start=Date.parse(data.starts_at),end=endAt(start,data.units,data.mode);
  if(start<Date.now()+60000)throw new Error('Choose a start at least one minute ahead.');
  if(!Number.isInteger(data.units)||data.units<1||data.units>(data.mode==='hourly'?168:12))throw new Error('Choose a valid duration.');
  checkPreviewAvailability(g.id,{starts_at:start,ends_at:end});
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
   checkPreviewAvailability(r.garage_id,r,r.id);
   r.status='confirmed';
  }
  save();return r;
 },
 async sampleHostRequest(){
  if(!isDemo)return;
  const gid=sampleHostGarage().id;
  const start=Math.ceil((Date.now()+48*3600000)/3600000)*3600000;
  preview.reservations.push({id:uid(),garage_id:gid,guest_id:'sample-guest',owner_id:demoUser.id,name:'Your sample garage',city:'Casablanca',area:'Maârif',image:samples[0].image,guest_name:'Salma (sample guest)',guest_name_fr:'Salma (locataire fictive)',guest_name_ar:'سلمى (مستأجرة تجريبية)',starts_at:start,ends_at:start+3*3600000,mode:'hourly',units:3,total_cents:3000,listed_cents:3600,status:'requested',expires_at:Date.now()+86400000,is_demo:true});save();
 },
 async priceRequests(){
  if(!isDemo)return (await api('/deals')).requests;
  return preview.deals.filter(deal=>deal.guest_id===demoUser.id).slice().reverse().map(row=>{
   const deal=previewDeal(row.id);
   const quotes=deal.quotes.map(q=>({...q,available:!previewConflict(q.garage_id,deal)}));
   quotes.sort((a,b)=>(a.total_cents??Infinity)-(b.total_cents??Infinity));
   return {...deal,quotes};
  });
 },
 async requestPrices(data){
  if(!isDemo)return (await api('/deals','POST',data)).request;
  const previous=preview.deals.find(row=>row.request_key===data.request_key);
  if(previous)return previous;
  const garageIds=data.garage_ids;
  if(garageIds.length<1||garageIds.length>5||new Set(garageIds).size!==garageIds.length)throw new Error('Choose one to five different garages.');
  const now=Date.now();
  if(preview.deals.filter(row=>row.guest_id===demoUser.id&&row.status==='open'&&row.expires_at>now).length>=5)throw new Error('Close one of your open price requests first.');
  const start=Date.parse(data.starts_at);
  if(!Number.isFinite(start)||start<now+60000||start>now+366*day)throw new Error('Choose a start at least one minute ahead, within the next year.');
  if(!Number.isInteger(data.units)||data.units<1||data.units>(data.mode==='hourly'?168:12))throw new Error('Choose a valid duration.');
  if(!Number.isSafeInteger(data.proposed_cents)||data.proposed_cents<100||data.proposed_cents>(data.mode==='hourly'?200000:20000000)*data.units)throw new Error('Choose a valid total price.');
  const end=endAt(start,data.units,data.mode),garages=await repo.garages();
  const quotes=garageIds.map(gid=>{
   const garage=garages.find(g=>g.id===gid&&g.city===data.city&&g.owner_id!==demoUser.id);
   if(!garage)throw new Error('This garage is unavailable.');
   checkPreviewAvailability(gid,{starts_at:start,ends_at:end});
   return previewQuote(garage);
  });
  const deal={id:uid(),guest_id:demoUser.id,city:data.city,mode:data.mode,units:data.units,
   starts_at:start,ends_at:end,proposed_cents:data.proposed_cents,status:'open',created_at:now,
   expires_at:Math.min(now+day,start),request_key:data.request_key,quotes};
  preview.deals.push(deal);save();return deal;
 },
 async cancelPriceRequest(id){
  if(!isDemo)return api(`/deals/${id}/cancel`,'POST',{});
  const deal=previewDeal(id);
  if(deal.status!=='open')throw new Error('This price request is closed.');
  deal.status='cancelled';save();
 },
 async selectPriceQuote(id,quoteId,total){
  if(!isDemo)return api(`/deals/${id}/select`,'POST',{quote_id:quoteId,total_cents:total});
  const deal=previewDeal(id),quote=deal.quotes.find(q=>q.id===quoteId);
  if(!quote||quote.status!=='quoted'||quote.total_cents!==total)throw new Error('This price quote is no longer available. Refresh your offers.');
  if(deal.reservation_id&&deal.selected_garage_id===quote.garage_id)return {reservation_id:deal.reservation_id};
  if(deal.status!=='open')throw new Error('This price request is closed.');
  checkPreviewAvailability(quote.garage_id,deal);
  const garage=(await repo.garages()).find(g=>g.id===quote.garage_id);
  if(!garage)throw new Error('This garage is unavailable.');
  const reservation={...quote,id:uid(),guest_id:demoUser.id,guest_name:demoUser.name,city:deal.city,image:garage.image,
   starts_at:deal.starts_at,ends_at:deal.ends_at,mode:deal.mode,units:deal.units,status:'confirmed',expires_at:null};
  preview.reservations.push(reservation);
  deal.status='booked';deal.selected_garage_id=quote.garage_id;deal.reservation_id=reservation.id;save();
  return {reservation_id:reservation.id};
 },
 async samplePriceReplies(id){
  if(!isDemo)return;
  const deal=previewDeal(id);
  if(deal.status!=='open')throw new Error('This price request is closed.');
  deal.quotes.filter(q=>q.status==='invited').forEach((q,index)=>{
   q.status='quoted';q.total_cents=index===0?deal.proposed_cents:deal.proposed_cents+500*index;
  });
  save();
 },
 async hostPriceQuotes(){
  if(!isDemo)return (await api('/host/deals')).quotes;
  return preview.deals.slice().reverse().flatMap(row=>{
   const deal=previewDeal(row.id);
   return deal.quotes.filter(q=>q.owner_id===demoUser.id).map(q=>({...q,city:deal.city,mode:deal.mode,units:deal.units,
    starts_at:deal.starts_at,ends_at:deal.ends_at,expires_at:deal.expires_at,proposed_cents:deal.proposed_cents,
    request_status:deal.status,guest_name:'Salma (sample guest)',guest_name_fr:'Salma (locataire fictive)',guest_name_ar:'سلمى (مستأجرة تجريبية)'}));
  });
 },
 async respondToPrice(quoteId,action,total){
  if(!isDemo)return api(`/host/deals/${quoteId}/respond`,'POST',{action,total_cents:total});
  const row=preview.deals.find(d=>d.quotes.some(q=>q.id===quoteId&&q.owner_id===demoUser.id));
  if(!row)throw new Error('Price quote not found.');
  const deal=previewDeal(row.id),quote=deal.quotes.find(q=>q.id===quoteId);
  if(deal.status!=='open')throw new Error('This price request is closed.');
  if(action==='decline'){
   quote.status='declined';quote.total_cents=null;
  }else{
   if(quote.status!=='invited')throw new Error('This action is not available.');
   checkPreviewAvailability(quote.garage_id,deal);
   if(action==='counter'&&(!Number.isSafeInteger(total)||total<100||total>(deal.mode==='hourly'?200000:20000000)*deal.units))throw new Error('Choose a valid total price.');
   quote.status='quoted';quote.total_cents=action==='match'?deal.proposed_cents:total;
  }
  save();
 },
 async samplePriceInvitation(){
  if(!isDemo)return;
  const garage=sampleHostGarage(),now=Date.now();
  const start=Math.ceil((now+2*day)/3600000)*3600000;
  preview.deals.push({id:uid(),guest_id:'sample-guest',city:garage.city,mode:'hourly',units:2,
   starts_at:start,ends_at:start+7200000,proposed_cents:2000,status:'open',created_at:now,
   expires_at:now+day,quotes:[previewQuote(garage)]});
  save();
 },
 async supportTickets(){
  if(!isDemo)return (await api('/support/tickets')).tickets;
  return preview.tickets.slice().sort((a,b)=>b.updated_at-a.updated_at);
 },
 async supportTicket(id){
  if(!isDemo)return (await api(`/support/tickets/${id}`)).ticket;
  return previewTicket(id);
 },
 async createSupportTicket(data){
  if(!isDemo)return (await api('/support/tickets','POST',data)).ticket;
  const existing=preview.tickets.find(t=>t.request_key===data.request_key);
  if(existing)return existing;
  const subject=data.subject.trim(),message=data.message.trim();
  if(subject.length<4||subject.length>120)throw new Error('Check subject.');
  if(message.length<5||message.length>3000)throw new Error('Check message.');
  const now=Date.now();
  const ticket={id:uid(),category:data.category,subject,status:'open',created_at:now,updated_at:now,
   request_key:data.request_key,reservation_id:data.reservation_id||null,
   messages:[{id:uid(),author_kind:'customer',message,created_at:now}]};
  preview.tickets.push(ticket);save();return ticket;
 },
 async replyToSupport(id,data){
  if(!isDemo)return (await api(`/support/tickets/${id}/reply`,'POST',data)).ticket;
  const ticket=previewTicket(id),message=data.message.trim();
  if(message.length<5||message.length>3000)throw new Error('Check message.');
  const now=Date.now();
  ticket.messages.push({id:uid(),author_kind:'customer',message,created_at:now});
  ticket.status='open';ticket.updated_at=now;save();return ticket;
 },
 async sampleSupportReply(id){
  if(!isDemo)return;
  const ticket=previewTicket(id),now=Date.now();
  ticket.messages.push({id:uid(),author_kind:'staff',sample:true,created_at:now});
  ticket.status='waiting';ticket.updated_at=now;save();return ticket;
 },
 async conversations(){
  if(!isDemo)return (await api('/chat')).conversations;
  return preview.chats.slice().sort((a,b)=>b.updated_at-a.updated_at).map(thread=>({
   ...previewChatContext(thread.kind,thread.id),latest:thread.messages.at(-1),
   unread:thread.messages.filter(row=>!row.own&&!row.read_at).length
  }));
 },
 async chat(kind,id,{before=0,after=0}={}){
  if(!isDemo){
   const query=before?`?before=${before}`:after?`?after=${after}`:'';
   return api(chatPath(kind,id)+query);
  }
  const conversation=previewChatContext(kind,id);
  const all=previewChat(conversation)?.messages||[];
  const eligible=before?all.filter(row=>row.seq<before):all;
  const messages=after?all.filter(row=>row.seq>after).slice(0,60):eligible.slice(-60);
  const seen=all.findLast(row=>row.own&&row.read_at);
  return {conversation,messages,has_older:!after&&eligible.length>60,seen_through:seen?.seq||0};
 },
 async sendChat(kind,id,data){
  if(!isDemo)return (await api(chatPath(kind,id)+'/send','POST',data)).message;
  const context=previewChatContext(kind,id);
  const existing=previewChat(context)?.messages.find(row=>row.own&&row.request_key===data.request_key);
  if(existing)return existing;
  if(!context.writable)throw new Error('This conversation is read-only.');
  const message=data.message.trim();
  if(!message||message.length>2000)throw new Error('Check message.');
  return addPreviewMessage(previewChat(context,true),{own:true,message,request_key:data.request_key});
 },
 async readChat(kind,id,through){
  if(!isDemo)return api(chatPath(kind,id)+'/read','POST',{through});
  const thread=previewChat(previewChatContext(kind,id));
  const unread=thread?.messages.filter(row=>!row.own&&!row.read_at&&row.seq<=through)||[];
  if(unread.length){
   for(const row of unread)row.read_at=Date.now();
   save();
  }
 },
 async sampleChatReply(kind,id){
  if(!isDemo)return;
  const context=previewChatContext(kind,id);
  if(!context.writable)throw new Error('This conversation is read-only.');
  const thread=previewChat(context,true);
  for(const row of thread.messages)if(row.own&&!row.read_at)row.read_at=Date.now();
  addPreviewMessage(thread,{own:false,sample:context.role==='host'?'renter':'host'});
 },
 async availableGarages(city,data){
  if(!isDemo)return api('/garages?'+new URLSearchParams({city,...data}));
  const start=Date.parse(data.starts_at),now=Date.now();
  if(!Number.isFinite(start)||start<now+60000||start>now+366*day)throw new Error('Choose a start at least one minute ahead, within the next year.');
  if(!['hourly','monthly'].includes(data.mode)||!Number.isInteger(data.units)||data.units<1||data.units>(data.mode==='hourly'?168:12))throw new Error('Choose a valid duration.');
  const period={mode:data.mode,units:data.units,starts_at:start,ends_at:endAt(start,data.units,data.mode)};
  const garages=(await repo.garages()).filter(g=>g.city===city&&!previewConflict(g.id,period));
  return {garages,period};
 },
 async calendar(id,from,to){
  if(!isDemo)return api(calendarPath(id)+'?'+new URLSearchParams({from,to}));
  previewOwnedGarage(id);
  const period={starts_at:Date.parse(from),ends_at:Date.parse(to)};
  return {
   blocks:preview.blocks.filter(row=>row.garage_id===id&&overlaps(row,period)),
   bookings:preview.reservations.filter(row=>row.garage_id===id&&row.status==='confirmed'&&overlaps(row,period))
  };
 },
 async blockTime(id,data){
  if(!isDemo)return api(calendarPath(id)+'/blocks','POST',data);
  previewOwnedGarage(id);
  const previous=preview.blocks.find(row=>row.garage_id===id&&row.request_key===data.request_key);
  if(previous)return {id:previous.id};
  const now=Date.now(),starts_at=Date.parse(data.starts_at),ends_at=Date.parse(data.ends_at);
  if(!Number.isFinite(starts_at)||!Number.isFinite(ends_at)||starts_at<now-60000||ends_at>now+366*day||ends_at-starts_at<900000)throw new Error('Block at least 15 minutes within the next year.');
  checkPreviewAvailability(id,{starts_at,ends_at});
  const block={id:uid(),garage_id:id,starts_at,ends_at,note:data.note.trim(),request_key:data.request_key};
  preview.blocks.push(block);save();return {id:block.id};
 },
 async unblockTime(id,blockId){
  if(!isDemo)return api(calendarPath(id)+`/blocks/${encodeURIComponent(blockId)}/remove`,'POST',{});
  previewOwnedGarage(id);
  preview.blocks=preview.blocks.filter(row=>row.garage_id!==id||row.id!==blockId);save();
 },
 async sampleCalendarGarage(){
  if(!isDemo)return;
  const garage=sampleHostGarage();save();return garage;
 },
 async garageReviews(id){
  if(!isDemo)return (await api(`/garages/${encodeURIComponent(id)}/reviews`)).reviews;
  return previewPublicReviews(id).slice().reverse().slice(0,30);
 },
 async stayReview(id){
  if(!isDemo)return api(`/reviews/${encodeURIComponent(id)}`);
  return previewReviewView(previewReviewStay(id));
 },
 async submitReview(id,data){
  if(!isDemo)return api(`/reviews/${encodeURIComponent(id)}`,'POST',data);
  const stay=previewReviewStay(id),view=previewReviewView(stay),comment=data.comment.trim();
  if(!Number.isInteger(data.rating)||data.rating<1||data.rating>5)throw new Error('Choose a valid star rating.');
  if(comment.length>1000)throw new Error('Check comment.');
  if(view.mine){
   if(view.mine.rating===data.rating&&view.mine.comment===comment)return view;
   throw new Error('You already reviewed this stay.');
  }
  if(!view.can_review)throw new Error('Reviews are open for 14 days after a completed stay.');
  addPreviewReview(stay,view.role,data.rating,comment);
  return previewReviewView(stay);
 },
 async sampleReviewReply(id){
  if(!isDemo)return;
  const stay=previewReviewStay(id),view=previewReviewView(stay);
  const otherRole=view.role==='host'?'renter':'host';
  if(view.mine&&Date.now()<view.deadline&&!preview.reviews.some(row=>row.reservation_id===id&&row.role===otherRole)) {
   addPreviewReview(stay,otherRole,5,'',true);
  }
  return previewReviewView(stay);
 },
 async sampleCompletedStay(host=false){
  if(!isDemo)return;
  const id=host?'preview-host-review':'preview-guest-review';
  if(!preview.reservations.some(row=>row.id===id)){
   const garage=host?sampleHostGarage():samples[0],now=Date.now();
   preview.reservations.push({id,garage_id:garage.id,owner_id:garage.owner_id,guest_id:host?'sample-guest':demoUser.id,
    name:garage.name,name_fr:garage.name_fr,name_ar:garage.name_ar,city:garage.city,area:garage.area,image:garage.image,
    owner_name:garage.owner_name,guest_name:host?'Salma':demoUser.name,starts_at:now-4*3600000,ends_at:now-2*3600000,
    mode:'hourly',units:2,total_cents:garage.hourly_cents*2,status:'confirmed',expires_at:null,is_demo:true});
   save();
  }
  return id;
 },
 resetDemo(){if(isDemo){preview=emptyPreview();save();}}
};
export const requestKey=uid;
