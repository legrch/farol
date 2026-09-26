#!/usr/bin/env python3
"""Run a command and prove it did not touch the owner's live Farol installation.

Tests are supposed to be hermetic: every one of them builds a throwaway home and
passes it explicitly. Nothing enforced that. On 2026-09-02 the owner's real
`~/.config/tunnel-client/*.yaml` and the workspace bridge manifest were found
pointing at a deleted test fixture — `…/T/farol-test-xxxxxxxx/home/.farol/
releases/farol-0.1.1-…` — which stopped the Hub from starting until the profiles
were reconciled by hand. The specific test was never reproduced, and that is
exactly why this exists: the next one will announce itself instead of being
discovered an hour later from a supervisor log.

It is a fingerprint, not a sandbox. It cannot stop a write; it makes one
impossible to miss, immediately, naming the file. That is the right trade for a
gate — a real sandbox would have to model everything a test legitimately does to
its own fixtures, and would be wrong the first time somebody added a case.

    scripts/assert-owner-untouched.py -- python3 -m unittest discover -s tests

Exit status is the command's own, unless the command passed and the owner's
installation changed, which is failure 1 whatever the command said.
"""

from __future__ import annotations

import hashlib
import os
import signal
import subprocess
import sys
from pathlib import Path

HOME = Path(os.path.expanduser("~"))

def _environment_paths():
    """Frozen V0 protection boundary at the standalone split.

    These are compatibility paths, not a dependency on a V0 checkout. Keep
    the owner installation, launchers, shared tunnel directory, and browser
    identity protected while tests use explicit disposable homes.
    """
    watched = tuple(HOME / relative for relative in (
        ".farol/current", ".farol/previous", ".farol/releases", ".farol/state",
        ".farol/runtime/hub", ".local/state/farol",
        "Library/LaunchAgents/local.farol.hub.plist",
        "bin/farol", "bin/farol-browser", "bin/farol-menubar", "bin/farol-full",
        "bin/farol-advisor-guard", "bin/farol-id-migrate",
        ".config/tunnel-client", ".local/libexec/agent-commons/secure-mcp-tunnel",
        ".local/state/agent-commons/secure-mcp-tunnel",
    ))
    # New-product profile identities are observed without walking cookies,
    # sessions, settings or authentication data. Startup markers are the only
    # content-hashed files: a test touching an owner generation must fail.
    new_profiles = (
        "Library/Application Support/Farol Dev",
        "Library/Application Support/Farol DEV",
        "Library/Application Support/Farol Next Preview",
        "Library/Application Support/Farol Dev Acceptance",
        "Library/Application Support/Farol Dev Acceptance/Farol Dev",
        "Library/Application Support/Farol Dev Acceptance/Farol DEV",
    )
    watched += tuple(
        HOME / profile / "farol-next-state" / marker
        for profile in new_profiles
        for marker in ("running.json", "last-quit.json")
    )
    presence = (HOME / ".farol/runtime/browser/browser-profile",) + tuple(
        HOME / profile for profile in new_profiles
    )
    churn = frozenset((
        "health.url", "tunnel-client.pid", "lifecycle.json", "lifecycle.jsonl",
        "hub-lifecycle.jsonl", "supervisor.lock", "supervisor.log",
        "codex-route-interpreters.json", "codex-route-activity.json",
        "service.log", "update-check.json",
    ))
    exempt = frozenset(HOME / ".config/tunnel-client" / name for name in (
        "farol-dev-full.yaml", "farol-dev-read.yaml",
    ))
    return watched, presence, churn, exempt


try:
    WATCHED, MTIME_ONLY, IGNORED_NAMES, EXEMPT = _environment_paths()
except Exception as error:  # pragma: no cover - proven by its own test
    # A guard that cannot tell what to watch must not quietly watch less. The
    # whole value here is that a green run means something.
    sys.stderr.write(
        "[fail] assert-owner-untouched could not read the product's own paths, so it "
        "cannot prove anything was left alone: {}\n".format(error)
    )
    raise SystemExit(2)


IGNORED_SUFFIXES = (".log", ".lock", ".jsonl")

# The same churn, caught mid-write. Everything here writes atomically — a dot
# file beside the target, then a rename — so a run that happens to end inside
# that window would otherwise fail on a file that no longer exists by the time
# anybody looks. The rename's result is still fingerprinted under its real name,
# which is the thing worth failing on.
IGNORED_INFIX = (".tmp-", ".farol-tmp-", ".reconcile-")

# The product's own atomic-write convention, which is not the one above. Six
# writers in `src/lifecycle/` stage through `.<name>.tmp` — a fixed suffix, no
# random part — so a mid-write sibling of an allowed churn file did not match
# any infix and failed the run. Measured on 2026-09-06: a gate run beside the
# owner's own supervised Codex route reported
# `.codex-route-activity.json.tmp` as the suite writing into their install,
# while `codex-route-activity.json` itself was already allowed to churn.
#
# The allowance is deliberately narrower than `IGNORED_INFIX`, which tolerates
# any dotted name carrying its marker. Here the sibling is forgiven only when
# the name it stages for is ALREADY named churn, so a test writing
# `.something-else.tmp` still fails, which is the whole point of this script.
STAGING_SUFFIX = ".tmp"

# The third shape the same idea takes: a reservation held beside an append-only
# log while the running Hub decides what to write next. Measured on 2026-09-11:
# with no test and no command running at all, the live service rewrote
# `~/.farol/runtime/hub/farol-full/hub-actions.jsonl.reservation` about every
# fifty seconds, so a gate run beside a running Hub failed on the service's own
# bookkeeping and reported it as the suite writing into the owner's install.
# `hub-actions.jsonl` was already allowed to churn; its reservation was not.
#
# Forgiven on exactly the same terms as the staging sibling above: only when the
# name it reserves for is ALREADY allowed to churn. A test writing
# `something-else.reservation` still fails, which is the whole point.
RESERVATION_SUFFIX = ".reservation"
MAX_FINGERPRINT_BYTES = 4 * 1024 * 1024


def _stages_for_churn(name: str) -> bool:
    """Is this the mid-write sibling of a file we already allow to change?"""

    if not name.startswith(".") or not name.endswith(STAGING_SUFFIX):
        return False
    target = name[1 : -len(STAGING_SUFFIX)]
    return bool(target) and target in IGNORED_NAMES


def _reserves_for_churn(name: str) -> bool:
    """Is this the reservation held beside a file we already allow to change?"""

    if not name.endswith(RESERVATION_SUFFIX):
        return False
    target = name[: -len(RESERVATION_SUFFIX)]
    if not target:
        return False
    return target in IGNORED_NAMES or target.endswith(IGNORED_SUFFIXES)


def _digest(path: Path) -> str:
    try:
        if path.is_symlink():
            return "link:" + os.readlink(path)
        info = path.stat()
        if info.st_size > MAX_FINGERPRINT_BYTES:
            return f"large:{info.st_size}"
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except OSError as error:
        return f"unreadable:{error.errno}"


def _interesting(path: Path) -> bool:
    if path in EXEMPT:
        return False
    if path.name in IGNORED_NAMES:
        return False
    if path.name.startswith(".") and any(part in path.name for part in IGNORED_INFIX):
        return False
    if _stages_for_churn(path.name):
        return False
    if _reserves_for_churn(path.name):
        return False
    return not path.name.endswith(IGNORED_SUFFIXES)


def fingerprint() -> dict[str, str]:
    seen: dict[str, str] = {}
    for target in WATCHED:
        try:
            relative = target.relative_to(HOME)
        except ValueError:
            relative = target
        if not target.exists() and not target.is_symlink():
            continue
        if target.is_symlink() or target.is_file():
            if _interesting(target):
                seen[str(relative)] = _digest(target)
            continue
        for base, _dirs, files in os.walk(target):
            for name in files:
                path = Path(base) / name
                if not _interesting(path):
                    continue
                try:
                    key = path.relative_to(HOME)
                except ValueError:
                    key = path
                seen[str(key)] = _digest(path)
    for target in MTIME_ONLY:
        # Existence and identity only. This is the owner's signed-in browser
        # session: a run that deletes or replaces it must be caught, and its
        # contents change every second while Chrome is open, so hashing them
        # would make the gate fail at random.
        try:
            relative = target.relative_to(HOME)
        except ValueError:
            relative = target
        seen[str(relative)] = _presence(target)
    return seen


def _presence(path: Path) -> str:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return "absent"
    except OSError as error:
        return "unreadable:{}".format(error.errno)
    return "present:{}:{}".format(info.st_dev, info.st_ino)


def report(before: dict[str, str], after: dict[str, str]) -> list[str]:
    changed = []
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if old == new:
            continue
        if old is None:
            changed.append(f"  created  ~/{key}")
        elif new is None:
            changed.append(f"  deleted  ~/{key}")
        else:
            changed.append(f"  rewrote  ~/{key}")
    return changed


_CHILD: subprocess.Popen | None = None


def _ignore_sigint(signum, frame):  # noqa: ANN001 - signal handler signature
    # The terminal already delivered this to the child directly: a wrapped
    # command runs in the same foreground process group unless it changes
    # that itself, so Ctrl+C reaches both processes at once. Python's default
    # SIGINT handler would otherwise raise KeyboardInterrupt here and abort
    # this wrapper with a traceback before the child has actually exited.
    # Doing nothing lets `_CHILD.wait()` below return normally once the child
    # (which did receive the signal) finishes reacting to it.
    del signum, frame


def _forward_sigterm(signum, frame):  # noqa: ANN001 - signal handler signature
    # Unlike SIGINT, a SIGTERM sent to this wrapper specifically (rather than
    # to the whole foreground process group) would not otherwise reach the
    # child at all, so it is relayed explicitly.
    del signum, frame
    if _CHILD is not None and _CHILD.poll() is None:
        try:
            _CHILD.send_signal(signal.SIGTERM)
        except OSError:
            pass


def main(argv: list[str]) -> int:
    global _CHILD

    if not argv or argv[0] != "--" or len(argv) < 2:
        sys.stderr.write("usage: assert-owner-untouched.py -- <command> [arguments...]\n")
        return 2
    command = argv[1:]

    # Installed for the whole of this function, not just around the child's
    # wait: an owner Ctrl+C can land while this is still walking the watched
    # paths, either before the child starts or during the fingerprint taken
    # after it exits, and Python's default SIGINT handler would raise
    # KeyboardInterrupt there just as readily, producing the exact traceback
    # this exists to avoid.
    previous_sigint = signal.signal(signal.SIGINT, _ignore_sigint)
    previous_sigterm = signal.signal(signal.SIGTERM, _forward_sigterm)
    try:
        before = fingerprint()
        _CHILD = subprocess.Popen(command)
        returncode = _CHILD.wait()
        completed_returncode = returncode
        changed = report(before, fingerprint())
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)
        _CHILD = None

    if changed:
        sys.stderr.write(
            "\n[fail] that run modified the owner's live Farol installation:\n"
            + "\n".join(changed)
            + "\n\nA test must build its own home and pass it explicitly. Writing here "
            "is how a suite stops the owner's Hub, and it is not something to fix "
            "afterwards by reconciling profiles by hand.\n"
        )
        return 1
    status = completed_returncode
    return 128 - status if status < 0 else status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
