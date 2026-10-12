/**
 * Text that is safe to put in a message, a log line or a report: the
 * credentials an address can carry are taken out.
 *
 * The reader refuses an address with a user name and password in it, and a lock
 * pnpm wrote never has one, so the refusal is where a secret would otherwise
 * be quoted back: a key, a dependency value or a path to the failure is the
 * address itself. Every `PnpmLockError` and every problem the validator lists
 * passes through here, so no message has to remember to.
 *
 * ```
 * https://user:secret@host/a.tgz?sig=abc   ->  https://[redacted]@host/a.tgz?[redacted]
 * git+ssh://git@host/o/r.git#<commit>      ->  unchanged (the user `git` is no secret)
 * https://host/@scope/a/-/a-1.0.0.tgz      ->  unchanged (an `@` in a path is not a user)
 * ```
 *
 * The user name goes as well as the password: a token is as often one as the
 * other. The query string goes because a signed URL keeps its credential there.
 * The host, the path and the fragment (a git commit) stay, so a message still
 * says which address it means.
 */

/**
 * `scheme://authority path ?query`. The scheme must start a word, so a long
 * run of letters is scanned once and not once per letter.
 */
const ADDRESS =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#]*)([^\s?#]*)(\?[^\s#"]*)?/gu;

/** The one user name that is not a secret: the conventional one for a git host. */
const OPEN_USER = 'git';

function redactAddress(
  _match: string,
  scheme: string,
  authority: string,
  path: string,
  query: string | undefined,
): string {
  // The last `@` ends the user information: an unescaped `@` may sit in a password.
  const at = authority.lastIndexOf('@');
  const shown =
    at === -1 || authority.slice(0, at) === OPEN_USER
      ? authority
      : `[redacted]${authority.slice(at)}`;
  return `${scheme}${shown}${path}${query === undefined ? '' : '?[redacted]'}`;
}

/** `text` with the user information and the query string of every address in it replaced by `[redacted]`. */
export function redactAddresses(text: string): string {
  return text.includes('://') ? text.replace(ADDRESS, redactAddress) : text;
}
