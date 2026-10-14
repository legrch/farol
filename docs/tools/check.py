#!/usr/bin/env python3
"""Check public-reader documentation links and command references offline.

Adapted from docs/github-guide at 1b2643cf. Historical redirect, dependency-table
and full-tree policy checks are intentionally outside this focused scope.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

LINK = re.compile(r"!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$", re.M)
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


def selected_files(root):
    files = [root / "README.md", root / "docs/README.md"]
    for directory in ("start", "guides", "development", "tools"):
        files.extend(sorted((root / "docs" / directory).glob("*.md")))
    files.extend(root / "docs/reference" / name for name in REFERENCES)
    return files


def check(root):
    root = root.resolve()
    files = selected_files(root)
    errors = []
    totals = {"pages": len(files), "links": 0, "commands": 0, "inbound": 0}
    package = json.loads((root / "package.json").read_text())
    tasks = set(re.findall(r"^  ([\w:-]+):\s*$", (root / "Taskfile.yml").read_text(), re.M))
    cache = {}

    def read(file):
        if file not in cache:
            cache[file] = markdown_parts(file.read_text())
        return cache[file]

    def issue(file, message):
        errors.append(f"{file.relative_to(root)}: {message}")

    def local_links(file, inbound_only=False):
        prose = read(file)[0]
        for match in LINK.finditer(prose):
            target = match[1].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc:
                continue
            destination = (file.parent / unquote(parsed.path)).resolve() if parsed.path else file
            if inbound_only and destination != root / "README.md":
                continue
            totals["inbound" if inbound_only else "links"] += 1
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
        local_links(file)
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

    for file in sorted((root / "docs").rglob("*.md")):
        if "archive" in file.relative_to(root / "docs").parts or file in files:
            continue
        local_links(file, inbound_only=True)
    return errors, totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2],
                        help="Repository root; checks declared reader pages and inbound README links")
    args = parser.parse_args()
    try:
        errors, totals = check(args.root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Documentation check refused: {error}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        print(f"FAIL: {len(errors)} documentation issue(s)", file=sys.stderr)
        return 1
    print(f"PASS: {totals['pages']} reader pages, {totals['links']} local links/anchors, "
          f"{totals['commands']} command references, {totals['inbound']} inbound README links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
