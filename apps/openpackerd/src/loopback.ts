import { parseUntrustedUrl } from '@openpacker/canonical';

/**
 * Hosts the reference daemon is willing to bind without an explicit override.
 *
 * The control plane is unauthenticated by design (capabilities say so). That
 * is only safe on a loopback interface. Binding `0.0.0.0` / `::` would expose
 * normalize/solve/materialize to the network with no auth — refuse that unless
 * the operator opts in with `allowRemoteBind`.
 */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Whether a `Host` header names this machine. The header is a network peer's
 * text, so it is read through the guard: a host no DNS name could be is refused
 * without the URL parser spending most of a second on it.
 */
export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (authority === undefined) return false;
  try {
    const url = parseUntrustedUrl(`http://${authority}`);
    return (
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

/** Whether an `Origin` header names this machine, read the same way. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = parseUntrustedUrl(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return LOOPBACK_HOSTS.has(
    normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized,
  );
}
