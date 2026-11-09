import { esc, dateLabel } from './icons.js';
import { t, locale, language } from './i18n.js';
import { localizeError } from './errors.js';

const h = (key, params) => esc(t(key, params));
const number = value => new Intl.NumberFormat(locale()).format(Number(value) || 0);
const money = cents => new Intl.NumberFormat(locale(), {style:'currency',currency:'MAD',maximumFractionDigits:2}).format((Number(cents)||0)/100);
const sum = statuses => Object.values(statuses || {}).reduce((total, value) => total + (Number(value) || 0), 0);
const statuses = ['requested','countered','confirmed','declined','cancelled','expired'];
const roles = ['customer','support','admin'];
const options = (values, selected, prefix) => values.map(value => `<option value="${esc(value)}" ${selected===value?'selected':''}>${h(prefix+value)}</option>`).join('');

function notice(root, message='', error=false) {
  if (!root.isConnected) return;
  const el=root.querySelector('[data-management-notice]');
  if (!el) return;
  el.textContent=message;
  el.classList.toggle('warning',error);
  el.hidden=!message;
}
function errorNotice(root,error) { notice(root,localizeError(error.message,language()),true); }
function pagination() { return `<div class="admin-pagination"><button type="button" class="secondary" data-management-action="previous" disabled>${h('managePrevious')}</button><span data-page-label></span><button type="button" class="secondary" data-management-action="next" disabled>${h('manageNext')}</button></div>`; }
function updatePagination(root,offset,hasMore) {
  const previous=root.querySelector('[data-management-action="previous"]');
  const next=root.querySelector('[data-management-action="next"]');
  previous.disabled=offset===0; next.disabled=!hasMore;
  for (const button of [previous,next]) if (button.dataset.wasDisabled!==undefined) button.dataset.wasDisabled=String(button.disabled);
  root.querySelector('[data-page-label]').textContent=t('managePage',{page:number(offset/25+1)});
}
function baseMarkup(title,intro,contents) {
  return `<div class="admin-section-heading"><div><h2>${h(title)}</h2><p class="small">${h(intro)}</p></div></div>
    <p data-management-notice class="staff-notice" role="status" hidden></p>${contents}`;
}
function busyState(root,busy) {
  root.setAttribute('aria-busy',String(busy));
  root.querySelectorAll('button, select, input, textarea').forEach(button=>{
    if(busy){button.dataset.wasDisabled=String(button.disabled);button.disabled=true;}
    else if(button.dataset.wasDisabled!==undefined){button.disabled=button.dataset.wasDisabled==='true';delete button.dataset.wasDisabled;}
  });
}

function needsSignIn(root,result) {
  if (!result?.sign_in_required) return false;
  if (root.isConnected) root.innerHTML=`<section class="staff-panel admin-editor"><h2>${h('manageSaved')}</h2><p>${h('staffSignedOut')}</p><a class="primary" href="./admin.html">${h('signIn')}</a></section>`;
  return true;
}

export function mountOverview(root,api,onNavigate) {
  let revision=0;
  root.innerHTML=`<div class="admin-toolbar"><p class="small">${h('manageOverviewIntro')}</p><button class="secondary" type="button" data-overview-refresh>${h('manageRefresh')}</button></div><p data-management-notice class="staff-notice" role="status" hidden></p><div data-overview-content></div>`;
  async function load() {
    if (!root.isConnected) return;
    const current=++revision; busyState(root,true);notice(root,t('manageLoading'));
    try {
      const data=await api('/staff/overview');
      if(current!==revision||!root.isConnected)return;
      const {counts={},percentages={},garage_statuses={},booking_statuses={},ticket_statuses={}}=data;
      const metrics=[['manageUsers',counts.users,'accounts'],['manageGarages',counts.garages,'garages'],['manageBookings',counts.reservations,'reservations'],['managePending',counts.pending_garages,'garages'],['manageOpenTickets',counts.open_tickets,'support']];
      const shares=[['manageApprovedRate',percentages.approved_garages,garage_statuses.approved,sum(garage_statuses)],['manageConfirmedRate',percentages.confirmed_bookings,booking_statuses.confirmed,sum(booking_statuses)],['manageCancelledRate',percentages.cancelled_bookings,booking_statuses.cancelled,sum(booking_statuses)],['manageResolvedRate',percentages.resolved_tickets,ticket_statuses.resolved,sum(ticket_statuses)]];
      root.querySelector('[data-overview-content]').innerHTML=`<div class="admin-metrics">${metrics.map(([label,value,target])=>`<button class="admin-metric" type="button" data-overview-target="${target}"><span>${h(label)}</span><strong>${esc(number(value))}</strong><small>${h('manageInspect')} →</small></button>`).join('')}</div>
      <div class="admin-split"><section class="staff-panel"><h3>${h('managePercentTitle')}</h3><p class="small">${h('manageRatesNote')}</p><div class="admin-chart-list">${shares.map(([label,percentage,count,total])=>{
        const value=Math.max(0,Math.min(100,Number(percentage)||0));
        return `<div class="admin-share"><div class="admin-share-heading"><span>${h(label)}</span><strong>${esc(new Intl.NumberFormat(locale(),{style:'percent',maximumFractionDigits:1}).format(value/100))}</strong></div><progress class="admin-progress" max="100" value="${value}" aria-label="${h(label)}"></progress><small>${h('manageDenominator',{count:number(count),total:number(total)})}</small></div>`;
      }).join('')}</div></section><div class="admin-stack"><section class="staff-panel admin-value-card"><h3>${h('manageBookingValue')}</h3><strong>${esc(money(data.confirmed_booking_value_cents))}</strong><p class="small">${h('manageValueNote')}</p></section><section class="staff-panel"><h3>${h('manageQuickActions')}</h3><div class="admin-actions"><button type="button" class="primary" data-overview-target="garages">${h('manageReviewGarages')} · ${esc(number(counts.pending_garages))}</button><button type="button" class="secondary" data-overview-target="support">${h('manageSupport')} · ${esc(number(counts.open_tickets))}</button></div></section></div></div>
      <section class="staff-panel admin-activity"><h3>${h('manageActivity')}</h3>${data.recent_activity?.length?`<ol>${data.recent_activity.map(row=>`<li><div><strong>${esc(String(row.action).replaceAll('_',' '))}</strong><small>${h('manageActor',{name:row.actor_name||t('manageSystem')})}</small></div><time datetime="${esc(new Date(row.created_at).toISOString())}">${esc(dateLabel(row.created_at))}</time></li>`).join('')}</ol>`:`<p class="small">${h('manageNoActivity')}</p>`}</section>
      <p class="small">${h('manageUpdated',{date:dateLabel(data.generated_at||Date.now())})}</p>`;
      notice(root);
    } catch(error){if(current===revision&&root.isConnected)errorNotice(root,error);}
    finally{if(current===revision&&root.isConnected)busyState(root,false);}
  }
  root.addEventListener('click',event=>{
    if(event.target.closest('[data-overview-refresh]'))load();
    const target=event.target.closest('[data-overview-target]');if(target)onNavigate(target.dataset.overviewTarget);
  });
  load();
}

export function mountAccounts(root,api) {
  let offset=0, query='', rows=[], revision=0, busy=false, editingUser=null;
  root.innerHTML=baseMarkup('manageAccounts','manageAccountIntro',`<div class="admin-toolbar"><form data-account-search class="admin-search"><label class="field">${h('manageSearch')}<input name="q" type="search" maxlength="120"></label><button type="submit" class="secondary">${h('manageFilter')}</button></form><button type="button" class="primary" data-management-action="create">+ ${h('manageAddAccount')}</button></div><p class="small">${h('manageRemoveNote')}</p><div data-account-editor></div><div data-account-list></div>${pagination()}`);
  function editor(user=null) {
    editingUser=user?{...user}:null;
    root.querySelector('[data-account-editor]').innerHTML=`<section class="staff-panel admin-editor"><div class="service-heading"><h3>${h(user?'manageAccountEdit':'manageAddAccount')}</h3><button class="text-button" type="button" data-management-action="close">${h('manageClose')}</button></div><form data-account-form class="form" ${user?`data-id="${esc(user.id)}"`:''}><label class="field">${h('manageName')}<input name="name" minlength="2" maxlength="80" value="${esc(user?.name||'')}" required autocomplete="off"></label><label class="field">${h('manageEmail')}<input type="email" name="email" maxlength="190" value="${esc(user?.email||'')}" autocomplete="off" required></label>${user?'':`<label class="field">${h('managePassword')}<input type="password" name="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><p class="small">${h('managePasswordNote')}</p>`}<div class="admin-actions"><button class="primary" type="submit">${h(user?'manageSave':'manageAddAccount')}</button><button class="secondary" type="button" data-management-action="close">${h('manageCancel')}</button></div></form></section>`;
    root.querySelector('[data-account-form] input').focus();
  }
  async function load() {
    if (!root.isConnected) return;
    const current=++revision;notice(root,t('manageLoading'));
    const data=await api('/staff/users?'+new URLSearchParams({q:query,offset:String(offset)}));
    if(current!==revision||!root.isConnected)return;
    rows=data.users;
    root.querySelector('[data-account-list]').innerHTML=rows.length?`<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>${h('manageName')}</th><th>${h('manageRole')}</th><th>${h('manageCreated')}</th><th>${h('manageGarages')} / ${h('manageBookings')}</th><th>${h('manageActions')}</th></tr></thead><tbody>${rows.map(user=>`<tr><td><strong>${esc(user.name)}</strong><small><bdi>${esc(user.email)}</bdi></small></td><td><label class="sr-only" for="role-${esc(user.id)}">${h('manageRole')} · ${esc(user.email)}</label><select id="role-${esc(user.id)}" data-account-role="${esc(user.id)}">${options(roles,user.role,'manageRole_')}</select></td><td>${esc(dateLabel(user.created_at))}</td><td>${esc(number(user.garage_count))} / ${esc(number(user.reservation_count))}</td><td><div class="admin-actions"><button class="secondary" type="button" data-management-action="edit" data-id="${esc(user.id)}">${h('manageEdit')}</button><button class="text-button admin-danger" type="button" data-management-action="remove" data-id="${esc(user.id)}">${h('manageRemove')}</button></div></td></tr>`).join('')}</tbody></table></div>`:`<div class="admin-empty"><p>${h('manageNoAccounts')}</p></div>`;
    updatePagination(root,offset,data.has_more);notice(root);
  }
  async function perform(action) {
    if(busy||!root.isConnected)return;busy=true;busyState(root,true);
    try{await action();}catch(error){if(root.isConnected)errorNotice(root,error);}
    finally{busy=false;if(root.isConnected)busyState(root,false);}
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-management-action]');if(!button||button.disabled||busy)return;
    const action=button.dataset.managementAction,user=rows.find(row=>row.id===button.dataset.id);
    if(action==='close'){editingUser=null;root.querySelector('[data-account-editor]').innerHTML='';return;}
    if(action==='create'){editor();return;}
    if(action==='edit'){editor(user);return;}
    perform(async()=>{
      if(action==='remove'){
        if(!user||!window.confirm(t('manageRemoveConfirm')))return;
        await api(`/staff/users/${user.id}/remove`,'POST',{expected_email:user.email});
        if(!root.isConnected)return;
        if(editingUser?.id===user.id){editingUser=null;root.querySelector('[data-account-editor]').innerHTML='';}
      }
      if(action==='next')offset+=25;
      if(action==='previous')offset=Math.max(0,offset-25);
      await load();if(action==='remove')notice(root,t('manageRemoved'));
    });
  });
  root.addEventListener('change',event=>{
    const select=event.target.closest('[data-account-role]');if(!select)return;
    const user=rows.find(row=>row.id===select.dataset.accountRole),role=select.value;
    if(busy||!user||!window.confirm(t('manageRoleConfirm'))){if(user)select.value=user.role;return;}
    perform(async()=>{
      try{const result=await api(`/staff/users/${user.id}/role`,'POST',{role,expected_role:user.role});if(!root.isConnected||needsSignIn(root,result))return;await load();notice(root,t('manageSaved'));}
      catch(error){select.value=user.role;throw error;}
    });
  });
  root.addEventListener('submit',event=>{
    const form=event.target;if(!form.matches('[data-account-search],[data-account-form]'))return;
    event.preventDefault();event.stopPropagation();if(!form.reportValidity()||busy)return;
    const data=Object.fromEntries(new FormData(form));
    perform(async()=>{
      if(form.matches('[data-account-search]')){query=data.q.trim();offset=0;await load();return;}
      const user=editingUser;
      const result=user?await api(`/staff/users/${user.id}/update`,'POST',{...data,expected_name:user.name,expected_email:user.email}):await api('/staff/users','POST',data);
      if(!root.isConnected||needsSignIn(root,result))return;
      editingUser=null;root.querySelector('[data-account-editor]').innerHTML='';await load();notice(root,t(user?'manageSaved':'manageCreatedAccount'));
    });
  });
  perform(load);
}

export function mountReservations(root,api) {
  let offset=0,query='',status='all',rows=[],revision=0,busy=false,cancellingReservation=null;
  root.innerHTML=baseMarkup('manageReservations','manageBookingIntro',`<form data-reservation-filter class="admin-toolbar"><label class="field">${h('manageSearch')}<input name="q" type="search" maxlength="120"></label><label class="field">${h('manageStatus')}<select name="status"><option value="all">${h('manageAll')}</option>${options(statuses,'all','manageReservation_')}</select></label><button class="secondary" type="submit">${h('manageFilter')}</button></form><div data-reservation-editor></div><div data-reservation-list></div>${pagination()}`);
  function cancelEditor(row) {
    cancellingReservation={...row};
    root.querySelector('[data-reservation-editor]').innerHTML=`<section class="staff-panel admin-editor"><h3>${h('manageBookingCancel')}</h3><p>${esc(row.garage_name)} · ${esc(row.guest_name)}</p><p class="small"><bdi>${esc(row.id)}</bdi></p><form data-reservation-cancel data-id="${esc(row.id)}" class="form"><label class="field">${h('manageCancelReason')}<textarea name="reason" minlength="5" maxlength="300" rows="3" required></textarea></label><div class="admin-actions"><button type="submit" class="primary">${h('manageBookingCancel')}</button><button type="button" class="secondary" data-management-action="close">${h('manageClose')}</button></div></form></section>`;
    root.querySelector('textarea').focus();
  }
  async function load() {
    if (!root.isConnected) return;
    const current=++revision;notice(root,t('manageLoading'));
    const data=await api('/staff/reservations?'+new URLSearchParams({q:query,status,offset:String(offset)}));
    if(current!==revision||!root.isConnected)return;rows=data.reservations;
    root.querySelector('[data-reservation-list]').innerHTML=rows.length?`<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>${h('manageGarage')}</th><th>${h('manageGuest')}</th><th>${h('manageDates')}</th><th>${h('manageTotal')}</th><th>${h('manageStatus')}</th><th>${h('manageActions')}</th></tr></thead><tbody>${rows.map(row=>`<tr><td><strong>${esc(row.garage_name)}</strong><small>${h('manageHost')}: ${esc(row.owner_name)}</small><details><summary>${h('manageReference')}</summary><small><bdi>${esc(row.id)}</bdi></small></details></td><td>${esc(row.guest_name)}<small><bdi>${esc(row.guest_email)}</bdi></small></td><td>${esc(dateLabel(row.starts_at))}<small>→ ${esc(dateLabel(row.ends_at))} · ${h(row.mode)}</small></td><td>${esc(money(row.total_cents))}</td><td><span class="admin-status admin-status-${esc(row.status)}">${h('manageReservation_'+row.status)}</span>${row.status==='cancelled'&&row.last_cancel_reason?`<details><summary>${h('manageCancelReason')}</summary><p class="small">${esc(row.last_cancel_reason)}</p>${row.cancelled_at?`<small>${esc(dateLabel(row.cancelled_at))}</small>`:''}</details>`:''}</td><td>${['confirmed','requested','countered'].includes(row.status)&&row.starts_at>Date.now()?`<button type="button" class="text-button admin-danger" data-management-action="cancel" data-id="${esc(row.id)}">${h('manageBookingCancel')}</button>`:`<span class="small">${h('manageNoAction')}</span>`}</td></tr>`).join('')}</tbody></table></div>`:`<div class="admin-empty"><p>${h('manageNoReservations')}</p></div>`;
    updatePagination(root,offset,data.has_more);notice(root);
  }
  async function perform(work){if(busy||!root.isConnected)return;busy=true;busyState(root,true);try{await work();}catch(error){if(root.isConnected)errorNotice(root,error);}finally{busy=false;if(root.isConnected)busyState(root,false);}}
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-management-action]');if(!button||button.disabled||busy)return;
    const action=button.dataset.managementAction;
    if(action==='close'){cancellingReservation=null;root.querySelector('[data-reservation-editor]').innerHTML='';return;}
    if(action==='cancel'){const row=rows.find(row=>row.id===button.dataset.id);if(row)cancelEditor(row);return;}
    perform(async()=>{if(action==='next')offset+=25;if(action==='previous')offset=Math.max(0,offset-25);await load();});
  });
  root.addEventListener('submit',event=>{
    const form=event.target;if(!form.matches('[data-reservation-filter],[data-reservation-cancel]'))return;
    event.preventDefault();event.stopPropagation();if(!form.reportValidity()||busy)return;
    const data=Object.fromEntries(new FormData(form));
    perform(async()=>{
      if(form.matches('[data-reservation-filter]')){query=data.q.trim();status=data.status;offset=0;await load();return;}
      const row=cancellingReservation;if(!row||row.id!==form.dataset.id||!window.confirm(t('manageCancelConfirm')))return;
      await api(`/staff/reservations/${row.id}/cancel`,'POST',{expected_updated_at:row.updated_at,reason:data.reason});
      if(!root.isConnected)return;
      cancellingReservation=null;root.querySelector('[data-reservation-editor]').innerHTML='';await load();notice(root,t('manageCancelled'));
    });
  });
  perform(load);
}
