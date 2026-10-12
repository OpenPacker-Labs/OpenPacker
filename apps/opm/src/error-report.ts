import { redactUrl } from '@openpacker/adapter-core';
import { plainLine, plainText } from '@openpacker/canonical';

/**
 * How an unexpected failure is reported by `opm` and `opmx`.
 *
 * Node's `fetch` reports every network fault as `TypeError: fetch failed` and
 * keeps the reason (`ECONNREFUSED`, `ENOTFOUND`, a refused proxy tunnel) on
 * `error.cause`. Printing only the message left a person with nothing to act
 * on, so an error that carries no code of its own is printed with its cause
 * chain. Everything printed passes the same redaction: a URL keeps its origin
 * and path and loses userinfo, query and fragment (`redactUrl`), and a value
 * that follows a credential-shaped name is withheld.
 *
 * What is printed is made plain first, once, here, and that is the second layer
 * of two. A message can carry text a registry chose (a dependency's name, a
 * version, a key in its document) on its way from an adapter. Where that is
 * known, the adapter or the policy makes the text plain at its source
 * (`safeEcho` in `@openpacker/canonical`: npm's dependency names, ranges and
 * owners, the policy's publish-time bound), so that a library user gets it
 * too. This writer does not rely on that: `plainText` (the same package, the
 * one definition of what a terminal must not be sent) removes escape sequences
 * and control, format and bidirectional characters, turns a tab into a space
 * and a carriage return into a line break, and keeps the line breaks a message
 * carries, because several of opm's own errors are lists, one entry to a line.
 * What it cannot do is tell an entry opm wrote from a line a registry added: a
 * message that reaches it with a line feed from a registry in it can start a
 * line of its own, in plain text. Flattening that text where it is quoted is
 * the first layer's job, and it is done at the source for what a registry or a
 * cloned repository sends: `echoed` in @openpacker/adapter-core (its shared
 * parsers, the PyPI, Cargo, NuGet, Maven, Go, OCI and PREX registry adapters, the
 * plugin store, opm-project's reading of opm.toml, opm.lock.json and the npm
 * lock, and the apt, Chocolatey, winget and Nix refusals), `safeEcho` in the OCI
 * client, the materializer, npm and the policy, and `plainLine` for what
 * `opm list`, `why` and `import --native` print. Text that does not come
 * through one of those (a plugin's, a path project-io refuses, a packer's file
 * name, a child's own stderr) reaches this writer unflattened, safe from
 * escapes and not from line feeds. It also reads an unterminated `ESC ]` or
 * `ESC P` as running to the end of the message, as a terminal does, so a field
 * that ends in one drops the entries after it (ADR 0044). The `openpacker`
 * command line (`apps/openpacker-cli`) has no writer and is not covered.
 */

/**
 * What an error's `message` may be when the error came from a library: its type
 * says a string, and a foreign value need not keep to that.
 */
export type MessageLike = string | number | boolean | bigint | null | undefined;

/**
 * `prefix` and `message` as the lines of an error report, ending in a newline.
 * The prefix is ours; the message is made plain and keeps its line breaks. A
 * message that is not a string is written as `String` writes it.
 */
export function report(prefix: string, message: MessageLike): string {
  return `${prefix}${plainText(String(message))}\n`;
}

/** How many `cause` links below the reported error are followed. */
export const MAX_CAUSE_DEPTH = 3;
/** How many sub-errors of an `AggregateError` are named on its line. */
const MAX_AGGREGATED = 3;
const MAX_LINE_LENGTH = 300;

/** Proxy variables Node's built-in fetch honours once NODE_USE_ENV_PROXY=1. */
const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

/** Codes that mean the connection itself failed, not that a peer refused us. */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** The same faults when only a message survives (a wrapped or foreign error). */
const CONNECTION_MESSAGE =
  /\b(?:ECONN(?:REFUSED|RESET|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|socket hang up|network socket disconnected|other side closed|connect timeout|proxy response/iu;

type Environment = Readonly<Record<string, string | undefined>>;

export interface FailureReportOptions {
  /** `opm` or `opmx`: the prefix of every line. */
  tool: 'opm' | 'opmx';
  /** `opm` words an unexpected failure as "internal error: …"; `opmx` does not. */
  internalError?: boolean;
  /** The process environment; injectable for tests. */
  env?: Environment;
}

/** One link of a cause chain, already scrubbed and flattened to a line. */
export interface CauseLink {
  text: string;
  connectionFault: boolean;
}

/** A caught value, decoded once at the boundary. */
export interface Failure {
  message: string;
  /**
   * Whether the error carries a string `code`, which is how opm and the
   * provider layer name the failures they expect. Anything else is unexpected.
   */
  coded: boolean;
  causes: CauseLink[];
}

/** The fields an Error, a DOMException or a foreign throwable may expose. */
interface ErrorFields {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
}

function fieldsOf(value: unknown): ErrorFields | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Withhold what must not reach a terminal, a log or a pasted bug report. */
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/giu, (match) => {
      try {
        const url = new URL(match);
        // A URL with an opaque origin (`socks5://…`) still has a host.
        return url.origin === 'null'
          ? `${url.protocol}//${url.host}${url.pathname}`
          : redactUrl(url);
      } catch {
        return '[url]';
      }
    })
    .replace(
      /\b([\w-]*(?:authorization|token|secret|password|passwd|api[_-]?key))(\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;'")\]]+/giu,
      (_match, name: string, separator: string) =>
        `${name}${separator}[REDACTED]`,
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
      (_match, scheme: string) => `${scheme} [REDACTED]`,
    );
}

function oneLine(text: string): string {
  // Plain before scrubbed: a credential-shaped name with a zero-width character
  // in it must be read as the terminal would show it, or it escapes the scrub.
  const flat = scrub(plainLine(text)).replace(/\s+/gu, ' ').trim();
  return flat.length > MAX_LINE_LENGTH
    ? `${flat.slice(0, MAX_LINE_LENGTH)}…`
    : flat;
}

function isConnectionFault(value: unknown): boolean {
  const fields = fieldsOf(value);
  const code = nonEmpty(fields?.code);
  if (code !== undefined && CONNECTION_CODES.has(code)) return true;
  const message = nonEmpty(fields?.message);
  return message !== undefined && CONNECTION_MESSAGE.test(message);
}

/** One line for one error: `Name: message [CODE]`, whatever it is made of. */
function describe(value: unknown): CauseLink | undefined {
  if (typeof value === 'string') {
    const text = oneLine(value);
    return text === ''
      ? undefined
      : { text, connectionFault: CONNECTION_MESSAGE.test(value) };
  }
  const fields = fieldsOf(value);
  if (fields === undefined) return undefined;
  const name = nonEmpty(fields.name);
  const message = nonEmpty(fields.message);
  const code = nonEmpty(fields.code);
  const members: unknown[] = Array.isArray(fields.errors) ? fields.errors : [];
  const parts: string[] = [];
  if (name !== undefined && message !== undefined)
    parts.push(`${name}: ${message}`);
  else if (message !== undefined || name !== undefined)
    parts.push(message ?? name ?? '');
  if (code !== undefined && !parts.join(' ').includes(code))
    parts.push(`[${code}]`);
  const named = members
    .slice(0, MAX_AGGREGATED)
    .map((member) => {
      const memberFields = fieldsOf(member);
      return nonEmpty(memberFields?.message) ?? nonEmpty(memberFields?.code);
    })
    .filter((detail) => detail !== undefined);
  if (named.length > 0) {
    const more = members.length - MAX_AGGREGATED;
    parts.push(`(${named.join('; ')}${more > 0 ? `; +${more} more` : ''})`);
  }
  const text = oneLine(parts.join(' '));
  return text === ''
    ? undefined
    : {
        text,
        connectionFault:
          isConnectionFault(value) || members.some(isConnectionFault),
      };
}

/** The `cause` links below an error, nearest first, at most MAX_CAUSE_DEPTH. */
function causeChain(error: unknown): CauseLink[] {
  const links: CauseLink[] = [];
  const seen = new Set<unknown>([error]);
  let current = fieldsOf(error)?.cause;
  while (
    current !== undefined &&
    current !== null &&
    !seen.has(current) &&
    links.length < MAX_CAUSE_DEPTH
  ) {
    const link = describe(current);
    if (link === undefined) break;
    links.push(link);
    seen.add(current);
    current = fieldsOf(current)?.cause;
  }
  return links;
}

/** Decode whatever was thrown into the shape the report is written from. */
export function parseFailure(thrown: unknown): Failure {
  return {
    message: thrown instanceof Error ? thrown.message : String(thrown),
    coded:
      thrown instanceof Error && nonEmpty(fieldsOf(thrown)?.code) !== undefined,
    causes: causeChain(thrown),
  };
}

/**
 * Node's fetch ignores proxy variables unless NODE_USE_ENV_PROXY=1, so a
 * connection that fails in a proxied environment fails for a reason the
 * variables already set cannot reveal. Names only: a proxy URL can carry
 * credentials, so its value is never printed.
 */
function proxyHint(env: Environment): string | undefined {
  const variable = PROXY_VARIABLES.find((name) => (env[name] ?? '') !== '');
  if (variable === undefined) return undefined;
  if ((env.NODE_USE_ENV_PROXY ?? '') !== '') return undefined;
  return `hint: ${variable} is set, but Node's built-in fetch ignores proxy variables unless NODE_USE_ENV_PROXY=1 (Node 22.21+); retry with NODE_USE_ENV_PROXY=1`;
}

/**
 * The text written to stderr for a failure, ending in a newline.
 *
 * A coded failure is one opm expected and named; it is reported as before, one
 * line. Any other is unexpected: its message is scrubbed, its cause chain
 * follows, and a connection fault that coincides with an unused proxy setting
 * ends with the one hint that explains it.
 */
export function formatFailure(
  failure: Failure,
  { tool, internalError = false, env = process.env }: FailureReportOptions,
): string {
  if (failure.coded) return report(`${tool}: `, failure.message);
  const label = internalError ? `${tool}: internal error` : tool;
  const lines = [`${label}: ${scrub(plainText(failure.message))}`];
  for (const [depth, cause] of failure.causes.entries())
    lines.push(`${tool}: ${'  '.repeat(depth + 1)}caused by: ${cause.text}`);
  if (failure.causes.some((cause) => cause.connectionFault)) {
    const hint = proxyHint(env);
    if (hint !== undefined) lines.push(`${tool}: ${hint}`);
  }
  return `${lines.join('\n')}\n`;
}
