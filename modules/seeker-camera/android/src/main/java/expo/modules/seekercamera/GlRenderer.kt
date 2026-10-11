package expo.modules.seekercamera

import android.graphics.Bitmap
import android.media.Image
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES30
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * GL render pipeline: one YUV->RGB definition (ShaderGen, BT.601 full range), clean output = same shader
 * with uStyled=0, FRAMEBUFFER_SRGB disabled (the Seeker enables it by default).
 * Texture units: 0-2 Y/U/V, 3 LUT, 5 scratch for FBO allocation.
 */
class GlRenderer {
  companion object {
    private const val TAG = "SeekerCamGL"
    private const val FRAMEBUFFER_SRGB_EXT = 0x8DB9
    const val REF_LONG_EDGE = 4000.0f
    const val NEUTRAL_MANIFEST = """{"profileId":"prof.neutral","profileVersion":1,"stages":[]}"""
    private const val DETACH_TIMEOUT_MS = 2000L
    /** Hard cap on either JPEG. A capture that cannot fit at q80 is refused, never shipped over-cap. */
    private const val MAX_JPEG_BYTES = 4 * 1024 * 1024
    private val JPEG_QUALITY_LADDER = intArrayOf(95, 92, 89, 86, 83, 80)

    // Process-wide encode pool: the GL thread blocks on readback only, never on encode or digest.
    private val ENCODE_POOL = Executors.newFixedThreadPool(2) { r ->
      Thread(r, "seeker-encode").apply { isDaemon = true }
    }
  }

  private val thread = HandlerThread("seeker-gl").apply { start() }
  val handler = Handler(thread.looper)

  private var eglDisplay: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
  private var eglConfig: EGLConfig? = null
  private var windowSurface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var pbufferSurface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var surfaceW = 0
  private var surfaceH = 0
  private var glReady = false
  // Set when init fails: nothing drains the pending queue, so later applies fail fast.
  private var glFailed: String? = null

  private var program = 0
  /** The GLSL `program` was linked from; a profile that generates the same text reuses it. */
  private var programSrc: String? = null
  /** One `glGetUniformLocation` per name per program: the draw must not query by name per frame. */
  private val uniformLocations = HashMap<String, Int>()
  /** Stage index → (param, uniform name), so no uniform name is built per frame. */
  private var stageUniforms: List<List<Pair<String, String>>> = emptyList()
  /** The lut digest on texture unit 3, so an unchanged LUT is not re-uploaded. */
  private var lutUploaded: String? = null
  /** The shader-graph digest in `capturePipelineId`, and the lut digest it was taken over. */
  private var graphDigest = "none"
  private var digestedLut: String? = null
  private var profile: Profile? = null
  private var pendingProfile: Profile? = null
  private val pendingApplies = mutableListOf<(String?, String?) -> Unit>()
  @Volatile var capturePipelineId: String = "sp/${ShaderGen.RENDERER_VERSION}/none/none@0/cal-none"
    private set
  // Read off the GL thread for the sidecar.
  @Volatile var profileId: String = "none"
    private set
  @Volatile var profileVersion: Int = 0
    private set
  @Volatile var intensity: Float = 0.6f
  @Volatile var rotationDegrees: Int = 90
  /**
   * Physical phone orientation. The preview stays sensor-upright, but anisotropic stages must run
   * along the still's axis, so the preview's uScanAxis adds this. The still uses its shutter snapshot.
   */
  @Volatile var deviceDegrees: Int = 0

  /** GL-init / surface-attach failures, for the view's onSessionError dispatch. */
  var onGlError: ((String) -> Unit)? = null

  private val texIds = IntArray(3) // Y, U, V
  private var lutTexId = 0
  private var texAllocW = 0
  private var texAllocH = 0
  private var quadVbo = 0

  private val pendingLock = Object()
  private var pendingPreview: Image? = null
  private var rendering = false
  @Volatile private var released = false

  private var yBuf: ByteBuffer? = null
  private var uBuf: ByteBuffer? = null
  private var vBuf: ByteBuffer? = null

  // Readback pair, reused across captures. Two buffers because both encodes read concurrently.
  private var readBufA: ByteBuffer? = null
  private var readBufB: ByteBuffer? = null
  private val sharedBufsBusy = AtomicBoolean(false)

  fun start(surface: Surface, width: Int, height: Int) {
    val posted = handler.post {
      if (released) return@post
      try {
        initEgl()
        attachWindowSurfaceOnThread(surface, width, height)
        setupQuad()
        glReady = true
        val initial = pendingProfile ?: Profile.parse(NEUTRAL_MANIFEST, null)
        pendingProfile = null
        applyProfileOnThread(initial)
        settlePendingApplies(null)
        Log.i(TAG, "GL ready ${GLES30.glGetString(GLES30.GL_RENDERER)} surface ${width}x${height}")
      } catch (e: Throwable) {
        Log.e(TAG, "GL init failed", e)
        val msg = e.message ?: "GL init failed"
        glFailed = msg
        settlePendingApplies(msg)
        onGlError?.invoke(msg)
      }
    }
    if (!posted) onGlError?.invoke("GL thread unavailable")
  }

  fun resize(width: Int, height: Int) {
    handler.post { surfaceW = width; surfaceH = height }
  }

  /** Re-attach after surfaceDestroyed, or the very first attach from start(). */
  fun attachWindowSurface(surface: Surface, width: Int, height: Int) {
    val posted = handler.post {
      if (released || !glReady) return@post
      try {
        attachWindowSurfaceOnThread(surface, width, height)
      } catch (e: Throwable) {
        Log.e(TAG, "attach window surface failed", e)
        onGlError?.invoke(e.message ?: "attach window surface failed")
      }
    }
    if (!posted) onGlError?.invoke("GL thread unavailable")
  }

  /**
   * BLOCKING: SurfaceHolder.Callback.surfaceDestroyed must not return while the GL thread can
   * still touch the surface. Destroys the EGL window surface only — the context stays current on
   * the 1x1 pbuffer, so textures/programs/LUT survive.
   */
  fun detachWindowSurface() {
    val latch = CountDownLatch(1)
    val posted = handler.post {
      try { destroyWindowSurfaceOnThread() }
      catch (e: Throwable) { Log.e(TAG, "detach window surface", e) }
      finally { latch.countDown() }
    }
    if (!posted) return
    if (!latch.await(DETACH_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      Log.w(TAG, "detachWindowSurface timed out after ${DETACH_TIMEOUT_MS}ms")
    }
  }

  fun applyProfile(p: Profile, onDone: (String?, String?) -> Unit) {
    val posted = handler.post {
      if (released) { onDone("renderer released", null); return@post }
      glFailed?.let { onDone(it, null); return@post }
      if (!glReady) {
        // Queue until start(): resolving now would return a stale capturePipelineId. Latest wins.
        pendingProfile = p
        pendingApplies.add(onDone)
        return@post
      }
      try {
        applyProfileOnThread(p)
        onDone(null, capturePipelineId)
      } catch (e: Throwable) {
        Log.e(TAG, "applyProfile failed", e)
        onDone(e.message ?: "applyProfile failed", null)
      }
    }
    if (!posted) onDone("GL thread unavailable", null)
  }

  private fun settlePendingApplies(err: String?) {
    if (pendingApplies.isEmpty()) return
    val cbs = pendingApplies.toList()
    pendingApplies.clear()
    cbs.forEach { it(err, if (err == null) capturePipelineId else null) }
  }

  /**
   * Parameters are uniforms, so a slider drag leaves the GLSL unchanged: the linked program, its
   * uniform locations and graph digest are reused, and an unchanged LUT is not re-uploaded.
   */
  private fun applyProfileOnThread(p: Profile, edited: Boolean = false) {
    val frag = if (edited) ShaderGen.editedFragmentSrc(p) else ShaderGen.fragmentSrc(p)
    val sameGraph = frag == programSrc && p.lutDigest == digestedLut
    if (frag != programSrc) {
      val newProgram = buildProgram(ShaderGen.VERTEX_SRC, frag)
      if (program != 0) GLES30.glDeleteProgram(program)
      program = newProgram
      programSrc = frag
      uniformLocations.clear()
    }
    if (p.lutSize > 0 && p.lutRgba != null && p.lutDigest != lutUploaded) {
      if (lutTexId == 0) {
        val t = IntArray(1); GLES30.glGenTextures(1, t, 0); lutTexId = t[0]
      }
      GLES30.glActiveTexture(GLES30.GL_TEXTURE3)
      GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lutTexId)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_R, GLES30.GL_CLAMP_TO_EDGE)
      p.lutRgba.rewind()
      GLES30.glTexImage3D(
        GLES30.GL_TEXTURE_3D, 0, GLES30.GL_RGBA8,
        p.lutSize, p.lutSize, p.lutSize, 0,
        GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, p.lutRgba
      )
      lutUploaded = p.lutDigest
    }
    if (p.lutSize == 0) lutUploaded = null
    profile = p
    stageUniforms = p.stages.mapIndexed { i, st ->
      ShaderGen.STAGE_PARAMS[st.type].orEmpty().map { param -> param to "u_s${i}_$param" }
    }
    profileId = p.profileId
    profileVersion = p.profileVersion
    if (!sameGraph) {
      graphDigest = ShaderGen.shaderGraphDigest(frag, p.lutDigest)
      digestedLut = p.lutDigest
    }
    capturePipelineId = ShaderGen.pipelineId(p, graphDigest)
    Log.i(TAG, "profile ${p.profileId}@${p.profileVersion} -> $capturePipelineId")
  }

  fun submitPreview(image: Image) {
    if (released) { image.close(); return }
    synchronized(pendingLock) {
      pendingPreview?.close()
      pendingPreview = image
      if (!rendering) {
        rendering = true
        if (!handler.post { drainPreview() }) {
          pendingPreview?.close(); pendingPreview = null; rendering = false
        }
      }
    }
  }

  private fun drainPreview() {
    while (true) {
      val img: Image?
      synchronized(pendingLock) {
        img = pendingPreview
        pendingPreview = null
        if (img == null) { rendering = false; return }
      }
      try { renderPreview(img!!) } catch (e: Throwable) { Log.e(TAG, "preview render", e) }
      finally { img!!.close() }
    }
  }

  private fun renderPreview(image: Image) {
    // Frames arriving while the window surface is detached are dropped here.
    if (windowSurface == EGL14.EGL_NO_SURFACE || program == 0) return
    uploadYuv(image)
    EGL14.eglMakeCurrent(eglDisplay, windowSurface, windowSurface, eglContext)
    val srcW: Float; val srcH: Float
    if (rotationDegrees == 90 || rotationDegrees == 270) { srcW = image.height.toFloat(); srcH = image.width.toFloat() }
    else { srcW = image.width.toFloat(); srcH = image.height.toFloat() }
    val scale = minOf(surfaceW / srcW, surfaceH / srcH)
    val vpW = (srcW * scale).toInt(); val vpH = (srcH * scale).toInt()
    GLES30.glClearColor(0.039f, 0.039f, 0.039f, 1f)
    GLES30.glViewport(0, 0, surfaceW, surfaceH)
    GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
    GLES30.glViewport((surfaceW - vpW) / 2, (surfaceH - vpH) / 2, vpW, vpH)
    draw(styled = true, frameW = vpW.toFloat(), frameH = vpH.toFloat(),
      scanRotation = (rotationDegrees + deviceDegrees) % 360)
    EGL14.eglSwapBuffers(eglDisplay, windowSurface)
  }

  /** Paths plus the SHA-256 of the exact encoded JPEG bytes written. */
  data class StillFiles(
    val cleanPath: String, val cleanSha256: String,
    val styledPath: String, val styledSha256: String,
  )

  /** @param intensityOverride shutter snapshot, 0..1, so the still matches the sidecar's intensity. */
  fun renderStill(
    image: Image, outDir: File, baseName: String, intensityOverride: Float, rotationOverride: Int,
    onDone: (Result<StillFiles>) -> Unit,
  ) {
    val posted = handler.post {
      if (released || !glReady || program == 0) {
        image.close()
        onDone(Result.failure(IllegalStateException("GL not ready for capture")))
        return@post
      }
      val fbo = IntArray(1)
      val colorTex = IntArray(1)
      var ownShared = false
      var encodesStarted = false
      try {
        try { uploadYuv(image) } finally { image.close() }
        val outW: Int; val outH: Int
        if (rotationOverride == 90 || rotationOverride == 270) { outW = texAllocH; outH = texAllocW }
        else { outW = texAllocW; outH = texAllocH }

        GLES30.glGenFramebuffers(1, fbo, 0)
        GLES30.glGenTextures(1, colorTex, 0)
        // Scratch unit for FBO color allocation: binding on units 0-3 would evict a sampler input.
        GLES30.glActiveTexture(GLES30.GL_TEXTURE5)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, colorTex[0])
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, outW, outH, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo[0])
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, colorTex[0], 0)
        if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) != GLES30.GL_FRAMEBUFFER_COMPLETE) {
          throw IllegalStateException("FBO incomplete for ${outW}x${outH}")
        }
        GLES30.glViewport(0, 0, outW, outH)

        val need = outW * outH * 4
        ownShared = sharedBufsBusy.compareAndSet(false, true)
        val bufs: Array<ByteBuffer> = if (ownShared) {
          readBufA = reuseBuf(readBufA, need); readBufB = reuseBuf(readBufB, need)
          arrayOf(readBufA!!, readBufB!!)
        } else {
          // An earlier capture's encoders still hold the shared pair; never stomp bytes in flight.
          arrayOf(allocBuf(need), allocBuf(need))
        }
        val paths = arrayOf(
          File(outDir, "$baseName-clean.jpg").absolutePath,
          File(outDir, "$baseName-styled.jpg").absolutePath,
        )

        // Index 0 = clean (uStyled=0), 1 = styled. GL thread blocks for readback only.
        for (idx in 0..1) {
          GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
          draw(styled = idx == 1, frameW = outW.toFloat(), frameH = outH.toFloat(),
            intensityOverride = intensityOverride, frameRotation = rotationOverride)
          GLES30.glFinish()
          bufs[idx].rewind()
          GLES30.glReadPixels(0, 0, outW, outH, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, bufs[idx])
        }

        val shas = arrayOfNulls<String>(2)
        val err = AtomicReference<Throwable?>(null)
        val remaining = AtomicInteger(2)
        val releaseShared = ownShared
        encodesStarted = true
        for (idx in 0..1) {
          ENCODE_POOL.execute {
            try {
              shas[idx] = encodeStill(bufs[idx], outW, outH, paths[idx])
            } catch (e: Throwable) {
              // File name only: the absolute path would expose the private captures dir in release logs.
              Log.e(TAG, "still encode ${File(paths[idx]).name}", e)
              err.compareAndSet(null, e)
            } finally {
              if (remaining.decrementAndGet() == 0) {
                if (releaseShared) sharedBufsBusy.set(false)
                val t = err.get()
                if (t != null) {
                  // Nothing half-written survives a failed capture.
                  paths.forEach { p -> runCatching { File(p).delete() } }
                  onDone(Result.failure(t))
                } else {
                  onDone(Result.success(StillFiles(paths[0], shas[0]!!, paths[1], shas[1]!!)))
                }
              }
            }
          }
        }
      } catch (e: Throwable) {
        Log.e(TAG, "still render", e)
        onDone(Result.failure(e))
      } finally {
        // Never leave the offscreen FBO bound, or the preview renders into it (black viewfinder).
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        if (colorTex[0] != 0) GLES30.glDeleteTextures(1, colorTex, 0)
        if (fbo[0] != 0) GLES30.glDeleteFramebuffers(1, fbo, 0)
        if (ownShared && !encodesStarted) sharedBufsBusy.set(false)
      }
    }
    if (!posted) {
      image.close()
      onDone(Result.failure(IllegalStateException("GL thread unavailable")))
    }
  }

  /** Renders an edit on a dedicated renderer, always from the clean JPEG so edits never stack. */
  fun renderEditedFile(source: File, p: Profile, strength: Float, output: File, onDone: (Result<String>) -> Unit) {
    val posted = handler.post {
      val fbo = IntArray(1); val texture = IntArray(1)
      var bitmap: Bitmap? = null
      try {
        require(strength.isFinite() && strength in 0f..1f)
        initEgl(); setupQuad(); rotationDegrees = 0
        applyProfileOnThread(p, edited = true)
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(source.absolutePath, bounds)
        // Full resolution only: refuse anything above the 4000x3000 capture rather than downscale.
        require(bounds.outWidth in 1..4000 && bounds.outHeight in 1..4000 &&
          bounds.outWidth.toLong() * bounds.outHeight <= 12_000_000L) {
          "Full-resolution editing supports photos up to 4000 pixels and 12 megapixels"
        }
        val textureLimit = IntArray(1)
        GLES30.glGetIntegerv(GLES30.GL_MAX_TEXTURE_SIZE, textureLimit, 0)
        require(maxOf(bounds.outWidth, bounds.outHeight) <= textureLimit[0]) { "Photo exceeds this device's editing limit" }
        val options = android.graphics.BitmapFactory.Options().apply {
          inSampleSize = 1
          inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        bitmap = android.graphics.BitmapFactory.decodeFile(source.absolutePath, options) ?: throw IOException("Missing original photo")
        val w = bitmap.width
        val h = bitmap.height
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texIds[0])
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        android.opengl.GLUtils.texImage2D(GLES30.GL_TEXTURE_2D, 0, bitmap, 0)
        bitmap.recycle(); bitmap = null
        GLES30.glGenFramebuffers(1, fbo, 0); GLES30.glGenTextures(1, texture, 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE5)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture[0])
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, w, h, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo[0])
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, texture[0], 0)
        check(GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) == GLES30.GL_FRAMEBUFFER_COMPLETE)
        GLES30.glViewport(0, 0, w, h)
        draw(true, w.toFloat(), h.toFloat(), strength)
        val bytes = allocBuf(w * h * 4)
        GLES30.glReadPixels(0, 0, w, h, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, bytes)
        check(GLES30.glGetError() == GLES30.GL_NO_ERROR) { "Photo edit rendering failed" }

        // Free the full-size GPU images before the JPEG bitmap; flip in place to avoid another frame copy.
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        GLES30.glDeleteTextures(1, texture, 0); texture[0] = 0
        GLES30.glDeleteFramebuffers(1, fbo, 0); fbo[0] = 0
        GLES30.glDeleteTextures(3, texIds, 0); texIds.fill(0)
        flipRgbaRows(bytes, w, h)
        val hash = encodeStill(bytes, w, h, output.absolutePath, pixelsAreTopDown = true)
        onDone(Result.success(hash))
      } catch (error: Throwable) {
        output.delete(); onDone(Result.failure(error))
      } finally {
        bitmap?.recycle()
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        if (texture[0] != 0) GLES30.glDeleteTextures(1, texture, 0)
        if (fbo[0] != 0) GLES30.glDeleteFramebuffers(1, fbo, 0)
        release()
      }
    }
    if (!posted) onDone(Result.failure(IllegalStateException("Photo editor unavailable")))
  }

  fun release() {
    released = true
    handler.post {
      glReady = false
      settlePendingApplies("renderer released")
      synchronized(pendingLock) { pendingPreview?.close(); pendingPreview = null }
      if (program != 0) { GLES30.glDeleteProgram(program); program = 0 }
      programSrc = null
      uniformLocations.clear()
      lutUploaded = null
      if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
        EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        if (windowSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, windowSurface)
        if (pbufferSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, pbufferSurface)
        windowSurface = EGL14.EGL_NO_SURFACE
        pbufferSurface = EGL14.EGL_NO_SURFACE
        EGL14.eglDestroyContext(eglDisplay, eglContext)
        EGL14.eglTerminate(eglDisplay)
      }
      thread.quitSafely()
    }
  }

  private fun hexOf(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

  private fun allocBuf(need: Int): ByteBuffer =
    ByteBuffer.allocateDirect(need).order(ByteOrder.nativeOrder())

  private fun reuseBuf(buf: ByteBuffer?, need: Int): ByteBuffer =
    if (buf != null && buf.capacity() >= need) buf else allocBuf(need)

  /** Off the GL thread: pixel copy, vertical flip, JPEG encode, SHA-256 over the written bytes. */
  private fun encodeStill(buf: ByteBuffer, w: Int, h: Int, path: String, pixelsAreTopDown: Boolean = false): String {
    // Logs name the file only, never the private absolute path.
    val name = File(path).name
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val flipped: Bitmap
    if (pixelsAreTopDown) {
      try {
        buf.rewind()
        bmp.copyPixelsFromBuffer(buf)
      } catch (error: Throwable) { bmp.recycle(); throw error }
      flipped = bmp
    } else try {
      buf.rewind()
      bmp.copyPixelsFromBuffer(buf)
      val m = android.graphics.Matrix().apply { preScale(1f, -1f) }
      flipped = Bitmap.createBitmap(bmp, 0, 0, w, h, m, false)
    } finally {
      bmp.recycle()
    }
    try {
      // Cap before writing so the hash covers the stored bytes; step quality down, fail below q80.
      var bytes: ByteArray? = null
      for (q in JPEG_QUALITY_LADDER) {
        val bos = ByteArrayOutputStream(MAX_JPEG_BYTES / 2)
        if (!flipped.compress(Bitmap.CompressFormat.JPEG, q, bos)) {
          throw IOException("JPEG encode returned false for $name")
        }
        val out = bos.toByteArray()
        if (out.size <= MAX_JPEG_BYTES) {
          if (q != JPEG_QUALITY_LADDER.first()) {
            Log.i(TAG, "still fit cap at q$q (${out.size}B) for $name")
          }
          bytes = out
          break
        }
      }
      val finalBytes = bytes ?: throw IOException(
        "still exceeds ${MAX_JPEG_BYTES}B even at q${JPEG_QUALITY_LADDER.last()} for $name")
      FileOutputStream(path).use { it.write(finalBytes) }
      return hexOf(MessageDigest.getInstance("SHA-256").digest(finalBytes))
    } finally {
      flipped.recycle()
    }
  }

  private fun flipRgbaRows(bytes: ByteBuffer, width: Int, height: Int) {
    val stride = width * 4
    val top = ByteArray(stride)
    val bottom = ByteArray(stride)
    for (row in 0 until height / 2) {
      val opposite = height - row - 1
      bytes.position(row * stride); bytes.get(top)
      bytes.position(opposite * stride); bytes.get(bottom)
      bytes.position(row * stride); bytes.put(bottom)
      bytes.position(opposite * stride); bytes.put(top)
    }
    bytes.rewind()
  }

  private fun initEgl() {
    eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    val ver = IntArray(2)
    if (!EGL14.eglInitialize(eglDisplay, ver, 0, ver, 1)) throw IllegalStateException("eglInitialize failed")
    val attrs = intArrayOf(
      EGL14.EGL_RENDERABLE_TYPE, 0x0040,
      // WINDOW|PBUFFER: the 1x1 pbuffer is what the context stays current on while the window
      // surface is destroyed. EGL_KHR_surfaceless_context is optional on Mali; a pbuffer is not.
      EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
      EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_NONE)
    val cfgs = arrayOfNulls<EGLConfig>(1); val n = IntArray(1)
    EGL14.eglChooseConfig(eglDisplay, attrs, 0, cfgs, 0, 1, n, 0)
    if (n[0] < 1 || cfgs[0] == null) throw IllegalStateException("no window+pbuffer RGBA8 EGL config")
    eglConfig = cfgs[0]
    eglContext = EGL14.eglCreateContext(eglDisplay, eglConfig, EGL14.EGL_NO_CONTEXT,
      intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE), 0)
    if (eglContext == EGL14.EGL_NO_CONTEXT) throw IllegalStateException("eglCreateContext failed")
    pbufferSurface = EGL14.eglCreatePbufferSurface(eglDisplay, eglConfig,
      intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
    if (pbufferSurface == EGL14.EGL_NO_SURFACE) throw IllegalStateException("eglCreatePbufferSurface failed")
    if (!EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext)) {
      throw IllegalStateException("eglMakeCurrent(pbuffer) failed")
    }
    val exts = GLES30.glGetString(GLES30.GL_EXTENSIONS) ?: ""
    if (exts.contains("GL_EXT_sRGB_write_control")) {
      GLES30.glDisable(FRAMEBUFFER_SRGB_EXT)
    }
    GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
    GLES30.glGenTextures(3, texIds, 0)
  }

  private fun attachWindowSurfaceOnThread(surface: Surface, width: Int, height: Int) {
    destroyWindowSurfaceOnThread()
    val s = EGL14.eglCreateWindowSurface(eglDisplay, eglConfig, surface, intArrayOf(EGL14.EGL_NONE), 0)
    if (s == EGL14.EGL_NO_SURFACE) throw IllegalStateException("eglCreateWindowSurface failed")
    windowSurface = s
    surfaceW = width
    surfaceH = height
    if (!EGL14.eglMakeCurrent(eglDisplay, windowSurface, windowSurface, eglContext)) {
      throw IllegalStateException("eglMakeCurrent(window) failed")
    }
  }

  private fun destroyWindowSurfaceOnThread() {
    if (windowSurface == EGL14.EGL_NO_SURFACE) return
    // Park the context on the pbuffer FIRST: destroying a surface that is still current only
    // defers the destroy, and the context must stay current so textures/programs survive.
    EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext)
    EGL14.eglDestroySurface(eglDisplay, windowSurface)
    windowSurface = EGL14.EGL_NO_SURFACE
  }

  private fun setupQuad() {
    val verts = floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)
    val bb = ByteBuffer.allocateDirect(verts.size * 4).order(ByteOrder.nativeOrder())
    bb.asFloatBuffer().put(verts).rewind()
    val vbo = IntArray(1); GLES30.glGenBuffers(1, vbo, 0)
    quadVbo = vbo[0]
    GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, quadVbo)
    GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, verts.size * 4, bb, GLES30.GL_STATIC_DRAW)
  }

  private fun buildProgram(vertexSrc: String, fragSrc: String): Int {
    val vs = compile(GLES30.GL_VERTEX_SHADER, vertexSrc)
    val fs = compile(GLES30.GL_FRAGMENT_SHADER, fragSrc)
    val p = GLES30.glCreateProgram()
    GLES30.glAttachShader(p, vs); GLES30.glAttachShader(p, fs); GLES30.glLinkProgram(p)
    val ok = IntArray(1); GLES30.glGetProgramiv(p, GLES30.GL_LINK_STATUS, ok, 0)
    GLES30.glDeleteShader(vs); GLES30.glDeleteShader(fs)
    if (ok[0] == 0) {
      val log = GLES30.glGetProgramInfoLog(p); GLES30.glDeleteProgram(p)
      throw IllegalStateException("link: $log")
    }
    return p
  }

  private fun compile(type: Int, src: String): Int {
    val s = GLES30.glCreateShader(type)
    GLES30.glShaderSource(s, src); GLES30.glCompileShader(s)
    val ok = IntArray(1); GLES30.glGetShaderiv(s, GLES30.GL_COMPILE_STATUS, ok, 0)
    if (ok[0] == 0) {
      val log = GLES30.glGetShaderInfoLog(s); GLES30.glDeleteShader(s)
      throw IllegalStateException("compile: $log")
    }
    return s
  }

  private fun uploadYuv(image: Image) {
    val w = image.width; val h = image.height
    val planes = image.planes
    yBuf = repack(planes[0].buffer, planes[0].rowStride, planes[0].pixelStride, w, h, yBuf)
    uBuf = repack(planes[1].buffer, planes[1].rowStride, planes[1].pixelStride, w / 2, h / 2, uBuf)
    vBuf = repack(planes[2].buffer, planes[2].rowStride, planes[2].pixelStride, w / 2, h / 2, vBuf)
    texAllocW = w; texAllocH = h
    uploadPlane(0, yBuf!!, w, h)
    uploadPlane(1, uBuf!!, w / 2, h / 2)
    uploadPlane(2, vBuf!!, w / 2, h / 2)
  }

  private fun repack(src: ByteBuffer, rowStride: Int, pixelStride: Int, w: Int, h: Int, reuse: ByteBuffer?): ByteBuffer {
    val out = if (reuse != null && reuse.capacity() >= w * h) reuse else ByteBuffer.allocateDirect(w * h)
    out.clear()
    src.rewind()
    if (pixelStride == 1 && rowStride == w) {
      val limit = minOf(src.remaining(), w * h)
      val dup = src.duplicate(); dup.limit(limit)
      out.put(dup)
    } else {
      val row = ByteArray(rowStride)
      for (y in 0 until h) {
        val base = y * rowStride
        val len = minOf(rowStride, src.capacity() - base)
        src.position(base)
        src.get(row, 0, len)
        if (pixelStride == 1) out.put(row, 0, w)
        else for (x in 0 until w) out.put(row[x * pixelStride])
      }
    }
    out.rewind()
    return out
  }

  private fun uploadPlane(unit: Int, buf: ByteBuffer, w: Int, h: Int) {
    GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + unit)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texIds[unit])
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R8, w, h, 0, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, buf)
  }

  /**
   * @param intensityOverride still path only (shutter snapshot); the preview reads the live value.
   * @param scanRotation rotation at which the output is upright; differs from frameRotation only
   * in the preview, which draws at sensor rotation but must smear along the still's horizontal.
   */
  private fun draw(styled: Boolean, frameW: Float, frameH: Float, intensityOverride: Float? = null,
    frameRotation: Int = rotationDegrees, scanRotation: Int = frameRotation) {
    val p = profile
    GLES30.glUseProgram(program)
    GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, quadVbo)
    GLES30.glEnableVertexAttribArray(0)
    GLES30.glVertexAttribPointer(0, 2, GLES30.GL_FLOAT, false, 0, 0)
    fun uni(name: String) =
      uniformLocations.getOrPut(name) { GLES30.glGetUniformLocation(program, name) }
    GLES30.glUniform1i(uni("uTexY"), 0)
    GLES30.glUniform1i(uni("uTexU"), 1)
    GLES30.glUniform1i(uni("uTexV"), 2)
    GLES30.glUniform1i(uni("uLut"), 3)
    GLES30.glUniform1i(uni("uRotation"), frameRotation)
    val i100 = (intensityOverride ?: intensity) * 100f
    // Axis convention: vUv is in SOURCE-texture axes, so uFrameSize is too — swap the output-frame
    // dims under 90/270 or grain cells / CA offsets / soften taps go anisotropic (4:3 vs 3:4).
    val rotated = frameRotation == 90 || frameRotation == 270
    GLES30.glUniform2f(uni("uFrameSize"), if (rotated) frameH else frameW, if (rotated) frameW else frameH)
    // uRefScale is rotation-invariant: the long edge is the long edge either way.
    GLES30.glUniform1f(uni("uRefScale"), maxOf(frameW, frameH) / REF_LONG_EDGE)
    // Upright picture's rightward direction in source uv: the derivative of VERTEX_SRC's rotation
    // remap (90: (uv.y, 1-uv.x), 180: (1-uv.x, 1-uv.y), 270: (1-uv.y, uv.x)). Programs without an
    // anisotropic stage get location -1, which glUniform ignores.
    when (scanRotation) {
      90 -> GLES30.glUniform2f(uni("uScanAxis"), 0f, -1f)
      180 -> GLES30.glUniform2f(uni("uScanAxis"), -1f, 0f)
      270 -> GLES30.glUniform2f(uni("uScanAxis"), 0f, 1f)
      else -> GLES30.glUniform2f(uni("uScanAxis"), 1f, 0f)
    }
    GLES30.glUniform1i(uni("uStyled"), if (styled) 1 else 0)
    if (p != null) {
      GLES30.glUniform1f(uni("uLutSize"), p.lutSize.toFloat())
      GLES30.glUniform1f(uni("uLutMix"), p.evalCurve(p.lutMixCurve, 1f, i100))
      for (idx in p.stages.indices) {
        val st = p.stages[idx]
        for ((param, name) in stageUniforms[idx]) {
          GLES30.glUniform1f(uni(name), p.resolved(st, param, i100))
        }
      }
    }
    GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)
  }
}
