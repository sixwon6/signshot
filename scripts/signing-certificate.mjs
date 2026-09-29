/**
 * Whether `apksigner verify --print-certs` output names exactly one signer, with the upload
 * certificate's SHA-256, and no debug key. Matches by fingerprint, never by subject name.
 */
export function matchesUploadCertificate(output, expectedSha256) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256) || /androiddebugkey/i.test(output)) return false;
  const certificates = [...output.matchAll(/^Signer #(\d+) certificate SHA-256 digest:\s*([a-f0-9]{64})\s*$/gmi)];
  return certificates.length === 1 && certificates[0][1] === "1" &&
    certificates[0][2].toLowerCase() === expectedSha256.toLowerCase();
}
