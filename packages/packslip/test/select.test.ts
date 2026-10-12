import { describe, expect, it } from 'vitest';
import { PackslipError, selectArtifact, type Artifact } from '../src/index.js';

const art = (name: string, fields: Partial<Artifact> = {}): Artifact => ({
  name,
  size: 1,
  format: 'tar.gz',
  ...fields,
});

const linuxGnu = { os: 'linux', arch: 'x86_64', libc: 'gnu' } as const;

describe('artifact selection beyond the upstream vectors', () => {
  it('prefers a musl build only after no gnu or portable build exists, and says so', () => {
    const artifacts = [
      art('musl', { os: 'linux', arch: 'x86_64', libc: 'musl' }),
    ];
    expect(() =>
      selectArtifact(artifacts, { host: linuxGnu, formats: ['tar.gz'] }),
    ).toThrow(expect.objectContaining({ code: 'NO_ARTIFACT' }));
    const chosen = selectArtifact(artifacts, {
      host: linuxGnu,
      formats: ['tar.gz'],
      fallbacks: ['musl-on-gnu'],
    });
    expect(chosen).toMatchObject({ fallback: 'musl-on-gnu' });
    expect(chosen.artifact.name).toBe('musl');
  });

  it('never uses a fallback while an exact match exists', () => {
    const chosen = selectArtifact(
      [
        art('musl', { os: 'linux', arch: 'x86_64', libc: 'musl' }),
        art('portable', { os: 'linux', arch: 'x86_64' }),
      ],
      { host: linuxGnu, formats: ['tar.gz'], fallbacks: ['musl-on-gnu'] },
    );
    expect(chosen.artifact.name).toBe('portable');
    expect(chosen.fallback).toBeUndefined();
  });

  it('does not offer a musl build to a host that is not a gnu Linux host', () => {
    expect(() =>
      selectArtifact(
        [art('musl', { os: 'linux', arch: 'x86_64', libc: 'musl' })],
        {
          host: { os: 'linux', arch: 'x86_64' },
          formats: ['tar.gz'],
          fallbacks: ['musl-on-gnu'],
        },
      ),
    ).toThrow(PackslipError);
  });

  it('offers an Intel macOS build to Apple silicon only under Rosetta, and only when allowed', () => {
    const artifacts = [art('intel', { os: 'darwin', arch: 'x86_64' })];
    const host = { os: 'darwin', arch: 'aarch64' };
    expect(() =>
      selectArtifact(artifacts, { host, formats: ['tar.gz'] }),
    ).toThrow(PackslipError);
    expect(
      selectArtifact(artifacts, {
        host,
        formats: ['tar.gz'],
        fallbacks: ['rosetta'],
      }),
    ).toMatchObject({ fallback: 'rosetta' });
    expect(() =>
      selectArtifact(artifacts, {
        host: { os: 'linux', arch: 'aarch64' },
        formats: ['tar.gz'],
        fallbacks: ['rosetta'],
      }),
    ).toThrow(PackslipError);
  });

  it('reports a tie inside a fallback as ambiguous too', () => {
    const artifacts = [
      art('a', { os: 'linux', arch: 'x86_64', libc: 'musl' }),
      art('b', { os: 'linux', arch: 'x86_64', libc: 'musl', format: 'zip' }),
    ];
    // Different formats, so they rank apart; the same format would tie.
    expect(
      selectArtifact(artifacts, {
        host: linuxGnu,
        formats: ['tar.gz', 'zip'],
        fallbacks: ['musl-on-gnu'],
      }).artifact.name,
    ).toBe('a');
    expect(() =>
      selectArtifact(
        [
          art('a', { os: 'linux', arch: 'x86_64', libc: 'musl' }),
          art('b', {
            os: 'linux',
            arch: 'x86_64',
            libc: 'musl',
          }),
        ],
        { host: linuxGnu, formats: ['tar.gz'], fallbacks: ['musl-on-gnu'] },
      ),
    ).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_ARTIFACT' }));
  });

  it('takes a universal macOS build that names no architecture', () => {
    const chosen = selectArtifact([art('universal', { os: 'darwin' })], {
      host: { os: 'darwin', arch: 'aarch64' },
      formats: ['tar.gz'],
    });
    expect(chosen.artifact.name).toBe('universal');
  });

  it('takes a script that names no platform at all', () => {
    expect(
      selectArtifact([art('script', { format: 'zip' })], {
        host: { os: 'freebsd', arch: 'riscv64' },
        formats: ['zip'],
      }).artifact.name,
    ).toBe('script');
  });

  it('refuses formats it was not told it can unpack, in the message as well as the code', () => {
    try {
      selectArtifact([art('x', { format: 'tar.xz', os: 'linux' })], {
        host: linuxGnu,
        formats: ['tar.gz', 'zip'],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PackslipError);
      expect(String(error)).toContain('tar.gz, zip');
    }
  });

  it('does not let a variant request fall back to the plain build', () => {
    expect(() =>
      selectArtifact([art('plain', { os: 'linux', arch: 'x86_64' })], {
        host: linuxGnu,
        variant: 'fips',
        formats: ['tar.gz'],
      }),
    ).toThrow(expect.objectContaining({ code: 'NO_ARTIFACT' }));
  });
});
