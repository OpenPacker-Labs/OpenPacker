/**
 * PREX control-plane verbs handled by `runCli` (`index.ts`). They are routed
 * from the `opm` process entry before the project manager loads adapters.
 * Verbs that overlap the opm surface (`resolve`, `pack`, `publish`) stay on the
 * project manager when invoked as `opm …`.
 */
export const PREX_ROUTED_COMMANDS: ReadonlySet<string> = new Set([
  'normalize',
  'identify',
  'enumerate',
  'inspect',
  'solve',
  'explain',
  'materialize',
  'verify',
  'receipt',
  'catalog',
  'import-lock',
  'lifecycle',
  'export',
  'serve',
  'demo',
]);
