/**
 * What a refusal of the file system means, in words a person can act on. Never
 * the name of the call that failed or a path built from a descriptor.
 */
const REASONS: Record<string, string> = {
  EBUSY: 'it is in use (a mount point, or something holds it open)',
  EXDEV: 'it is on another file system than the copy',
  EACCES: 'opm may not change it',
  EPERM: 'opm may not change it',
  EROFS: 'its file system is read-only',
  ENOSPC: 'the disk is full',
  ENOTEMPTY: 'something is still writing into it',
};

export function plainReason(error: NodeJS.ErrnoException): string {
  return (
    (error.code === undefined ? undefined : REASONS[error.code]) ??
    error.message
  );
}

/** Whether `error` is the file system refusing opm a change, rather than a bug. */
export function isRefusal(error: Error): error is NodeJS.ErrnoException {
  return (
    'code' in error &&
    typeof error.code === 'string' &&
    ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT'].includes(error.code)
  );
}
