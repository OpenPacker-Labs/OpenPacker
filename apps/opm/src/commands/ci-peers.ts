/**
 * What `opm ci` says when the places chosen for a pnpm lock do not keep every
 * shared peer to one copy (ADR 0055 §9): one plain line on stderr, never a
 * refusal. The lock installs, as pnpm installs it, and every dependency still
 * resolves to the instance the lock names; what is lost is that a package and
 * its dependent load two copies of a peer, which pnpm's symlinks never do.
 */

import type { FrozenLockPeers } from '@openpacker/adapter-core';
import { say } from '../error-report.js';
import type { CommandIo } from './yank.js';

/** The line about `peers`, ending in a newline. */
export function peerNotice(peers: FrozenLockPeers): string {
  const many = peers.splits !== 1;
  const named =
    peers.first === undefined
      ? ''
      : ` (first: ${peers.first.dependency}, needed by ${peers.first.dependent})`;
  const loads =
    `${peers.splits} ${many ? 'dependencies load' : 'dependency loads'} ` +
    `another copy of a peer ${many ? 'they share with their dependent' : 'it shares with its dependent'}${named}`;
  if (!peers.withoutPeers)
    return `opm: ${loads}; no node_modules layout opm could write gives both one copy, as pnpm's symlinks do\n`;
  return (
    'opm: no layout that keeps each shared peer to one copy could be written, so the places were chosen without peers in view; ' +
    `${peers.splits === 0 ? 'none was found to load another copy of a shared peer' : loads}\n`
  );
}

export function printPeerNotice(
  io: Pick<CommandIo, 'stderr'>,
  peers: FrozenLockPeers,
): void {
  say(io.stderr, peerNotice(peers));
}
