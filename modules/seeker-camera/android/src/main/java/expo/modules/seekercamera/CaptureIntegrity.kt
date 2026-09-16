package expo.modules.seekercamera

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

/**
 * Streams a file's current SHA-256, so frames can be checked against their capture-time hashes.
 * Callers enforce path confinement.
 */
internal object CaptureIntegrity {

  /** 1 MiB: a still is up to 4 MiB and this runs on the export thread, never the UI thread. */
  private const val BUFFER_BYTES = 1 shl 20

  fun sha256(file: File): String {
    if (!file.isFile) throw IOException("missing frame: ${file.name}")
    return FileInputStream(file).use { sha256(it) }
  }

  /** The caller owns and closes the stream. */
  fun sha256(stream: InputStream, bufferBytes: Int = BUFFER_BYTES): String {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(bufferBytes)
    while (true) {
      val read = stream.read(buf)
      if (read < 0) break
      md.update(buf, 0, read)
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }
}
