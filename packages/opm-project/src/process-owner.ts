/**
 * The owner rule lives in `@openpacker/project-io` (`process-owner.ts`
 * there), which the sandbox's jail homes are judged by too; opm-project's
 * holders (a step's lock, its rollback copy, a run's scratch) reach it here.
 */
export {
  currentOwner,
  describeProcessOwner,
  isOwnerAlive,
  makeCurrentOwner,
  ownerKey,
  ownerPlace,
  parseMachineId,
  parseProcessOwner,
  placeDigest,
  systemProbe,
  type OwnerPlace,
  type OwnerProbe,
  type OwnerReads,
  type PlaceOptions,
  type ProcessOwner,
} from '@openpacker/project-io';
