#!/usr/bin/env python3
"""Check Farol's repository documentation without network access or file writes."""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

LINK = re.compile(r"!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$", re.M)
URL = re.compile(r"https?://[^\s)\"'`]+")
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


def check(root):
    root = root.resolve()
    docs = root / "docs"
    files = [root / "README.md", *sorted(docs.rglob("*.md"))]
    errors, graph, parts, totals = [], {}, {}, {"links": 0, "commands": 0}
    package = json.loads((root / "package.json").read_text())
    routes = json.loads((docs / "tools/redirects.json").read_text())
    if routes.get("schema") != 1 or not isinstance(routes.get("pages"), dict):
        raise ValueError("Unsupported documentation compatibility manifest")
    if not re.fullmatch(r"[a-f0-9]{40}", routes.get("compatibility_base", "")):
        raise ValueError("Missing original documentation compatibility base")
    aliases = {docs / name for name in routes["pages"]}
    tasks = set(re.findall(r"^  ([\w:-]+):\s*$", (root / "Taskfile.yml").read_text(), re.M))

    def issue(file, message):
        errors.append(f"{file.relative_to(root)}: {message}")

    for file in files:
        prose, code, unclosed = markdown_parts(file.read_text())
        parts[file] = prose, code
        graph[file] = set()
        if unclosed:
            issue(file, "unclosed code fence")
        if len(re.findall(r"^#\s+", prose, re.M)) != 1:
            issue(file, "expected exactly one H1")
        for pattern, reason in PRIVATE:
            if pattern.search(file.read_text()):
                issue(file, reason)

    for file, (prose, code) in parts.items():
        for match in LINK.finditer(prose):
            target = match[1].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc:
                continue
            totals["links"] += 1
            if parsed.path.startswith("/"):
                issue(file, f"use a relative repository link: {target}")
                continue
            destination = (file.parent / unquote(parsed.path)).resolve() if parsed.path else file
            if not destination.is_relative_to(root):
                issue(file, f"link escapes the repository: {target}")
            elif not destination.exists():
                issue(file, f"missing target: {target}")
            elif destination.is_dir():
                issue(file, f"link to an explicit file/README: {target}")
            elif destination in parts:
                graph[file].add(destination)
                if parsed.fragment and unquote(parsed.fragment) not in anchors(parts[destination][0]):
                    issue(file, f"missing anchor: {target}")
        for snippet in code:
            for task in re.findall(r"\btask\s+([A-Za-z][\w:-]*)", snippet):
                totals["commands"] += 1
                if task not in tasks:
                    issue(file, f"unknown Task entrypoint: {task}")
            for script in re.findall(r"\bnpm\s+run\s+([A-Za-z][\w:-]*)", snippet):
                totals["commands"] += 1
                if script not in package["scripts"]:
                    issue(file, f"unknown npm entrypoint: {script}")
            for script in re.findall(r"\bnode\s+([A-Za-z][\w./-]*\.(?:mjs|cjs|js))\b", snippet):
                totals["commands"] += 1
                if not (root / script).is_file():
                    issue(file, f"missing Node entrypoint: {script}")

    for directory in {file.parent for file in files if file.is_relative_to(docs)}:
        if not (directory / "README.md").is_file():
            issue(next(file for file in files if file.parent == directory), "section has no README")

    reached, pending = set(), [docs / "README.md"]
    while pending:
        file = pending.pop()
        if file not in reached:
            reached.add(file)
            pending.extend(graph.get(file, set()) - reached)
    for file in files:
        if file.is_relative_to(docs) and file not in aliases and file not in reached:
            issue(file, "canonical page is unreachable from docs/README.md")

    def original_anchors(file, record):
        required = record["baseline_anchors"]
        if not isinstance(required, list) or not all(isinstance(anchor, str) for anchor in required):
            raise ValueError("Invalid original documentation anchor inventory")
        actual = anchors(parts[file][0])
        for anchor in required:
            if anchor not in actual:
                issue(file, f"missing original anchor: {anchor}")
        return required

    landing = routes["landing"]
    original_anchors(root / "README.md", landing)
    for old, current in landing["sections"].items():
        actual = anchors(parts[root / "README.md"][0])
        if old not in actual or current not in actual:
            issue(root / "README.md", f"missing landing compatibility route: {old}")

    for name, record in routes["pages"].items():
        file = docs / name
        if file.parent != docs or not file.is_file():
            errors.append(f"docs/{name}: compatibility address is missing or invalid")
            continue
        prose = parts[file][0]
        for anchor in original_anchors(file, record):
            if anchor not in record["sections"]:
                issue(file, f"missing original section mapping: {anchor}")
        targets = {m[1] for m in LINK.finditer(prose)}
        if record["target"] not in targets or "This page has moved to" not in prose:
            issue(file, "compatibility page does not identify its canonical page")
        for anchor, target in record["sections"].items():
            if anchor not in anchors(prose) or target not in targets:
                issue(file, f"missing compatibility route: {anchor}")

    electron = re.escape(package["dependencies"]["electron"])
    runtime_row = re.compile(rf"\| Electron\s+\| runtime closure \|\s+{electron}\s+\|")
    for file in [docs / "dependencies.md", docs / "development/dependencies.md"]:
        if not runtime_row.search(file.read_text()):
            issue(file, "Electron runtime row differs from package.json")
    media = json.loads((root / "resources/setup-media.json").read_text())
    urls = {url.rstrip(".,") for slot in media for step in slot["steps"] for url in URL.findall(step)}
    for file in [docs / "setup-links.md", docs / "reference/setup-links.md"]:
        for url in sorted(urls):
            if url not in file.read_text():
                issue(file, "bundled setup destination is missing")

    totals.update(pages=len(files), canonical=len(files) - len(aliases), aliases=len(aliases))
    return errors, totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2],
                        help="Repository root; defaults to this checkout")
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
    print(f"PASS: {totals['canonical']} canonical Markdown pages, {totals['aliases']} compatibility pages, "
          f"{totals['links']} local links/anchors, {totals['commands']} command references")
    return 0


if __name__ == "__main__":
    sys.exit(main())
