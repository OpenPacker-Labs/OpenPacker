import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEpochPactProvider } from '../src/provider-fixture.js';
import {
  verifyEpochPact,
  type EpochPactProviderOptions,
} from '../src/pact-provider.js';

interface PactInteraction {
  description: string;
  request: { method: string; path: string };
  response: {
    status: number;
    headers: Record<string, string[]>;
    body: { content: unknown; encoded: boolean | string };
    matchingRules?: {
      body?: Record<
        string,
        { combine: string; matchers: Array<Record<string, unknown>> }
      >;
    };
  };
}

interface PactDocument {
  interactions: PactInteraction[];
}

const committedPact = fileURLToPath(
  new URL(
    '../../../pacts/Epoch PREX Consumer-OpenPacker PREX Provider.json',
    import.meta.url,
  ),
);
let provider: Awaited<ReturnType<typeof startEpochPactProvider>>;

beforeAll(async () => {
  provider = await startEpochPactProvider();
});
afterAll(async () => provider.close());

describe('committed Pact mutation coverage', () => {
  it('kills request, status, header, and body drift in every interaction', async () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const original = JSON.parse(
      await readFile(committedPact, 'utf8'),
    ) as PactDocument;
    expect(original.interactions.length).toBeGreaterThan(0);
    await verifyEpochPact({
      providerBaseUrl: provider.address,
      pactFile: committedPact,
      logLevel: 'error',
    });
    const directory = await mkdtemp(join(tmpdir(), 'openpacker-pact-mutants-'));
    const survivors: string[] = [];
    const mutations = {
      request(interaction: PactInteraction) {
        if (interaction.request.path.includes('not-a-route'))
          interaction.request.path = '/.well-known/prex';
        else interaction.request.method = 'DELETE';
      },
      status(interaction: PactInteraction) {
        interaction.response.status =
          interaction.response.status === 200 ? 503 : 200;
      },
      header(interaction: PactInteraction) {
        interaction.response.headers['X-Pact-Chaos'] = ['required'];
      },
      body(interaction: PactInteraction) {
        if (
          typeof interaction.response.body.content === 'object' &&
          interaction.response.body.content !== null
        )
          Object.assign(interaction.response.body.content, {
            pactChaosMutation: 'required',
          });
        else {
          interaction.response.body.content = 'cGFjdC1jaGFvcy1tdXRhdGlvbg==';
          interaction.response.matchingRules?.body?.['$']?.matchers.push({
            match: 'equality',
          });
        }
      },
    };

    try {
      for (const [index, interaction] of original.interactions.entries()) {
        for (const [name, mutate] of Object.entries(mutations)) {
          const mutant = structuredClone(original);
          const mutatedInteraction = structuredClone(interaction);
          mutant.interactions = [mutatedInteraction];
          mutate(mutatedInteraction);
          const pactFile = join(directory, `${index}-${name}.json`);
          await writeFile(pactFile, JSON.stringify(mutant));
          try {
            await verifyEpochPact({
              providerBaseUrl: provider.address,
              pactFile,
              logLevel: 'error',
            } satisfies EpochPactProviderOptions);
            survivors.push(`${interaction.description}: ${name}`);
          } catch {
            // Expected: the real provider must kill every contract mutant.
          }
        }
      }
      expect(survivors).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
