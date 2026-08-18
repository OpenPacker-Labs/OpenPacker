import { describe, expect, it } from 'vitest';
import type { PackagePacker } from '@openpacker/adapter-core';
import {
  cargoPacker,
  chocolateyPacker,
  debPacker,
  golangPacker,
  mavenPacker,
  nixPacker,
  npmPacker,
  nugetPacker,
  ociPacker,
  pypiPacker,
  wingetPacker,
} from './packers.js';

const project = { root: '/workspace', manifestPath: '/workspace/manifest' };

describe('default standard packers', () => {
  it.each([
    npmPacker(),
    cargoPacker(),
    pypiPacker(),
    nugetPacker(),
    mavenPacker(),
    golangPacker(),
    ociPacker(),
    nixPacker(),
    debPacker(),
    wingetPacker(),
    chocolateyPacker(),
  ])(
    'keeps $purlType deterministic and process-free',
    async (packer: PackagePacker) => {
      const plan = await packer.plan({ project }, { strategy: 'standard' });
      expect(plan).toMatchObject({
        strategy: 'standard',
        requiresBuild: false,
        requiresNetwork: false,
      });
      expect(plan.commands).toBeUndefined();
      await expect(
        packer.plan({ project }, { strategy: 'delegate' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    },
  );
});
