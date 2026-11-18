import { t } from './i18n.js';

// Only called on WebP bytes produced by the browser's own image encoder.
export function stripWebpMetadata(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error(t('hostPhotoError'));
    const length = view.getUint32(offset + 4, true);
    const next = offset + 8 + length + (length % 2);
    if (next > bytes.length) throw new Error(t('hostPhotoError'));
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

export async function prepareListingPhoto(file, options = {}) {
  const errorKey = options.errorKey || 'hostPhotoError';
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 10*1024*1024) throw new Error(t(errorKey));
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(t(errorKey)); }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error(t(errorKey));
    const dimension = Math.min(1920, Math.max(320, Number(options.maxDimension) || 1920));
    const ratio = Math.min(1, dimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t(errorKey));
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
    if (!blob || blob.type !== 'image/webp' || blob.size > 5*1024*1024) throw new Error(t(errorKey));
    blob = stripWebpMetadata(await blob.arrayBuffer());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error(t(errorKey)));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    if (error.message === t(errorKey)) throw error;
    throw new Error(t(errorKey));
  } finally { bitmap.close(); }
}

export const prepareModerationPhoto = file => prepareListingPhoto(file, {errorKey:'moderationPhotoError'});
