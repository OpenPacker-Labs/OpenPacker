/**
 * The owner file of a directory lives in `@openpacker/project-io`
 * (`owner-file.ts` there), with the owner rule it is read by.
 */
export {
  OWNER_FILE,
  ownerFileProblem,
  readOwnerFile,
  writeOwnerFile,
  type OwnerFileProblem,
} from '@openpacker/project-io';
