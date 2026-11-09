import { esc } from './icons.js';
import { t, language } from './i18n.js';
import { localizeError } from './errors.js';

// Canvas encoders may retain a standard color profile. Remove ancillary metadata
// chunks and their VP8X flags before upload, while preserving the image payload.
export function stripWebpMetadata(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    const length = view.getUint32(offset + 4, true);
    const next = offset + 8 + length + (length % 2);
    const kind = String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (!['ICCP', 'EXIF', 'XMP '].includes(kind)) {
      const chunk = bytes.slice(offset, next);
      if (kind === 'VP8X') chunk[8] &= ~(0x20 | 0x08 | 0x04);
      chunks.push(chunk);
    }
    offset = next;
  }
  const header = bytes.slice(0, 12);
  new DataView(header.buffer).setUint32(4, 4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), true);
  return new Blob([header, ...chunks], {type:'image/webp'});
}

// Re-encode in the browser to remove metadata and bound the uploaded image size.
export async function prepareModerationPhoto(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10*1024*1024) throw new Error(t('moderationPhotoError'));
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
    if (!blob || blob.type !== 'image/webp' || blob.size > 5*1024*1024) throw new Error(t('moderationPhotoError'));
    blob = stripWebpMetadata(await blob.arrayBuffer());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error(t('moderationPhotoError')));
      reader.readAsDataURL(blob);
    });
  } finally { bitmap.close(); }
}

export function mountModeration(root, api) {
  let offset = 0, revision = 0, busy = false, rows = [], selected = null, mode = 'details', hasMore = false;
  const statuses = ['pending','approved','rejected','archived'];
  const cities = ['Casablanca','Rabat','Marrakech','Tangier','Nador','Fes','Meknes'];
  const h = (key, params) => esc(t(key, params));
  const money = cents => new Intl.NumberFormat(language(), {style:'currency',currency:'MAD',maximumFractionDigits:2}).format(cents/100);
  root.innerHTML = `<div class="admin-section-heading"><div><h2>${h('moderationTitle')}</h2><p class="small">${h('moderationIntro')}</p></div>
    <button type="button" class="primary" data-mod-action="new">${h('moderationNew')}</button></div>
    <div class="admin-toolbar moderation-toolbar">
      <label class="field">${h('moderationStatus')}<select id="moderation-status">${statuses.map(s=>`<option value="${s}">${h('moderation_'+s)}</option>`).join('')}</select></label>
      <label class="field">${h('moderationSearch')}<input type="search" id="moderation-search" maxlength="120"></label>
      <button type="button" class="secondary" data-mod-action="refresh">${h('moderationRefresh')}</button>
    </div><p role="status" id="moderation-notice" class="admin-notice" hidden></p>
    <div class="moderation-workspace"><section class="moderation-queue-panel" aria-label="${h('moderationTitle')}">
      <p id="moderation-count" class="small"></p><div id="moderation-list" class="moderation-queue"></div>
      <div class="moderation-pagination"><button type="button" class="secondary" data-mod-action="previous" disabled>${h('moderationPrevious')}</button>
      <button type="button" class="secondary" data-mod-action="next" disabled>${h('moderationNext')}</button></div>
    </section><section id="moderation-detail" class="moderation-detail" aria-live="polite"></section></div>`;
  const list = root.querySelector('#moderation-list'), detail = root.querySelector('#moderation-detail');
  const alive = () => root.isConnected && root.contains(list);
  const status = root.querySelector('#moderation-status'), search = root.querySelector('#moderation-search'), notice = root.querySelector('#moderation-notice');
  function message(value, error=false) { notice.textContent=value; notice.hidden=!value; notice.classList.toggle('warning',error); }
  function showError(error) { message(error.status===413?t('moderationUploadLimit'):localizeError(error.message,language()),true); }
  function current() { return rows.find(g=>g.id===selected); }
  function navigation() {
    root.querySelector('[data-mod-action="previous"]').disabled=busy||offset===0;
    root.querySelector('[data-mod-action="next"]').disabled=busy||!hasMore;
  }
  function renderRows() {
    const query=search.value.trim().toLocaleLowerCase();
    const filtered=rows.filter(g=>[g.name,g.owner_name,g.owner_email,g.city,g.area].some(v=>String(v).toLocaleLowerCase().includes(query)));
    root.querySelector('#moderation-count').textContent=t('moderationPageCount',{count:filtered.length});
    list.innerHTML=filtered.length ? filtered.map(g=>`<button type="button" class="moderation-row ${g.id===selected?'is-selected':''}" data-mod-action="select" data-id="${esc(g.id)}" ${g.id===selected?'aria-current="true"':''}>
      <span class="moderation-row-title">${esc(g.name)}</span><span class="admin-badge status-${esc(g.status)}">${h('moderation_'+g.status)}</span>
      <span class="small">${esc(g.city)} · ${esc(g.area)}</span><span class="small">${esc(g.owner_name)}</span>
      <strong>${esc(money(g.hourly_cents))} / ${h('hour')}</strong></button>`).join('') : `<p class="admin-empty">${h('moderationEmpty')}</p>`;
    navigation();
  }
  function renderDetails() {
    const g=current();
    if(!g){detail.innerHTML=`<div class="admin-empty">${h('moderationSelect')}</div>`;return;}
    detail.innerHTML=`<article class="moderation-card">
      <div class="admin-section-heading"><div><span class="admin-badge status-${esc(g.status)}">${h('moderation_'+g.status)}</span><h3>${esc(g.name)}</h3></div>
      <button type="button" class="secondary" data-mod-action="edit">${h('moderationEdit')}</button></div>
      ${g.image?.startsWith('/assets/host-photos/')?`<img class="moderation-current-photo" src="${esc(g.image)}" alt="${esc(g.name)}">`:''}
      <div class="moderation-facts"><div><h4>${h('moderationOwner')}</h4><p>${esc(g.owner_name)}<br><bdi>${esc(g.owner_email)}</bdi></p></div>
      <div><h4>${h('moderationPrices')}</h4><p>${esc(money(g.hourly_cents))} / ${h('hour')}<br>${esc(money(g.monthly_cents))} / ${h('month')}</p></div>
      <div><h4>${h('moderationEntrance')}</h4><p>${esc(g.city)} · ${esc(g.area)}<br>${esc(g.address)}<br><bdi>${esc(g.latitude)}, ${esc(g.longitude)}</bdi></p></div>
      <div><h4>${h('moderationSpecifications')}</h4><p>${h('height')}: ${esc(g.height_cm)} cm<br>${h(g.vehicle_size)} · ${h(g.covered?'covered':'outdoor')}</p></div></div>
      <p class="moderation-description">${esc(g.description)}</p>
      ${g.status==='pending'?`<section class="moderation-review"><h4>${h('moderationReviewPhoto')}</h4><p class="small">${h('moderationPhotoHint')}</p>
        <form class="form moderation-form" data-garage="${esc(g.id)}"><label class="field">${h('moderationPhoto')}<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label>
        <img class="moderation-photo" alt="${h('moderationPreview')}" hidden>
        <label class="staff-checkbox"><input name="confirmed" type="checkbox" required><span>${h('moderationConfirm')}</span></label>
        <div class="moderation-actions"><button type="submit" class="primary">${h('moderationApprove')}</button>
        <button type="button" class="secondary danger" data-mod-action="reject" data-id="${esc(g.id)}">${h('moderationReject')}</button></div></form></section>`:''}
      ${g.status==='approved'?`<button type="button" class="secondary danger" data-mod-action="archive" data-id="${esc(g.id)}">${h('moderationArchive')}</button>`:''}
    </article>`;
  }
  function field(name,label,value='',type='text',extra='') {
    return `<label class="field">${h(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra} required></label>`;
  }
  function renderEditor(editing) {
    const g=editing?current():{};if(editing&&!g)return;
    mode=editing?'edit':'new';
    detail.innerHTML=`<section class="moderation-card"><div class="admin-section-heading"><h3>${h(editing?'moderationEdit':'moderationNew')}</h3><button type="button" class="text-button" data-mod-action="cancel-edit">${h('moderationCancel')}</button></div>
      <p class="small">${h(editing?'moderationEditIntro':'moderationCreateIntro')}</p>
      ${!editing?`<form id="moderation-owner-search" class="admin-toolbar"><label class="field">${h('moderationOwnerSearch')}<input type="search" name="q" minlength="2" maxlength="120" required></label><button type="submit" class="secondary">${h('moderationFindOwner')}</button></form>`:''}
      <form class="form moderation-editor" data-id="${esc(g.id||'')}" data-status="${esc(g.status||'pending')}">
      ${editing?`<p class="small">${h('moderationOwner')}: ${esc(g.owner_name)} · ${esc(g.owner_email)}</p>`:`<label class="field">${h('moderationOwner')}<select name="owner_id" id="moderation-owner" required><option value="">${h('moderationChooseOwner')}</option></select></label>`}
      <div class="admin-form-grid">${field('name','garageName',g.name||'','text','minlength="3" maxlength="100"')}
      <label class="field">${h('city')}<select name="city">${cities.map(c=>`<option ${g.city===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      ${field('area','neighbourhood',g.area||'','text','minlength="2" maxlength="100"')}${field('address','address',g.address||'','text','minlength="5" maxlength="220"')}
      ${field('latitude','moderationLatitude',g.latitude??'','number','step="any" min="27.5" max="36"')}${field('longitude','moderationLongitude',g.longitude??'','number','step="any" min="-14" max="-0.8"')}
      ${field('hourly','hourlyPrice',g.hourly_cents?g.hourly_cents/100:'','number','step="0.01" min="1" max="1000"')}${field('monthly','monthlyPrice',g.monthly_cents?g.monthly_cents/100:'','number','step="0.01" min="100" max="100000"')}
      ${field('height_cm','heightCm',g.height_cm||'','number','step="1" min="140" max="500"')}
      <label class="field">${h('vehicleSize')}<select name="vehicle_size">${['compact','suv','van'].map(v=>`<option value="${v}" ${g.vehicle_size===v?'selected':''}>${h(v)}</option>`).join('')}</select></label></div>
      <label class="staff-checkbox"><input name="covered" type="checkbox" ${g.covered?'checked':''}> ${h('coveredGarage')}</label>
      <label class="field">${h('renterInfo')}<textarea name="description" minlength="10" maxlength="1500" rows="4" required>${esc(g.description||'')}</textarea></label>
      <button type="submit" class="primary">${h('moderationSave')}</button></form></section>`;
  }
  async function load() {
    const n=++revision;message(t('moderationLoading'));
    const result=await api(`/staff/garages?status=${status.value}&offset=${offset}`);
    if(n!==revision||!alive())return;
    rows=result.garages;hasMore=result.has_more;
    if(!rows.some(g=>g.id===selected))selected=rows[0]?.id||null;
    mode='details';renderRows();renderDetails();message('');
  }
  async function perform(work) {
    if(busy)return;busy=true;message('');root.setAttribute('aria-busy','true');status.disabled=true;search.disabled=true;
    root.querySelectorAll('button').forEach(b=>b.disabled=true);
    try {await work();}catch(error){if(alive())showError(error);}
    finally {busy=false;if(alive()){root.setAttribute('aria-busy','false');status.disabled=false;search.disabled=false;root.querySelectorAll('button').forEach(b=>b.disabled=false);navigation();}}
  }
  status.addEventListener('change',()=>{offset=0;selected=null;perform(load);});
  search.addEventListener('input',renderRows);
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-mod-action]');if(!button||button.disabled||busy)return;
    const action=button.dataset.modAction;
    if(action==='select'){selected=button.dataset.id;mode='details';renderRows();renderDetails();message('');return;}
    if(action==='new'){renderEditor(false);return;}
    if(action==='edit'){renderEditor(true);return;}
    if(action==='cancel-edit'){mode='details';renderDetails();return;}
    perform(async()=>{
      if(['reject','archive'].includes(action)){
        if(!window.confirm(t('moderationActionConfirm')))return;
        await api(`/staff/garages/${button.dataset.id}/${action}`,'POST',{expected_status:status.value});
      }
      if(action==='next')offset+=25;
      if(action==='previous')offset=Math.max(0,offset-25);
      await load();if(['reject','archive'].includes(action))message(t('moderationSaved'));
    });
  });
  root.addEventListener('change',event=>{
    if(event.target.name!=='photo')return;
    const input=event.target,image=input.form.querySelector('img');image.hidden=true;image.removeAttribute('src');
    const file=input.files[0];if(file&&file.size<=10*1024*1024&&['image/jpeg','image/png','image/webp'].includes(file.type)){
      const reader=new FileReader();reader.onload=()=>{if(input.files[0]===file){image.src=reader.result;image.hidden=false;}};reader.readAsDataURL(file);
    }
  });
  root.addEventListener('submit',event=>{
    const form=event.target;if(!form.matches('.moderation-form,.moderation-editor,#moderation-owner-search'))return;
    event.preventDefault();event.stopPropagation();if(!form.reportValidity())return;
    perform(async()=>{
      if(form.id==='moderation-owner-search'){
        const q=form.elements.q.value.trim();const result=await api('/staff/users?q='+encodeURIComponent(q));if(!alive())return;
        const select=root.querySelector('#moderation-owner');
        select.innerHTML=`<option value="">${h('moderationChooseOwner')}</option>`+result.users.map(u=>`<option value="${esc(u.id)}">${esc(u.name)} · ${esc(u.email)}</option>`).join('');
        if(!result.users.length)message(t('moderationOwnerEmpty'));else message('');return;
      }
      if(form.matches('.moderation-form')){
        let photo_base64;
        try {photo_base64=await prepareModerationPhoto(form.elements.photo.files[0]);}catch {throw new Error(t('moderationPhotoFailed'));}
        await api(`/staff/garages/${form.dataset.garage}/approve`,'POST',{expected_status:'pending',confirmed:true,photo_base64});
        await load();message(t('moderationSaved'));return;
      }
      const values=Object.fromEntries(new FormData(form));
      const data={name:values.name,city:values.city,area:values.area,address:values.address,description:values.description,
        latitude:Number(values.latitude),longitude:Number(values.longitude),hourly_cents:Math.round(Number(values.hourly)*100),monthly_cents:Math.round(Number(values.monthly)*100),
        height_cm:Number(values.height_cm),vehicle_size:values.vehicle_size,covered:form.elements.covered.checked};
      const editing=Boolean(form.dataset.id);if(editing){data.expected_status=form.dataset.status;data.owner_id=current().owner_id;}else data.owner_id=values.owner_id;
      const result=await api('/staff/managed-garages'+(editing?`/${form.dataset.id}/update`:''),'POST',data);
      status.value='pending';offset=0;selected=result.id||result.garage?.id||null;search.value='';await load();message(t(editing?'moderationSaved':'moderationCreated'));
    });
  });
  perform(load);
}
