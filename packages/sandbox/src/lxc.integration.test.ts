import { describe, expect, it } from 'vitest';
import { probeLxc } from './backends/lxc.js';
import { createLxcBackend } from './backends/lxc.js';

describe('lxc integration', () => {
  it('creates a backend when incus/lxc is available', async () => {
    const probe = await probeLxc();
    if (!probe.available) {
      expect(probe.id).toBe('lxc');
      return;
    }
    const backend = await createLxcBackend();
    expect(backend.id).toBe('lxc');
  });
});
