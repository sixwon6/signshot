package expo.modules.seekercamera

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.util.Size
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Device checks for the shipped camera configuration. Takes no photographs. */
@RunWith(AndroidJUnit4::class)
class CaptureControlsTest {
  @Test fun stillRotationFollowsPhysicalPhoneWithPortraitUiLocked() {
    val orientation = CaptureOrientation()
    assertEquals(90, orientation.rotation(90))
    orientation.update(270)
    assertEquals(0, orientation.rotation(90))
    orientation.update(-1)
    assertEquals("Laying the phone flat must preserve its last orientation", 0, orientation.rotation(90))
    orientation.update(180)
    assertEquals(270, orientation.rotation(90))
    orientation.update(90)
    assertEquals(180, orientation.rotation(90))
    orientation.update(0)
    orientation.update(49)
    assertEquals(90, orientation.rotation(90))
    orientation.update(51)
    assertEquals(180, orientation.rotation(90))
    orientation.update(44)
    assertEquals("A small tilt back across 45 degrees must not flip the saved photo", 180, orientation.rotation(90))
    orientation.update(39)
    assertEquals(90, orientation.rotation(90))
  }

  private fun characteristics(): CameraCharacteristics {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    return manager.getCameraCharacteristics("0")
  }

  @Test fun seekerSupportsConfiguredStreamsAndManualExposure() {
    val chars = characteristics()
    val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!
    val sizes = map.getOutputSizes(ImageFormat.YUV_420_888).toSet()
    val streams = CaptureStreams.read(chars)
    assertTrue("Selected preview size must be advertised by the camera", sizes.contains(streams.preview))
    assertTrue("Selected still size must be advertised by the camera", sizes.contains(streams.still))
    println("Selected streams: preview=${streams.preview}, still=${streams.still}")
    val caps = CaptureCaps.read(chars)
    assertTrue("The Seeker Pro controls require manual sensor support", caps.manualSensor)
    assertNotNull(caps.isoMin)
    assertNotNull(caps.shutterMinNs)
  }

  @Test fun streamSelectionHandlesMissingOldSizesAndBoundsMemory() {
    val streams = CaptureStreams.choose(listOf(Size(640, 480), Size(1440, 1080),
      Size(4032, 3024), Size(8000, 6000), Size(1920, 1080)))
    assertEquals(Size(1440, 1080), streams.preview)
    assertEquals(Size(4032, 3024), streams.still)
    val original = CaptureStreams.choose(listOf(Size(1600, 1200), Size(4000, 3000)))
    assertEquals(Size(1600, 1200), original.preview)
    assertEquals(Size(4000, 3000), original.still)
  }

  @Test fun movingOneExposureDialHoldsBothAndAutoReleasesBoth() {
    val caps = CaptureCaps.read(characteristics())
    val iso = 200.coerceIn(caps.isoMin!!, caps.isoMax!!)
    val shutter = 8_000_000L.coerceIn(caps.shutterMinNs!!, caps.shutterMaxNs!!)
    val isoOnly = CaptureSettings.AUTO.copy(iso = iso).resolve(caps, iso, shutter)
    assertTrue(isoOnly.manualExposure)
    assertEquals(iso, isoOnly.iso)
    assertEquals(shutter, isoOnly.shutterNs)
    val shutterOnly = CaptureSettings.AUTO.copy(shutterNs = shutter).resolve(caps, iso, shutter)
    assertTrue(shutterOnly.manualExposure)
    assertEquals(iso, shutterOnly.iso)
    assertEquals(shutter, shutterOnly.shutterNs)
    val auto = CaptureSettings.AUTO.resolve(caps, iso, shutter)
    assertFalse(auto.manualExposure)
    assertNull(auto.iso)
    assertNull(auto.shutterNs)
  }

  @Test fun manualExposureClearsCompensationAndExposureLock() {
    val caps = CaptureCaps.read(characteristics())
    val held = CaptureSettings.AUTO.copy(iso = caps.isoMin, ev = 2, aeLock = true)
      .resolve(caps, caps.isoMin, caps.shutterMinNs)
    assertTrue(held.manualExposure)
    assertEquals(0, held.ev)
    assertFalse(held.aeLock)
  }
}
