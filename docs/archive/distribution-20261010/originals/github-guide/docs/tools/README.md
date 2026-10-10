# Documentation checks

Run the local checker from a Git checkout with the history of the named
compatibility base, using the repository root:

```sh
python3 docs/tools/check.py
```

[check.py](check.py) reads repository Markdown and executable command declarations.
It checks local links/anchors, section indexes, canonical-page reachability,
compatibility routes, selected mirrored source facts, and literal command names.
It makes no network requests and edits no files.

[redirects.json](redirects.json) records the original flat page addresses and their
canonical page/section destinations. Its frozen `baseline_anchors` inventory
comes from the named `compatibility_base` and also covers the original root README.
The checker reads that commit with local `git ls-tree` and `git show`, verifies
the manifest inventory against it, and requires every original flat page address.
Deleting an old anchor, its route, and its inventory entry together still fails.
An unavailable commit refuses the check; use a complete clone or make its history
available before running it. The checker never fetches history automatically.
Those Markdown compatibility pages remain clickable on GitHub; they are not
server-side redirects.

The checker cannot certify external account access, live UI, diagram rendering,
or semantic correctness. Follow the complete
[documentation review](../development/documentation.md) and required
[source gate](../development/testing.md#source-gate).

---

[Documentation](../README.md)
