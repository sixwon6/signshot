import { getBase64Decoder } from "@solana/kit";

/** The colour half of a recipe: a programmatic 3D LUT builder and the small maths a grade needs. */

export type Rgb = [number, number, number];
type RgbTransform = (r: number, g: number, b: number) => Rgb;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** BT.601 luma, the basis the renderer's YUV decode uses, so luma-keyed grading matches the shader. */
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
 * Builds an RGBA8 3D LUT (size^3, r fastest) and returns it base64-encoded, matching the layout
 * the native lut3d stage uploads. The transform is applied to gamma-encoded, display-referred
 * RGB — that is what the renderer feeds the LUT.
 */
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
  // Kit's "decoder" reads BYTES and yields the encoded text, which is the opposite of the
  // intuition the name invites. This is the base64 path everywhere in the app; there is no
  // Buffer to reach for.
  return getBase64Decoder().decode(bytes);
}
