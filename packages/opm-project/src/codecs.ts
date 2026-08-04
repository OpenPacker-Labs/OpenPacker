import type { EcosystemCodec } from '@openpacker/adapter-core';
import { CargoCodec } from '@openpacker/adapter-cargo';
import { GolangCodec } from '@openpacker/adapter-golang';
import { MavenCodec } from '@openpacker/adapter-maven';
import { NpmCodec } from '@openpacker/adapter-npm';
import { NugetCodec } from '@openpacker/adapter-nuget';
import { PypiCodec } from '@openpacker/adapter-pypi';
import { OpmError } from './types.js';

/**
 * The codec that knows an ecosystem's version and range semantics.
 *
 * Resolution matches a candidate against a range using the ecosystem's own
 * rules rather than a translated constraint: `^4.1.0`, `~=2.1`, `[1.0,2.0)` and
 * `>=1.2 <2` mean different things, and the adapters already implement each of
 * them exactly. Going through VERS would mean resolving through a known
 * approximation — the npm codec records `NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE`
 * precisely because that translation is lossy.
 */
export function codecFor(ecosystem: string): EcosystemCodec {
  switch (ecosystem) {
    case 'npm':
      return new NpmCodec();
    case 'cargo':
      return new CargoCodec();
    case 'pypi':
      return new PypiCodec();
    case 'nuget':
      return new NugetCodec();
    case 'maven':
      return new MavenCodec();
    case 'golang':
      return new GolangCodec();
    default:
      throw new OpmError(
        'UNSUPPORTED_ECOSYSTEM',
        `No version semantics are implemented for "${ecosystem}".`,
      );
  }
}
