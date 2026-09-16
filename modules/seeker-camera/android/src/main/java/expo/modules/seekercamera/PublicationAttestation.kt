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
 * Android key attestation of one publication manifest. The keystore generates a fresh P-256 key
 * whose attestation challenge is the manifest's SHA-256 and whose certificate carries the
 * device's attested brand/model (API 31+), the key signs the manifest bytes, and the key is
 * deleted: the certificate chain and the signature are the durable evidence, not the key.
 *
 * Only this call's own fresh alias is ever touched. No wallet material, no existing keystore
 * entries, no camera files. A device that cannot attest answers `available: false`; it is never
 * an error, because publishing must not depend on it.
 */
internal object PublicationAttestation {
  private const val TAG = "SeekerCamera"
  private const val ALIAS_PREFIX = "seedshot-attestation-"

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
   * A process death between key generation and the `finally` below leaves an alias behind, and
   * StrongBox has a finite key budget, so every call first removes any alias of ours. Only our
   * own prefix is ever touched; nothing else in the keystore is enumerated for any other purpose.
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
        // Diagnostic only: what was REQUESTED. The certificate's security level is the evidence.
        .put("strongBox", strongBox)
        .put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
        .put("certificates", certificates)
    } finally {
      runCatching { if (store.containsAlias(alias)) store.deleteEntry(alias) }
    }
  }
}
