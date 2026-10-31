/**
 * What `opm` exits with, and the exit code of each refusal it reports: an
 * `OpmError` by its code, and an error a provider or a delegated plugin raised
 * by the string code it carries.
 */
export const EXIT_CODES = {
  success: 0,
  usage: 2,
  invalidInput: 3,
  notFound: 4,
  unsatisfiable: 5,
  policyDenied: 6,
  verificationFailed: 7,
  unavailable: 8,
  internal: 9,
} as const;

/** The exit code of an `OpmError` of this code. */
export function opmErrorExit(code: string): number {
  switch (code) {
    // What the person wrote, in an option or the environment, is not usable.
    case 'USAGE':
      return EXIT_CODES.usage;
    case 'NOT_FOUND':
    case 'NO_PROJECT':
    case 'PLUGIN_NOT_INSTALLED':
      return EXIT_CODES.notFound;
    case 'AMBIGUOUS_SPEC':
    case 'INVALID_SPEC':
    case 'INVALID_MANIFEST':
    case 'INVALID_LOCK':
    case 'UNSUPPORTED_LOCK':
    case 'INVALID_ROLLBACK':
    case 'ROLLBACK_CONFLICT':
    case 'PATCH_FAILED':
    case 'INVALID_PATCH':
    case 'INVALID_CATALOG':
    case 'INVALID_PLUGIN_SPEC':
    case 'INVALID_PLUGIN_MANIFEST':
    case 'INVALID_PLUGIN_ARTIFACT':
    case 'PLUGIN_ALREADY_INSTALLED':
    case 'PLUGIN_ID_CONFLICT':
      return EXIT_CODES.invalidInput;
    case 'UNRESOLVABLE':
      return EXIT_CODES.unsatisfiable;
    case 'DIGEST_MISMATCH':
    case 'PLUGIN_DIGEST_MISMATCH':
    case 'SIZE_MISMATCH':
    case 'UNSAFE_PATH':
    case 'UNSAFE_BIN':
    case 'UNSAFE_SOURCE':
    case 'SIZE_LIMIT':
    case 'INVALID_DIGEST':
      return EXIT_CODES.verificationFailed;
    case 'OFFLINE':
    case 'FETCH_FAILED':
    case 'UNAVAILABLE':
    case 'STORE_ENTRY_VANISHED':
    case 'PROJECT_BUSY':
    case 'PROJECT_READ_ONLY':
    case 'STEP_ALIVE':
    case 'PLUGIN_ERROR':
    case 'PLUGIN_FAILED':
    case 'PLUGIN_REGISTRY_UNCONFIGURED':
      return EXIT_CODES.unavailable;
    case 'ECOSYSTEM_DENIED':
    case 'POLICY':
    case 'POLICY_DENIED':
    case 'POLICY_INDETERMINATE':
      return EXIT_CODES.policyDenied;
    default:
      return EXIT_CODES.internal;
  }
}

/** The exit code of a provider's or a plugin's error of this code. */
export function providerErrorExit(code: string): number {
  switch (code) {
    case 'OFFLINE':
    case 'UPSTREAM_UNAVAILABLE':
    case 'UPSTREAM_RESPONSE_TOO_LARGE':
    case 'INVALID_PROVIDER_RESPONSE':
    case 'PLUGIN_ERROR':
    case 'PLUGIN_FAILED':
    // The registry changed a document the resolve had read: its state, not
    // the project's or opm's, and a run once it has settled can succeed.
    case 'STALE_METADATA':
      return EXIT_CODES.unavailable;
    case 'PACKAGE_NOT_FOUND':
    case 'ARTIFACT_NOT_FOUND':
    case 'VERSION_NOT_FOUND':
    case 'PLUGIN_NOT_INSTALLED':
      return EXIT_CODES.notFound;
    case 'DIGEST_MISMATCH':
    case 'SIZE_MISMATCH':
    // A signed release whose signature, signer, or signed document does
    // not hold is a verification failure, the same as bytes that do not
    // hash. (`INVALID_PROVIDER_METADATA` stays what it was: another
    // registry's malformed response is not evidence of tampering.)
    case 'SIGNATURE_VERIFICATION_FAILED':
    case 'INVALID_PACKSLIP_METADATA':
      return EXIT_CODES.verificationFailed;
    case 'INVALID_PURL':
    case 'UNSUPPORTED_OPERATION':
    case 'INVALID_PACKSLIP_INPUT':
      return EXIT_CODES.invalidInput;
    case 'UNRESOLVABLE':
    // Nothing wrong with the release, but nothing in it fits this machine.
    case 'HOST_INCOMPATIBLE':
      return EXIT_CODES.unsatisfiable;
    // A signer that changed is a decision for a person, not a failure; an
    // archive over the limit is a limit opm sets.
    case 'TRUST_CHANGE_REQUIRES_APPROVAL':
    case 'ARTIFACT_TOO_LARGE':
      return EXIT_CODES.policyDenied;
    default:
      return EXIT_CODES.internal;
  }
}
