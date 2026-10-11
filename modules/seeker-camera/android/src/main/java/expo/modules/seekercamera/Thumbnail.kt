package expo.modules.seekercamera

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The public print image: at most 96 KiB (free upload size), no EXIF. Idempotent by content because
 * the upload's data item id is derived from these bytes.
 */
internal object Thumbnail {

  /** 96 KiB — under `dataItem.ts`'s 100 KiB item cap, itself under the provider's 105 KiB. */
  const val MAX_BYTES = 98_304

  class Result(val file: File, val sha256: String, val bytes: Int)

  /** Readable image header? A failed bounds decode leaves `outWidth`/`outHeight` at -1. */
  private fun decodes(file: File): Boolean {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    return bounds.outWidth > 0 && bounds.outHeight > 0
  }

  fun printImage(styled: File, out: File): Result {
    // Reuse an existing print only if it decodes: a truncated JPEG would publish -1 dimensions.
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

  /** Decodes `styled` scaled to `longEdge` for `body`; both bitmaps are recycled on every path. */
  private fun <T> withScaled(styled: File, longEdge: Int, body: (Bitmap) -> T): T {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(styled.absolutePath, bounds)
    val srcW = bounds.outWidth
    val srcH = bounds.outHeight
    if (srcW <= 0 || srcH <= 0) throw IOException("could not read ${styled.name}")

    // Largest power-of-two subsample that keeps the long edge >= target: never an upscale.
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

  /** Scratch file before the rename; SeekerCameraModule's cleanup uses the same name. */
  fun tmpFor(out: File): File = File(out.parentFile, "${out.name}.tmp")

  /** `src` with its long edge at `longEdge`, or `src` itself if already no larger. */
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
