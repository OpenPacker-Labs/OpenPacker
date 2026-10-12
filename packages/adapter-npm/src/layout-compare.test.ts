import { describe, expect, it } from 'vitest';
import { compareText, compareVersions } from './layout-compare.js';
import { compareVersions as fromPlan } from './layout-plan.js';

describe('compareVersions', () => {
  it('orders versions numerically and repeatably', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
  });

  it('is still exported from the planner', () => {
    expect(fromPlan).toBe(compareVersions);
  });
});

describe('compareText', () => {
  it('orders by code unit, not by locale', () => {
    expect(compareText('B', 'a')).toBe(-1);
    expect(compareText('a', 'a')).toBe(0);
    expect(compareText('b', 'a')).toBe(1);
  });
});
