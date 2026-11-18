import { dateLabel, esc, safeImage } from './icons.js';
import { t, locale, language } from './i18n.js';
import { localizeError } from './errors.js';

const h = (key,params) => esc(t(key,params));
const number = value => new Intl.NumberFormat(locale()).format(Number(value)||0);
const statuses = ['pending','under_review','resolved','dismissed'];
const contentTypes = ['garage','message','review'];
const readable = value => typeof value==='string' ? value : '';

function reportEvidence(report) {
  const snapshot=report.evidence?.snapshot || report.evidence || {};
  if(snapshot.expired)return `<p class="notice">${h('reportsEvidenceExpired')}</p>`;
  if(report.target_type==='message'){
    const context=Array.isArray(snapshot.context)?snapshot.context.slice(0,7):[snapshot];
    const senderName=id=>id===report.subject?.id?report.subject.name:id===report.reporter?.id?report.reporter.name:t('reportsOtherParticipant');
    return `<h4>${h('reportsContext')}</h4><p class="small">${h('reportsContextInfo')}</p><div class="reports-message-context">${context.map(row=>`<article class="moderation-card ${String(row.seq)===String(report.target_id)?'reports-target-message':''}">
      ${String(row.seq)===String(report.target_id)?`<span class="service-badge">${h('reportsReportedMessage')}</span>`:''}
      <strong>${esc(senderName(row.sender_id))}</strong><p class="review-comment">${esc(readable(row.message).slice(0,2000))}</p>
      ${row.created_at?`<small>${esc(dateLabel(row.created_at))}</small>`:''}</article>`).join('')}</div>`;
  }
  if(report.target_type==='garage')return `<article class="moderation-card">${snapshot.image?`<img class="moderation-photo" src="${esc(safeImage(snapshot.image))}" alt="${esc(snapshot.name||'')}">`:''}<h4>${esc(snapshot.name||'')}</h4><p>${esc(snapshot.city||'')} · ${esc(snapshot.area||'')}</p><p class="review-comment">${esc(readable(snapshot.description).slice(0,1500))}</p></article>`;
  if(report.target_type==='review')return `<article class="moderation-card"><strong>${h('reportsRating',{rating:Number(snapshot.rating)||0})}</strong><p class="review-comment">${esc(readable(snapshot.comment).slice(0,1000))}</p>${snapshot.created_at?`<p class="small">${esc(dateLabel(snapshot.created_at))}</p>`:''}</article>`;
  if(report.target_type==='user')return `<article class="moderation-card"><strong>${esc(snapshot.name||report.subject?.name||'')}</strong></article>`;
  return `<p class="small">${h('reportsNoEvidenceText')}</p>`;
}

function availableActions(report) {
  const state=report.subject?.state||'active',expired=Boolean(report.evidence?.expired||report.evidence?.snapshot?.expired);
  const actions=[];
  if(['pending','under_review'].includes(report.status)){
    actions.push('review','dismiss');
    if(!expired){
      if(contentTypes.includes(report.target_type)&&!report.content_removed)actions.push('remove_content');
      if(state!=='deleted')actions.push('warn');
      if(state==='active')actions.push('suspend');
    }
  }
  if(state==='suspended')actions.push('restore');
  if(report.can_restore_content)actions.push('restore_content');
  return actions;
}

export function mountReports(root,api) {
  let offset=0,query='',status='pending',rows=[],selectedId=null,report=null,hasMore=false,busy=false;
  let queueRead=0,detailRead=0;
  const disabledBefore=new WeakMap(),drafts=new Map();
  root.classList.add('reports-admin');
  const alive=()=>root.isConnected;
  root.innerHTML=`<div class="admin-section-heading"><div><h2>${h('reportsTitle')}</h2><p class="small">${h('reportsIntro')}</p></div><button class="secondary" type="button" data-report-action="refresh">${h('reportsRefresh')}</button></div>
    <p class="small reports-privacy">${h('reportsPrivate')}</p><div class="admin-metrics reports-metrics" data-reports-counts></div>
    <form class="admin-toolbar" id="reports-filter-form"><label class="field">${h('reportsSearch')}<input name="q" type="search" maxlength="120"></label><label class="field">${h('reportsStatus')}<select name="status"><option value="all">${h('reportsAll')}</option>${statuses.map(value=>`<option value="${value}" ${value===status?'selected':''}>${h('reportsStatus_'+value)}</option>`).join('')}</select></label><button type="submit" class="secondary">${h('reportsFilter')}</button></form>
    <p class="staff-notice" data-reports-notice role="status" hidden></p><div class="moderation-workspace"><section class="moderation-queue-panel"><div data-reports-queue class="staff-queue" role="region" aria-label="${h('reportsTitle')}" tabindex="0"></div><div class="admin-pagination"><button type="button" class="secondary" data-report-action="previous" disabled>${h('reportsPrevious')}</button><span data-reports-page></span><button type="button" class="secondary" data-report-action="next" disabled>${h('reportsNext')}</button></div></section><section class="moderation-detail" data-reports-detail aria-live="polite" aria-label="${h('reportsEvidence')}"><p class="small">${h('reportsPick')}</p></section></div>`;
  const queue=root.querySelector('[data-reports-queue]'),detail=root.querySelector('[data-reports-detail]');
  function message(value='',error=false){if(!alive())return;const el=root.querySelector('[data-reports-notice]');el.textContent=value;el.hidden=!value;el.classList.toggle('warning',error);}
  function syncNavigation(){if(!alive())return;root.querySelectorAll('[data-report-action="status"]').forEach(button=>button.setAttribute('aria-pressed',String(status===button.dataset.status)));root.querySelector('[data-report-action="previous"]').disabled=busy||offset===0;root.querySelector('[data-report-action="next"]').disabled=busy||!hasMore;root.querySelector('[data-reports-page]').textContent=t('reportsPage',{page:number(offset/25+1)});}
  function setBusy(value){
    busy=value;if(!alive())return;root.setAttribute('aria-busy',String(value));
    root.querySelectorAll('button,input,select,textarea').forEach(control=>{
      if(value){disabledBefore.set(control,control.disabled);control.disabled=true;}
      else if(disabledBefore.has(control)){control.disabled=disabledBefore.get(control);disabledBefore.delete(control);}
    });syncNavigation();
  }
  function paintQueue(){
    queue.innerHTML=rows.length?rows.map(row=>`<button type="button" class="ticket-row moderation-card" data-report-action="open" data-id="${esc(row.id)}" ${selectedId===row.id?'aria-current="true"':''}><span><strong>${esc(row.subject_name||t('reportsType_'+row.target_type))}</strong><small>${h('reportsType_'+row.target_type)} · ${h('reportsReason_'+row.reason)}</small><small>${h('reportsFiled',{date:dateLabel(row.created_at)})}</small></span><span class="service-badge report-status-${esc(row.status)}">${h('reportsStatus_'+row.status)}</span></button>`).join(''):`<p class="small">${h('reportsEmpty')}</p>`;
  }
  function paintDetail(){
    if(!report){detail.innerHTML=`<p class="small">${h('reportsPick')}</p>`;return;}
    const actions=availableActions(report),subject=report.subject||{},reporter=report.reporter||{},draft=drafts.get(report.id)||{};
    detail.innerHTML=`<div class="service-heading"><span class="service-badge report-status-${esc(report.status)}">${h('reportsStatus_'+report.status)}</span><span class="small">${h('reportsType_'+report.target_type)}</span></div>
      <h3 tabindex="-1" data-report-title>${esc(subject.name||t('reportsType_'+report.target_type))}</h3><p class="small">${h('reportsReason_'+report.reason)} · ${h('reportsFiled',{date:dateLabel(report.created_at)})}</p>
      <details><summary>${h('reportsReference')}</summary><p class="small"><bdi>${esc(report.id)}</bdi></p><p class="small">${h('reportsContentReference')}: <bdi>${esc(report.target_id)}</bdi></p></details>
      <div class="admin-split"><section><h4>${h('reportsReporter')}</h4><p>${esc(reporter.name||'')}<br><bdi>${esc(reporter.email||'')}</bdi></p></section><section><h4>${h('reportsSubject')}</h4><p>${esc(subject.name||'')}<br><bdi>${esc(subject.email||'')}</bdi></p><p class="small">${h('reportsAccount_'+(subject.state||'active'))}</p></section></div>
      <h4>${h('reportsExplanation')}</h4><p class="review-comment">${report.explanation?esc(report.explanation):h('reportsNoExplanation')}</p>
      <h4>${h('reportsEvidence')}</h4>${reportEvidence(report)}
      ${report.review_note?`<details><summary>${h('reportsPreviousNote')}</summary><p class="review-comment">${esc(report.review_note)}</p></details>`:''}
      ${actions.length?`<form class="form" id="report-decision-form" data-id="${esc(report.id)}"><h4>${h('reportsDecision')}</h4><label class="field">${h('reportsChooseAction')}<select name="action" required><option value="">${h('reportsChooseAction')}</option>${actions.map(action=>`<option value="${action}" ${draft.action===action?'selected':''}>${h('reportsAction_'+action)}</option>`).join('')}</select></label>${report.can_restore_content?`<p class="small">${h('reportsRestoreContentHint')}</p>`:''}<label class="field">${h('reportsDecisionNote')}<textarea name="note" rows="4" minlength="3" maxlength="1000" required>${esc(draft.note||'')}</textarea><small>${h('reportsDecisionHint')}</small></label>${draft.note||draft.action?`<p class="small" data-report-draft>${h('reportsDraftRetained')}</p>`:''}<div class="form-error" role="alert" tabindex="-1" hidden></div><button class="primary" type="submit">${h('reportsSubmit')}</button></form>`:`<p class="notice">${h('reportsClosed')}</p>`}`;
  }
  async function loadQueue(){
    if(!alive())return;const revision=++queueRead;
    try {
      const data=await api('/staff/reports?'+new URLSearchParams({status,q:query,offset:String(offset)}));
      if(!alive()||revision!==queueRead)return;
      rows=data.reports;hasMore=data.has_more;
      root.querySelector('[data-reports-counts]').innerHTML=statuses.map(value=>`<button type="button" class="admin-metric" data-report-action="status" data-status="${value}" aria-pressed="${status===value}"><span>${h('reportsStatus_'+value)}</span><strong>${esc(number(data.counts?.[value]))}</strong></button>`).join('');
      paintQueue();syncNavigation();
    } catch(error) {
      if(alive()&&revision===queueRead){
        rows=[];hasMore=false;
        queue.innerHTML=`<p role="alert" class="small">${h('reportsQueueError')}</p><button type="button" class="secondary" data-report-action="retry">${h('reportsRetry')}</button>`;
        syncNavigation();
      }
      throw error;
    }
  }
  function focusDetail(){
    const heading=detail.querySelector('[data-report-title]');
    if(!heading)return;
    heading.focus({preventScroll:true});
    if(window.matchMedia('(max-width:1150px)').matches){
      const header=document.querySelector('.staff-header');
      const pinned=header&&['sticky','fixed'].includes(getComputedStyle(header).position);
      const obstruction=pinned?Math.max(0,header.getBoundingClientRect().bottom):0;
      const target=window.scrollY+heading.getBoundingClientRect().top-obstruction-16;
      window.scrollTo({top:Math.max(0,target),behavior:'instant'});
    }
  }
  async function openReport(id){
    const revision=++detailRead;selectedId=id;report=null;paintQueue();detail.innerHTML=`<p>${h('reportsLoading')}</p>`;
    try {
      const result=await api(`/staff/reports/${encodeURIComponent(id)}`);
      if(!alive()||revision!==detailRead||selectedId!==id)return;
      report=result.report;paintDetail();focusDetail();
    } catch(error) {
      if(alive()&&revision===detailRead)detail.innerHTML=`<p class="small">${esc(localizeError(error.message,language()))}</p>`;
      throw error;
    }
  }
  async function perform(work){if(busy||!alive())return;setBusy(true);try{await work();}catch(error){if(alive())message(localizeError(error.message,language()),true);}finally{setBusy(false);}}
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-report-action]');if(!button||button.disabled||busy)return;
    const action=button.dataset.reportAction;
    perform(async()=>{
      message(t('reportsLoading'));
      if(action==='open'){await openReport(button.dataset.id);message();return;}
      if(action==='status'){
        status=button.dataset.status;offset=0;selectedId=null;report=null;detailRead++;paintDetail();root.querySelector('[name=status]').value=status;
      }
      if(action==='previous')offset=Math.max(0,offset-25);
      if(action==='next')offset+=25;
      await loadQueue();
      if(action==='refresh'&&selectedId)await openReport(selectedId);
      message();
    });
  });
  function rememberDraft(event){
    const form=event.target.closest('#report-decision-form');
    if(form)drafts.set(form.dataset.id,{note:form.elements.note.value,action:form.elements.action.value});
  }
  root.addEventListener('input',rememberDraft);
  root.addEventListener('change',rememberDraft);
  root.addEventListener('submit',event=>{
    const form=event.target;if(!['reports-filter-form','report-decision-form'].includes(form.id))return;
    event.preventDefault();event.stopPropagation();if(busy||!form.reportValidity())return;
    const data=Object.fromEntries(new FormData(form));
    const snapshot=report;
    perform(async()=>{
      if(form.id==='reports-filter-form'){
        status=data.status;query=data.q.trim();offset=0;selectedId=null;report=null;detailRead++;paintDetail();message(t('reportsLoading'));await loadQueue();message();return;
      }
      if(!snapshot||snapshot.id!==form.dataset.id||!window.confirm(t('reportsConfirm')))return;
      try{
        const priorError=form.querySelector('.form-error');priorError.hidden=true;priorError.textContent='';
        const result=await api(`/staff/reports/${snapshot.id}/action`,'POST',{action:data.action,note:data.note,expected_status:snapshot.status,expected_updated_at:snapshot.updated_at});
        if(!alive())return;drafts.delete(snapshot.id);report=result.report;selectedId=report.id;paintDetail();focusDetail();message(t('reportsSaved'));
        try{await loadQueue();}catch(error){message(t('reportsSaved')+' '+localizeError(error.message,language()),true);}
      }catch(error){if(alive()&&form.isConnected){const field=form.querySelector('.form-error');field.textContent=localizeError(error.message,language());field.hidden=false;field.focus({preventScroll:true});field.scrollIntoView({block:'nearest'});}else throw error;}
    });
  });
  perform(async()=>{message(t('reportsLoading'));await loadQueue();message();});
}
