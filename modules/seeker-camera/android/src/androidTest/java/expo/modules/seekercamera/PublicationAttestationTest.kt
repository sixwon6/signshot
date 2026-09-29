package expo.modules.seekercamera

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs the production attestation path (`PublicationAttestation.attest`) on a connected phone
 * against the sample manifest from `scripts/fixtures/attestation-sample.json`, and prints the
 * result so `scripts/wrap-device-attestation.ts` and `scripts/verify-attestation.ts --file` can
 * check the real chain off-device. Touches no camera, wallet or user files; only its own fresh
 * key alias.
 *
 * The attested package is this TEST package with its debug signer, so the verifier's `app`
 * check is expected to fail; every other check should pass on a genuine Seeker.
 */
@RunWith(AndroidJUnit4::class)
class PublicationAttestationTest {
  @Test fun attestSampleManifest() {
    val manifest = """{"capturedAtMs":1789000000000,"cleanHash":"4444444444444444444444444444444444444444444444444444444444444444","cluster":"devnet","collection":"SampLe2222222222222222222222222222222222222","creator":"SampLe3333333333333333333333333333333333333","edition":"SampLe1111111111111111111111111111111111111","height":3264,"imageHash":"2222222222222222222222222222222222222222222222222222222222222222","nonce":"1111111111111111111111111111111111111111111111111111111111111111","program":"7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU","schema":"seedshot-attestation/1","sourceHash":"3333333333333333333333333333333333333333333333333333333333333333","styledHash":"5555555555555555555555555555555555555555555555555555555555555555","width":2448}"""
    val result = PublicationAttestation.attest(manifest.toByteArray(Charsets.UTF_8))
    // The test package's private storage is removed with the package after the run, so the
    // result goes into the report's captured output for the host to extract; captured lines are
    // truncated near 4 KB, so it is printed in numbered 1000-character chunks.
    val text = result.toString()
    text.chunked(1000).forEachIndexed { i, chunk -> println("ATTESTATION_PART:${"%03d".format(i)}:$chunk") }
    println("ATTESTATION_PARTS:${(text.length + 999) / 1000}")
    assertTrue("attestation must be available on a Seeker: $result", result.optBoolean("available"))
  }
}
