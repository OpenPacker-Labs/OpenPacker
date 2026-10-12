/**
 * Every refusal the workspace model makes carries one of these codes, so a
 * caller can tell a hostile or malformed workspace from a limit it set itself
 * without reading the message.
 */
export type WorkspaceErrorCode =
  | 'WORKSPACE_DECLARATION_INVALID'
  | 'WORKSPACE_PATTERN_INVALID'
  | 'WORKSPACE_PATTERN_ESCAPES_ROOT'
  | 'WORKSPACE_PATTERN_UNSUPPORTED'
  | 'WORKSPACE_LIMIT_EXCEEDED'
  | 'WORKSPACE_MANIFEST_INVALID'
  | 'WORKSPACE_NAME_INVALID'
  | 'WORKSPACE_NAME_DUPLICATE'
  | 'WORKSPACE_SYMLINK'
  | 'WORKSPACE_SPEC_UNSUPPORTED'
  | 'WORKSPACE_SPEC_UNRESOLVED'
  | 'WORKSPACE_CYCLE'
  | 'WORKSPACE_FILTER_INVALID'
  | 'WORKSPACE_FILTER_UNSUPPORTED'
  | 'WORKSPACE_FILTER_NO_MATCH';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  /**
   * What the refusal is about, for a program to act on: member directories
   * (relative, `''` for the root) or names, one entry per party, in a stable
   * order. The message already names them for a person.
   */
  readonly subjects: readonly string[];

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    subjects: readonly string[] = [],
  ) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.subjects = subjects;
  }
}
