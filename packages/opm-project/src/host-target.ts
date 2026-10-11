/**
 * The machine a resolve or an install is for, and the evaluation of a target
 * predicate against it. Defined once in `@openpacker/adapter-core`, where the
 * ecosystem adapters that read a lock can reach it too; re-exported here so the
 * closure walk keeps its import.
 */
export {
  detectLibc,
  detectNativeTarget,
  evaluateTargetPredicate,
  type NativeTarget,
} from '@openpacker/adapter-core';
