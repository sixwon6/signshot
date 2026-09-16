package expo.modules.seekercamera

import kotlin.math.abs
import kotlin.math.min

/** Physical phone orientation, independent of the camera UI's portrait lock. Back camera only. */
internal class CaptureOrientation {
  @Volatile private var deviceDegrees = 0

  fun update(degrees: Int) {
    // Face-up/down readings are unknown; keep the last useful orientation.
    if (degrees !in 0..359) return
    val difference = abs(degrees - deviceDegrees)
    // Five degrees of hysteresis around the quadrant boundary prevents tilted shots oscillating.
    if (min(difference, 360 - difference) >= 50)
      deviceDegrees = ((degrees + 45) / 90 * 90) % 360
  }

  fun rotation(sensorDegrees: Int): Int = (sensorDegrees + deviceDegrees) % 360
}
