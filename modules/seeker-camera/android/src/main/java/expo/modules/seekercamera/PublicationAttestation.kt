package expo.modules.seekercamera

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android key attestation of one publication manifest: a fresh P-256 key, challenge = SHA-256 of
 * the manifest, device properties attested (API 31+), signs the manifest and is deleted. The chain
 * and signature are the evidence. A device that cannot attest returns `available: false`, not an error.
 */
internal object PublicationAttestation {
  private const val TAG = "SeekerCamera"
  private const val ALIAS_PREFIX = "signshot-attestation-"

  fun attest(manifest: ByteArray): JSONObject {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S)
      return unavailable("device property attestation needs Android 12 or newer")
    sweepStaleAliases()
    val challenge = MessageDigest.getInstance("SHA-256").digest(manifest)
    var lastReason = "hardware key attestation is unavailable on this device"
    for (strongBox in listOf(true, false)) {
      try {
        return generateAndSign(manifest, challenge, strongBox)
      } catch (e: StrongBoxUnavailableException) {
        lastReason = "StrongBox is unavailable"
      } catch (e: Throwable) {
        Log.w(TAG, "attestation (strongBox=$strongBox) failed", e)
        lastReason = "${e.javaClass.simpleName}: ${e.message ?: "attestation failed"}"
      }
    }
    return unavailable(lastReason)
  }

  private fun unavailable(reason: String) =
    JSONObject().put("available", false).put("reason", reason)

  /**
   * Process death before the `finally` below leaks an alias, and StrongBox key slots are finite,
   * so each call first deletes leftovers under ALIAS_PREFIX. No other entry is touched.
   */
  private fun sweepStaleAliases() {
    runCatching {
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      for (alias in store.aliases().toList())
        if (alias.startsWith(ALIAS_PREFIX)) runCatching { store.deleteEntry(alias) }
    }.onFailure { Log.w(TAG, "attestation alias sweep failed", it) }
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun generateAndSign(manifest: ByteArray, challenge: ByteArray, strongBox: Boolean): JSONObject {
    val alias = ALIAS_PREFIX + UUID.randomUUID()
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    try {
      val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setAttestationChallenge(challenge)
        // Brand, device, product, manufacturer and model — never serial, IMEI or MEID.
        .setDevicePropertiesAttestationIncluded(true)
        .apply { if (strongBox) setIsStrongBoxBacked(true) }
        .build()
      val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
      generator.initialize(spec)
      val pair = generator.generateKeyPair()
      val signature = Signature.getInstance("SHA256withECDSA").run {
        initSign(pair.private)
        update(manifest)
        sign()
      }
      val chain = store.getCertificateChain(alias) ?: throw IllegalStateException("no certificate chain")
      if (chain.isEmpty()) throw IllegalStateException("empty certificate chain")
      val certificates = JSONArray()
      chain.forEach { certificates.put(Base64.encodeToString(it.encoded, Base64.NO_WRAP)) }
      return JSONObject()
        .put("available", true)
        // What was requested; the certificate's security level is the evidence.
        .put("strongBox", strongBox)
        .put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
        .put("certificates", certificates)
    } finally {
      runCatching { if (store.containsAlias(alias)) store.deleteEntry(alias) }
    }
  }
}
