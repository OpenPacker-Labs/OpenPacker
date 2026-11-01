import { flushV8Coverage } from './v8-coverage-setup.mjs';

export default async function globalTeardown() {
  await flushV8Coverage();
}
