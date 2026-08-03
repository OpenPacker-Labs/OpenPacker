#!/usr/bin/env node
/**
 * Assert .agents/skills/<name> and .claude/skills/<name> are byte-identical
 * for every skill directory present under either mirror.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../..');
const agentsRoot = join(root, '.agents/skills');
const claudeRoot = join(root, '.claude/skills');

async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(path);
    }
  }
  await walk(dir);
  return out.sort();
}

async function digestTree(base) {
  const files = await listFiles(base);
  const map = new Map();
  for (const file of files) {
    const rel = relative(base, file).split('\\').join('/');
    const bytes = await readFile(file);
    map.set(rel, createHash('sha256').update(bytes).digest('hex'));
  }
  return map;
}

async function skillNames(base) {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

const agentSkills = await skillNames(agentsRoot);
const claudeSkills = await skillNames(claudeRoot);
const names = [...new Set([...agentSkills, ...claudeSkills])].sort();

if (names.length === 0) {
  console.error(
    'check-skill-mirrors: no skills under .agents/skills or .claude/skills',
  );
  process.exit(1);
}

let failed = 0;
for (const name of names) {
  const left = join(agentsRoot, name);
  const right = join(claudeRoot, name);
  const leftStat = await stat(left).catch(() => null);
  const rightStat = await stat(right).catch(() => null);
  if (!leftStat?.isDirectory() || !rightStat?.isDirectory()) {
    console.error(`check-skill-mirrors: missing mirror for skill "${name}"`);
    failed += 1;
    continue;
  }
  const a = await digestTree(left);
  const b = await digestTree(right);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const key of keys) {
    if (a.get(key) !== b.get(key)) {
      console.error(
        `check-skill-mirrors: drift in ${name}/${key}\n  agents=${a.get(key) ?? 'MISSING'}\n  claude=${b.get(key) ?? 'MISSING'}`,
      );
      failed += 1;
    }
  }
  if (
    ![...a.keys()].some((k) => k === 'SKILL.md') &&
    ![...b.keys()].some((k) => k === 'SKILL.md')
  ) {
    console.error(`check-skill-mirrors: ${name} has no SKILL.md`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`check-skill-mirrors: ${failed} problem(s)`);
  process.exit(1);
}

console.log(
  `check-skill-mirrors: ${names.length} skill(s) mirrored (${names.join(', ')})`,
);
