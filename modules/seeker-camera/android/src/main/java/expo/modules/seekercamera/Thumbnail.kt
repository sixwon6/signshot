package expo.modules.seekercamera

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The public print image: under 96 KiB so the upload stays within the free item size, no EXIF (fresh
 * `Bitmap.compress`), decoded with `inSampleSize`. Idempotent by content, because the upload's data
 * item id is derived from these exact bytes.
 */
internal object Thumbnail {

  /** 96 KiB — under `dataItem.ts`'s 100 KiB item cap, itself under the provider's 105 KiB. */
  const val MAX_BYTES = 98_304

  class Result(val file: File, val sha256: String, val bytes: Int)

  /**
   * Does this file have a readable image header? `inJustDecodeBounds` allocates no bitmap — it
   * only fills `outWidth`/`outHeight`, which are left at -1 when the header cannot be read
   * (https://developer.android.com/topic/performance/graphics/load-bitmap).
   */
  private fun decodes(file: File): Boolean {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    return bounds.outWidth > 0 && bounds.outHeight > 0
  }

  fun printImage(styled: File, out: File): Result {
    // Reuse an existing print only if it also decodes: a truncated JPEG would yield -1 dimensions
    // in published metadata. A bounds decode is cheap; anything else is re-rendered.
    if (out.isFile && out.length() in 1..MAX_BYTES.toLong() && decodes(out)) {
      return Result(out, CaptureIntegrity.sha256(out), out.length().toInt())
    }
    for (edge in listOf(1600, 1280, 1024, 800, 640, 512)) {
      val encoded = withScaled(styled, edge) { scaled ->
        var chosen: ByteArray? = null
        for (quality in listOf(85, 75, 65)) {
          val stream = ByteArrayOutputStream()
          if (!scaled.compress(Bitmap.CompressFormat.JPEG, quality, stream)) throw IOException("print encode failed")
          if (stream.size() <= MAX_BYTES) { chosen = stream.toByteArray(); break }
        }
        chosen
      }
      if (encoded != null) {
        val tmp = tmpFor(out)
        try {
          FileOutputStream(tmp).use { it.write(encoded); it.fd.sync() }
          if (!tmp.renameTo(out)) throw IOException("print rename failed")
        } finally { tmp.delete() }
        return Result(out, CaptureIntegrity.sha256(out), encoded.size)
      }
    }
    throw IOException("This photo cannot fit in the publication size limit")
  }

  /**
   * Decodes `styled` subsampled, scales it to `longEdge` and hands the bitmap to `body`. Both
   * bitmaps are recycled before this returns, on every path — the caller encodes inside `body`
   * and keeps only bytes, so nothing may outlive it.
   */
  private fun <T> withScaled(styled: File, longEdge: Int, body: (Bitmap) -> T): T {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(styled.absolutePath, bounds)
    val srcW = bounds.outWidth
    val srcH = bounds.outHeight
    if (srcW <= 0 || srcH <= 0) throw IOException("could not read ${styled.name}")

    // Largest power-of-two subsample that still leaves the long edge at or above the target, so
    // the exact scale below is only ever a downscale of at most 2x and never an upscale.
    var sample = 1
    while (maxOf(srcW, srcH) / (sample * 2) >= longEdge) sample *= 2

    val decoded = BitmapFactory.decodeFile(
      styled.absolutePath,
      BitmapFactory.Options().apply { inSampleSize = sample },
    ) ?: throw IOException("could not decode ${styled.name}")

    val scaled = try {
      scale(decoded, longEdge)
    } catch (e: Throwable) {
      decoded.recycle()
      throw e
    }
    try {
      return body(scaled)
    } finally {
      if (scaled !== decoded) scaled.recycle()
      decoded.recycle()
    }
  }

  /** Scratch file written before the rename; shared with SeekerCameraModule's cleanup so both agree on the name. */
  fun tmpFor(out: File): File = File(out.parentFile, "${out.name}.tmp")

  /** `src` with its long edge at `longEdge`, aspect preserved. `src` itself when it already is. */
  private fun scale(src: Bitmap, longEdge: Int): Bitmap {
    val w = src.width
    val h = src.height
    val long = maxOf(w, h)
    if (long <= longEdge) return src
    val ratio = longEdge.toDouble() / long
    val outW = maxOf(1, Math.round(w * ratio).toInt())
    val outH = maxOf(1, Math.round(h * ratio).toInt())
    return Bitmap.createScaledBitmap(src, outW, outH, true)
  }
}
