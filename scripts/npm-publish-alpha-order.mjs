#!/usr/bin/env node
/**
 * Print the alpha publish for the only public package, @openpacker/cli.
 * Authenticate with a passkey (npm trusted publishing).
 * Never publish this prerelease to the latest dist-tag.
 * Does not publish.
 */
console.log(`npm ci && npm run build && npm run bundle --workspace @openpacker/cli
cd apps/openpacker-cli/release && npm publish --tag alpha --access public`);
