import { expect, test } from 'vitest';
import type { LifecycleEvent, PackageIdentity } from '@openpacker/contracts';
import { defaultLifecycleAllowed, reduceLifecycle } from '../src/index.js';

const digest = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };
const identity: PackageIdentity = {
  canonicalPurl: 'pkg:npm/demo',
  exactPurl: 'pkg:npm/demo@1.0.0',
  purlType: 'npm',
  name: 'demo',
  version: '1.0.0',
  qualifiers: {},
  nativeCoordinates: [],
  aliases: [],
  sourceRefs: [],
  publisherRefs: [],
  externalRefs: [],
};
function event(
  id: string,
  action: LifecycleEvent['action'],
  effectiveAt: string,
  authority: LifecycleEvent['authority'] = 'registry',
): LifecycleEvent {
  return {
    eventVersion: '1',
    eventId: id,
    subject: identity,
    action,
    effectiveAt,
    issuedAt: effectiveAt,
    actor: { type: 'key', value: 'fixture' },
    authority,
    reasonCode: `fixture.${action}`,
    replacementRefs: [],
    sourceSnapshot: digest,
    evidenceRefs: [],
    externalRefs: [],
  };
}
const rules = [
  {
    authority: 'registry' as const,
    scopes: ['exact-version' as const],
    actions: [
      'published',
      'yanked',
      'restored',
      'quarantined',
      'revoked',
      'deprecated',
      'delisted',
      'promoted',
      'removed-from-channel',
      'ownership-transferred',
    ] as LifecycleEvent['action'][],
  },
];

test('lifecycle reduction is stable, authorized, time-aware, and restore-safe', async () => {
  const events = [
    event('restore', 'restored', '2026-03-01T00:00:00Z'),
    event('publish', 'published', '2026-01-01T00:00:00Z'),
    event('yank', 'yanked', '2026-02-01T00:00:00Z'),
    event('attacker', 'restored', '2026-04-01T00:00:00Z', 'user'),
    { ...event('future', 'revoked', '2027-01-01T00:00:00Z') },
  ];
  const target = {
    packagePurl: identity.canonicalPurl,
    exactPurl: identity.exactPurl,
    digest,
  };
  const first = await reduceLifecycle(
    events,
    target,
    '2026-06-01T00:00:00Z',
    rules,
  );
  const second = await reduceLifecycle(
    [...events].reverse(),
    target,
    '2026-06-01T00:00:00Z',
    rules,
  );
  expect(first.root).toEqual(second.root);
  expect(first.state).toMatchObject({ status: 'restored', eligible: true });
  expect(
    first.history.find((item) => item.event.eventId === 'attacker'),
  ).toMatchObject({ accepted: false, reason: 'unauthorized' });
  expect(
    first.history.find((item) => item.event.eventId === 'future'),
  ).toMatchObject({ accepted: false, reason: 'not-effective' });
  expect(
    defaultLifecycleAllowed(
      (
        await reduceLifecycle(
          [event('yank', 'yanked', '2026-02-01T00:00:00Z')],
          target,
          '2026-06-01T00:00:00Z',
          rules,
        )
      ).state,
    ),
  ).toBe(false);
});

test('informational ownership events do not erase a denial', async () => {
  const result = await reduceLifecycle(
    [
      event('publish', 'published', '2026-01-01T00:00:00Z'),
      event('revoke', 'revoked', '2026-02-01T00:00:00Z'),
      event('transfer', 'ownership-transferred', '2026-03-01T00:00:00Z'),
    ],
    {
      packagePurl: identity.canonicalPurl,
      exactPurl: identity.exactPurl,
      digest,
    },
    '2026-06-01T00:00:00Z',
    rules,
  );
  expect(result.state).toMatchObject({ status: 'revoked', eligible: false });
  expect(result.state.derivationEventIds).toContain('transfer');
});
