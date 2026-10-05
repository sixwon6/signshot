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
    // A rebuilt view brings its fresh renderer up on these, so a tab switch cannot leave native
    // state diverged from JS state.
    @Volatile var lastProfile: Profile? = null
    @Volatile var lastIntensity: Float = 0.6f
    /** The last ACCEPTED capture settings, re-applied by a rebuilt view for the same reason. */
    @Volatile var lastCaptureSettings: String? = null
    private const val TAG = "SeekerCamera"
    private val BASE_NAME = Regex("^cap-[0-9]+$")
    private val SIDECAR_NAME = Regex("^cap-[0-9]+\\.json$")

    // Exports hash and copy multi-MB JPEGs off the module queue. Single-threaded because gallery
    // export is check-then-write: two concurrent exports of one capture would both write.
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

    /**
     * What camera "0" can actually do — the manual-control ranges, read from
     * `CameraCharacteristics`. Works with no camera view mounted, and never rejects for a missing
     * control: an absent range reaches JS as the string `"unavailable"`.
     */
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

    /**
     * Applies manual controls to the preview and next still; resolves the clamped values in force.
     * Rejects only for a control this camera lacks.
     */
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

    // Works with no camera view mounted.
    AsyncFunction("listCaptures") { promise: Promise ->
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val files = dir.listFiles { f: File -> f.isFile && SIDECAR_NAME.matches(f.name) } ?: emptyArray()
      val out = files.mapNotNull { f ->
        try {
          // The whole sidecar passes through (no allowlist, so new fields are never dropped).
          val rec = jsonToMap(JSONObject(f.readText())).toMutableMap()
          // Fields CaptureRecord requires; JS does not re-check them, so skip a partial record.
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
          null // corrupt sidecar: skip, never fail the list
        }
      }.sortedByDescending { (it["capturedAtMs"] as? Number)?.toLong() ?: 0L }
      promise.resolve(out)
    }

    // Separate immutable edit artifacts; never overwrites the captured frames.
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
          // The export policy is part of the edit id, so an edit rendered under another policy is
          // never reused or replaced.
          val pipeline = "edit-rgb/2-full-size/" + ShaderGen.capturePipelineId(profile, graph)
          val editId = Profile.sha256Hex("$sourceHash\n$pipeline\n$strength".toByteArray())
          val out = File(dir, "$baseName-edit-$editId.jpg")
          val temp = File(dir, "$baseName-edit-$editId.tmp.jpg")
          fun resolve() {
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeFile(out.absolutePath, bounds)
            // Edits can be published, so unreadable dimensions must fail here, including for an
            // existing `out` reused below.
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
          // Serialize native edit/export file operations; never block the UI or module queue.
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
          // An unreadable header leaves -1 dimensions, which would go into permanently uploaded
          // metadata the app's reader rejects. Fail before the wallet instead.
          if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("invalid print image")
          promise.resolve(mapOf("path" to out.file.absolutePath, "sha256" to out.sha256, "bytes" to out.bytes, "width" to bounds.outWidth, "height" to bounds.outHeight))
        } catch (e: Throwable) { promise.reject(CodedException(e.message ?: "print preparation failed")) }
      }
    }

    /**
     * Removes one print derivative and its scratch file, leaving the capture alone. The print is
     * written at the estimate step, so discarding a draft (`discardDraft`) must remove it.
     */
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

    /**
     * Writes one JSON file into `cacheDir/share` with the metadata document and the
     * fingerprint-checked print image, so an unuploaded publication's bytes (not backed up) can
     * leave the phone. There is no import path.
     */
    AsyncFunction("exportPublicationBundle") { baseName: String, sourceUri: String, expectedHash: String, documentJson: String, promise: Promise ->
      if (!BASE_NAME.matches(baseName) || !Regex("[a-f0-9]{64}").matches(expectedHash)) { promise.reject(CodedException("invalid publication bundle")); return@AsyncFunction }
      val ctx = appContext.reactContext ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      val dir = capturesDir() ?: run { promise.reject(CodedException("no react context")); return@AsyncFunction }
      EXPORT_EXECUTOR.execute {
        try {
          val source = confinedOrNull(dir, sourceUri.removePrefix("file://")) ?: throw IOException("missing published image")
          if (!source.isFile) throw IOException("missing published image")
          if (CaptureIntegrity.sha256(source) != expectedHash) throw IOException("Published image fingerprint changed")
          // Parsed, not concatenated: the document is composed in TypeScript and must still be
          // one JSON object here, or the file this writes would not be readable by anything.
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
      // Parsed, not trusted: the bytes signed are exactly the bytes given, but they must be one
      // JSON object or nothing reading the document could ever match them.
      val bytes = manifestJson.toByteArray(Charsets.UTF_8)
      if (bytes.isEmpty() || bytes.size > 4096 || runCatching { JSONObject(manifestJson) }.isFailure) {
        promise.reject(CodedException("invalid attestation manifest")); return@AsyncFunction
      }
      // Key generation can take a second on StrongBox; never on the module queue.
      EXPORT_EXECUTOR.execute {
        try {
          promise.resolve(jsonToMap(PublicationAttestation.attest(bytes)))
        } catch (e: Throwable) {
          promise.reject(CodedException(e.message ?: "attestation failed"))
        }
      }
    }

    /**
     * Returns `{ clean, styled }` hex SHA-256 of the frames on disk, for comparison with the sidecar
     * before wallet approval. Both sidecar paths must be inside the captures dir (no fallback name).
     */
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
      // `.json.tmp` (a sidecar write interrupted before rename) is deleted too, but on its own does
      // not mean a capture existed.
      val existed = targets.any { it.exists() }
      targets.add(File(dir, "$baseName.json.tmp"))
      targets.forEach { runCatching { it.delete() } }
      // Derived copies are deleted on the export thread, after any in-flight write, so they cannot
      // be recreated once the capture is gone. Only this capture's derived files match.
      appContext.reactContext?.let { ctx ->
        EXPORT_EXECUTOR.execute {
          dir.listFiles()?.filter { Regex("${baseName}-(edit|print)-[a-f0-9]{64}(\\.tmp)?\\.jpg(\\.tmp)?").matches(it.name) }
            ?.forEach { runCatching { it.delete() } }
          runCatching { File(File(ctx.cacheDir, "share"), "$baseName-share.jpg").delete() }
          File(ctx.cacheDir, "share").listFiles()?.filter { Regex("${baseName}-[a-f0-9]{64}-share\\.jpg(\\.tmp)?").matches(it.name) }
            ?.forEach { runCatching { it.delete() } }
          // The publication bundle contains the print image, so it goes too.
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

    /**
     * Opens the QR scanner (QrScanner.kt) and resolves the first QR code's text, null when the
     * person backs out. Rejects with a readable sentence when scanning cannot happen: camera access
     * refused, no back camera, or the bundled ML Kit model failing to run. Refuses while a camera
     * view is mounted, since both would own camera "0" (see QrScanner.kt).
     */
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

    // The scanner's only way back: Expo routes the host activity's onActivityResult here.
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

  /**
   * The styled frame for `baseName`, exported as `<base>.jpg`. The sidecar path is confined to the
   * captures dir because it becomes a file that leaves the sandbox.
   */
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

  /** `path` as a File if it is a direct child of `dir`, else null. Never throws: canonicalising
   *  can fail on a path that does not resolve, and "not confined" is the right answer then. */
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

  /** JSON gives Int or Double; `intensity` is an integer 0..100, so a fractional value is not it. */
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
