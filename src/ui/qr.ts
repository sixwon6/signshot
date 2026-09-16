import { create } from 'qrcode/lib/core/qrcode';
/** Core-only import: no Node file writers or browser canvas code enters Android. */
export function qrMatrix(url: string) {
  const qr = create(url, { errorCorrectionLevel: 'M' });
  return { size: qr.modules.size, modules: Array.from(qr.modules.data, n => n ? '1' : '0').join('') };
}
