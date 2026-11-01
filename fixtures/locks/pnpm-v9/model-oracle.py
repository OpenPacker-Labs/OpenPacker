#!/usr/bin/env python3
"""
An independent reading of the pnpm lock fixtures for the install model
(packages/adapter-npm/src/pnpm-install/model.test.ts): PyYAML and none of the
TypeScript reader's logic. It prints, per fixture, the counts of the model a
frozen install builds (instances, edges, tops) and a SHA-256 over the canonical
list of edges, so the model is checked against a second reading.

    python3 model-oracle.py > model-oracle.json

It also reads the *selection* a machine makes (`selection.<case>`): how many
snapshots a frozen install of every importer installs for a target, written as
a plain reachability walk with npm's `os`, `cpu` and `libc` rule and none of
the TypeScript selection's code. A snapshot pnpm marked `optional` whose
package does not run on the target is dropped with whatever needs it outright;
one that is not optional and does not run is counted as `refused`.

A dependency value is already a full `name@version` when it starts with `@` or
its first `@` comes before any `:` and any `(` (pnpm's `refToRelative`);
otherwise the dependency's own name goes in front.
"""
import hashlib
import json
import os
import sys

import yaml

LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = [
    "ai-bdd.pnpm-lock.yaml",
    "hobo.cut.pnpm-lock.yaml",
    "opensesame.cut.pnpm-lock.yaml",
    "exotic.pnpm-lock.yaml",
]
FIELDS = ("dependencies", "devDependencies", "optionalDependencies")


def target_of(name, value):
    value = str(value)
    if value.startswith("link:"):
        return "link", value[5:]
    at = value.find("@")
    colon = value.find(":")
    bracket = value.find("(")
    full = value.startswith("@") or (
        at != -1 and (colon == -1 or at < colon) and (bracket == -1 or at < bracket)
    )
    return "dep", value if full else f"{name}@{value}"


def runs(value, wanted):
    """npm's rule for one list: `['any']` constrains nothing, `!x` excludes, and plain entries must include."""
    if not wanted or wanted == ["any"]:
        return True
    if value is None:
        return True
    blocked = [w[1:] for w in wanted if w.startswith("!")]
    allowed = [w for w in wanted if not w.startswith("!") and w != "*"]
    if value in blocked:
        return False
    return not allowed or value in allowed


def package_key(key):
    return key.split("(")[0]


CASES = {
    "linux-x64": {"os": ["linux"], "cpu": ["x64"], "libc": ["glibc"], "omit": []},
    "linux-x64-omit-dev": {"os": ["linux"], "cpu": ["x64"], "libc": ["glibc"], "omit": ["dev"]},
    "linux-x64-and-arm64": {"os": ["linux"], "cpu": ["x64", "arm64"], "libc": ["glibc"], "omit": []},
    "everywhere": {"os": None, "cpu": None, "libc": None, "omit": []},
}


def selection(lock, case):
    snapshots = {k: (v or {}) for k, v in lock.get("snapshots", {}).items()}
    packages = lock.get("packages", {})

    def edges(key):
        s = snapshots[key]
        out = []
        for field in ("dependencies", "optionalDependencies"):
            for name, value in (s.get(field) or {}).items():
                kind, target = target_of(name, value)
                if kind == "dep":
                    out.append((target, field == "optionalDependencies"))
        return out

    roots = []
    for importer in lock.get("importers", {}).values():
        for field in FIELDS:
            if field == "devDependencies" and "dev" in case["omit"]:
                continue
            for name, entry in ((importer or {}).get(field) or {}).items():
                kind, target = target_of(name, entry["version"])
                if kind == "dep":
                    roots.append(target)

    def walk(start, blocked):
        seen, pending = set(), [k for k in start if k not in blocked]
        while pending:
            key = pending.pop()
            if key in seen:
                continue
            seen.add(key)
            for target, _optional in edges(key):
                if target not in blocked and target not in seen:
                    pending.append(target)
        return seen

    reach = walk(roots, set())

    def fits(key):
        pkg = packages[package_key(key)]
        if case["os"] is None:
            return True
        return (
            any(runs(o, pkg.get("os")) for o in case["os"])
            and any(runs(c, pkg.get("cpu")) for c in case["cpu"])
            and any(runs(l, pkg.get("libc")) for l in case["libc"])
        )

    failing = [k for k in reach if not fits(k)]
    refused = [k for k in failing if not snapshots[k].get("optional")]
    dropped = {k for k in failing if snapshots[k].get("optional")}
    changed = True
    while changed:
        changed = False
        for key in reach:
            if key in dropped:
                continue
            if any(t in dropped and not opt for t, opt in edges(key)):
                if snapshots[key].get("optional"):
                    dropped.add(key)
                    changed = True
    final = walk(roots, dropped)
    return {
        "installed": len(final),
        "platformSkipped": len([k for k in failing if k in dropped]),
        "refused": len(refused),
        "orphaned": len(reach - final) - len([k for k in failing if k in dropped]),
        "packages": len({package_key(k) for k in final}),
        "listSha256": hashlib.sha256("\n".join(sorted(final)).encode()).hexdigest(),
    }


def reading(path):
    with open(os.path.join(HERE, path), "rb") as handle:
        data = handle.read()
    lock = yaml.load(data, Loader=LOADER)
    lines = []
    instance_edges = optional_edges = alias_edges = link_edges = 0
    for key, snapshot in sorted(lock.get("snapshots", {}).items()):
        snapshot = snapshot or {}
        for field in ("dependencies", "optionalDependencies"):
            for name, value in sorted((snapshot.get(field) or {}).items()):
                kind, target = target_of(name, value)
                optional = field == "optionalDependencies"
                lines.append(f"S\t{key}\t{name}\t{kind}\t{target}\t{int(optional)}")
                instance_edges += 1
                optional_edges += int(optional)
                if kind == "dep" and target.split("(")[0].rsplit("@", 1)[0] != name:
                    alias_edges += 1
                link_edges += int(kind == "link")
    top_edges = top_links = 0
    for iid, importer in sorted(lock.get("importers", {}).items()):
        importer = importer or {}
        for field in FIELDS:
            for name, entry in sorted((importer.get(field) or {}).items()):
                kind, target = target_of(name, entry["version"])
                lines.append(
                    f"I\t{iid}\t{field}\t{name}\t{entry['specifier']}\t{kind}\t{target}"
                )
                top_edges += 1
                top_links += int(kind == "link")
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "instances": len(lock.get("snapshots", {})),
        "tops": len(lock.get("importers", {})),
        "instanceEdges": instance_edges,
        "optionalEdges": optional_edges,
        "snapshotAliasEdges": alias_edges,
        "snapshotLinks": link_edges,
        "topEdges": top_edges,
        "topLinks": top_links,
        "optionalInstances": sum(
            1 for s in lock.get("snapshots", {}).values() if (s or {}).get("optional")
        ),
        "edgesSha256": hashlib.sha256("\n".join(lines).encode()).hexdigest(),
        "selection": {name: selection(lock, case) for name, case in CASES.items()},
    }


json.dump({name: reading(name) for name in FIXTURES}, sys.stdout, indent=2)
sys.stdout.write("\n")
