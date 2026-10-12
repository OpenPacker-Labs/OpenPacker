#!/usr/bin/env python3
"""
An independent reading of the pnpm lock fixtures for the install model
(packages/adapter-npm/src/pnpm-install/model.test.ts): PyYAML and none of the
TypeScript reader's logic. It prints, per fixture, the counts of the model a
frozen install builds (instances, edges, tops) and a SHA-256 over the canonical
list of edges, so the model is checked against a second reading.

    python3 model-oracle.py > model-oracle.json

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
    }


json.dump({name: reading(name) for name in FIXTURES}, sys.stdout, indent=2)
sys.stdout.write("\n")
