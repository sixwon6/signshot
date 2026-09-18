package expo.modules.seekercamera

import android.content.Context
import android.graphics.*
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** A shareable 9:16 invitation. The QR has an unbroken four-module quiet zone. */
internal object PrintCard {
  fun write(ctx: Context, source: File, title: String, count: Int, modules: String, size: Int, name: String): File {
    require(size in 21..177 && modules.length == size * size && modules.all { it == '0' || it == '1' })
    require(title.toByteArray(Charsets.UTF_8).size <= 24 && count in 1..1000)
    val photo = BitmapFactory.decodeFile(source.absolutePath) ?: throw IOException("missing print image")
    val card = Bitmap.createBitmap(1080, 1920, Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(card)
      canvas.drawColor(Color.rgb(239, 237, 225))
      val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(25, 25, 20); textSize = 36f; typeface = Typeface.MONOSPACE }
      canvas.drawText("SIGNSHOT / COLLECT A MOMENT", 70f, 106f, p)
      val scale = minOf(940f / photo.width, 1090f / photo.height)
      val w = photo.width * scale; val h = photo.height * scale
      canvas.drawBitmap(photo, null, RectF((1080-w)/2, 170+(1090-h)/2, (1080+w)/2, 170+(1090+h)/2), Paint(Paint.FILTER_BITMAP_FLAG))
      p.textSize = 52f; canvas.drawText(title, 70f, 1350f, p)
      p.textSize = 30f; canvas.drawText(if (count == 1) "ONE PRINT" else "$count DIGITAL PRINTS", 70f, 1410f, p)
      canvas.drawText(if (count == 1) "SCAN TO VIEW" else "SCAN TO COLLECT", 70f, 1570f, p)
      val unit = 340 / (size + 8)
      val left = 670; val top = 1480
      p.color = Color.WHITE
      canvas.drawRect(left.toFloat(), top.toFloat(), (left+(size+8)*unit).toFloat(), (top+(size+8)*unit).toFloat(), p)
      p.color = Color.BLACK; p.isAntiAlias = false
      for (y in 0 until size) for (x in 0 until size) if (modules[y*size+x] == '1') {
        val a = left + (x+4)*unit; val b = top + (y+4)*unit
        canvas.drawRect(a.toFloat(), b.toFloat(), (a+unit).toFloat(), (b+unit).toFloat(), p)
      }
      val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
      val out = File(dir, "$name-print-card.png")
      val tmp = File(dir, "$name-print-card.png.tmp")
      try {
        FileOutputStream(tmp).use { if (!card.compress(Bitmap.CompressFormat.PNG, 100, it)) throw IOException("card encode failed") }
        if (!tmp.renameTo(out)) throw IOException("card rename failed")
      } finally { tmp.delete() }
      return out
    } finally { photo.recycle(); card.recycle() }
  }
}
