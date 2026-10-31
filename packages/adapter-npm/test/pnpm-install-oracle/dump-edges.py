#!/usr/bin/env python3
"""Independent reading of a pnpm-lock.yaml for the acceptance checks: PyYAML only.
Prints {importers: {id: [[as, list, kind, target]]}, snapshots: {key: [[as, kind, target, optional]]}}.
"""
import json, sys, yaml
L = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
lock = yaml.load(open(sys.argv[1], "rb"), Loader=L)

def target_of(name, value):
    value = str(value)
    if value.startswith("link:"):
        return "link", value[5:]
    at, colon, br = value.find("@"), value.find(":"), value.find("(")
    full = value.startswith("@") or (at != -1 and (colon == -1 or at < colon) and (br == -1 or at < br))
    return "dep", value if full else f"{name}@{value}"

out = {"importers": {}, "snapshots": {}, "packages": {}}
for iid, imp in lock["importers"].items():
    edges = []
    for lst in ("dependencies", "devDependencies", "optionalDependencies"):
        for name, e in ((imp or {}).get(lst) or {}).items():
            kind, target = target_of(name, e["version"])
            edges.append([name, lst, kind, target])
    out["importers"][iid] = edges
for key, snap in lock["snapshots"].items():
    edges = []
    for lst in ("dependencies", "optionalDependencies"):
        for name, v in ((snap or {}).get(lst) or {}).items():
            kind, target = target_of(name, v)
            edges.append([name, kind, target, lst == "optionalDependencies"])
    out["snapshots"][key] = edges
for key, pkg in lock["packages"].items():
    out["packages"][key] = {k: pkg.get(k) for k in ("os", "cpu", "libc")}
json.dump(out, sys.stdout)
