package expo.modules.seekercamera

import android.app.Activity
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

class SeekerCameraModule : Module() {
  companion object {
    @Volatile var activeView: SeekerCameraView? = null
    // Re-applied by a rebuilt view so native state matches JS after a tab switch.
    @Volatile var lastProfile: Profile? = null
    @Volatile var lastIntensity: Float = 0.6f
    /** Last accepted capture settings, re-applied the same way. */
    @Volatile var lastCaptureSettings: String? = null
    private const val TAG = "SeekerCamera"
    private val BASE_NAME = Regex("^cap-[0-9]+$")
    private val SIDECAR_NAME = Regex("^cap-[0-9]+\\.json$")

    // Off the module queue. Single-threaded: gallery export is check-then-write.
    private val EXPORT_EXECUTOR = Executors.newSingleThreadExecutor { r ->
      Thread(r, "SeekerCameraExport").apply { isDaemon = true }
    }

    /** Guards `scanPromise`: `scanQrCode` runs on the module queue, `OnActivityResult` on main. */
    private val SCAN_LOCK = Any()
  }

  /** The one pending `scanQrCode`, handed back by `OnActivityResult`. Read under `SCAN_LOCK`. */
  private var scanPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("SeekerCamera")

    View(SeekerCameraView::class) {
      Events("onSessionError", "onMeter")
    }

    Function("setIntensity") { value: Float ->
      lastIntensity = value.coerceIn(0f, 1f)
      activeView?.setIntensity(value)
    }

    AsyncFunction("applyProfile") { manifestJson: String, lutBase64: String?, promise: Promise ->
      val view = activeView ?: run { promise.reject(CodedException("no active camera view")); return@AsyncFunction }
      val parsed = try {
        Profile.parse(manifestJson, lutBase64)
      } catch (e: Throwable) {
        promise.reject(CodedException(e.message ?: "profile parse failed")); return@AsyncFunction
      }
      lastProfile = parsed
      view.renderer.applyProfile(parsed) { err, pipelineId ->
        if (err == null) promise.resolve(pipelineId) else promise.reject(CodedException(err))
      }
    }

    /** Camera "0" manual-control ranges; no view needed. An absent range is `"unavailable"`. */
    AsyncFunction("captureCapabilities") { promise: Promise ->
      val view = activeView
      val caps = view?.camera?.capabilities() ?: run {
        val ctx = appContext.reactContext ?: run {
          promise.reject(CodedException("no react context")); return@AsyncFunction
        }
        CaptureCaps.read(ctx, "0")
      }
      promise.resolve(jsonToMap(caps.toJson()))
    }

    /** Resolves the clamped values in force; rejects only for a control this camera lacks. */
    AsyncFunction("setCaptureSettings") { json: String, promise: Promise ->
      val view = activeView ?: run { promise.reject(CodedException("no active camera view")); return@AsyncFunction }
      val effective = try {
        view.camera.setSettings(json)
      } catch (e: Throwable) {
        promise.reject(CodedException(e.message ?: "capture settings refused")); return@AsyncFunction
      }
      lastCaptureSettings = json
      promise.resolve(jsonToMap(effective.toJson()))
    }

    AsyncFunction("capture") { promise: Promise ->
      val view = activeView ?: run { promise.reject(CodedException("no active camera view")); return@AsyncFunction }
      view.captureToFiles { r ->
        r.fold({ out ->
          promise.resolve(mapOf(
            "baseName" to out.baseName,
            "cleanUri" to "file://${out.cleanPath}",
            "styledUri" to "file://${out.styledPath}",
            "cleanSha256" to out.cleanSha256,
            "styledSha256" to out.styledSha256,
            "captureResult" to out.captureResultJson,
            "capturePipelineId" to view.renderer.capturePipelineId,
            "totalMs" to out.totalMs,
          ))
        }, { e -> promise.reject(CodedException(e.message ?: "capture failed")) })
      }
    }

    AsyncFunction("listCaptures") { promise: Promise ->
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val files = dir.listFiles { f: File -> f.isFile && SIDECAR_NAME.matches(f.name) } ?: emptyArray()
      val out = files.mapNotNull { f ->
        try {
          val rec = jsonToMap(JSONObject(f.readText())).toMutableMap()
          // JS trusts these CaptureRecord fields, so a partial record is skipped here.
          val clean = frameOrNull(rec["clean"])
          val styled = frameOrNull(rec["styled"])
          if (rec["baseName"] !is String ||
            clean == null ||
            styled == null ||
            rec["captureResult"] !is Map<*, *> ||
            !isIntLike(rec["intensity"])
          ) {
            Log.w(TAG, "skipping malformed sidecar ${f.name}")
            return@mapNotNull null
          }
          rec["cleanUri"] = "file://" + (clean["path"] as String)
          rec["styledUri"] = "file://" + (styled["path"] as String)
          rec
        } catch (e: Throwable) {
          Log.w(TAG, "skipping unreadable sidecar ${f.name}", e)
          null
        }
      }.sortedByDescending { (it["capturedAtMs"] as? Number)?.toLong() ?: 0L }
      promise.resolve(out)
    }

    // Writes a separate immutable edit; the captured frames are never touched.
    AsyncFunction("editPhoto") { baseName: String, manifest: String, lut: String?, strength: Int, promise: Promise ->
      if (!BASE_NAME.matches(baseName) || strength !in 0..100) { promise.reject(CodedException("invalid photo edit")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val rec = readSidecarOrNull(File(dir, "$baseName.json")) ?: throw IOException("missing capture")
          val clean = rec.getJSONObject("clean")
          val source = confinedOrNull(dir, clean.getString("path")) ?: throw IOException("missing original")
          val sourceHash = CaptureIntegrity.sha256(source)
          if (sourceHash != clean.getString("sha256")) throw IOException("Original photo fingerprint changed")
          val profile = Profile.parse(manifest, lut)
          val graph = ShaderGen.editedFragmentSrc(profile)
          // The export policy is part of the edit id, so edits under another policy are never reused.
          val pipeline = "edit-rgb/2-full-size/" + ShaderGen.capturePipelineId(profile, graph)
          val editId = Profile.sha256Hex("$sourceHash\n$pipeline\n$strength".toByteArray())
          val out = File(dir, "$baseName-edit-$editId.jpg")
          val temp = File(dir, "$baseName-edit-$editId.tmp.jpg")
          fun resolve() {
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeFile(out.absolutePath, bounds)
            // Edits can be published: fail on unreadable dimensions, including a reused `out`.
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("invalid photo edit")
            promise.resolve(mapOf("uri" to "file://${out.absolutePath}", "sha256" to CaptureIntegrity.sha256(out),
              "sourceHash" to sourceHash, "pipelineId" to pipeline, "width" to bounds.outWidth, "height" to bounds.outHeight,
              "profileId" to profile.profileId, "profileVersion" to profile.profileVersion, "intensity" to strength))
          }
          if (out.isFile) { resolve(); return@execute }
          val finished = java.util.concurrent.CountDownLatch(1)
          GlRenderer().renderEditedFile(source, profile, strength / 100f, temp) { result ->
            try {
              result.getOrThrow()
              if (!temp.renameTo(out)) throw IOException("Unable to save photo edit")
              resolve()
            } catch (e: Throwable) { temp.delete(); promise.reject(CodedException(e.message ?: "photo edit failed")) }
            finally { finished.countDown() }
          }
          // Holds the export thread so edits and exports stay serialized.
          finished.await()
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "photo edit failed")) }
      }
    }

    AsyncFunction("preparePrintImage") { baseName: String, sourceUri: String, expectedHash: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName) || !Regex("[a-f0-9]{64}").matches(expectedHash)) { promise.reject(CodedException("invalid print source")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val source = confinedOrNull(dir, sourceUri.removePrefix("file://")) ?: throw IOException("missing photo")
          val rec = readSidecarOrNull(File(dir, "$baseName.json")) ?: throw IOException("missing capture")
          val styled = confinedOrNull(dir, rec.getJSONObject("styled").getString("path"))
          if (source != styled && !Regex("${baseName}-edit-[a-f0-9]{64}\\.jpg").matches(source.name)) throw IOException("photo does not belong to capture")
          if (CaptureIntegrity.sha256(source) != expectedHash) throw IOException("Photo fingerprint changed")
          val out = Thumbnail.printImage(source, File(dir, "$baseName-print-$expectedHash.jpg"))
          val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
          android.graphics.BitmapFactory.decodeFile(out.file.absolutePath, bounds)
          // An unreadable header gives -1 dimensions that would be uploaded permanently; fail before the wallet.
          if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("invalid print image")
          promise.resolve(mapOf("path" to out.file.absolutePath, "sha256" to out.sha256, "bytes" to out.bytes, "width" to bounds.outWidth, "height" to bounds.outHeight))
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "print preparation failed")) }
      }
    }

    /** Removes one print derivative and its scratch file, leaving the capture alone. */
    AsyncFunction("deletePrintImage") { baseName: String, sha256: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName) || !Regex("[a-f0-9]{64}").matches(sha256)) { promise.reject(CodedException("invalid print image")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        val out = File(dir, "$baseName-print-$sha256.jpg")
        val existed = out.isFile
        runCatching { out.delete() }
        runCatching { Thumbnail.tmpFor(out).delete() }
        promise.resolve(existed)
      }
    }

    AsyncFunction("sharePrintCard") { baseName: String, sourceHash: String, title: String, count: Int, modules: String, size: Int, by: String?, promise: Promise ->
      if (!BASE_NAME.matches(baseName) || !Regex("[a-f0-9]{64}").matches(sourceHash)) { promise.reject(CodedException("invalid print source")); return@AsyncFunction }
      val ctx = appContext.reactContext ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val out = PrintCard.write(ctx, File(dir, "$baseName-print-$sourceHash.jpg"), title, count, modules, size, "$baseName-$sourceHash", by)
          promise.resolve("file://${out.absolutePath}")
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "card export failed")) }
      }
    }

    /** Copies a fingerprint-checked edit into the gallery as `<base>-edit-<hash12>.jpg`. */
    AsyncFunction("exportEditToGallery") { baseName: String, sourceUri: String, expectedHash: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName) || !Regex("[a-f0-9]{64}").matches(expectedHash)) { promise.reject(CodedException("invalid edit")); return@AsyncFunction }
      val ctx = appContext.reactContext ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val source = confinedOrNull(dir, sourceUri.removePrefix("file://")) ?: throw IOException("missing edit")
          if (!Regex("${baseName}-edit-[a-f0-9]{64}\\.jpg").matches(source.name) || CaptureIntegrity.sha256(source) != expectedHash) throw IOException("Edit fingerprint changed")
          promise.resolve(GalleryExport.export(ctx, source, "$baseName-edit-${expectedHash.take(12)}.jpg").toString())
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "export failed")) }
      }
    }

    /** Copies the styled frame into the gallery as `<base>.jpg`; idempotent by content (see GalleryExport). */
    AsyncFunction("exportToGallery") { baseName: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName)) { promise.reject(CodedException("invalid baseName")); return@AsyncFunction }
      val ctx = appContext.reactContext ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val src = exportSource(dir, baseName)
          val uri = GalleryExport.export(ctx, src.file, src.displayName)
          promise.resolve(uri.toString())
        } catch (e: Throwable) {
          Log.w(TAG, "exportToGallery failed for $baseName", e)
          promise.reject(CodedException(e.message ?: "export failed"))
        }
      }
    }

    /**
     * Unstamped share copy of the selected version, fingerprint-checked and re-encoded into
     * `cacheDir/share`, the sharing FileProvider's only root, so originals are never exposed.
     */
    AsyncFunction("shareCopy") { baseName: String, sourceUri: String, expectedHash: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName)) { promise.reject(CodedException("invalid baseName")); return@AsyncFunction }
      val ctx = appContext.reactContext ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val out = ShareStamp.writeSelected(ctx, dir, baseName, sourceUri, expectedHash, null)
          promise.resolve("file://${out.absolutePath}")
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "share copy failed")) }
      }
    }

    /** Metadata document plus the hash-checked print image as one JSON file in `cacheDir/share`. */
    AsyncFunction("exportPublicationBundle") { baseName: String, sourceUri: String, expectedHash: String, documentJson: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName) || !Regex("[a-f0-9]{64}").matches(expectedHash)) { promise.reject(CodedException("invalid publication bundle")); return@AsyncFunction }
      val ctx = appContext.reactContext ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val source = confinedOrNull(dir, sourceUri.removePrefix("file://")) ?: throw IOException("missing published image")
          if (!source.isFile) throw IOException("missing published image")
          if (CaptureIntegrity.sha256(source) != expectedHash) throw IOException("Published image fingerprint changed")
          // Parsed, not concatenated, so the output is guaranteed to be one JSON object.
          val document = JSONObject(documentJson)
          val bytes = source.readBytes()
          document.put(
            "printImage",
            JSONObject()
              .put("name", source.name)
              .put("sha256", expectedHash)
              .put("bytes", bytes.size)
              .put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)),
          )
          val shareDir = File(ctx.cacheDir, "share").apply { mkdirs() }
          val out = File(shareDir, "$baseName-publication-bundle.json")
          val tmp = File(shareDir, "$baseName-publication-bundle.json.tmp")
          try {
            tmp.writeText(document.toString(2), Charsets.UTF_8)
            if (out.exists() && !out.delete()) throw IOException("could not replace the publication bundle")
            if (!tmp.renameTo(out)) throw IOException("rename failed for the publication bundle")
          } catch (e: Throwable) {
            runCatching { tmp.delete() }
            throw e
          }
          promise.resolve("file://${out.absolutePath}")
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "publication bundle export failed")) }
      }
    }

    AsyncFunction("stampSelectedShareCopy") { baseName: String, sourceUri: String, expectedHash: String, text: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName)) { promise.reject(CodedException("invalid baseName")); return@AsyncFunction }
      val ctx = appContext.reactContext ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val out = ShareStamp.writeSelected(ctx, dir, baseName, sourceUri, expectedHash, text)
          promise.resolve("file://${out.absolutePath}")
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "stamp failed")) }
      }
    }

    /** Tap to focus at a point 0..1 across the displayed picture; see `CameraController.focusAt`. */
    AsyncFunction("focusAt") { u: Double, v: Double, promise: Promise ->
      val view = activeView ?: run { promise.reject(CodedException("no active camera view")); return@AsyncFunction }
      if (!u.isFinite() || !v.isFinite()) { promise.reject(CodedException("invalid focus point")); return@AsyncFunction }
      view.camera.focusAt(u, v)
      promise.resolve(null)
    }

    /** Back to continuous focus and frame-wide metering. */
    AsyncFunction("releaseFocusPoint") { promise: Promise ->
      val view = activeView ?: run { promise.resolve(null); return@AsyncFunction }
      view.camera.releaseFocusPoint()
      promise.resolve(null)
    }

    /** Hardware key attestation of one publication manifest; see `PublicationAttestation`. */
    AsyncFunction("attestPublication") { manifestJson: String, promise: Promise ->
      // Signs the bytes as given, but only if they parse as one JSON object.
      val bytes = manifestJson.toByteArray(Charsets.UTF_8)
      if (bytes.isEmpty() || bytes.size > 4096 || runCatching { JSONObject(manifestJson) }.isFailure) {
        promise.reject(CodedException("invalid attestation manifest")); return@AsyncFunction
      }
      // StrongBox key generation can take a second.
      EXPORT_EXECUTOR.execute {
        try {
          promise.resolve(jsonToMap(PublicationAttestation.attest(bytes)))
        } catch (e: Throwable) {
          promise.reject(CodedException(e.message ?: "attestation failed"))
        }
      }
    }

    /** `{ clean, styled }` SHA-256 of the frames on disk. Sidecar paths must be inside the captures dir. */
    AsyncFunction("hashCaptureFrames") { baseName: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName)) { promise.reject(CodedException("invalid baseName")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val rec = readSidecarOrNull(File(dir, "$baseName.json")) ?: throw IOException("no capture $baseName")
          val cleanPath = rec.optJSONObject("clean")?.optString("path").orEmpty()
          val styledPath = rec.optJSONObject("styled")?.optString("path").orEmpty()
          val clean = confinedOrNull(dir, cleanPath) ?: throw IOException("$baseName names no clean frame inside the captures dir")
          val styled = confinedOrNull(dir, styledPath) ?: throw IOException("$baseName names no styled frame inside the captures dir")
          promise.resolve(mapOf(
            "clean" to CaptureIntegrity.sha256(clean),
            "styled" to CaptureIntegrity.sha256(styled),
          ))
        } catch (e: Throwable) {
          Log.w(TAG, "hashCaptureFrames failed for $baseName", e)
          promise.reject(CodedException(e.message ?: "hash failed"))
        }
      }
    }

    AsyncFunction("deleteCapture") { baseName: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName)) { promise.reject(CodedException("invalid baseName")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val sidecar = File(dir, "$baseName.json")
      val targets = mutableListOf(
        File(dir, "$baseName-clean.jpg"), File(dir, "$baseName-styled.jpg"), sidecar)
      // An interrupted sidecar's `.json.tmp` is removed but does not count as a capture.
      val existed = targets.any { it.exists() }
      targets.add(File(dir, "$baseName.json.tmp"))
      targets.forEach { runCatching { it.delete() } }
      // Derived files go on the export thread, after any in-flight write, so none is recreated.
      appContext.reactContext?.let { ctx ->
        EXPORT_EXECUTOR.execute {
          dir.listFiles()?.filter { Regex("${baseName}-(edit|print)-[a-f0-9]{64}(\\.tmp)?\\.jpg(\\.tmp)?").matches(it.name) }
            ?.forEach { runCatching { it.delete() } }
          runCatching { File(File(ctx.cacheDir, "share"), "$baseName-share.jpg").delete() }
          File(ctx.cacheDir, "share").listFiles()?.filter { Regex("${baseName}-[a-f0-9]{64}-share\\.jpg(\\.tmp)?").matches(it.name) }
            ?.forEach { runCatching { it.delete() } }
          runCatching { File(File(ctx.cacheDir, "share"), "$baseName-publication-bundle.json").delete() }
          runCatching { File(File(ctx.cacheDir, "share"), "$baseName-publication-bundle.json.tmp").delete() }
          runCatching { File(File(ctx.cacheDir, "share"), "$baseName-print-card.png").delete() }
          runCatching { File(File(ctx.cacheDir, "share"), "$baseName-print-card.png.tmp").delete() }
          File(ctx.cacheDir, "share").listFiles()?.filter { Regex("${baseName}-[a-f0-9]{64}-print-card\\.png(\\.tmp)?").matches(it.name) }
            ?.forEach { runCatching { it.delete() } }
        }
      }
      promise.resolve(existed)
    }

    /** Resolves the first QR code's text, or null on cancel. Refused while a camera view owns camera "0". */
    AsyncFunction("scanQrCode") { promise: Promise ->
      if (activeView != null) {
        promise.reject(CodedException("close the camera before scanning a QR code")); return@AsyncFunction
      }
      val activity = appContext.currentActivity ?: run {
        promise.reject(CodedException("no foreground activity to scan from")); return@AsyncFunction
      }
      synchronized(SCAN_LOCK) {
        if (scanPromise != null) {
          promise.reject(CodedException("a QR scan is already open")); return@AsyncFunction
        }
        scanPromise = promise
      }
      try {
        activity.startActivityForResult(QrScanner.intent(activity), QrScanner.REQUEST_CODE)
      } catch (e: Throwable) {
        Log.w(TAG, "scanner activity refused to start", e)
        synchronized(SCAN_LOCK) { scanPromise = null }
        promise.reject(CodedException(e.message ?: "the QR scanner could not be opened"))
      }
    }

    // Expo routes the host activity's onActivityResult here.
    OnActivityResult { _, payload ->
      if (payload.requestCode != QrScanner.REQUEST_CODE) return@OnActivityResult
      val promise = synchronized(SCAN_LOCK) { scanPromise.also { scanPromise = null } }
        ?: return@OnActivityResult
      when (payload.resultCode) {
        Activity.RESULT_OK -> {
          val value = payload.data?.getStringExtra(QrScanner.EXTRA_VALUE)
          if (value == null) promise.reject(CodedException("the scanner returned no code"))
          else promise.resolve(value)
        }
        Activity.RESULT_CANCELED -> promise.resolve(null)
        else -> promise.reject(
          CodedException(
            payload.data?.getStringExtra(QrScanner.EXTRA_ERROR)
              ?: "QR scanning is unavailable on this device.",
          ),
        )
      }
    }
  }

  private class ExportSource(val file: File, val displayName: String)

  /** The styled frame for `baseName`; the sidecar path is confined because the file leaves the sandbox. */
  private fun exportSource(dir: File, baseName: String): ExportSource {
    val sidecar = File(dir, "$baseName.json")
    if (!sidecar.isFile) throw IOException("no capture $baseName")
    val rec = readSidecarOrNull(sidecar) ?: throw IOException("sidecar unreadable for $baseName")
    val styledPath = rec.optJSONObject("styled")?.optString("path").orEmpty()
    val styled = confinedOrNull(dir, styledPath) ?: File(dir, "$baseName-styled.jpg")
    if (!styled.isFile) throw IOException("$baseName has no styled frame")
    return ExportSource(styled, "$baseName.jpg")
  }

  private fun readSidecarOrNull(sidecar: File): JSONObject? = try {
    if (sidecar.isFile) JSONObject(sidecar.readText()) else null
  } catch (e: Throwable) {
    null
  }

  /** `path` as a File if it is a direct child of `dir`, else null (including when canonicalising fails). */
  private fun confinedOrNull(dir: File, path: String): File? {
    if (path.isEmpty()) return null
    val f = File(path)
    val inside = runCatching {
      f.canonicalFile.parentFile?.canonicalPath == dir.canonicalPath
    }.getOrDefault(false)
    return if (inside) f else null
  }

  /** A `clean`/`styled` entry, or null unless BOTH path and sha256 are present as strings. */
  private fun frameOrNull(value: Any?): Map<*, *>? {
    val m = value as? Map<*, *> ?: return null
    if (m["path"] !is String || m["sha256"] !is String) return null
    return m
  }

  /** JSON numbers arrive as Int or Double; `intensity` must be integral. */
  private fun isIntLike(value: Any?): Boolean {
    val n = value as? Number ?: return false
    val d = n.toDouble()
    return d.isFinite() && d == Math.floor(d) && d >= Int.MIN_VALUE.toDouble() && d <= Int.MAX_VALUE.toDouble()
  }

  private fun capturesDir(): File? =
    appContext.reactContext?.let { File(it.filesDir, "captures") }

  private fun jsonToMap(o: JSONObject): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    o.keys().forEach { k -> out[k] = jsonToValue(o.get(k)) }
    return out
  }

  private fun jsonToValue(v: Any?): Any? = when (v) {
    null, JSONObject.NULL -> null
    is JSONObject -> jsonToMap(v)
    is JSONArray -> (0 until v.length()).map { jsonToValue(v.get(it)) }
    else -> v
  }
}
