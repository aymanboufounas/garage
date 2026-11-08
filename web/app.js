import {icon,esc,money,cityCenters,safeImage,moroccoInput,fromMoroccoInput,endAt,dateLabel} from './icons.js';
import {repo,requestKey} from './data.js';
import {t,language,setLanguage,locale,cityName,duration,localizedField,applyDocumentLanguage} from './i18n.js';
import {localizeError} from './errors.js';
import { priceRequestForm, guestPriceRequests, hostPriceRequests, selectPriceForm, counterPriceForm, supportList, supportTicketForm, supportThread } from './service-ui.js';
const $=(s,root=document)=>root.querySelector(s),h=(key,params)=>esc(t(key,params));
const state={page:'explore',city:'Casablanca',mode:'hourly',query:'',filters:new Set(),sort:'recommended',garages:[],priceRequests:[],user:null,demo:false,mapOpen:false,hostTab:'spaces',saved:new Set(),coords:null};
try{state.saved=new Set(JSON.parse(localStorage.getItem('garageshare-saved')||'[]').filter(x=>typeof x==='string'));}catch{}
let map=null,markerLayer=null,picker=null,modalGarage=null,bookingKey='',lastFocus=null,renderVersion=0,afterAuth=null,mapScrollY=0;
const mobileQuery=window.matchMedia('(max-width:760px)');
const mapResizeObserver=typeof ResizeObserver==='undefined'?null:new ResizeObserver(()=>map?.invalidateSize({animate:false}));
const main=$('#main'),rate=g=>state.mode==='hourly'?g.hourly_cents:g.monthly_cents,period=()=>t(state.mode==='hourly'?'hour':'month');
const title=g=>localizedField(g,'name'),amount=cents=>`${money(cents)} ${t('currency')}`;
const badge=s=>`<span class="status ${esc(s)}">${h('status_'+s)}</span>`;
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('visible'),4200);}
function updateChrome(){
 applyDocumentLanguage();$('#demo-banner').hidden=!state.demo;$('#demo-title').textContent=t('preview');$('#demo-note').textContent='· '+t('previewNote');$('#connection').textContent=t('offline');
 $('#home-brand').setAttribute('aria-label',t('home'));$('#header-explore').textContent=t('findGarage');$('#header-host').innerHTML=`${h('becomeHost')} <span>↗</span>`;$('#header-currency').textContent='MAD · '+t('morocco');
 $('#language').value=language();$('#language').setAttribute('aria-label',t('language'));$('#avatar').setAttribute('aria-label',t('account'));$('#avatar').innerHTML=state.user?esc((state.demo?t('previewName'):state.user.name)[0]):icon('user');
 $('#bottom-nav').setAttribute('aria-label',t('navigation'));$('#bottom-nav').innerHTML=[['explore','search'],['saved','heart'],['trips','trip'],['host','garage']].map(([page,i])=>`<button class="nav-item ${state.page===page?'active':''}" data-action="navigate" data-page="${page}" ${state.page===page?'aria-current="page"':''}>${icon(i)}<span>${h(page)}</span></button>`).join('');
 document.querySelectorAll('.header-link').forEach(el=>el.classList.toggle('active',el.dataset.page===state.page));syncMapView();
}
// Use the visible WebView area, including keyboard/rotation updates, without
// rerendering forms or clearing the focused input when that area changes.
function syncViewport(){
 const viewport=window.visualViewport;
 document.documentElement.style.setProperty('--app-viewport-height',`${Math.round(viewport?.height||window.innerHeight)}px`);
 if(state.mapOpen)requestAnimationFrame(()=>map?.invalidateSize({animate:false}));
}
function syncMapView(){
 const open=state.mapOpen&&state.page==='explore'&&mobileQuery.matches;
 document.body.classList.toggle('map-open',open);
 const button=$('.map-toggle'),surface=$('.map-surface'),layout=$('.explore-layout');
 if(button&&surface&&layout){
  (open?surface:layout).append(button);
  button.innerHTML=`${icon(open?'list':'map')}${h(open?'showSpaces':'mapView')}`;
  button.setAttribute('aria-expanded',String(open));
  button.setAttribute('aria-controls','map');
 }
 syncViewport();
}
function setMapOpen(open){
 const next=Boolean(open)&&state.page==='explore'&&mobileQuery.matches;
 if(next&&!state.mapOpen)mapScrollY=window.scrollY;
 const restore=state.mapOpen&&!next;
 state.mapOpen=next;syncMapView();
 if(next)window.scrollTo(0,0);
 else if(restore)window.scrollTo(0,mapScrollY);
 requestAnimationFrame(()=>map?.invalidateSize({animate:false}));
}
window.addEventListener('resize',syncViewport);
window.visualViewport?.addEventListener('resize',syncViewport);
mobileQuery.addEventListener('change',()=>{if(!mobileQuery.matches&&state.mapOpen)setMapOpen(false);else syncMapView();});
function distance(g){if(!state.coords)return 0;const rad=Math.PI/180,a=(g.latitude-state.coords[0])*rad,b=(g.longitude-state.coords[1])*rad;return a*a+b*b*Math.cos(g.latitude*rad)**2;}
function visibleGarages(saved=false){
 let rows=state.garages.filter(g=>saved?state.saved.has(g.id):g.city===state.city);
 if(!saved){const query=state.query.toLocaleLowerCase(locale());rows=rows.filter(g=>`${title(g)} ${g.name} ${g.area} ${cityName(g.city)} ${g.city}`.toLocaleLowerCase(locale()).includes(query));if(state.filters.has('covered'))rows=rows.filter(g=>g.covered);if(state.filters.has('suv'))rows=rows.filter(g=>['suv','van'].includes(g.vehicle_size));if(state.filters.has('budget'))rows=rows.filter(g=>rate(g)<=(state.mode==='hourly'?1200:100000));}
 if(state.sort==='price')rows.sort((a,b)=>rate(a)-rate(b));if(state.sort==='closest'&&state.coords)rows.sort((a,b)=>distance(a)-distance(b));return rows;
}
function card(g){const name=title(g);return `<article class="garage-card" data-garage="${esc(g.id)}"><div class="card-media"><button class="card-image-button" data-action="detail" data-id="${esc(g.id)}" aria-label="${h('viewGarage',{name})}"><img src="${esc(safeImage(g.image))}" alt="${h(g.is_demo?'sampleIllustration':'photoOf',{name})}" loading="lazy" width="480" height="340"></button><span class="card-badge">${h(g.covered?'peaceBadge':'airBadge')}</span><button class="save-btn ${state.saved.has(g.id)?'saved':''}" data-action="save" data-id="${esc(g.id)}" aria-label="${h(state.saved.has(g.id)?'unsaveGarage':'saveGarage',{name})}" aria-pressed="${state.saved.has(g.id)}">${icon('heart')}</button></div><div class="card-body"><div class="card-title"><button data-action="detail" data-id="${esc(g.id)}">${esc(name)}</button>${g.is_demo?`<span class="sample-tag">${h('sample')}</span>`:''}</div><p class="card-area">${esc(g.area.split('·')[0].trim())} · ${esc(cityName(g.city))}</p><div class="card-footer"><div class="card-price"><bdi>${esc(amount(rate(g)))}</bdi> <span>/ ${esc(period())}</span></div><span class="cover-label">${icon(g.covered?'roof':'car')}${h(g.covered?'covered':'outdoor')}</span></div></div></article>`;}
function grid(rows){return rows.length?rows.map(card).join(''):`<div class="search-empty">${h('noSpaces')}<br><br>${h('tryCity')}</div>`;}
function empty(i,titleKey,copyKey,buttonKey,action){return `<div class="empty"><div class="empty-icon">${icon(i)}</div><h3>${h(titleKey)}</h3><p>${h(copyKey)}</p><button class="primary" data-action="${['explore','saved','trips','host'].includes(action)?'navigate':esc(action)}" data-page="${esc(action)}">${h(buttonKey)} ${icon('arrow')}</button></div>`;}
function errorBox(message){return `<div class="notice warning">${icon('info')}<div>${esc(localizeError(message,language()))}<br><button class="text-button" data-action="refresh">${h('retry')}</button></div></div>`;}
function cityOptions(selected){return Object.keys(cityCenters).map(city=>`<option value="${esc(city)}" ${city===selected?'selected':''}>${esc(cityName(city))}</option>`).join('');}
async function render(){
 const version=++renderVersion;updateChrome();if(map){mapResizeObserver?.disconnect();map.remove();map=null;markerLayer=null;}
 if(state.page==='explore'){
  main.innerHTML=`<div class="explore-layout"><section class="explore-main"><div class="hero"><div class="eyebrow">${h('heroEyebrow')}</div><h1>${h('heroLead')}<br><span class="hero-accent">${h('heroAccent')}</span></h1><svg class="hero-asterisk" viewBox="0 0 60 60" fill="none" stroke="currentColor" stroke-width="5"><path d="M30 4v52M4 30h52M12 12l36 36m0-36L12 48"/></svg><p class="hero-copy">${h('heroCopy')}<br>${h('heroCopy2')}</p></div><div class="search-box">${icon('search')}<div class="search-input-wrap"><label class="search-label" for="search">${h('searchLabel')}</label><input id="search" type="search" placeholder="${h('searchPlaceholder')}" value="${esc(state.query)}" autocomplete="off"></div><select class="city-picker" id="city" aria-label="${h('city')}">${cityOptions(state.city)}</select></div><div class="mode-bar"><div class="segmented" aria-label="${h('rentalPeriod')}">${['hourly','monthly'].map(mode=>`<button data-action="mode" data-mode="${mode}" class="${state.mode===mode?'selected':''}" aria-pressed="${state.mode===mode}">${icon(mode==='hourly'?'clock':'calendar')}${h(mode)}</button>`).join('')}</div><button class="near-button" data-action="locate">${icon('locate')}${h('nearMe')}</button></div><div class="filters">${[['covered','roof','covered'],['suv','car','suv'],['budget','money',state.mode==='hourly'?'budgetHourly':'budgetMonthly']].map(([key,i,label])=>`<button class="chip ${state.filters.has(key)?'on':''}" data-action="filter" data-filter="${key}" aria-pressed="${state.filters.has(key)}">${icon(i)}${h(label)}</button>`).join('')}${state.filters.size?`<button class="chip" data-action="clear-filters">${h('clear')}</button>`:''}</div><div class="price-discovery"><p>${h('dealIntro')}</p><button class="secondary" data-action="price-request">${h('askForOffers')} ${icon('arrow')}</button></div><div class="section-line"><div><h2>${h('spacesTitle')}</h2><span class="small" id="result-count"></span></div><select id="sort" class="sort-select" aria-label="${h('sort')}"><option value="recommended">${h('recommended')}</option><option value="price" ${state.sort==='price'?'selected':''}>${h('lowestPrice')}</option>${state.coords?`<option value="closest" ${state.sort==='closest'?'selected':''}>${h('nearestFirst')}</option>`:''}</select></div><div class="garage-grid" id="garage-grid"></div><div class="footer-note">${icon('leaf')}${h('quietCity')}</div></section><aside class="map-wrap" aria-label="${h('garageMap')}"><div class="map-surface"><div id="map" class="map"></div><div class="map-label">${icon('shield')}${h('approximate')}</div><button class="mobile-map-top" data-action="locate" aria-label="${h('useLocation')}">${icon('locate')}</button><div id="map-retry" class="map-retry" hidden>${h('tileFailure')}</div><div class="map-note"><img src="./assets/logo.svg" alt=""><div><strong>${h('goodSpot')}</strong><p>${h(state.demo?'mapSample':'mapLive')}</p></div></div></div></aside><button class="map-toggle" data-action="toggle-map">${icon(state.mapOpen?'list':'map')}${h(state.mapOpen?'showSpaces':'mapView')}</button></div>`;updateResults();setupMap();syncMapView();
 }else if(state.page==='saved'){
  const rows=visibleGarages(true);main.innerHTML=`<section class="page"><div class="eyebrow">${h('shortlistEyebrow')}</div><h1 class="page-title">${h('shortlistTitle')}</h1><p class="page-intro">${h('shortlistCopy')}</p>${rows.length?`<div class="garage-grid">${grid(rows)}</div>`:empty('heart','emptySavedTitle','emptySavedCopy','exploreGarages','explore')}</section>`;
 }else if(state.page==='trips'){
  main.innerHTML=`<section class="page"><div class="eyebrow">${h('tripsEyebrow')}</div><h1 class="page-title">${h('tripsTitle')}</h1><p class="page-intro">${h('tripsCopy')}</p><div id="price-list"></div><div id="trip-list"><div class="loading"><span class="spinner"></span></div></div></section>`;
  if(!state.user){$('#trip-list').innerHTML=empty('lock','tripsLoginTitle','tripsLoginCopy','signIn','auth');return;}
  const [trips, prices]=await Promise.allSettled([repo.reservations(),repo.priceRequests()]);
  if(version!==renderVersion)return;
  if(prices.status==='fulfilled'){
   state.priceRequests=prices.value;
   $('#price-list').innerHTML=guestPriceRequests(prices.value,state.demo);
  }else $('#price-list').innerHTML=errorBox(prices.reason.message);
  if(trips.status==='fulfilled'){
   const rows=trips.value;
   $('#trip-list').innerHTML=rows.length?rows.map(r=>reservationCard(r,false)).join(''):empty('trip','emptyTripsTitle','emptyTripsCopy','findGarage','explore');
  }else $('#trip-list').innerHTML=errorBox(trips.reason.message);
 }else if(state.page==='support'){
  main.innerHTML=`<section class="page"><div class="eyebrow">${h('support')}</div><h1 class="page-title">${h('supportTitle')}</h1><p class="page-intro">${h('supportIntro')}</p><div id="support-list"></div></section>`;
  if(!state.user){$('#support-list').innerHTML=empty('lock','supportTitle','supportIntro','signIn','auth');return;}
  try{
   const tickets=await repo.supportTickets();
   if(version!==renderVersion)return;
   $('#support-list').innerHTML=`${state.demo?`<p class="small">${h('supportPreview')}</p>`:''}<div class="service-actions"><button class="primary" data-action="support-new">${h('supportNew')} ${icon('plus')}</button><button class="text-button" data-action="refresh">${h('supportRefresh')}</button></div>${supportList(tickets)}`;
  }catch(e){if(version===renderVersion)$('#support-list').innerHTML=errorBox(e.message);}
 }else if(state.page==='host'){
  main.innerHTML=`<section class="page"><div class="host-hero"><div class="host-copy"><div class="eyebrow">${h('hostEyebrow')}</div><h1>${h('hostLead')}<br>${h('hostAccent')}</h1><p>${h('hostCopy')}</p><button class="primary" data-action="host-form">${h('listGarage')}${icon('plus')}</button></div><div class="host-illustration">${icon('garage')}</div></div><div class="steps">${[1,2,3].map(n=>`<div class="step"><div class="step-num">${n}</div><h3>${h('step'+n)}</h3><p>${h('step'+n+'Copy')}</p></div>`).join('')}</div><div class="host-tabs"><button class="${state.hostTab==='spaces'?'selected':''}" data-action="host-tab" data-tab="spaces">${h('myGarages')}</button><button class="${state.hostTab==='requests'?'selected':''}" data-action="host-tab" data-tab="requests">${h('hostRequests')}</button><button class="${state.hostTab==='prices'?'selected':''}" data-action="host-tab" data-tab="prices">${h('hostPrices')}</button></div><div id="host-list"></div></section>`;
  if(!state.user){$('#host-list').innerHTML=empty('user','hostLoginTitle','hostLoginCopy','createAccount','auth');return;}
  if(state.hostTab==='prices'){
   try{
    const quotes=await repo.hostPriceQuotes();
    if(version===renderVersion)$('#host-list').innerHTML=hostPriceRequests(quotes,state.demo);
   }catch(e){if(version===renderVersion)$('#host-list').innerHTML=errorBox(e.message);}
   return;
  }
  try{const rows=state.hostTab==='spaces'?await repo.listings():await repo.reservations(true);if(version!==renderVersion)return;$('#host-list').innerHTML=rows.length?(state.hostTab==='spaces'?rows.map(hostCard).join(''):rows.map(r=>reservationCard(r,true)).join('')):empty('garage',state.hostTab==='spaces'?'noHostSpace':'noRequests',state.hostTab==='spaces'?'moderationCopy':'requestsCopy','listGarage','host-form');if(state.demo&&state.hostTab==='requests')$('#host-list').insertAdjacentHTML('beforeend',`<button class="secondary wide" data-action="sample-host">${h('sampleRequest')}</button>`);}catch(e){if(version===renderVersion)$('#host-list').innerHTML=errorBox(e.message);}
 }
}
function updateResults(){const rows=visibleGarages();$('#garage-grid').innerHTML=grid(rows);$('#result-count').textContent=t(state.demo?'sampleSpaceCount':'spaceCount',{count:new Intl.NumberFormat(locale()).format(rows.length),city:cityName(state.city)});drawMarkers(rows);}
function setupMap(){if(!globalThis.L){$('#map').innerHTML=`<div class="offline-map"><p>${h('mapUnavailable')}</p></div>`;return;}map=L.map('map',{zoomControl:false,scrollWheelZoom:false}).setView(cityCenters[state.city],13);L.control.zoom({position:'topright',zoomInTitle:t('zoomIn'),zoomOutTitle:t('zoomOut')}).addTo(map);const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);let failed=0;tiles.on('tileerror',()=>{if(++failed>2&&$('#map-retry'))$('#map-retry').hidden=false;});tiles.on('tileload',()=>{if($('#map-retry'))$('#map-retry').hidden=true;});markerLayer=L.layerGroup().addTo(map);drawMarkers(visibleGarages());mapResizeObserver?.observe(map.getContainer());requestAnimationFrame(()=>map?.invalidateSize({animate:false}));}
function drawMarkers(rows){if(!map||!markerLayer)return;markerLayer.clearLayers();rows.forEach(g=>L.marker([g.latitude,g.longitude],{keyboard:true,title:`${title(g)} · ${amount(rate(g))} / ${period()}`,icon:L.divIcon({html:`<div class="price-marker"><bdi>${esc(amount(rate(g)))}</bdi></div>`,className:'',iconSize:[76,34],iconAnchor:[38,37]})}).addTo(markerLayer).on('click',()=>detail(g)));}
function showModal(html){lastFocus=document.activeElement;if(picker){picker.remove();picker=null;}$('#modal-root').innerHTML=`<div class="modal-overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-handle"></div><button class="sheet-close" data-action="close-modal" aria-label="${h('close')}">${icon('close')}</button>${html}</section></div>`;document.body.style.overflow='hidden';requestAnimationFrame(()=>$('.sheet-close')?.focus({preventScroll:true}));}
function closeModal(){if(picker){picker.remove();picker=null;}$('#modal-root').innerHTML='';document.body.style.overflow='';if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true});}
function detail(g){modalGarage=g;showModal(`<img class="detail-image" src="${esc(safeImage(g.image))}" alt="${h(g.is_demo?'sampleIllustration':'photoOf',{name:title(g)})}"><div class="sheet-content"><div class="eyebrow">${h(g.is_demo?'detailEyebrowSample':'detailEyebrow')}</div><h2 id="sheet-title">${esc(title(g))}</h2><p class="detail-location">${icon('pin')}${esc(g.area.split('·')[0])} · ${esc(cityName(g.city))}</p><div class="detail-features"><div>${icon(g.covered?'roof':'car')}<strong>${h(g.covered?'covered':'openAir')}</strong><span>${h('parkingType')}</span></div><div>${icon('car')}<strong>${h(g.vehicle_size==='compact'?'compact':g.vehicle_size==='suv'?'suv':'van')}</strong><span>${h('vehicleFit')}</span></div><div>${icon('height')}<strong><bdi>${new Intl.NumberFormat(locale(),{minimumFractionDigits:2}).format(g.height_cm/100)} ${h('metre')}</bdi></strong><span>${h('height')}</span></div></div><p class="detail-description">${esc(localizedField(g,'description'))}</p><div class="host-line"><div class="host-avatar">${esc(g.owner_name?.[0]||'G')}</div><div><strong>${h('hostedBy',{name:g.owner_name})}</strong><span>${h(g.is_demo?'sampleHost':'pendingIdentity')}</span></div></div><div class="notice">${icon('lock')}<span>${h('entranceNotice')}</span></div><p class="small">${h('cancelPolicy')}</p></div><div class="detail-bottom"><div><strong><bdi>${esc(amount(rate(g)))}</bdi></strong><small>${h('perPeriod',{period:period()})}</small></div><button class="primary" data-action="book-form">${h(state.demo?'tryBooking':'chooseDates')}${icon('arrow')}</button></div>`);}
function bookingForm(){if(!state.user){auth(false,bookingForm);return;}bookingKey=requestKey();const start=Math.ceil((Date.now()+3600000)/3600000)*3600000;showModal(`<div class="sheet-content"><div class="eyebrow">${h(state.demo?'bookingEyebrowSample':'bookingEyebrow')}</div><h2 id="sheet-title">${h('bookingTitle')}</h2><p class="detail-location">${esc(title(modalGarage))} · ${esc(cityName(modalGarage.city))}</p><form id="booking-form" class="form"><div class="two-fields"><label class="field">${h('startMorocco')}<input type="datetime-local" name="start" value="${moroccoInput(start)}" min="${moroccoInput(Date.now()+60000)}" required></label><label class="field">${h(state.mode==='hourly'?'hours':'months')}<input type="number" name="units" min="1" max="${state.mode==='hourly'?168:12}" step="1" value="${state.mode==='hourly'?3:1}" required></label></div><div class="booking-options"><button type="button" class="secondary selected" data-action="booking-type" data-type="book">${h('bookListed')}</button><button type="button" class="secondary" data-action="booking-type" data-type="offer">${h('propose')}</button></div><input type="hidden" name="type" value="book"><label class="field" id="offer-field" hidden>${h('offerTotal')}<input name="offer" type="number" step="1" min="1" inputmode="numeric"><small>${h('fairOfferHint')}</small></label><div class="price-summary" id="price-summary"></div><div class="notice">${icon('shield')}<span>${h(state.demo?'practiceNotice':'arrivalNotice')}</span></div><div class="form-error" hidden></div><button class="primary wide" type="submit" id="booking-submit">${h(state.demo?'confirmPreview':'confirmBooking')}${icon('arrow')}</button><p class="form-footer">${state.mode==='monthly'?h('calendarBilling')+' ':''}${h('timePolicy')}</p></form></div>`);updateQuote();}
function quote(){const form=$('#booking-form');if(!form)return null;const data=new FormData(form),start=fromMoroccoInput(data.get('start')),units=Number(data.get('units'));if(!Number.isInteger(units)||units<1||units>(state.mode==='hourly'?168:12))throw new Error(localizeError('Choose a valid duration.',language()));return {starts_at:new Date(start).toISOString(),end:endAt(start,units,state.mode),units,mode:state.mode,action:data.get('type'),total_cents:Math.round(Number(data.get('offer'))*100),listed:rate(modalGarage)*units};}
function updateQuote(){try{const q=quote();if(!q)return;$('#price-summary').innerHTML=`<div class="summary-line"><span>${esc(amount(rate(modalGarage)))} × ${esc(duration(q.units,state.mode))}</span><bdi>${esc(amount(q.listed))}</bdi></div><div class="summary-line"><span>${h('platformFee')}</span><bdi>${esc(amount(0))}</bdi></div><div class="summary-line muted"><span>${h('ends',{date:dateLabel(q.end)})}</span><span>${h('moroccoTime')}</span></div><div class="summary-line total"><span>${h(q.action==='offer'?'yourOffer':'totalArrival')}</span><bdi>${esc(amount(q.action==='offer'?q.total_cents:q.listed))}</bdi></div>`;const offer=$('[name="offer"]');offer.min=Math.ceil(q.listed*.6/100);offer.max=Math.floor(q.listed*2/100);}catch{$('#price-summary').textContent=t('validQuote');}}
function reservationCard(r,host){const g=state.garages.find(g=>g.id===r.garage_id),name=g?title(g):r.name,active=['requested','countered','confirmed'].includes(r.status)&&r.starts_at>Date.now();return `<article class="booking-card" id="reservation-${esc(r.id)}"><img src="${esc(safeImage(r.image))}" alt="${esc(name)}"><div class="booking-info">${badge(r.status)}<h3 class="booking-title">${esc(name)}</h3><p class="booking-meta">${esc(cityName(r.city))} · ${esc(duration(r.units,r.mode))}${host?` · ${esc(localizedField(r,'guest_name'))}`:''}<br>${esc(dateLabel(r.starts_at))} ←→ ${esc(dateLabel(r.ends_at))}<br>${h('moroccoTime')}${state.demo?' · '+h('previewOnly'):''}</p><div class="booking-amount"><bdi>${esc(amount(r.total_cents))}</bdi> <span class="small">${h(r.status==='confirmed'?'onArrival':'total')}</span></div>${!host&&r.address&&r.status==='confirmed'?`<div class="private-address">${icon('lock')}${h('yourEntrance',{address:r.address})}<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.latitude+','+r.longitude)}" target="_blank" rel="noopener noreferrer">${h('directions')} ↗</a></div>`:''}<div class="booking-actions">${host&&r.status==='requested'?`<button class="primary" data-action="reservation-action" data-id="${esc(r.id)}" data-step="accept">${h('acceptOffer')}</button><button class="secondary" data-action="counter-form" data-id="${esc(r.id)}">${h('counterPrice')}</button>`:''}${!host&&r.status==='countered'?`<button class="primary" data-action="reservation-action" data-id="${esc(r.id)}" data-step="accept">${h('acceptAmount',{amount:amount(r.total_cents)})}</button>`:''}${host&&['requested','countered'].includes(r.status)?`<button class="secondary" data-action="reservation-action" data-id="${esc(r.id)}" data-step="decline">${h('decline')}</button>`:''}${state.demo&&!host&&r.status==='requested'?`<button class="secondary" data-action="reservation-action" data-id="${esc(r.id)}" data-step="reply">${h('previewReply')}</button>`:''}${active?`<button class="secondary" data-action="cancel-form" data-id="${esc(r.id)}">${h(state.demo?'cancelPreview':'cancel')}</button>`:''}<button class="text-button" data-action="support-new" data-id="${esc(r.id)}">${h('supportBooking')}</button></div></div></article>`;}
function hostCard(g){return `<article class="booking-card"><img src="${esc(safeImage(g.image))}" alt="${h('photoPending')}"><div class="booking-info">${badge(g.status)}<h3 class="booking-title">${esc(title(g))}</h3><p class="booking-meta">${esc(g.area)} · ${esc(cityName(g.city))}<br><bdi>${esc(amount(g.hourly_cents))}</bdi> / ${h('hour')} · <bdi>${esc(amount(g.monthly_cents))}</bdi> / ${h('month')}</p><div class="booking-actions">${state.demo&&g.status==='pending'?`<button class="secondary" data-action="approve-demo" data-id="${esc(g.id)}">${h('previewApproval')}</button>`:''}</div>${g.status==='pending'?`<p class="small">${h('listingPending')}</p>`:''}</div></article>`;}
function auth(register=false,callback=null){if(callback)afterAuth=callback;showModal(`<div class="sheet-content"><div class="eyebrow">${h('authEyebrow')}</div><h2 id="sheet-title">${h(register?'registerTitle':'loginTitle')}</h2><p class="small">${h('oneAccount')}</p><form id="auth-form" class="form" data-register="${register}">${register?`<label class="field">${h('yourName')}<input name="name" autocomplete="name" minlength="2" maxlength="80" required></label>`:''}<label class="field">${h('email')}<input name="email" type="email" autocomplete="email" maxlength="190" required></label><label class="field">${h('password')}<input name="password" type="password" minlength="12" maxlength="128" autocomplete="${register?'new-password':'current-password'}" required><small>${h('passwordHint')}</small></label><div class="form-error" hidden></div><button class="primary wide" type="submit">${h(register?'createMyAccount':'signIn')}${icon('arrow')}</button><button type="button" class="text-button" data-action="auth-toggle" data-register="${!register}">${h(register?'alreadyAccount':'newAccount')}</button><p class="form-footer">${h('agreeTerms')} <button type="button" data-action="privacy" class="support-link">${h('privacyTerms')}</button></p></form></div>`);}
function profile(){showModal(`<div class="sheet-content"><div class="eyebrow">${h('profileEyebrow')}</div><h2 id="sheet-title">${state.user?h('hello',{name:state.demo?t('previewName'):state.user.name}):h('welcome')}</h2><p class="small">${state.demo?h('previewAccount'):state.user?esc(state.user.email):h('signInCopy')}</p>${state.demo?`<div class="notice">${icon('info')}<span>${h('previewAccountNotice')}</span></div>`:''}<div class="account-menu"><label class="field">${h('language')}<select id="language-dialog"><option value="fr" ${language()==='fr'?'selected':''}>Français</option><option value="ar" ${language()==='ar'?'selected':''}>العربية</option><option value="en" ${language()==='en'?'selected':''}>English</option></select></label>${!state.user?`<button class="primary wide" data-action="auth">${h('signInOrCreate')}</button>`:''}<button class="secondary" data-action="navigate" data-page="support">${icon('info')}${h('support')}</button>${state.user?.staff_role?`<a class="secondary" href="./admin.html">${h('staffDashboard')}</a>`:''}<button class="secondary" data-action="privacy">${icon('shield')}${h('privacyTerms')}</button><button class="secondary" data-action="about">${icon('info')}${h('about')}</button>${state.demo?`<button class="danger" data-action="reset-confirm">${h('resetData')}</button>`:state.user?`<button class="secondary" data-action="signout">${h('signOut')}</button>`:''}</div></div>`);}
function hostForm(){if(!state.user){auth(true,hostForm);return;}showModal(`<div class="sheet-content"><div class="eyebrow">${h('hostFormEyebrow')}</div><h2 id="sheet-title">${h('hostFormTitle')}</h2><p class="small">${h('privateEntrance')}</p><form id="host-form" class="form"><label class="field">${h('garageName')}<input name="name" placeholder="${h('garageNameHint')}" minlength="3" maxlength="100" required></label><div class="two-fields"><label class="field">${h('city')}<select name="city" id="host-city">${cityOptions(state.city)}</select></label><label class="field">${h('neighbourhood')}<input name="area" placeholder="${h('areaHint')}" minlength="2" maxlength="100" required></label></div><label class="field">${h('address')}<input name="address" placeholder="${h('addressHint')}" minlength="5" maxlength="220" required><small>${h('privateAddressHint')}</small></label><label class="field">${h('placePin')}</label><div class="location-select-map"><div id="picker-map" class="map"></div></div><input type="hidden" name="latitude" value=""><input type="hidden" name="longitude" value=""><span class="small" id="pin-label">${h('pinRequired')}</span><div class="two-fields"><label class="field">${h('hourlyPrice')}<input name="hourly" type="number" min="1" max="1000" step="1" placeholder="12" required></label><label class="field">${h('monthlyPrice')}<input name="monthly" type="number" min="100" max="100000" step="1" placeholder="950" required></label></div><div class="two-fields"><label class="field">${h('vehicleSize')}<select name="vehicle_size"><option value="compact">${h('compact')}</option><option value="suv">${h('carSUV')}</option><option value="van">${h('carVan')}</option></select></label><label class="field">${h('heightCm')}<input name="height_cm" type="number" min="140" max="500" step="1" placeholder="220" required></label></div><label class="field">${h('parkingType')}<select name="covered"><option value="yes">${h('coveredGarage')}</option><option value="no">${h('outdoorSpace')}</option></select></label><label class="field">${h('renterInfo')}<textarea name="description" minlength="10" maxlength="1500" placeholder="${h('descriptionHint')}" required></textarea></label><div class="photo-choice">${icon('camera')}<span>${h('accuratePhotos')}</span></div><div class="notice">${icon('shield')}<span>${h('hostConsent')}</span></div><div class="form-error" hidden></div><button class="primary wide" type="submit">${h(state.demo?'submitPreview':'submitReview')}${icon('arrow')}</button></form></div>`);if(!globalThis.L){$('#pin-label').textContent=t('mapHostUnavailable');return;}picker=L.map('picker-map',{scrollWheelZoom:false}).setView(cityCenters[state.city],14);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(picker);let pin;picker.on('click',e=>{if(pin)pin.remove();pin=L.marker(e.latlng).addTo(picker);$('[name="latitude"]').value=e.latlng.lat.toFixed(7);$('[name="longitude"]').value=e.latlng.lng.toFixed(7);$('#pin-label').textContent=t('entranceSelected',{coordinates:e.latlng.lat.toFixed(5)+', '+e.latlng.lng.toFixed(5)});});requestAnimationFrame(()=>picker?.invalidateSize());}
function privacy(){showModal(`<div class="sheet-content"><div class="eyebrow">${h('privacyEyebrow')}</div><h2 id="sheet-title">${h('privacyTitle')}</h2><div class="privacy-copy">${['Booking','Location','Trust','Preview'].map(section=>`<h3>${h('privacy'+section+'Title')}</h3><p>${h('privacy'+section)}</p>`).join('')}</div></div>`);}
async function navigate(page){closeModal();setMapOpen(false);state.page=page;window.scrollTo({top:0});await render();}

async function openPriceRequest() {
 if(!state.user){auth(false,openPriceRequest);return;}
 const version=renderVersion;
 const ownIds=new Set((await repo.listings()).map(g=>g.id));
 if(version!==renderVersion)return;
 const garages=visibleGarages().filter(g=>!ownIds.has(g.id)).slice(0,20);
 if(!garages.length)throw new Error(t('dealNoGarages'));
 showModal(priceRequestForm(garages,state.city,state.mode));
}

async function openSupportTicket(id) {
 const version=renderVersion, sheet=$('.sheet');
 const ticket=await repo.supportTicket(id);
 if(version===renderVersion&&sheet===$('.sheet'))showModal(supportThread(ticket,state.demo));
}

document.addEventListener('click',async event=>{
 if(event.target.classList.contains('modal-overlay')){closeModal();return;}
 const button=event.target.closest('[data-action]');if(!button)return;const a=button.dataset.action,gid=button.dataset.id;
 try{
  if(a==='navigate')await navigate(button.dataset.page);else if(a==='refresh')await render();else if(a==='reload')location.reload();
  else if(a==='mode'){state.mode=button.dataset.mode;await render();}
  else if(a==='filter'){state.filters.has(button.dataset.filter)?state.filters.delete(button.dataset.filter):state.filters.add(button.dataset.filter);await render();}
  else if(a==='clear-filters'){state.filters.clear();state.query='';await render();}
  else if(a==='save'){state.saved.has(gid)?state.saved.delete(gid):state.saved.add(gid);try{localStorage.setItem('garageshare-saved',JSON.stringify([...state.saved]));}catch{toast(t('savedSession'));}if(state.page==='explore')updateResults();else await render();}
  else if(a==='detail'){const g=state.garages.find(g=>g.id===gid);if(g)detail(g);}
  else if(a==='toggle-map')setMapOpen(!state.mapOpen);
  else if(a==='price-request'){button.disabled=true;try{await openPriceRequest();}finally{button.disabled=false;}}
  else if(a==='price-select'){
   const request=state.priceRequests.find(row=>row.id===gid);
   const quote=request?.quotes.find(row=>row.id===button.dataset.quote);
   if(quote?.status==='quoted'&&request.status==='open')showModal(selectPriceForm(request,quote));
  }
  else if(a==='price-counter')showModal(counterPriceForm(gid));
  else if(a==='price-respond'){
   button.disabled=true;
   await repo.respondToPrice(gid,button.dataset.response);
   if(button.dataset.response==='match')toast(t('dealQuoteSent'));
   await render();
  }
  else if(a==='price-cancel'){button.disabled=true;await repo.cancelPriceRequest(gid);await render();}
  else if(a==='price-sample-replies'){button.disabled=true;await repo.samplePriceReplies(gid);await render();}
  else if(a==='price-sample-invitation'){
   button.disabled=true;await repo.samplePriceInvitation();state.garages=await repo.garages();await render();
  }
  else if(a==='support-new'){
   const open=()=>showModal(supportTicketForm(gid,state.demo));
   if(state.user)open();else auth(false,open);
  }
  else if(a==='support-ticket')await openSupportTicket(gid);
  else if(a==='support-sample-reply'){
   button.disabled=true;const ticket=await repo.sampleSupportReply(gid);
   if(ticket&&button.isConnected)showModal(supportThread(ticket,state.demo));
  }
  else if(a==='close-modal')closeModal();else if(a==='book-form')bookingForm();
  else if(a==='booking-type'){const type=button.dataset.type;$('[name="type"]').value=type;$('#offer-field').hidden=type!=='offer';$('.booking-options').querySelectorAll('button').forEach(b=>b.classList.toggle('selected',b.dataset.type===type));const offer=$('[name="offer"]');offer.required=type==='offer';if(type==='offer'&&!offer.value){try{offer.value=Math.round(quote().listed*.85/100);}catch{}}$('#booking-submit').innerHTML=`${h(type==='offer'?(state.demo?'sendPreviewOffer':'sendOffer'):(state.demo?'confirmPreview':'confirmBooking'))}${icon('arrow')}`;updateQuote();}
  else if(a==='profile')profile();else if(a==='auth')auth();else if(a==='auth-toggle')auth(button.dataset.register==='true');else if(a==='privacy')privacy();
  else if(a==='about')showModal(`<div class="sheet-content"><div class="about-brand"><img src="./assets/logo.svg" alt="GarageShare"><strong id="sheet-title"><bdi>GarageShare</bdi></strong></div><p class="privacy-copy">${h('aboutCopy')}<br><br>${h('aboutVersion')}<br><br>${h('credits')}</p></div>`);
  else if(a==='host-form')hostForm();else if(a==='host-tab'){state.hostTab=button.dataset.tab;await render();}
  else if(a==='approve-demo'){await repo.approveDemo(gid);state.garages=await repo.garages();toast(t('approvedToast'));await render();}
  else if(a==='sample-host'){await repo.sampleHostRequest();state.garages=await repo.garages();await render();toast(t('sampleRequestToast'));}
  else if(a==='reservation-action'){button.disabled=true;await repo.reservationAction(gid,button.dataset.step);toast(t(button.dataset.step==='accept'?'acceptedToast':button.dataset.step==='reply'?'replyToast':'updatedToast'));await render();}
  else if(a==='counter-form')showModal(`<div class="sheet-content"><h2 id="sheet-title">${h('counterTitle')}</h2><p class="small">${h('counterCopy')}</p><form class="form" id="counter-form" data-id="${esc(gid)}"><label class="field">${h('newTotal')}<input type="number" name="total" min="1" step="1" required></label><div class="form-error" hidden></div><button class="primary wide" type="submit">${h('sendCounter')}</button></form></div>`);
  else if(a==='cancel-form')showModal(`<div class="sheet-content"><h2 id="sheet-title">${h('cancelTitle')}</h2><p class="page-intro">${h('cancelCopy')}</p><form id="cancel-form" data-id="${esc(gid)}"><div class="form-error" hidden></div><button class="danger wide" type="submit">${h('yesCancel')}</button><button type="button" class="text-button wide" data-action="close-modal">${h('keepReservation')}</button></form></div>`);
  else if(a==='signout'){await repo.signOut();state.user=null;closeModal();await repo.init();await render();toast(t('signedOut'));}
  else if(a==='reset-confirm')showModal(`<div class="sheet-content"><h2 id="sheet-title">${h('resetTitle')}</h2><p class="page-intro">${h('resetCopy')}</p><button class="danger wide" data-action="reset-demo">${h('resetData')}</button><button class="text-button wide" data-action="close-modal">${h('keepData')}</button></div>`);
  else if(a==='reset-demo'){repo.resetDemo();state.saved.clear();try{localStorage.removeItem('garageshare-saved');}catch{}state.garages=await repo.garages();await navigate('explore');toast(t('resetToast'));}
  else if(a==='locate'){if(!navigator.geolocation){toast(t('locationUnavailable'));return;}button.disabled=true;navigator.geolocation.getCurrentPosition(async pos=>{state.coords=[pos.coords.latitude,pos.coords.longitude];state.city=Object.entries(cityCenters).sort((a,b)=>distance({latitude:a[1][0],longitude:a[1][1]})-distance({latitude:b[1][0],longitude:b[1][1]}))[0][0];state.sort='closest';state.query='';await render();toast(t('nearCity',{city:cityName(state.city)}));},()=>{button.disabled=false;toast(t('locationUnavailable'));},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});}
 }catch(e){button.disabled=false;toast(localizeError(e.message,language()));}
});
document.addEventListener('input',event=>{if(event.target.id==='search'){state.query=event.target.value;updateResults();}if(event.target.closest('#booking-form'))updateQuote();});
document.addEventListener('change',async event=>{
 if(['language','language-dialog'].includes(event.target.id)){if(setLanguage(event.target.value)){closeModal();await render();}}
 if(event.target.id==='city'){state.city=event.target.value;state.query='';await render();}
 if(event.target.id==='sort'){state.sort=event.target.value;updateResults();}
 if(event.target.id==='host-city'){picker?.setView(cityCenters[event.target.value],14);$('[name="latitude"]').value='';$('[name="longitude"]').value='';$('#pin-label').textContent=t('pinCity');}
});
document.addEventListener('submit',async event=>{
 const form=event.target;event.preventDefault();const button=$('[type="submit"]',form);if(!button||button.disabled)return;button.disabled=true;const error=$('.form-error',form);if(error)error.hidden=true;
 try{const data=Object.fromEntries(new FormData(form));
  if(form.id==='auth-form'){state.user=await repo.signIn(data,form.dataset.register==='true');closeModal();await render();const cb=afterAuth;afterAuth=null;if(cb)await cb();else toast(t('welcome'));}
  else if(form.id==='price-request-form'){
   await repo.requestPrices({city:data.city,mode:data.mode,starts_at:new Date(fromMoroccoInput(data.start)).toISOString(),units:Number(data.units),
    proposed_cents:Math.round(Number(data.total)*100),garage_ids:new FormData(form).getAll('garage_ids'),request_key:data.request_key});
   await navigate('trips');$('#price-requests')?.scrollIntoView({block:'start'});toast(t('dealSent'));
  }
  else if(form.id==='price-select-form'){
   const selected=await repo.selectPriceQuote(form.dataset.id,data.quote_id,Number(data.total_cents));
   await navigate('trips');document.getElementById('reservation-'+selected.reservation_id)?.scrollIntoView({block:'start'});
   toast(t('bookingSuccessTitle'));
  }
  else if(form.id==='price-counter-form'){
   await repo.respondToPrice(form.dataset.id,'counter',Math.round(Number(data.total)*100));
   closeModal();await render();toast(t('dealQuoteSent'));
  }
  else if(form.id==='support-create-form'){
   const ticket=await repo.createSupportTicket(data);
   await navigate('support');showModal(supportThread(ticket,state.demo));
  }
  else if(form.id==='support-reply-form'){
   const ticket=await repo.replyToSupport(form.dataset.id,data);
   if(form.isConnected)showModal(supportThread(ticket,state.demo));
   if(state.page==='support')await render();
  }
  else if(form.id==='booking-form'){const q=quote();if(Date.parse(q.starts_at)<Date.now()+60000)throw new Error(localizeError('Choose a start at least one minute ahead.',language()));const result=await repo.reserve(modalGarage,{starts_at:q.starts_at,units:q.units,mode:q.mode,action:q.action,total_cents:q.total_cents,request_key:bookingKey});showModal(`<div class="sheet-content success"><div class="success-mark">${icon('check')}</div><div class="eyebrow" style="justify-content:center">${h(state.demo?'previewDone':'tripsEyebrow')}</div><h2 id="sheet-title">${h(result.status==='requested'?'offerSentTitle':'bookingSuccessTitle')}</h2><p>${result.status==='requested'?h('offerSentCopy'):h(state.demo?'sampleConfirmedCopy':'confirmedCopy',{amount:amount(result.total_cents)})}${state.demo?'<br><br>'+h('noRealBooking'):''}</p><button class="primary wide" data-action="navigate" data-page="trips">${h('seeTrips')}${icon('arrow')}</button></div>`);}
  else if(form.id==='host-form'){if(!data.latitude||!data.longitude)throw new Error(t('pinRequired'));await repo.createListing({name:data.name,city:data.city,area:data.area,address:data.address,description:data.description,latitude:Number(data.latitude),longitude:Number(data.longitude),hourly_cents:Math.round(Number(data.hourly)*100),monthly_cents:Math.round(Number(data.monthly)*100),height_cm:Number(data.height_cm),vehicle_size:data.vehicle_size,covered:data.covered==='yes'});state.hostTab='spaces';closeModal();await navigate('host');toast(t(state.demo?'previewSubmitted':'listingSubmitted'));}
  else if(form.id==='counter-form'){await repo.reservationAction(form.dataset.id,'counter',{total_cents:Math.round(Number(data.total)*100)});closeModal();await render();toast(t('counterSent'));}
  else if(form.id==='cancel-form'){await repo.reservationAction(form.dataset.id,'cancel');closeModal();await render();toast(t('cancelledToast'));}
 }catch(e){if(error){error.textContent=localizeError(e.message,language());error.hidden=false;error.scrollIntoView({block:'nearest'});}else toast(localizeError(e.message,language()));button.disabled=false;}
});
document.addEventListener('keydown',event=>{if(!$('.sheet'))return;if(event.key==='Escape'){closeModal();event.preventDefault();}if(event.key==='Tab'){const elements=[...$('.sheet').querySelectorAll('button:not(:disabled),a[href],input:not([type="hidden"]),select,textarea')].filter(el=>el.getClientRects().length),first=elements[0],last=elements.at(-1);if(event.shiftKey&&document.activeElement===first){last.focus();event.preventDefault();}else if(!event.shiftKey&&document.activeElement===last){first.focus();event.preventDefault();}}});
window.garageshareBack=()=>{if($('.sheet')){closeModal();return true;}if(state.mapOpen){setMapOpen(false);return true;}if(state.page!=='explore'){navigate('explore');return true;}return false;};
window.addEventListener('offline',()=>{$('#connection').hidden=false;});window.addEventListener('online',()=>{$('#connection').hidden=true;});
async function start(){updateChrome();try{const initial=await repo.init();state.demo=initial.demo;state.user=initial.user;state.garages=await repo.garages();await render();}catch(e){main.innerHTML=`<section class="page">${empty('info','connectTitle','connectCopy','retry','reload')}<p class="small">${esc(localizeError(e.message,language()))}</p></section>`;}}
start();
