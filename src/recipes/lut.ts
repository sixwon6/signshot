import { getBase64Decoder } from "@solana/kit";

export type Rgb = [number, number, number];
type RgbTransform = (r: number, g: number, b: number) => Rgb;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** BT.601 to match the renderer's YUV decode. */
export const luma601 = (r: number, g: number, b: number): number =>
  0.299 * r + 0.587 * g + 0.114 * b;

/** amount < 1 desaturates, > 1 saturates, around BT.601 luma. */
export function saturate(rgb: Rgb, amount: number): Rgb {
  const y = luma601(rgb[0], rgb[1], rgb[2]);
  return [mix(y, rgb[0], amount), mix(y, rgb[1], amount), mix(y, rgb[2], amount)];
}

/** Smoothstep-weighted contrast; t = 0 is a no-op, t = 1 is a full smoothstep S-curve. */
export function sCurve(x: number, t: number): number {
  const s = x * x * (3 - 2 * x);
  return mix(x, s, t);
}

/**
 * Identity up to `knee`, then knee + (1 - e^(-rate·(x-knee))) / rate. Slope 1 at the knee, so it
 * only compresses highlights; asymptotic to knee + 1/rate.
 */
export function shoulder(x: number, knee: number, rate: number): number {
  if (x <= knee) return x;
  return knee + (1 - Math.exp(-(x - knee) * rate)) / rate;
}

/** RGBA8 3D LUT (size^3, r fastest), base64. `fn` sees gamma-encoded, display-referred RGB. */
export function buildLut(size: number, fn: RgbTransform): string {
  const bytes = new Uint8Array(size * size * size * 4);
  let o = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        bytes[o++] = Math.round(clamp01(out[0]) * 255);
        bytes[o++] = Math.round(clamp01(out[1]) * 255);
        bytes[o++] = Math.round(clamp01(out[2]) * 255);
        bytes[o++] = 255;
      }
    }
  }
  // Kit's base64 *decoder* turns bytes into text, despite the name.
  return getBase64Decoder().decode(bytes);
}
