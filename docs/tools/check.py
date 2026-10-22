#!/usr/bin/env python3
"""Check documentation placement, local links and reader commands offline.

Adapted from docs/github-guide at 1b2643cf. Frozen archives retain their original
links. Strict prose/command checks apply only to the declared reader pages.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

LINK = re.compile(r"!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$", re.M)
HTML_LINK = re.compile(r'<(?:a|img)\b[^>]*?\b(?:href|src)="([^"]+)"', re.I)
REFERENCE = re.compile(r'^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)', re.M)
REFERENCE_USE = re.compile(r'!?\[([^\]\n]+)\]\[([^\]\n]*)\]')
PRIVATE = [
    (re.compile(r"/(?:Users|home)/[^\s/]+/"), "owner-specific path"),
]


def markdown_parts(text):
    """Separate prose and fenced/inline code for links and command checks."""
    prose, code, block = [], [], []
    fence = None
    language = ""
    for line in text.splitlines():
        marker = FENCE.match(line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                if language in {"", "sh", "bash", "shell", "zsh", "console"}:
                    code.append("\n".join(block))
                block, fence = [], None
            else:
                block.append(line)
        elif marker:
            fence = marker[1]
            language = marker[2].strip().lower()
        else:
            code.extend(re.findall(r"`([^`\n]+)`", line))
            prose.append(line)
    return "\n".join(prose), code, fence is not None


def anchors(prose):
    used = set()
    for title in HEADING.findall(prose):
        title = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", title)
        title = re.sub(r"<[^>]*>", "", title)
        base = re.sub(r"[^\w\s-]", "", title.lower()).strip().replace(" ", "-")
        value, ordinal = base, 0
        while value in used:
            ordinal += 1
            value = f"{base}-{ordinal}"
        used.add(value)
    used.update(re.findall(r'<a\s+(?:id|name)="([^"]+)"', prose))
    return used


REFERENCES = (
    "README.md", "status.md", "install-readiness.md", "documentation-verification.md",
)
PROPOSED_TASKS = {"test", "qualify:live"}
FROZEN_CONTENT = (
    "docs/archive/distribution-20261010/originals/",
    "docs/archive/coordinator-20261010/frozen/",
)


def inventory(root):
    """Include tracked and new nonignored files; never walk dependencies/output."""
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        check=True, capture_output=True,
    )
    return sorted({name for name in result.stdout.decode().split("\0")
                   if name and Path(name).suffix.lower() == ".md" and (root / name).is_file()})


def link_targets(prose):
    yield from (match[1].strip("<>") for match in LINK.finditer(prose))
    yield from (match[1] for match in HTML_LINK.finditer(prose))
    references = {match[1].casefold(): match[2].strip("<>") for match in REFERENCE.finditer(prose)}
    # Definitions are checked even when unused. Shortcut uses resolve to the
    # same target; explicit/collapsed uses must also name a definition.
    yield from references.values()


def missing_references(prose):
    references = {match[1].casefold() for match in REFERENCE.finditer(prose)}
    for match in REFERENCE_USE.finditer(prose):
        label = (match[2] or match[1]).casefold()
        if label not in references:
            yield label


def placement_errors(root, names, exceptions):
    errors = []
    for name in names:
        if name in {"README.md", "AGENTS.md"} or name.startswith("docs/"):
            continue
        entry = exceptions.get(name)
        if not isinstance(entry, dict) or not entry.get("reason") or not entry.get("index"):
            errors.append(f"{name}: ordinary Markdown belongs under docs/; document any machine-required exception")
            continue
        index = (root / entry["index"]).resolve()
        if not index.is_relative_to(root / "docs") or not index.is_file() or name not in index.read_text():
            errors.append(f"{name}: placement exception lacks a canonical index entry")
    for name in exceptions:
        if name not in names:
            errors.append(f"{name}: stale placement exception")
    return errors


def selected_files(root):
    files = [root / "README.md", root / "docs/README.md"]
    for directory in ("start", "guides", "development", "tools"):
        files.extend(sorted((root / "docs" / directory).glob("*.md")))
    files.extend(root / "docs/reference" / name for name in REFERENCES)
    return files


GUIDE_POLICY = "apps/desktop/renderer/navigation-guide-policy.json"


def user_guide_ui_errors(root, names):
    """Check current user instructions against the renderer's retired-label policy.

    ADRs, historical/frozen records and past release notes are explicitly excluded,
    even when nested inside a reader tree. Technical references are not UI guides.
    """
    policy = json.loads((root / GUIDE_POLICY).read_text())
    rules = [
        (rule["label"], re.compile(
            rule.get("pattern", r"(?<!\w)" + re.escape(rule["label"]) + r"(?!\w)"),
            0 if rule.get("caseSensitive") else re.I,
        ))
        for rule in policy["retiredLabels"]
    ]
    errors = []
    for name in names:
        path = Path(name)
        if (any(part in policy["excludedPathParts"] for part in path.parts)
                or any(path.name.startswith(prefix) for prefix in policy["excludedNamePrefixes"])):
            continue
        if name not in policy["readerFiles"] and not name.startswith(tuple(policy["readerTrees"])):
            continue
        # Strip Markdown emphasis/code delimiters and join wrapped prose so routes
        # cannot escape the invariant by formatting or wrapping a retired label.
        text = re.sub(r"[*_`]+", "", (root / name).read_text())
        text = re.sub(r"\s+", " ", text)
        for label, pattern in rules:
            if pattern.search(text):
                errors.append(f"{name}: retired UI label: {label}; use the current Setup, Unresolved actions or General surface")
    return errors


def check(root):
    root = root.resolve()
    files = selected_files(root)
    names = inventory(root)
    exceptions = json.loads((root / "docs/tools/placement-exceptions.json").read_text())
    errors = placement_errors(root, names, exceptions)
    errors.extend(user_guide_ui_errors(root, names))
    totals = {"pages": len(files), "documents": len(names), "links": 0, "commands": 0, "inbound": 0}
    package = json.loads((root / "package.json").read_text())
    tasks = set(re.findall(r"^  ([\w:-]+):\s*$", (root / "Taskfile.yml").read_text(), re.M))
    cache = {}

    def read(file):
        if file not in cache:
            cache[file] = markdown_parts(file.read_text())
        return cache[file]

    def issue(file, message):
        errors.append(f"{file.relative_to(root)}: {message}")

    def local_links(file):
        # Inline code can contain regexes such as `[A-Z][A-Z0-9_]*`; it is not
        # a Markdown link. Keep the original prose for heading-anchor parsing.
        prose = re.sub(r"(`+).*?\1", "", read(file)[0], flags=re.S)
        for label in missing_references(prose):
            issue(file, f"missing reference definition: {label}")
        for target in link_targets(prose):
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc:
                continue
            destination = (file.parent / unquote(parsed.path)).resolve() if parsed.path else file
            totals["links"] += 1
            if destination == root / "README.md" and file not in files:
                totals["inbound"] += 1
            if not destination.is_relative_to(root):
                issue(file, f"link escapes repository: {target}")
            elif not destination.exists():
                issue(file, f"missing target: {target}")
            elif destination.is_file() and destination.suffix == ".md" and parsed.fragment:
                if unquote(parsed.fragment) not in anchors(read(destination)[0]):
                    issue(file, f"missing anchor: {target}")

    for file in files:
        prose, code, unclosed = read(file)
        if unclosed:
            issue(file, "unclosed code fence")
        if len(re.findall(r"^#\s+", prose, re.M)) != 1:
            issue(file, "expected exactly one H1")
        for pattern, reason in PRIVATE:
            if pattern.search(file.read_text()):
                issue(file, reason)
        for snippet in code:
            for task in re.findall(r"\btask\s+([A-Za-z][\w:-]*)", snippet):
                totals["commands"] += 1
                documented_proposal = (
                    task in PROPOSED_TASKS
                    and snippet.strip() == f"task {task}"
                    and "target contracts" in file.read_text()
                )
                if task not in tasks and not documented_proposal:
                    issue(file, f"unknown Task entrypoint: {task}")
            for script in re.findall(r"\bnpm\s+run\s+([A-Za-z][\w:-]*)", snippet):
                totals["commands"] += 1
                if script not in package["scripts"]:
                    issue(file, f"unknown npm entrypoint: {script}")
            for script in re.findall(r"\bnode\s+([A-Za-z][\w./-]*\.(?:mjs|cjs|js))\b", snippet):
                totals["commands"] += 1
                dependency = script.split("/")[1] if script.startswith("node_modules/") else None
                declared = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
                if not (root / script).is_file() and dependency not in declared:
                    issue(file, f"missing Node entrypoint: {script}")

    for name in names:
        if name.startswith(FROZEN_CONTENT):
            continue
        local_links(root / name)
    return errors, totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2],
                        help="Repository root; checks placement/all non-frozen links and declared reader commands")
    parser.add_argument("--ui-only", action="store_true",
                        help="Check only current user guides for retired renderer UI labels")
    args = parser.parse_args()
    try:
        if args.ui_only:
            root = args.root.resolve()
            errors = user_guide_ui_errors(root, inventory(root))
            totals = None
        else:
            errors, totals = check(args.root)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"Documentation check refused: {error}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        print(f"FAIL: {len(errors)} documentation issue(s)", file=sys.stderr)
        return 1
    if totals is None:
        print("PASS: current user guides contain no retired UI labels")
        return 0
    print(f"PASS: {totals['documents']} Markdown documents, {totals['pages']} reader pages, {totals['links']} local links/anchors, "
          f"{totals['commands']} command references, {totals['inbound']} inbound README links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
