import type {
  Capabilities,
  NormalizeRequest,
  NormalizeResponse,
} from '@openpacker/contracts';
import {
  OpenPackerClient,
  type PrexClientOptions,
  type RawResponse,
} from '@openpacker/sdk';

export interface BasicClientResult {
  capabilities: RawResponse<Capabilities>;
  normalization: RawResponse<NormalizeResponse>;
}

/** Discover first, then submit a typed PREX request while retaining exact bytes. */
export async function runBasicClient(
  options: PrexClientOptions = {},
): Promise<BasicClientResult> {
  const client = new OpenPackerClient(options);
  const capabilities = await client.capabilities();
  if (!capabilities.data.protocolVersions.includes('1.0-draft'))
    throw new Error('Provider does not support PREX 1.0-draft');
  if (!capabilities.data.operations.includes('normalize'))
    throw new Error('Provider does not advertise normalize');

  const request: NormalizeRequest = {
    items: [
      { type: 'purl', value: 'pkg:npm/%40openpacker/demo-tool@1.0.0' },
      { type: 'vers', value: 'vers:npm/>=1.0.0|<2.0.0' },
      { type: 'digest', value: `sha256:${'0'.repeat(64)}` },
    ],
  };
  return { capabilities, normalization: await client.normalize(request) };
}
