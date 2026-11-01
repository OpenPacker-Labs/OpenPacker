import { spawnSync } from 'node:child_process';

/** @returns {boolean} */
export function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return result.status === 0 && !result.error;
}
