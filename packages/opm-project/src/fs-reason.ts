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

/**
 * Text taken from a file in the project (a path a record names) as a message
 * shows it: control characters, an escape sequence among them, are `?`.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '?');
}

/** `.opm/<name>` as a message shows it: a name in a project is text from a file. */
export function opmEntry(name: string): string {
  return printable(`.opm/${name}`);
}
