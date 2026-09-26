#!/usr/bin/env python3
"""Scan tracked and nonignored source bytes, never generated dependency caches."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
paths = subprocess.check_output(
    ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
).split(b"\0")
private_name = re.compile(
    r"(^|/)(\.env(\..*)?|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.(pem|p12|pfx))$"
    r"|(^|/)(cookies?|credentials?|auth-state|session-token|transcripts?|browser-profile)(/|\.(json|jsonl|sqlite|db)$)",
    re.I,
)
with tempfile.TemporaryDirectory(prefix="farol-secret-scan-") as temporary:
    for raw in sorted(set(paths) - {b""}):
        relative = os.fsdecode(raw)
        if private_name.search(relative):
            raise SystemExit("Private source path refused: " + relative)
        source = root / relative
        if source.is_symlink():
            raise SystemExit("Source symlink refused: " + relative)
        if not source.is_file():
            raise SystemExit("Source file unreadable: " + relative)
        target = Path(temporary) / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    subprocess.run(
        ["gitleaks", "dir", "--config", str(root / "config/gitleaks.toml"), "--redact=100", temporary],
        check=True,
    )
