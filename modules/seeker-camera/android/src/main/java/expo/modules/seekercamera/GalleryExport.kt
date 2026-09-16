package expo.modules.seekercamera

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * Copies a JPEG into `Pictures/Seedshot` via scoped MediaStore (pending row, stream, clear
 * IS_PENDING) and returns its `content://` URI. Not safe to run concurrently for the same display
 * name, so it is only called from SeekerCameraModule's single export thread.
 */
internal object GalleryExport {
  private const val TAG = "SeekerCamera"
  private const val ALBUM = "Seedshot"
  private const val MIME = "image/jpeg"
  private const val HASH_BUFFER_BYTES = 64 * 1024

  /** `Pictures/Seedshot/`. MediaStore stores RELATIVE_PATH with a trailing slash. */
  private val RELATIVE_PATH = "${Environment.DIRECTORY_PICTURES}/$ALBUM/"

  fun export(ctx: Context, source: File, displayName: String): Uri {
    if (!source.isFile) throw IOException("source missing: ${source.name}")
    val sourceSha = FileInputStream(source).use { CaptureIntegrity.sha256(it, HASH_BUFFER_BYTES) }
    return exportScoped(ctx, source, sourceSha, displayName)
  }

  private fun exportScoped(ctx: Context, source: File, sourceSha: String, displayName: String): Uri {
    val resolver = ctx.contentResolver
    val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    // Existing rows with this name in our album, pending ones included: a pending row is a copy
    // that never finished (process died between insert and the IS_PENDING=0 update).
    for (row in findRows(resolver, collection, displayName)) {
      val uri = ContentUris.withAppendedId(collection, row.id)
      if (row.pending) {
        Log.w(TAG, "removing stale pending export $displayName")
        // Best effort: a pending row that is somehow not ours cannot be deleted, and is not
        // the copy we are about to write either way.
        runCatching { resolver.delete(uri, null, null) }
        continue
      }
      val existingSha = try {
        resolver.openInputStream(uri)?.use { CaptureIntegrity.sha256(it, HASH_BUFFER_BYTES) }
      } catch (e: Throwable) {
        null
      }
      if (existingSha == sourceSha) return uri
      // Same name, different bytes: not ours to overwrite. Fall through and insert; MediaStore
      // will disambiguate the display name.
      Log.w(TAG, "gallery row $displayName exists with different content; writing a new copy")
    }

    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
      put(MediaStore.Images.Media.MIME_TYPE, MIME)
      put(MediaStore.Images.Media.RELATIVE_PATH, RELATIVE_PATH)
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val uri = resolver.insert(collection, values)
      ?: throw IOException("MediaStore insert failed for $displayName")
    try {
      val out = resolver.openOutputStream(uri, "wt")
        ?: throw IOException("MediaStore gave no output stream for $displayName")
      out.use { o -> FileInputStream(source).use { i -> i.copyTo(o) } }
      // Read back before publishing: a copy that does not hash to the source is not the artifact
      // and must not appear in the gallery as if it were.
      val written = resolver.openInputStream(uri)?.use { CaptureIntegrity.sha256(it, HASH_BUFFER_BYTES) }
      if (written != sourceSha) throw IOException("gallery copy of $displayName does not match source")
      resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
    } catch (e: Throwable) {
      runCatching { resolver.delete(uri, null, null) }
      throw e
    }
    return uri
  }

  private class Row(val id: Long, val pending: Boolean)

  private fun findRows(resolver: ContentResolver, collection: Uri, displayName: String): List<Row> {
    val projection = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.IS_PENDING)
    val selection = "${MediaStore.Images.Media.DISPLAY_NAME} = ? AND ${MediaStore.Images.Media.RELATIVE_PATH} = ?"
    val args = arrayOf(displayName, RELATIVE_PATH)
    val q = Bundle().apply {
      putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
      putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
      putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE)
    }
    val cursor = resolver.query(collection, projection, q, null)
    val out = ArrayList<Row>()
    cursor?.use { c ->
      val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
      val pendingCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.IS_PENDING)
      while (c.moveToNext()) out.add(Row(c.getLong(idCol), c.getInt(pendingCol) != 0))
    }
    return out
  }

}
