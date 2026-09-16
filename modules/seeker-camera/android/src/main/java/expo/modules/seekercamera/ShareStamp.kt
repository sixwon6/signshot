package expo.modules.seekercamera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Share copies: re-encoded (long edge <= 2048 px) into `cacheDir/share`, optionally with a text stamp
 * in the bottom-right corner. Every share goes through here because `cacheDir/share` is the sharing
 * FileProvider's only root, so the originals in `filesDir/captures` are never exposed.
 */
internal object ShareStamp {
  private const val JPEG_QUALITY = 92
  /** Longest stamp, in code points rather than UTF-16 units. */
  private const val MAX_STAMP_POINTS = 64
  /**
   * Control, zero-width and bidi code points; must match `hasUnsafeText` in
   * `publications/core/details.ts`. Also checked natively because the stamp entry points are public
   * and a bidi override in a stamp could misattribute the picture.
   */
  private val UNSAFE_RANGES = listOf(
    0x0000..0x001f,
    0x007f..0x009f,
    0x00ad..0x00ad,
    0x061c..0x061c,
    0x200b..0x200f,
    0x202a..0x202e,
    0x2028..0x2029,
    0x2060..0x2064,
    0x2066..0x2069,
    0xfeff..0xfeff,
  )
  /** Longest edge of a share copy. Socials re-encode below this anyway; a full 4000×3000 mutable
   *  ARGB decode is ~48 MB, which is more than a share deserves and more than a small heap has. */
  private const val MAX_EDGE = 2048
  /** Room between the stamp's rightmost glyph and the frame edge, and the same below. */
  private const val MARGIN_FRAC = 0.03f
  private val STAMP_COLOR = Color.rgb(0xFF, 0x9A, 0x3C)
  private val HALO_COLOR = Color.argb(0xB0, 0x00, 0x00, 0x00)

  /** Fingerprint-checks the selected version, then writes a share copy of it; `text` is null for a plain share. */
  fun writeSelected(ctx: Context, captures: File, baseName: String, sourceUri: String, expectedHash: String, text: String?): File {
    if (!Regex("[A-Za-z0-9_-]{1,128}").matches(baseName) || !Regex("[a-f0-9]{64}").matches(expectedHash))
      throw IOException("invalid selected photo")
    val stamp = text?.let { assertStampText(it) }
    val source = File(sourceUri.removePrefix("file://")).canonicalFile
    val allowedName = Regex("${Regex.escape(baseName)}-(styled|edit-[a-f0-9]{64}|print(?:-[a-f0-9]{64})?)\\.jpg")
    if (source.parentFile != captures.canonicalFile || !allowedName.matches(source.name) || !source.isFile)
      throw IOException("selected photo is not part of this capture")
    if (CaptureIntegrity.sha256(source) != expectedHash) throw IOException("Selected photo fingerprint changed")
    return write(ctx, source, stamp, "$baseName-$expectedHash-share.jpg")
  }

  /**
   * Returns the trimmed stamp, or throws. Unsafe code points are checked on the raw string, since
   * `trim()` would silently strip C0 controls such as TAB; the trimmed text must be 1-64 code points.
   */
  fun assertStampText(text: String): String {
    var index = 0
    while (index < text.length) {
      val point = text.codePointAt(index)
      if (UNSAFE_RANGES.any { point in it })
        throw IOException("stamp text contains a control, zero-width or bidi character")
      index += Character.charCount(point)
    }
    val stamp = text.trim()
    val points = stamp.codePointCount(0, stamp.length)
    if (points == 0 || points > MAX_STAMP_POINTS)
      throw IOException("stamp text must be 1–$MAX_STAMP_POINTS characters")
    return stamp
  }

  fun write(ctx: Context, source: File, text: String?, outName: String): File {
    // Validated here too, since both entry points reach `write`. Null text draws nothing.
    val stamp = text?.let { assertStampText(it) }
    if (!source.isFile) throw IOException("source missing: ${source.name}")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(source.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("could not read ${source.name}")
    // Power-of-two subsampling down to at most MAX_EDGE on the long side.
    var sample = 1
    while ((maxOf(bounds.outWidth, bounds.outHeight) + sample - 1) / sample > MAX_EDGE) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inMutable = true
      inSampleSize = sample
    }
    val bitmap = BitmapFactory.decodeFile(source.absolutePath, opts)
      ?: throw IOException("could not decode ${source.name}")
    try {
      if (stamp != null) draw(bitmap, stamp)
      val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
      val out = File(dir, outName)
      val tmp = File(dir, "$outName.tmp")
      try {
        FileOutputStream(tmp).use { s ->
          if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, s)) {
            throw IOException("JPEG encode failed for $outName")
          }
        }
        if (out.exists() && !out.delete()) throw IOException("could not replace $outName")
        if (!tmp.renameTo(out)) throw IOException("rename failed for $outName")
      } catch (e: Throwable) {
        runCatching { tmp.delete() }
        throw e
      }
      return out
    } finally {
      bitmap.recycle()
    }
  }

  private fun draw(bitmap: Bitmap, text: String) {
    val w = bitmap.width.toFloat()
    val h = bitmap.height.toFloat()
    // Sized to the frame, not to pixels: the same stamp on a 4000-wide still and a smaller
    // frame should occupy the same share of the picture.
    val margin = w * MARGIN_FRAC
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
      textAlign = Paint.Align.RIGHT
      letterSpacing = 0.08f
    }
    // Start at 2.8% of the width and shrink until the string fits: 64 characters would not fit a
    // narrow frame at that size.
    var textSize = w * 0.028f
    paint.textSize = textSize
    val maxWidth = w - 2 * margin
    while (paint.measureText(text) > maxWidth && textSize > 8f) {
      textSize *= 0.9f
      paint.textSize = textSize
    }
    val x = w - margin
    // Baseline sits so the DESCENDERS clear the margin, not just the baseline.
    val y = h - margin - paint.fontMetrics.descent
    val canvas = Canvas(bitmap)
    // Halo first: a soft dark shadow, then the text. Blur needs a software layer, which a
    // bitmap-backed Canvas is.
    paint.color = HALO_COLOR
    paint.maskFilter = android.graphics.BlurMaskFilter(textSize * 0.25f, android.graphics.BlurMaskFilter.Blur.NORMAL)
    canvas.drawText(text, x, y, paint)
    paint.maskFilter = null
    paint.color = STAMP_COLOR
    canvas.drawText(text, x, y, paint)
  }
}
