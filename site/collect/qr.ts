import { create } from 'qrcode/lib/core/qrcode';
/** Core-only import: keeps qrcode's Node file writers and canvas renderer out of the bundle. */
export function qrMatrix(url: string) {
  const qr = create(url, { errorCorrectionLevel: 'M' });
  return { size: qr.modules.size, modules: Array.from(qr.modules.data, n => n ? '1' : '0').join('') };
}
