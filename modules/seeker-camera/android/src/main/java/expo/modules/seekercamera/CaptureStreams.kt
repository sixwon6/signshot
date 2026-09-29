package expo.modules.seekercamera

import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.util.Size

/** The renderer and viewfinder use 4:3. Select only sizes the current camera advertises. */
data class CaptureStreams(val preview: Size, val still: Size) {
  companion object {
    fun read(chars: CameraCharacteristics): CaptureStreams {
      val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        ?: error("Camera does not report supported image sizes")
      return choose(map.getOutputSizes(ImageFormat.YUV_420_888)?.toList().orEmpty())
    }

    fun choose(supported: List<Size>): CaptureStreams {
      val sizes = supported.filter {
        it.width > 0 && it.height > 0 && it.width.toLong() * 3 == it.height.toLong() * 4
      }.sortedBy { pixels(it) }
      require(sizes.isNotEmpty()) { "Camera does not support 4:3 YUV photographs" }
      // The Seeker's own sizes when advertised, else the largest 4:3 size under the cap. The
      // ~12 MP still cap (4032 x 3024 included) bounds memory for full-size GL rendering.
      fun pick(preferred: Size, maxPixels: Long): Size =
        sizes.firstOrNull { it == preferred }
          ?: sizes.lastOrNull { pixels(it) <= maxPixels }
          ?: error("Camera has no supported image size within the capture memory limit")
      return CaptureStreams(
        preview = pick(Size(1600, 1200), 1_920_000),
        still = pick(Size(4000, 3000), 12_500_000),
      )
    }

    private fun pixels(size: Size): Long = size.width.toLong() * size.height
  }
}
