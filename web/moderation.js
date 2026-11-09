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
  let offset = 0, revision = 0, busy = false;
  const h = key => esc(t(key));
  root.innerHTML = `<h2>${h('moderationTitle')}</h2><p class="small">${h('moderationIntro')}</p>
    <label class="field">${h('moderationStatus')}<select id="moderation-status">${['pending','approved','rejected','archived'].map(s => `<option value="${s}">${h('moderation_'+s)}</option>`).join('')}</select></label>
    <button type="button" class="secondary" data-mod-action="refresh">${h('moderationRefresh')}</button>
    <p role="status" id="moderation-notice"></p><div id="moderation-list"></div>
    <div class="moderation-pagination"><button type="button" class="secondary" data-mod-action="previous" disabled>${h('moderationPrevious')}</button>
    <button type="button" class="secondary" data-mod-action="next" disabled>${h('moderationNext')}</button></div>`;
  const list = root.querySelector('#moderation-list');
  const status = root.querySelector('#moderation-status');
  const notice = root.querySelector('#moderation-notice');
  const buttons = () => root.querySelectorAll('button');
  function showError(error) { notice.textContent = localizeError(error.message, language()); }
  async function load() {
    const current = ++revision;
    notice.textContent = t('moderationLoading');
    const result = await api(`/staff/garages?status=${status.value}&offset=${offset}`);
    if (current !== revision || !root.isConnected) return;
    list.innerHTML = result.garages.length ? result.garages.map(g => `<article class="moderation-card">
      <h3>${esc(g.name)}</h3><p>${esc(g.owner_name)} · <bdi>${esc(g.owner_email)}</bdi></p>
      <p>${esc(g.city)} · ${esc(g.area)} · ${esc(g.address)}</p><p><bdi>${esc(g.latitude)}, ${esc(g.longitude)}</bdi></p>
      <p>${esc(g.description)}</p><p>${esc(g.hourly_cents/100)} MAD / ${h('hour')} · ${esc(g.monthly_cents/100)} MAD / ${h('month')}</p>
      <p>${h('height')}: ${esc(g.height_cm)} cm · ${h(g.vehicle_size)} · ${h(g.covered ? 'covered' : 'outdoor')}</p>
      ${g.status === 'pending' ? `<form class="form moderation-form" data-garage="${esc(g.id)}">
        <label class="field">${h('moderationPhoto')}<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label>
        <img class="moderation-photo" alt="${h('moderationPreview')}" hidden>
        <label class="staff-checkbox"><input name="confirmed" type="checkbox" required> ${h('moderationConfirm')}</label>
        <button type="submit" class="primary">${h('moderationApprove')}</button>
      </form><button type="button" class="secondary" data-mod-action="reject" data-id="${esc(g.id)}">${h('moderationReject')}</button>` : ''}
      ${g.status === 'approved' ? `<button type="button" class="secondary" data-mod-action="archive" data-id="${esc(g.id)}">${h('moderationArchive')}</button>` : ''}
      </article>`).join('') : `<p>${h('moderationEmpty')}</p>`;
    root.querySelector('[data-mod-action="previous"]').disabled = offset === 0;
    root.querySelector('[data-mod-action="next"]').disabled = !result.has_more;
    notice.textContent = '';
  }
  async function perform(work) {
    if (busy) return;
    busy = true; status.disabled = true;
    buttons().forEach(b => { b.disabled = true; });
    try { await work(); } catch (error) { showError(error); }
    finally {
      busy = false; status.disabled = false;
      // Navigation state is reset by load; only unlock action buttons here.
      buttons().forEach(b => { if (!['previous','next'].includes(b.dataset.modAction)) b.disabled = false; });
    }
  }
  status.addEventListener('change', () => { offset = 0; perform(load); });
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-mod-action]');
    if (!button || button.disabled || busy) return;
    perform(async () => {
      const action = button.dataset.modAction;
      if (['reject','archive'].includes(action)) {
        if (!window.confirm(t('moderationActionConfirm'))) return;
        await api(`/staff/garages/${button.dataset.id}/${action}`, 'POST', {expected_status:status.value});
      }
      if (action === 'next') offset += 25;
      if (action === 'previous') offset = Math.max(0, offset - 25);
      await load();
      if (['reject','archive'].includes(action)) notice.textContent = t('moderationSaved');
    });
  });
  root.addEventListener('change', event => {
    if (event.target.name !== 'photo') return;
    const input = event.target, image = input.form.querySelector('img');
    image.hidden = true; image.removeAttribute('src');
    const file = input.files[0];
    if (file && file.size <= 10*1024*1024 && ['image/jpeg','image/png','image/webp'].includes(file.type)) {
      const reader = new FileReader();
      reader.onload = () => { if (input.files[0] === file) { image.src = reader.result; image.hidden = false; } };
      reader.readAsDataURL(file);
    }
  });
  root.addEventListener('submit', event => {
    const form = event.target.closest('.moderation-form');
    if (!form) return;
    event.preventDefault(); event.stopPropagation();
    if (!form.reportValidity()) return;
    perform(async () => {
      const photo_base64 = await prepareModerationPhoto(form.elements.photo.files[0]);
      await api(`/staff/garages/${form.dataset.garage}/approve`, 'POST', {expected_status:'pending',confirmed:true,photo_base64});
      await load(); notice.textContent = t('moderationSaved');
    });
  });
  perform(load);
}
