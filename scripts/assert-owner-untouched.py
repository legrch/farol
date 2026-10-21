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
import json
import os
import signal
import stat
import subprocess
import sys
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
NEW_PROFILES = (
    "Library/Application Support/Farol Dev",
    "Library/Application Support/Farol DEV",
    "Library/Application Support/Farol Next Preview",
    "Library/Application Support/Farol Dev Acceptance",
    "Library/Application Support/Farol Dev Acceptance/Farol Dev",
    "Library/Application Support/Farol Dev Acceptance/Farol DEV",
)


def _owner_launch_profiles(command: list[str]) -> frozenset[str]:
    """Allow only the exact profile a supported owner launch will update."""
    def selected_dev_profile(parent: str) -> str:
        preferred = f"{parent}/Farol Dev"
        legacy = f"{parent}/Farol DEV"
        return legacy if not (HOME / preferred).exists() and (HOME / legacy).exists() else preferred

    if len(command) >= 2 and Path(command[0]).name == "node":
        if command[1] == "tooling/dev.mjs":
            if "--check" in command[2:]:
                return frozenset()
            if "--acceptance-profile" in command[2:]:
                parent = "Library/Application Support/Farol Dev Acceptance"
                return frozenset((parent, selected_dev_profile(parent)))
            return frozenset((selected_dev_profile("Library/Application Support"),))
        if command[1] == "tooling/run-preview.mjs" and os.environ.get("FAROL_NEXT_OWNER_LAUNCH") == "1":
            return frozenset(("Library/Application Support/Farol Next Preview",))
    if command == ["npm", "run", "preview"]:
        return frozenset(("Library/Application Support/Farol Next Preview",))
    return frozenset()

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
    watched += tuple(
        HOME / profile / "farol-next-state" / marker
        for profile in NEW_PROFILES
        for marker in ("running.json", "last-quit.json")
    )
    presence = (HOME / ".farol/runtime/browser/browser-profile",) + tuple(
        HOME / profile for profile in NEW_PROFILES
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
OPEN_TIMEOUT_SECONDS = 5.0


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


class FingerprintError(Exception):
    """A bounded fingerprint could not prove a stable filesystem object."""


def _metadata(info: os.stat_result) -> str:
    # atime changes on our own reads; the remaining fields protect identity,
    # type, ownership, permissions and mutation without consuming special nodes.
    return ":".join(str(value) for value in (
        info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
        info.st_rdev, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
    ))


def _require_stable(path: Path, before: os.stat_result, after: os.stat_result) -> None:
    if _metadata(before) != _metadata(after):
        raise FingerprintError(f"filesystem object changed while fingerprinting: {path}")


def _open_content(path: Path) -> int:
    # POSIX has no portable regular-only open. NONBLOCK protects FIFO races;
    # the alarm bounds an interruptible open after other type substitutions.
    # This is not a device-driver side-effect or uninterruptible-I/O guarantee.
    if (not hasattr(signal, "setitimer") or not hasattr(signal, "pthread_sigmask")
            or signal.SIGALRM in signal.pthread_sigmask(signal.SIG_BLOCK, set())
            or signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0)):
        raise FingerprintError("a dedicated bounded descriptor-open deadline is unavailable")

    def timed_out(signum, frame):
        del signum, frame
        raise FingerprintError(f"descriptor open deadline exceeded: {path}")

    previous = signal.signal(signal.SIGALRM, timed_out)
    try:
        signal.setitimer(signal.ITIMER_REAL, OPEN_TIMEOUT_SECONDS)
        return os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _digest(path: Path) -> str:
    try:
        before = path.lstat()
        metadata = _metadata(before)
        if stat.S_ISLNK(before.st_mode):
            target = os.readlink(path)
            _require_stable(path, before, path.lstat())
            return f"link:{metadata}:{target}"
        if not stat.S_ISREG(before.st_mode):
            # FIFO, socket and device bytes have no safe file-content meaning.
            # Keep the node visible and detect replacement/metadata changes.
            _require_stable(path, before, path.lstat())
            return f"special:{metadata}"
        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_NONBLOCK"):
            raise FingerprintError("safe no-follow nonblocking file opens are unavailable")
        fd = _open_content(path)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode):
                raise FingerprintError(f"regular file replaced by a special object: {path}")
            _require_stable(path, before, opened)
            if opened.st_size > MAX_FINGERPRINT_BYTES:
                result = f"large:{metadata}"
            else:
                digest = hashlib.sha256()
                remaining = MAX_FINGERPRINT_BYTES + 1
                count = 0
                while remaining:
                    chunk = os.read(fd, min(65536, remaining))
                    if not chunk:
                        break
                    count += len(chunk)
                    remaining -= len(chunk)
                    if count > opened.st_size:
                        raise FingerprintError(f"file grew while fingerprinting: {path}")
                    digest.update(chunk)
                if count != opened.st_size:
                    raise FingerprintError(f"file length changed while fingerprinting: {path}")
                result = f"regular:{metadata}:{digest.hexdigest()[:16]}"
            _require_stable(path, before, os.fstat(fd))
            _require_stable(path, before, path.lstat())
            return result
        finally:
            os.close(fd)
    except OSError as error:
        raise FingerprintError(f"cannot safely fingerprint {path}: errno {error.errno}") from error


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


def _equivalent_profiles(selected: frozenset[str]) -> frozenset[str]:
    """Include only same-inode spelling aliases on case-insensitive volumes."""
    equivalent = set(selected)
    for candidate in NEW_PROFILES:
        if candidate in equivalent:
            continue
        try:
            if any(os.path.samefile(HOME / candidate, HOME / chosen) for chosen in selected):
                equivalent.add(candidate)
        except OSError:
            continue
    return frozenset(equivalent)


def fingerprint(allowed_profiles: frozenset[str] = frozenset()) -> dict[str, str]:
    seen: dict[str, str] = {}
    allowed_roots = tuple(HOME / profile for profile in _equivalent_profiles(allowed_profiles))
    for target in WATCHED:
        if any(target == root or root in target.parents for root in allowed_roots):
            continue
        try:
            relative = target.relative_to(HOME)
        except ValueError:
            relative = target
        try:
            target_info = target.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise FingerprintError(f"cannot inspect {target}: errno {error.errno}") from error
        if not stat.S_ISDIR(target_info.st_mode):
            if _interesting(target):
                seen[str(relative)] = _digest(target)
            continue
        def walk_error(error):
            raise FingerprintError(f"cannot walk protected directory: errno {error.errno}")

        for base, dirs, files in os.walk(target, onerror=walk_error):
            # os.walk does not follow directory symlinks, but their identity
            # and target must still remain part of the protected tree.
            links = [name for name in dirs if (Path(base) / name).is_symlink()]
            for name in files + links:
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


def report(before: dict[str, str], after: dict[str, str], allowed_profiles: frozenset[str] = frozenset()) -> list[str]:
    changed = []
    allowed_creation = _equivalent_profiles(allowed_profiles)
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if old == new:
            continue
        # A first owner launch may create its selected profile. Replacement of
        # an existing profile remains a guard failure.
        if (key in allowed_creation and old == "absent" and new is not None
                and new.startswith("present:") and (HOME / key).is_dir()
                and not (HOME / key).is_symlink()):
            continue
        if old is None:
            changed.append(f"  created  ~/{key}")
        elif new is None:
            changed.append(f"  deleted  ~/{key}")
        else:
            changed.append(f"  rewrote  ~/{key}")
    return changed


_CHILD: subprocess.Popen | None = None
_PHASE = "idle"
_FORWARD_ERROR: int | None = None


class GuardCancelled(Exception):
    def __init__(self, signum: int, phase: str):
        self.signum = signum
        self.phase = phase


def _handle_sigint(signum, frame):  # noqa: ANN001 - signal handler signature
    del frame
    if _PHASE != "child":
        raise GuardCancelled(signum, _PHASE)
    # A foreground terminal delivers SIGINT to the child too. Wait for its
    # actual exit instead of abandoning it with a wrapper traceback.


def _forward_sigterm(signum, frame):  # noqa: ANN001 - signal handler signature
    del frame
    if _PHASE != "child":
        raise GuardCancelled(signum, _PHASE)
    _signal_child(signum)


def _signal_child(signum: int) -> None:
    global _FORWARD_ERROR
    if _CHILD is not None and _CHILD.poll() is None:
        try:
            _CHILD.send_signal(signum)
        except ProcessLookupError:
            pass
        except OSError as error:
            # A refused relay is not proof of child exit. Keep waiting on the
            # owned child and make the failure visible after its actual exit.
            _FORWARD_ERROR = error.errno
            sys.stderr.write(f"[fail] cannot forward cancellation: errno {error.errno}; child exit not yet observed\n")


def _spawn_child(command: list[str]) -> None:
    global _CHILD, _PHASE
    # Publish the child atomically with respect to cancellation. The guard is
    # single-threaded; only this tiny POSIX spawn section blocks the two signals.
    # Restore the original mask in the child before exec, so it can be cancelled.
    cancelled_signals = {signal.SIGINT, signal.SIGTERM}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, cancelled_signals)
    try:
        pending = signal.sigpending() & cancelled_signals
        if pending:
            raise GuardCancelled(min(pending), "preflight")
        _CHILD = subprocess.Popen(
            command,
            preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask),
        )
        _PHASE = "child"
        # A group signal received during spawn predates the child's membership.
        # Relay it to the now-known child instead of losing cancellation.
        for signum in signal.sigpending() & cancelled_signals:
            # sigpending is observational. Consume before relay so restoring
            # the mask cannot forward the same SIGTERM a second time.
            signal.sigwait({signum})
            _signal_child(signum)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def main(argv: list[str]) -> int:
    global _CHILD, _PHASE, _FORWARD_ERROR

    if argv == ["--print-protected-roots"]:
        # Read-only: the paths this guard fingerprints, so a test that must never
        # name an owner location reads the same declaration instead of copying it.
        sys.stdout.write(json.dumps({
            "schema": 1,
            "watched": sorted(str(path) for path in WATCHED),
            "presence": sorted(str(path) for path in MTIME_ONLY),
        }) + "\n")
        return 0
    if not argv or argv[0] != "--" or len(argv) < 2:
        sys.stderr.write("usage: assert-owner-untouched.py -- <command> [arguments...]\n")
        return 2
    command = argv[1:]
    _PHASE = "preflight"
    _FORWARD_ERROR = None
    completed_returncode = None
    previous_sigint = signal.signal(signal.SIGINT, _handle_sigint)
    previous_sigterm = signal.signal(signal.SIGTERM, _forward_sigterm)
    try:
        allowed_profiles = _owner_launch_profiles(command)
        before = fingerprint(allowed_profiles)
        _spawn_child(command)
        completed_returncode = _CHILD.wait()
        _PHASE = "postflight"
        changed = report(before, fingerprint(allowed_profiles), allowed_profiles)
    except GuardCancelled as error:
        child_status = "no child spawned" if completed_returncode is None else f"child exit {completed_returncode}"
        sys.stderr.write(f"[fail] owner guard cancelled during {error.phase}; {child_status}; verification incomplete\n")
        return 128 + error.signum
    except (FingerprintError, OSError, subprocess.SubprocessError) as error:
        child_status = "no child spawned" if completed_returncode is None else f"child exit {completed_returncode}"
        sys.stderr.write(f"[fail] owner guard verification incomplete; {child_status}: {error}\n")
        return 2
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)
        _CHILD = None
        _PHASE = "idle"

    if _FORWARD_ERROR is not None:
        sys.stderr.write(f"[fail] cancellation relay refused; child exit {completed_returncode}; errno {_FORWARD_ERROR}\n")
        return 2
    if changed:
        sys.stderr.write(
            "\n[fail] that run modified the owner's live Farol installation:\n"
            + "\n".join(changed)
            + "\n\nA test must build its own home and pass it explicitly. Writing here "
            "is how a suite stops the owner's Hub, and it is not something to fix "
            "afterwards by reconciling profiles by hand.\n"
        )
        return 1
    return 128 - completed_returncode if completed_returncode < 0 else completed_returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
