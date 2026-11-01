#!/usr/bin/env node
/**
 * Build the static GitHub Pages artifact under `_site/`.
 * Templates live in `site/`; placeholders are filled from package metadata
 * and (when online) GitHub Releases for OpenPacker-Labs/OpenPacker.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(root, '_site');
const siteSrc = join(root, 'site');
const repo = 'OpenPacker-Labs/OpenPacker';
const pagesBase = '/OpenPacker/';

const packageJson = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const version = packageJson.version ?? '0.0.0';

function replaceAll(text, pairs) {
  let out = text;
  for (const [key, value] of pairs) out = out.split(key).join(value);
  return out;
}

async function fetchReleases() {
  if (process.env.OPENPACKER_OFFLINE === '1') return [];
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=20`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'openpacker-site-build',
        },
      },
    );
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

function latestSection(releases) {
  const latest = releases.find((entry) => !entry.draft && !entry.prerelease);
  if (latest === undefined) {
    return `<p class="release-meta">No GitHub release is published yet. Build from source on <a href="https://github.com/${repo}">GitHub</a>.</p>`;
  }
  const tag = latest.tag_name ?? latest.name ?? version;
  const url =
    latest.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`;
  return `<p>Latest production release: <strong><a href="${url}">${tag}</a></strong></p>`;
}

function installSection() {
  return `<pre><code>npm install -g @openpacker/cli@${version}

# or from a clone:
git clone https://github.com/${repo}.git
cd OpenPacker
npm ci
npm run build
npm link -w @openpacker/opm</code></pre>`;
}

function releasesSection(releases) {
  const production = releases.filter(
    (entry) => !entry.draft && !entry.prerelease,
  );
  if (production.length === 0) {
    return '<p>No production releases yet.</p>';
  }
  return production
    .map((entry) => {
      const tag = entry.tag_name ?? entry.name ?? 'release';
      const url =
        entry.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`;
      const when = entry.published_at
        ? new Date(entry.published_at).toISOString().slice(0, 10)
        : '';
      const assets =
        entry.assets?.length > 0
          ? `<ul>${entry.assets
              .map(
                (asset) =>
                  `<li><a href="${asset.browser_download_url}">${asset.name}</a> (${asset.size} bytes)</li>`,
              )
              .join('')}</ul>`
          : '';
      return `<article class="release-entry"><h3><a href="${url}">${tag}</a></h3><p class="release-meta">${when}</p>${assets}</article>`;
    })
    .join('\n');
}

const releases = await fetchReleases();
const indexTemplate = await readFile(join(siteSrc, 'index.html'), 'utf8');
const releasesTemplate = await readFile(join(siteSrc, 'releases.html'), 'utf8');

await mkdir(outRoot, { recursive: true });
await mkdir(join(outRoot, 'releases'), { recursive: true });

const indexHtml = replaceAll(indexTemplate, [
  ['{{LATEST_SECTION}}', latestSection(releases)],
  ['{{INSTALL_SECTION}}', installSection()],
  [
    'https://github.com/Tyler-R-Kendrick/OpenPacker',
    `https://github.com/${repo}`,
  ],
  ['Tyler-R-Kendrick/OpenPacker', repo],
]);
const releasesHtml = replaceAll(releasesTemplate, [
  ['{{RELEASES}}', releasesSection(releases)],
  ['href="../"', `href="${pagesBase}"`],
  ['href="../style.css"', 'href="../style.css"'],
]);

await writeFile(join(outRoot, 'index.html'), indexHtml);
await writeFile(join(outRoot, 'releases', 'index.html'), releasesHtml);
await cp(join(siteSrc, 'style.css'), join(outRoot, 'style.css'));
await writeFile(join(outRoot, '.nojekyll'), '');
await writeFile(
  join(outRoot, '404.html'),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${pagesBase}"><link rel="canonical" href="${pagesBase}"><title>OpenPacker</title><p><a href="${pagesBase}">OpenPacker</a></p>`,
);

console.log(`site: wrote ${outRoot} (${releases.length} release(s) from API)`);
