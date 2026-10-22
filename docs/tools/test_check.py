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
        policy = Path(__file__).resolve().parents[2] / doccheck.GUIDE_POLICY
        self.write(doccheck.GUIDE_POLICY, policy.read_text())

    def write(self, name, content):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def errors(self):
        return doccheck.check(self.root)[0]

    def test_retired_ui_labels_fail_in_every_current_reader_scope(self):
        policy = json.loads((self.root / doccheck.GUIDE_POLICY).read_text())
        names = [*policy["readerFiles"], "docs/guides/nested/recovery.MD", "docs/start/nested/setup.md"]
        examples = [rule["label"] for rule in policy["retiredLabels"] if "pattern" not in rule]
        examples.extend([
            "Settings → Diagnostics", "Settings > Diagnostics", "Settings › Diagnostics",
            "Settings / Diagnostics", "Review Diagnostics", "Open the Diagnostics",
            "Settings → This Mac", "This Mac settings page", "page named This Mac", "Open This Mac",
            "Home → Check sign-in", "Home > Check sign-in",
        ])
        for name in names:
            for example in examples:
                with self.subTest(name=name, example=example):
                    self.write(name, f"# Guide\n\n{example}\n")
                    self.assertTrue(any(name in error and "retired UI label" in error for error in self.errors()))
            self.write(name, "# Guide\n")

    def test_wrapped_formatted_retired_routes_fail(self):
        self.write("docs/guides/recovery.md", "# Recovery\n\nOpen **Connection**\n**help**.\n")
        self.assertTrue(any("retired UI label: Connection help" in error for error in self.errors()))

    def test_current_ui_labels_and_ordinary_folder_words_pass(self):
        self.write("docs/guides/recovery.md", """# Recovery

Setup → Sign in → Workspaces → Connect this Mac → Add to ChatGPT.
Check sign-in; + Add workspace; Read only; Check access; Connect; Test in ChatGPT.
Settings → General → Update recovery…; Setup status; Save support file….
Review unresolved actions → Unresolved actions → Refresh status.
Inspect action details; Observe existing edit; Record result delivery.
This Mac has folders. Diagnostics can be useful evidence.
""")
        self.assertEqual([], self.errors())

    def test_history_adrs_and_past_release_notes_are_excluded_from_ui_check(self):
        names = [
            "docs/reference/history/setup.md", "docs/archive/example.md",
            "docs/adr/001-setup.md", "docs/adrs/001-setup.md",
            "docs/releases/v0.1.md", "docs/release-notes/v0.1.md",
            "docs/guides/history/setup.md", "docs/guides/archive/setup.md",
            "docs/guides/adr/001-setup.md", "docs/start/adrs/001-setup.md",
            "docs/guides/ADR-001-setup.md", "docs/start/release-notes-v0.1.md",
            "docs/guides/releases/v0.1.md", "docs/start/release-notes/v0.1.md",
        ]
        for name in names:
            self.write(name, "# Historical\n\nConnection help → Connection diagnostics\n")
        self.assertEqual([], self.errors())

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
