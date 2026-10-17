/**
 * The exit codes of `opm`, which tell a script what kind of failure it was,
 * and the one an `OpmError`'s code maps to.
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

/** The exit code of a failure whose `OpmError` code is `code`. */
export function opmErrorExitCode(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
    case 'NO_PROJECT':
    case 'PLUGIN_NOT_INSTALLED':
      return EXIT_CODES.notFound;
    case 'AMBIGUOUS_SPEC':
    case 'INVALID_SPEC':
    case 'INVALID_MANIFEST':
    case 'INVALID_LOCK':
    case 'UNSUPPORTED_LOCK':
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
