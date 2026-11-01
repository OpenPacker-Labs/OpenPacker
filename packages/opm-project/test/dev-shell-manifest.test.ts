import { describe, expect, it } from 'vitest';
import {
  parseShellIsolatePrefer,
  serializeManifest,
  parseManifest,
} from '@openpacker/opm-project';

describe('[environment] manifest', () => {
  it('round-trips shell_isolate and network', () => {
    const text = `[project]
name = "demo"
ecosystems = ["npm"]

[environment]
shell_isolate = "lxc"
network = true
`;
    const manifest = parseManifest(text);
    expect(manifest.environment?.shellIsolate).toBe('lxc');
    expect(manifest.environment?.network).toBe(true);
    expect(serializeManifest(manifest)).toContain('shell_isolate = "lxc"');
  });

  it('parseShellIsolatePrefer rejects unknown values', () => {
    expect(() => parseShellIsolatePrefer('docker')).toThrow(/shell_isolate/u);
  });
});
