package expo.modules.seekercamera

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs `PublicationAttestation.attest` on a device over the manifest in
 * `scripts/fixtures/attestation-sample.json` and prints the result for
 * `scripts/wrap-device-attestation.ts` and `scripts/verify-attestation.ts --file`.
 * The attested app is this debug-signed test package, so only the verifier's `app` check fails.
 */
@RunWith(AndroidJUnit4::class)
class PublicationAttestationTest {
  @Test fun attestSampleManifest() {
    val manifest = """{"capturedAtMs":1789000000000,"cleanHash":"4444444444444444444444444444444444444444444444444444444444444444","cluster":"devnet","collection":"SampLe2222222222222222222222222222222222222","creator":"SampLe3333333333333333333333333333333333333","edition":"SampLe1111111111111111111111111111111111111","height":3264,"imageHash":"2222222222222222222222222222222222222222222222222222222222222222","nonce":"1111111111111111111111111111111111111111111111111111111111111111","program":"CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J","schema":"signshot-attestation/1","sourceHash":"3333333333333333333333333333333333333333333333333333333333333333","styledHash":"5555555555555555555555555555555555555555555555555555555555555555","width":2448}"""
    val result = PublicationAttestation.attest(manifest.toByteArray(Charsets.UTF_8))
    // Test storage is wiped after the run, so the result goes to stdout, chunked because captured
    // lines are truncated near 4 KB.
    val text = result.toString()
    text.chunked(1000).forEachIndexed { i, chunk -> println("ATTESTATION_PART:${"%03d".format(i)}:$chunk") }
    println("ATTESTATION_PARTS:${(text.length + 999) / 1000}")
    assertTrue("attestation must be available on a Seeker: $result", result.optBoolean("available"))
  }
}
