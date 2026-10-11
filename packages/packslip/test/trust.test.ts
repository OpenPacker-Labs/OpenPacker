import { describe, expect, it } from 'vitest';
import {
  evaluateTrust,
  type SignerRecord,
  type TrustDecision,
  type TrustMemory,
} from '../src/index.js';

const keyless = (over: Partial<SignerRecord> = {}): SignerRecord => ({
  scheme: 'sigstore-oidc',
  identity: '.github/workflows/release.yml',
  issuer: 'https://token.actions.githubusercontent.com',
  repositoryId: '922514152',
  pinWorkflow: true,
  ...over,
});

const memory = (
  over: Partial<TrustMemory> = {},
  signer: Partial<SignerRecord> = {},
): TrustMemory => ({
  project: 'github.com/jdx/hk',
  signer: keyless(signer),
  attestedBy: 'vendor',
  logged: true,
  provenance: false,
  ...over,
});

const PROJECT = 'github.com/jdx/hk';

function refusal(decision: TrustDecision) {
  if (decision.accepted) throw new Error('expected a refusal');
  return decision.proposal;
}

describe('trust on first use', () => {
  it('accepts and remembers the first release it sees', () => {
    const observed = memory();
    expect(evaluateTrust(PROJECT, undefined, observed)).toEqual({
      accepted: true,
      memory: observed,
      approved: [],
    });
  });
});

describe('continuity of a keyless signer', () => {
  it('accepts a new tag from the same workflow: the ref is not part of the signer', () => {
    expect(evaluateTrust(PROJECT, memory(), memory()).accepted).toBe(true);
  });

  it('accepts a rename or transfer: the repository ID, not the name, is the identity', () => {
    const decision = evaluateTrust(
      PROJECT,
      memory(),
      memory({ project: 'github.com/acme/hk' }),
    );
    expect(decision.accepted).toBe(true);
  });

  it('refuses a different workflow in the same repository', () => {
    const proposal = refusal(
      evaluateTrust(
        PROJECT,
        memory(),
        memory({}, { identity: '.github/workflows/publish.yml' }),
      ),
    );
    expect(proposal.changes.map((change) => change.kind)).toEqual([
      'signer-changed',
    ]);
    expect(proposal.changes[0]?.message).toContain('workflow');
  });

  it('refuses another repository even when the identity string is identical', () => {
    const proposal = refusal(
      evaluateTrust(PROJECT, memory(), memory({}, { repositoryId: '1' })),
    );
    expect(proposal.changes[0]).toMatchObject({ kind: 'signer-changed' });
    expect(proposal.changes[0]?.message).toContain('repository');
  });

  it('refuses another issuer', () => {
    const proposal = refusal(
      evaluateTrust(
        PROJECT,
        memory(),
        memory({}, { issuer: 'https://gitlab.com' }),
      ),
    );
    expect(proposal.changes[0]?.message).toContain('issuer');
  });

  it('falls back to comparing names when the new certificate carries no repository ID', () => {
    const { repositoryId: _gone, ...withoutId } = keyless();
    expect(
      evaluateTrust(PROJECT, memory(), { ...memory(), signer: withoutId }, [])
        .accepted,
    ).toBe(true);
    // Same name and no ID on the new side: only the name is left to compare,
    // and it still matches, so this is allowed. A different requested name is not.
    expect(
      evaluateTrust(
        'github.com/other/hk',
        memory(),
        { ...memory(), signer: withoutId },
        [],
      ).accepted,
    ).toBe(false);
  });
});

describe('workflow pinning (the specification’s table)', () => {
  const pinned = { pinWorkflow: true };
  const repoOnly = { pinWorkflow: false };
  const other = { identity: '.github/workflows/other.yml' };

  it('true then true: a changed workflow needs approval', () => {
    expect(
      evaluateTrust(
        PROJECT,
        memory({}, pinned),
        memory({}, { ...pinned, ...other }),
      ).accepted,
    ).toBe(false);
    expect(
      evaluateTrust(PROJECT, memory({}, pinned), memory({}, pinned)).accepted,
    ).toBe(true);
  });

  it('true then false: turning the pin off is a reduction and needs approval', () => {
    const proposal = refusal(
      evaluateTrust(PROJECT, memory({}, pinned), memory({}, repoOnly)),
    );
    expect(proposal.changes.map((change) => change.kind)).toEqual([
      'workflow-pin-reduced',
    ]);
  });

  it('true then false, approved: it is remembered, and not asked about again', () => {
    const first = evaluateTrust(
      PROJECT,
      memory({}, pinned),
      memory({}, repoOnly),
    );
    const id = refusal(first).id;
    const approved = evaluateTrust(
      PROJECT,
      memory({}, pinned),
      memory({}, repoOnly),
      [id],
    );
    expect(approved).toMatchObject({ accepted: true });
    if (!approved.accepted) return;
    expect(approved.memory.signer.pinWorkflow).toBe(false);
    expect(approved.approved).toHaveLength(1);
    // The next release, from yet another workflow, is accepted without asking.
    expect(
      evaluateTrust(
        PROJECT,
        approved.memory,
        memory({}, { ...repoOnly, ...other }),
      ).accepted,
    ).toBe(true);
  });

  it('false then false: workflows are not compared, repositories still are', () => {
    expect(
      evaluateTrust(
        PROJECT,
        memory({}, repoOnly),
        memory({}, { ...repoOnly, ...other }),
      ).accepted,
    ).toBe(true);
    expect(
      evaluateTrust(
        PROJECT,
        memory({}, repoOnly),
        memory({}, { ...repoOnly, repositoryId: '9' }),
      ).accepted,
    ).toBe(false);
  });

  it('false then true: comparison resumes against the last accepted workflow', () => {
    expect(
      evaluateTrust(PROJECT, memory({}, repoOnly), memory({}, pinned)).accepted,
    ).toBe(true);
    expect(
      evaluateTrust(
        PROJECT,
        memory({}, repoOnly),
        memory({}, { ...pinned, ...other }),
      ).accepted,
    ).toBe(false);
  });
});

describe('key-signed projects', () => {
  const key = (identity: string): SignerRecord => ({
    scheme: 'sigstore-key',
    identity,
    pinWorkflow: true,
  });

  it('accepts the same key and refuses another', () => {
    const base = memory({ project: 'example.com/demo' });
    const previous = { ...base, signer: key('AAAA') };
    expect(
      evaluateTrust('example.com/demo', previous, { ...previous }).accepted,
    ).toBe(true);
    const proposal = refusal(
      evaluateTrust('example.com/demo', previous, {
        ...previous,
        signer: key('BBBB'),
      }),
    );
    expect(proposal.changes[0]).toMatchObject({ kind: 'signer-changed' });
  });
});

describe('no-downgrade', () => {
  it('flags a keyless project that moves to a long-lived key as weaker, and as a new signer', () => {
    const proposal = refusal(
      evaluateTrust(
        PROJECT,
        memory(),
        memory({}, { scheme: 'sigstore-key', identity: 'AAAA' }),
      ),
    );
    expect(proposal.changes.map((change) => change.kind)).toEqual([
      'scheme-weaker',
      'signer-changed',
    ]);
  });

  it('flags a move from a key to keyless as a new signer, but not as weaker', () => {
    const previous = memory({}, { scheme: 'sigstore-key', identity: 'AAAA' });
    const proposal = refusal(evaluateTrust(PROJECT, previous, memory()));
    expect(proposal.changes.map((change) => change.kind)).toEqual([
      'signer-changed',
    ]);
  });

  it('flags a repackager taking over from the vendor', () => {
    const proposal = refusal(
      evaluateTrust(PROJECT, memory(), memory({ attestedBy: 'repackager' })),
    );
    expect(proposal.changes.map((change) => change.kind)).toEqual([
      'attestation-weaker',
    ]);
  });

  it('does not flag the vendor taking over from a repackager', () => {
    expect(
      evaluateTrust(PROJECT, memory({ attestedBy: 'repackager' }), memory())
        .accepted,
    ).toBe(true);
  });

  it('flags dropped provenance but welcomes added provenance', () => {
    expect(
      refusal(
        evaluateTrust(
          PROJECT,
          memory({ provenance: true }),
          memory({ provenance: false }),
        ),
      ).changes[0]?.kind,
    ).toBe('provenance-dropped');
    expect(
      evaluateTrust(
        PROJECT,
        memory({ provenance: false }),
        memory({ provenance: true }),
      ).accepted,
    ).toBe(true);
  });

  it('flags a release that lost its transparency-log entry', () => {
    expect(
      refusal(
        evaluateTrust(
          PROJECT,
          memory({ logged: true }),
          memory({ logged: false }),
        ),
      ).changes[0]?.kind,
    ).toBe('log-dropped');
    expect(
      evaluateTrust(
        PROJECT,
        memory({ logged: false }),
        memory({ logged: true }),
      ).accepted,
    ).toBe(true);
  });

  it('reports every change at once, so one approval names all of them', () => {
    const proposal = refusal(
      evaluateTrust(
        PROJECT,
        memory({ provenance: true }),
        memory(
          { attestedBy: 'repackager', provenance: false, logged: false },
          { identity: 'x' },
        ),
      ),
    );
    expect(proposal.changes.map((change) => change.kind).sort()).toEqual([
      'attestation-weaker',
      'log-dropped',
      'provenance-dropped',
      'signer-changed',
    ]);
  });
});

describe('approvals', () => {
  const changed = memory({}, { identity: '.github/workflows/publish.yml' });

  it('names exactly one change, deterministically', () => {
    const a = refusal(evaluateTrust(PROJECT, memory(), changed));
    const b = refusal(evaluateTrust(PROJECT, memory(), changed));
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('accepts the change it names and reports what was approved', () => {
    const id = refusal(evaluateTrust(PROJECT, memory(), changed)).id;
    const decision = evaluateTrust(PROJECT, memory(), changed, [id]);
    expect(decision).toMatchObject({ accepted: true, memory: changed });
    if (decision.accepted)
      expect(decision.approved[0]?.kind).toBe('signer-changed');
  });

  it('does not let an approval for one change wave through a different one', () => {
    const id = refusal(evaluateTrust(PROJECT, memory(), changed)).id;
    const worse = memory({}, { identity: '.github/workflows/evil.yml' });
    expect(evaluateTrust(PROJECT, memory(), worse, [id]).accepted).toBe(false);
  });

  it('does not let an approval carry to a different starting point', () => {
    const id = refusal(evaluateTrust(PROJECT, memory(), changed)).id;
    const earlier = memory({}, { identity: '.github/workflows/older.yml' });
    expect(evaluateTrust(PROJECT, earlier, changed, [id]).accepted).toBe(false);
  });

  it('does not let an approval carry to a different project', () => {
    const id = refusal(evaluateTrust(PROJECT, memory(), changed)).id;
    expect(
      evaluateTrust('github.com/jdx/other', memory(), changed, [id]).accepted,
    ).toBe(false);
  });

  it('ignores unrelated and malformed ids', () => {
    expect(
      evaluateTrust(PROJECT, memory(), changed, [
        '',
        'zzzz',
        '0000000000000000',
      ]).accepted,
    ).toBe(false);
  });
});
