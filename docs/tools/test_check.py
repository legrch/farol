"""Synthetic offline regressions for documentation placement and link coverage."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("doccheck", Path(__file__).with_name("check.py"))
doccheck = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doccheck)


class DocumentationCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="farol-docs-check-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        for path in doccheck.selected_files(self.root):
            self.write(path.relative_to(self.root), "# Reader\n")
        self.write("package.json", '{"scripts": {}}')
        self.write("Taskfile.yml", "version: '3'\ntasks:\n")
        self.write("docs/tools/placement-exceptions.json", "{}")

    def write(self, name, content):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def errors(self):
        return doccheck.check(self.root)[0]

    def test_root_entrypoints_and_canonical_docs_pass(self):
        self.write("AGENTS.md", "# Repository policy\n")
        self.write("docs/reference/modules/task/README.md", "# Task\n")
        self.assertEqual([], self.errors())

    def test_new_module_markdown_is_refused_including_uppercase_extension(self):
        for name in ("modules/computer/access.md", "modules/task/README.MD"):
            with self.subTest(name=name):
                self.write(name, "# Scattered\n")
                self.assertTrue(any(name in error and "belongs under docs/" in error for error in self.errors()))

    def test_new_design_and_resource_notes_are_refused(self):
        self.write("design-lab/proposal.md", "# Proposal\n")
        self.write("resources/design.md", "# Design\n")
        self.assertEqual(2, len(self.errors()))

    def test_exception_requires_canonical_entry_and_cannot_go_stale(self):
        name = "resources/asset/PROVENANCE.md"
        self.write(name, "# Provenance\n")
        exceptions = {name: {"reason": "Synthetic machine custody requirement", "index": "docs/design/README.md"}}
        self.write("docs/tools/placement-exceptions.json", json.dumps(exceptions))
        self.assertTrue(any("canonical index entry" in error for error in self.errors()))
        self.write("docs/design/README.md", f"# Asset records\n\n[{name}](../../{name})\n")
        self.assertEqual([], self.errors())
        (self.root / name).unlink()
        self.assertTrue(any("stale placement exception" in error for error in self.errors()))

    def test_links_outside_reader_pages_are_checked(self):
        self.write("docs/reference/modules/chat/lifecycle.md", "# Lifecycle\n\n[Missing](absent.md)\n")
        self.assertTrue(any("missing target: absent.md" in error for error in self.errors()))

    def test_reference_links_and_html_images_are_checked(self):
        self.write("docs/design/README.md", '# Design\n\n[Study][study]\n\n[study]: missing.md\n\n<img src="missing.png">\n')
        errors = self.errors()
        self.assertTrue(any("missing target: missing.md" in error for error in errors))
        self.assertTrue(any("missing target: missing.png" in error for error in errors))

    def test_undefined_reference_and_missing_anchor_are_refused(self):
        self.write("docs/reference/example.md", "# Example\n\n[Unknown][absent]\n\n[Section](#absent)\n")
        errors = self.errors()
        self.assertTrue(any("missing reference definition: absent" in error for error in errors))
        self.assertTrue(any("missing anchor: #absent" in error for error in errors))

    def test_inline_code_and_fenced_examples_are_not_links(self):
        self.write("docs/reference/example.md", "# Example\n\nUse `[A-Z][A-Z0-9_]*` or ``[text][label]``.\n\n```md\n[Original](missing.md)\n```\n")
        self.assertEqual([], self.errors())

    def test_repeated_heading_anchors_and_source_links_resolve(self):
        self.write("modules/chat/source.go", "package chat\n")
        self.write("docs/reference/example.md", "# Example\n\n## Repeated\n\n## Repeated\n\n[Again](#repeated-1) [Source](../../modules/chat/source.go)\n")
        self.assertEqual([], self.errors())

    def test_frozen_archive_links_are_not_rewritten_or_linted(self):
        self.write("docs/archive/distribution-20261010/originals/fixture/README.md", "# Frozen\n\n[Original](missing.md)\n")
        self.assertEqual([], self.errors())

    def test_archive_index_links_are_checked(self):
        self.write("docs/archive/README.md", "# Archive index\n\n[Original](missing.md)\n")
        self.assertTrue(any("missing target: missing.md" in error for error in self.errors()))

    def test_ignored_dependency_markdown_is_not_inventory(self):
        self.write(".gitignore", "node_modules/\n")
        self.write("node_modules/vendor/README.md", "# Vendor\n\n[Original](missing.md)\n")
        self.assertEqual([], self.errors())


if __name__ == "__main__":
    unittest.main()
