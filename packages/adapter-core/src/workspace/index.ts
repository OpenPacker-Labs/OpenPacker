export { WorkspaceError, type WorkspaceErrorCode } from './errors.js';
export {
  DEFAULT_WORKSPACE_LIMITS,
  resolveWorkspaceLimits,
  type WorkspaceLimits,
} from './limits.js';
export { compareText, workspaceNameProblem } from './names.js';
export { findDuplicateJsonKey, parseStrictJson } from './strict-json.js';
export {
  DEPENDENCY_FIELDS,
  readWorkspaceManifest,
  workspacePatternsOf,
  type DependencyField,
  type DependencyMap,
  type WorkspaceManifest,
} from './manifest.js';
export {
  assembleMembers,
  describeMember,
  nameFromDirectory,
  type MemberSource,
  type WorkspaceMember,
  type WorkspaceTool,
} from './members.js';
export {
  compileGlob,
  expandBraces,
  globMatches,
  globMayMatchBelow,
  textMatchesGlob,
  type GlobAlternative,
  type Segment,
} from './glob.js';
export {
  compileWorkspacePatterns,
  type WorkspacePatterns,
} from './patterns.js';
