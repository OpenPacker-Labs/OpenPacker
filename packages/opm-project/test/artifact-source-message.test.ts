import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchArtifactBytes } from '../src/install.js';

/** Stands for a credential a source URL holds. */
const CANARY = 'vtok_dummy_marker_0123456789abcdef';
const SOURCE = `https://user:${CANARY}@host.example/x.tgz?token=${CANARY}#${CANARY}`;

/**
 * A source the person gave is repeated in the error that refuses it, and it was
 * repeated whole: userinfo, query and fragment. It is shown as every other error
 * shows an address (`redactAddress`).
 */
describe('fetchArtifactBytes, naming a source in an error', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not print the credentials of a source it refuses to fetch offline', async () => {
    const error = await fetchArtifactBytes(SOURCE, true).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: 'OFFLINE',
      message:
        'Refusing network fetch for https://host.example/x.tgz while offline',
    });
  });

  it('does not print the credentials of a source that answered with an error', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    const error = await fetchArtifactBytes(SOURCE, false).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: 'FETCH_FAILED',
      message: 'Failed to fetch https://host.example/x.tgz: HTTP 404',
    });
  });

  it('shows a source the parser refuses as a scheme and a fixed word', async () => {
    const error = await fetchArtifactBytes(
      `https://u:${CANARY}@ho st/x.tgz?t=${CANARY}`,
      true,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'OFFLINE',
      message:
        'Refusing network fetch for https:[address withheld] while offline',
    });
  });
});
