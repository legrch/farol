"""Descriptor-bound filesystem helper for Farol Next Computer.

This reviewed helper started from the Farol Hub safe-open implementation at
commit 59ae5c4's parent.  Next packages and attests its own bytes, sends them to
the reviewed CPython interpreter on stdin, and exposes typed read, list, grep,
write and edit operations through bounded Computer adapters.  Mutations require
an exact source digest (or an explicit create-only precondition), publish with
one descriptor-relative atomic replace and return content-free receipts.  A
successful response is ``FAROLR1\0`` plus an unsigned 64-bit big-endian payload
length and the exact payload bytes.  Failures are content-free exit statuses.
"""

import bisect
import json
import errno
import codecs
import ctypes
import hashlib
import itertools
import os
import re
import signal
import sre_parse
import stat
import struct
import sys
import unicodedata


MAGIC = b"FAROLR1\0"
MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_MUTATION_BYTES = 8 * 1024 * 1024
MAX_EDITS = 256

# Bounds on one list-context walk.  Reaching any of them stops the walk and
# returns what has been collected so far: a large workspace is an ordinary
# workspace, and refusing it outright would make open_workspace fail for a root
# whose only fault is its size.  Every bound is monotonic and the walk order is
# fixed, so the partial catalog is the same on every run over the same tree.
MAX_CONTEXT_FILES = 200
MAX_CONTEXT_DIRECTORIES = 10000
MAX_CONTEXT_ENTRIES = 100000
MAX_CONTEXT_DEPTH = 64

# Search walks are deliberately bounded independently of result counts.  A
# pattern that matches nothing must not be able to turn one MCP call into an
# unbounded filesystem crawl.
MAX_SEARCH_DIRECTORIES = 10000
MAX_SEARCH_ENTRIES = 100000
MAX_SEARCH_DEPTH = 64
MAX_LIST_RESULTS = 500
MAX_GLOB_RESULTS = 1000
MAX_GREP_RESULTS = 100
MAX_GREP_LINE_CHARS = 500
# The Node adapter accepts at most 512 KiB of response payload.  Matches are
# charged at their serialized size (ASCII-escaped path and excerpt included)
# before they are kept, and 1 KiB stays reserved for the result envelope, so
# a search that would overflow ends as a bounded partial result instead of a
# killed helper.
MAX_GREP_RESPONSE_BYTES = 512 * 1024 - 1024
MAX_GREP_FILE_BYTES = 8 * 1024 * 1024
MAX_GREP_TOTAL_BYTES = 64 * 1024 * 1024
MAX_IGNORE_BYTES = 256 * 1024
MAX_GREP_WALL_SECONDS = 5.0
# One window of a file somebody else is still writing.  Large enough that a
# tail or a search step is one call, small enough that a caller cannot ask for
# a whole transcript by naming a length.
MAX_WINDOW_BYTES = 4 * 1024 * 1024
# An offset only positions one bounded read, so it is not capped by file size:
# any offset a JavaScript caller can express exactly is accepted, and the
# next offset a window reports is always a request this helper will serve.
MAX_WINDOW_OFFSET = 2 ** 53 - 1

# workspace-snapshot bounds.  A caller may ask for a smaller ceiling (clamped
# the same way _source_ceiling clamps maxBytes for a read); it can never ask
# for more than these.  Two byte budgets, because the two kinds of file in a
# snapshot cost different things.  `MAX_SNAPSHOT_BYTES` bounds bytes this verb
# itself reads and writes: the copied index and the rewritten config.
# `MAX_SNAPSHOT_CLONED_BYTES` bounds the sizes of the regular files attached as
# APFS clones (`fclonefileat`): a clone moves no data -- it is a new inode
# sharing the source's extents copy-on-write -- so its budget is a bound on
# the work Git is then committed to (every cloned byte may be hashed once),
# which the command's own ten-second deadline already caps; it is generous so
# an ordinary large repository is never refused for its size alone, while a
# single absurd blob still is.  A cross-volume root cannot be cloned at all
# (`EXIT_SNAPSHOT_CROSS_VOLUME`) and a volume without clone support refuses
# distinctly (`EXIT_SNAPSHOT_CLONE_UNSUPPORTED`); neither case ever falls back
# to copying an unbounded tree.
MAX_SNAPSHOT_ENTRIES = 200_000
MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
MAX_SNAPSHOT_CLONED_BYTES = 4 * 1024 * 1024 * 1024
MAX_SNAPSHOT_CONFIG_BYTES = 256 * 1024
MAX_SNAPSHOT_GITLINK_BYTES = 4096
MAX_SNAPSHOT_DEPTH = 64
# A caller-named relative path list (the "bounded path mode"): every regular
# file `git ls-files` reports, instead of the whole approved tree.  Bounded by
# the same entry ceiling, since each named path becomes at most one entry.
MAX_SNAPSHOT_PATHS = MAX_SNAPSHOT_ENTRIES

EXIT_INVALID = 20
EXIT_NOT_FOUND = 21
EXIT_PATH_REFUSED = 22
EXIT_NOT_A_FILE = 23
EXIT_FILE_TOO_LARGE = 24
EXIT_RACE = 25
EXIT_INTERNAL = 26
EXIT_TIMEOUT = 27
EXIT_NOT_TEXT = 28
EXIT_EDIT_NO_MATCH = 29
EXIT_EDIT_NOT_UNIQUE = 30
EXIT_EDIT_OVERLAP = 31
EXIT_MUTATION_OUTCOME_UNKNOWN = 32
EXIT_ROOT_CHANGED = 33
# workspace-snapshot only, below.  Distinct from EXIT_ROOT_CHANGED (identity
# lost while walking the approved tree itself) and from the generic codes
# above so the caller can tell "the source moved" from "the snapshot request
# itself cannot be satisfied".
EXIT_SNAPSHOT_CROSS_VOLUME = 34
EXIT_SNAPSHOT_TOO_LARGE = 35
EXIT_SNAPSHOT_METADATA_UNAPPROVED = 36
EXIT_SNAPSHOT_DESTINATION_INVALID = 37
# The destination volume holds no clone support (`fclonefileat` -> ENOTSUP):
# a non-APFS volume.  Distinct from EXIT_SNAPSHOT_CROSS_VOLUME so the caller
# can say which of the two the owner's layout ran into.
EXIT_SNAPSHOT_CLONE_UNSUPPORTED = 38
# The caller asked for the snapshot only if the live index still has the
# exact bytes an earlier snapshot copied (`expectedIndexSha256`), and it no
# longer does: the tracked-path list the caller derived from that earlier copy
# would describe a different index than the one this snapshot would carry.
EXIT_SNAPSHOT_INDEX_CHANGED = 39
# The repository borrows objects from another object store
# (`objects/info/alternates`).  That store lives outside the snapshot by
# construction, so Git could never read it there; refused up front, before
# the file is read, instead of letting the fixed command fail obscurely.
EXIT_SNAPSHOT_ALTERNATES_UNSUPPORTED = 40
# S35-H1-2.  A tracked path is listed and cloned one at a time, so a process
# writing inside the approved root between two clones could leave a snapshot
# holding file `a` as it was before that write and file `b` as it was after:
# a tree that never existed at any single instant, whose `git status` the
# caller would then report as the truth about the owner's workspace.  The
# index pin (`expectedIndexSha256`) cannot see it -- a working-tree write
# does not touch `.git/index`.  Every tracked source's stable identity is
# therefore kept as it was cloned and re-checked once the whole list is
# attached; any difference refuses here rather than reporting a mixed tree.
EXIT_SNAPSHOT_TREE_CHANGED = 41

CONTEXT_NAMES = ("AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")
CONTEXT_NAME_SET = frozenset(CONTEXT_NAMES)
SKIPPED_CONTEXT_DIRS = frozenset(
    (
        ".git",
        ".hg",
        ".svn",
        ".devspace",
        "node_modules",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
    )
)

DIRECTORY_FLAGS = (
    os.O_RDONLY
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
    | os.O_CLOEXEC
    | getattr(os, "O_NONBLOCK", 0)
)
FILE_FLAGS = (
    os.O_RDONLY
    | os.O_NOFOLLOW
    | os.O_CLOEXEC
    | getattr(os, "O_NONBLOCK", 0)
)


class Refusal(Exception):
    def __init__(self, status):
        super().__init__()
        self.status = status


def refuse(status):
    raise Refusal(status)


def _read_request():
    chunks = []
    remaining = MAX_REQUEST_BYTES + 1
    while remaining:
        chunk = os.read(3, min(8192, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    raw = b"".join(chunks)
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        refuse(EXIT_INVALID)
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        refuse(EXIT_INVALID)
    if not isinstance(request, dict):
        refuse(EXIT_INVALID)
    return request


def _components(value, *, absolute):
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        refuse(EXIT_INVALID)
    if absolute:
        if not value.startswith("/") or os.path.normpath(value) != value or value == "/":
            refuse(EXIT_INVALID)
        parts = value.split("/")[1:]
    else:
        if value.startswith("/") or os.path.normpath(value) != value:
            refuse(EXIT_INVALID)
        parts = value.split("/")
    if not parts or len(parts) > 256:
        refuse(EXIT_INVALID)
    for part in parts:
        if part in ("", ".", "..") or len(os.fsencode(part)) > 255:
            refuse(EXIT_INVALID)
    return parts


def _map_open_error(error, parent_fd, name):
    if error.errno == errno.ELOOP:
        refuse(EXIT_PATH_REFUSED)
    try:
        listed = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        listed = None
    if listed is not None and stat.S_ISLNK(listed.st_mode):
        refuse(EXIT_PATH_REFUSED)
    if error.errno in (2, 20):  # ENOENT, ENOTDIR
        refuse(EXIT_NOT_FOUND)
    refuse(EXIT_PATH_REFUSED)


def _open_directory(parent_fd, name):
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        _map_open_error(error, parent_fd, name)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            refuse(EXIT_NOT_FOUND)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


MAX_TEST_BARRIERS = 4


def _test_hook(request, phase, index=None):
    hook = request.get("testHook")
    if hook is None:
        return
    barriers = hook if isinstance(hook, list) else [hook]
    if not 1 <= len(barriers) <= MAX_TEST_BARRIERS:
        refuse(EXIT_INVALID)
    for position, barrier in enumerate(barriers):
        if not isinstance(barrier, dict) or set(barrier) != {"phase", "index"}:
            refuse(EXIT_INVALID)
        if barrier.get("phase") != phase or barrier.get("index") != index:
            continue
        # FDs 4 and 5 exist only in the test adapter.  Production requests
        # cannot ask the public MCP surface to add them.  The signal names the
        # barrier, so a test can pause the helper at several points in turn.
        try:
            os.write(4, b"R" + bytes((position,)))
            if os.read(5, 1) != b"C":
                refuse(EXIT_INTERNAL)
        except OSError:
            refuse(EXIT_INTERNAL)
        return


def _approved_root(request, parts):
    """The approved folder's depth in `parts` and the identity it had then.

    The approved root is the requested root or one of its ancestors, so a
    narrowed subtree is still checked against the folder the owner approved.
    A pathname alone cannot tell a replacement at the same path from the
    approved object; its device and inode can.
    """

    approved = request.get("approvedRoot")
    # No request is approved without the identity the owner verified: without
    # it a folder that later took the same path would pass as the approved one.
    if not isinstance(approved, dict) or set(approved) != {"path", "device", "inode"}:
        refuse(EXIT_INVALID)
    approved_parts = _components(approved.get("path"), absolute=True)
    identity = []
    for key in ("device", "inode"):
        value = approved.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,20}", value):
            refuse(EXIT_INVALID)
        identity.append(int(value))
    if len(approved_parts) < 1 or tuple(parts[: len(approved_parts)]) != tuple(
        approved_parts
    ):
        refuse(EXIT_INVALID)
    return len(approved_parts) - 1, tuple(identity)


def _refuse_if_replaced(descriptor, identity):
    opened = os.fstat(descriptor)
    if (opened.st_dev, opened.st_ino) != identity:
        refuse(EXIT_ROOT_CHANGED)


def _open_root(request):
    parts = _components(request.get("root"), absolute=True)
    approved = _approved_root(request, parts)
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for index, part in enumerate(parts):
            child = _open_directory(descriptor, part)
            os.close(descriptor)
            descriptor = child
            if approved is not None and index == approved[0]:
                _refuse_if_replaced(descriptor, approved[1])
            _test_hook(request, "after-directory", index)
        opened = os.fstat(descriptor)
        if opened.st_uid != os.getuid() or opened.st_mode & 0o022:
            refuse(EXIT_PATH_REFUSED)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _walk_parent(request, root_fd):
    parts = _components(request.get("relative"), absolute=False)
    _refuse_if_denied(parts)
    descriptor = os.dup(root_fd)
    try:
        for index, part in enumerate(parts[:-1]):
            child = _open_directory(descriptor, part)
            os.close(descriptor)
            descriptor = child
            _test_hook(request, "after-relative-directory", index)
        return descriptor, parts[-1]
    except BaseException:
        os.close(descriptor)
        raise


def _open_or_create_directory(parent_fd, name):
    """Open one real directory, creating that exact component when absent."""
    try:
        return _open_directory(parent_fd, name), False
    except Refusal as error:
        if error.status != EXIT_NOT_FOUND:
            raise
    created = False
    try:
        os.mkdir(name, mode=0o755, dir_fd=parent_fd)
        created = True
    except OSError as error:
        if error.errno != errno.EEXIST:
            _map_open_error(error, parent_fd, name)
    try:
        return _open_directory(parent_fd, name), created
    except BaseException:
        if created:
            refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
        raise


def _walk_parent_for_write(request, root_fd):
    parts = _components(request.get("relative"), absolute=False)
    _refuse_if_denied(parts)
    descriptor = os.dup(root_fd)
    created_any = False
    try:
        for index, part in enumerate(parts[:-1]):
            child, created = _open_or_create_directory(descriptor, part)
            created_any = created_any or created
            os.close(descriptor)
            descriptor = child
            _test_hook(request, "after-relative-directory", index)
        return descriptor, parts[-1], created_any
    except Refusal as error:
        os.close(descriptor)
        if created_any and error.status != EXIT_MUTATION_OUTCOME_UNKNOWN:
            refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
        raise
    except BaseException:
        os.close(descriptor)
        if created_any:
            refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
        raise


def _stable_identity(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


# Root-relative paths this request must never open or walk into, set once from
# the request before any descriptor exists.  The helper serves exactly one
# request per process, so a module-level answer is the whole truth about it.
#
# This is the same list the Hub gives the kernel for the shell.  Enforcing it
# here as well is not belt-and-braces for its own sake: an approved root may
# contain a credential directory, and a caller that names it, walks into it, or
# greps through it has to be refused by the thing that opens files, not only by
# the thing that runs commands.
_DENIED_PREFIXES = ()
MAX_DENIED_PREFIXES = 64

# Root-relative paths this request may read but must never change, set the same
# way and from the same request.  Two lists rather than one, because one list
# cannot express the rule: adding ``.git`` to the list above would also make
# ``.git/config`` unreadable, and reading Git state is exactly what a delegated
# worker needs in order to report what it did.  The shell half of this boundary
# makes the same distinction, in `src/hub/git-fence.mjs`.
_WRITE_DENIED_PREFIXES = ()

# The operations that change a file.  Named here so the write-denied check has
# one answer to consult rather than a literal of its own; the dispatch below
# still chooses a walk per operation, because ``write`` may create the
# directories on the way down and ``edit`` may not.  An operation added there
# and not here would be a mutation nothing fences.
MUTATING_OPERATIONS = ("write", "edit")


def _comparable(part):
    """One path component, folded the way the filesystem compares it.

    macOS volumes are case-insensitive and normalisation-insensitive by default:
    `.SSH` and `.ssh` are one directory, and so are the composed and decomposed
    spellings of any name carrying an accent.  Comparing components byte-wise
    therefore answered a different question from the one that matters — it asked
    whether two names were spelled alike, not whether they named the same file.
    Every entry on the deny list was reachable by changing a letter's case:
    `openat` opened `.SSH` and returned the same inode as `.ssh`, while this
    check saw two different strings and allowed the walk through.

    Folding unconditionally, rather than probing the volume, keeps the boundary
    one rule instead of one rule per mount.  On a case-sensitive volume it can
    refuse a differently-cased sibling that would have been safe to serve, which
    is the direction a deny list is allowed to be wrong in.
    """

    return unicodedata.normalize("NFC", part).casefold()


def _parse_denied(request):
    """The paths this request may not reach at all."""
    return _parse_prefixes(request.get("denied"))


def _parse_write_denied(request):
    """The paths this request may read but may not change."""
    return _parse_prefixes(request.get("writeDenied"))


def _parse_prefixes(raw):
    if raw is None:
        return ()
    if not isinstance(raw, list) or len(raw) > MAX_DENIED_PREFIXES:
        refuse(EXIT_INVALID)
    prefixes = []
    for entry in raw:
        parts = tuple(_comparable(part) for part in _components(entry, absolute=False))
        if parts not in prefixes:
            prefixes.append(parts)
    return tuple(prefixes)


def _under(parts, prefixes):
    listed = tuple(_comparable(part) for part in parts)
    for prefix in prefixes:
        if listed[: len(prefix)] == prefix:
            return True
    return False


def _denied(parts):
    """True when this root-relative path is a denied path or lives inside one."""
    return _under(parts, _DENIED_PREFIXES)


def _refuse_if_denied(parts):
    if _denied(parts):
        refuse(EXIT_PATH_REFUSED)


def _refuse_if_write_denied(parts):
    """Refuse a mutation whose target is inside a path this request may only read."""
    if _under(parts, _WRITE_DENIED_PREFIXES):
        refuse(EXIT_PATH_REFUSED)


def _search_relative(value):
    """Return a plain relative path, accepting only ``.`` for the root."""
    if value == ".":
        return []
    parts = _components(value, absolute=False)
    if any(not _safe_output_name(part) for part in parts):
        refuse(EXIT_PATH_REFUSED)
    return parts


def _safe_output_name(name):
    return (
        isinstance(name, str)
        and name not in ("", ".", "..")
        and "/" not in name
        and "\\" not in name
        and all(ord(character) >= 32 and ord(character) != 127 for character in name)
    )


def _open_relative_directory(request, root_fd, relative):
    parts = _search_relative(relative)
    _refuse_if_denied(parts)
    descriptor = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            child = _open_directory(descriptor, part)
            os.close(descriptor)
            descriptor = child
            _test_hook(request, "after-search-directory", index)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _listed_child(parent_fd, name, *, missing_status=EXIT_RACE):
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            refuse(missing_status)
        refuse(EXIT_PATH_REFUSED)


def _opened_regular(parent_fd, name, *, explicit):
    listed = _listed_child(
        parent_fd,
        name,
        missing_status=EXIT_NOT_FOUND if explicit else EXIT_RACE,
    )
    if stat.S_ISLNK(listed.st_mode):
        if explicit:
            refuse(EXIT_PATH_REFUSED)
        return None
    if not stat.S_ISREG(listed.st_mode):
        if explicit:
            refuse(EXIT_NOT_A_FILE)
        return None
    # A descriptor walk proves the pathname chain but cannot prove where a
    # second hardlink to the same inode lives.  Search therefore skips such
    # entries, and an explicitly requested file fails closed.
    if listed.st_nlink != 1:
        if explicit:
            refuse(EXIT_PATH_REFUSED)
        return None
    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        _map_open_error(error, parent_fd, name)
    try:
        opened = os.fstat(descriptor)
        if _stable_identity(listed) != _stable_identity(opened) or opened.st_nlink != 1:
            refuse(EXIT_RACE)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _opened_child_directory(parent_fd, name, *, explicit):
    listed = _listed_child(
        parent_fd,
        name,
        missing_status=EXIT_NOT_FOUND if explicit else EXIT_RACE,
    )
    if stat.S_ISLNK(listed.st_mode):
        if explicit:
            refuse(EXIT_PATH_REFUSED)
        return None
    if not stat.S_ISDIR(listed.st_mode):
        if explicit:
            refuse(EXIT_PATH_REFUSED)
        return None
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        _map_open_error(error, parent_fd, name)
    try:
        opened = os.fstat(descriptor)
        if _stable_identity(listed) != _stable_identity(opened):
            refuse(EXIT_RACE)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _read_descriptor(descriptor, *, ceiling, request=None, hook_phase=None):
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        refuse(EXIT_PATH_REFUSED)
    if before.st_size < 0 or before.st_size > ceiling:
        return None
    chunks = []
    remaining = before.st_size
    while remaining:
        chunk = os.read(descriptor, min(1024 * 1024, remaining))
        if not chunk:
            refuse(EXIT_RACE)
        chunks.append(chunk)
        remaining -= len(chunk)
    if os.read(descriptor, 1):
        refuse(EXIT_RACE)
    if request is not None and hook_phase is not None:
        _test_hook(request, hook_phase, None)
    after = os.fstat(descriptor)
    if _stable_identity(before) != _stable_identity(after) or after.st_nlink != 1:
        refuse(EXIT_RACE)
    payload = b"".join(chunks)
    if len(payload) != before.st_size:
        refuse(EXIT_RACE)
    return payload


def _glob_expression(pattern):
    """Compile the small, slash-aware glob language the public tools expose."""
    if (
        not isinstance(pattern, str)
        or not pattern
        or len(pattern) > 4096
        or "\x00" in pattern
        or "\\" in pattern
        or pattern.startswith("/")
    ):
        refuse(EXIT_INVALID)
    parts = pattern.split("/")
    if any(part in ("", ".", "..") for part in parts):
        # ``**/name`` has no empty component; repeated separators do.
        refuse(EXIT_INVALID)

    translated = []
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                while index + 1 < len(pattern) and pattern[index + 1] == "*":
                    index += 1
                if index + 1 < len(pattern) and pattern[index + 1] == "/":
                    translated.append("(?:.*/)?")
                    index += 1
                else:
                    translated.append(".*")
            else:
                translated.append("[^/]*")
        elif character == "?":
            translated.append("[^/]")
        elif character == "[":
            close = pattern.find("]", index + 1)
            if close == -1:
                refuse(EXIT_INVALID)
            body = pattern[index + 1 : close]
            if not body:
                refuse(EXIT_INVALID)
            if body[0] == "!":
                body = "^" + body[1:]
            elif body[0] == "^":
                body = "\\" + body
            translated.append("[" + body.replace("\\", "\\\\") + "]")
            index = close
        else:
            translated.append(re.escape(character))
        index += 1
    try:
        return re.compile("^" + "".join(translated) + "$")
    except re.error:
        refuse(EXIT_INVALID)


def _glob_matches(compiled, pattern, relative):
    candidate = relative.rsplit("/", 1)[-1] if "/" not in pattern else relative
    return compiled.fullmatch(candidate) is not None


def _load_ignore_rules(directory_fd, base, inherited):
    rules = list(inherited)
    try:
        listed = os.stat(".gitignore", dir_fd=directory_fd, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            return rules
        refuse(EXIT_RACE)
    if (
        stat.S_ISLNK(listed.st_mode)
        or not stat.S_ISREG(listed.st_mode)
        or listed.st_nlink != 1
    ):
        return rules
    try:
        descriptor = os.open(".gitignore", FILE_FLAGS, dir_fd=directory_fd)
    except OSError as error:
        _map_open_error(error, directory_fd, ".gitignore")
    try:
        opened = os.fstat(descriptor)
        if _stable_identity(listed) != _stable_identity(opened) or opened.st_nlink != 1:
            refuse(EXIT_RACE)
        payload = _read_descriptor(descriptor, ceiling=MAX_IGNORE_BYTES)
    finally:
        os.close(descriptor)
    if payload is None:
        return rules
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeError:
        return rules
    for raw in lines:
        if not raw or raw.startswith("#"):
            continue
        negated = raw.startswith("!")
        if negated:
            raw = raw[1:]
        if not raw:
            continue
        directory_only = raw.endswith("/")
        raw = raw.rstrip("/")
        anchored = raw.startswith("/")
        raw = raw.lstrip("/")
        if not raw or "\\" in raw or "\x00" in raw:
            continue
        try:
            compiled = _glob_expression(raw)
        except Refusal:
            continue
        rules.append((base, raw, compiled, negated, directory_only, anchored))
    return rules


def _ignored(rules, relative, *, directory):
    ignored = False
    for base, pattern, compiled, negated, directory_only, anchored in rules:
        if base:
            if relative == base:
                local = ""
            elif relative.startswith(base + "/"):
                local = relative[len(base) + 1 :]
            else:
                continue
        else:
            local = relative
        if not local or (directory_only and not directory):
            continue
        candidate = local
        if not anchored and "/" not in pattern:
            components = candidate.split("/")
            matched = any(compiled.fullmatch(component) for component in components)
        else:
            matched = compiled.fullmatch(candidate) is not None
        if matched:
            ignored = not negated
    return ignored


def _sorted_directory_names(directory_fd, state):
    remaining = MAX_SEARCH_ENTRIES - state["entries"]
    if remaining <= 0:
        state["bounded"] = True
        return []
    names, overflowed = _bounded_sorted_names(directory_fd, remaining)
    if overflowed:
        state["entries"] = MAX_SEARCH_ENTRIES
        state["bounded"] = True
        return []
    state["entries"] += len(names)
    return [name for name in names if _safe_output_name(name)]


def _scope_with_rules(request, root_fd, relative):
    parts = _search_relative(relative)
    _refuse_if_denied(parts)
    descriptor = os.dup(root_fd)
    prefix = ""
    rules = _load_ignore_rules(descriptor, prefix, [])
    try:
        for index, part in enumerate(parts):
            child = _opened_child_directory(descriptor, part, explicit=True)
            os.close(descriptor)
            descriptor = child
            prefix = part if not prefix else prefix + "/" + part
            rules = _load_ignore_rules(descriptor, prefix, rules)
            _test_hook(request, "after-search-directory", index)
        return descriptor, prefix, rules
    except BaseException:
        os.close(descriptor)
        raise


def _source_ceiling(request):
    """Largest source file this read will accept, decided before anything is read.

    A caller whose own budget is smaller than MAX_FILE_BYTES says so here, so an
    oversized file costs one fstat instead of a full transfer into the caller's
    address space.  Omitting the key keeps the public read behaviour: the ceiling
    is the same 64 MiB the helper has always enforced.
    """
    if "maxBytes" not in request:
        return MAX_FILE_BYTES
    value = request["maxBytes"]
    if type(value) is not int or value < 1 or value > MAX_FILE_BYTES:
        refuse(EXIT_INVALID)
    return value


def _read_regular(request, parent_fd, leaf, ceiling):
    try:
        descriptor = os.open(leaf, FILE_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        _map_open_error(error, parent_fd, leaf)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            refuse(EXIT_NOT_A_FILE)
        if before.st_nlink != 1:
            refuse(EXIT_PATH_REFUSED)
        if before.st_size < 0 or before.st_size > ceiling:
            refuse(EXIT_FILE_TOO_LARGE)
        chunks = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                refuse(EXIT_RACE)
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            refuse(EXIT_RACE)
        _test_hook(request, "before-post-stat", None)
        after = os.fstat(descriptor)
        if _stable_identity(before) != _stable_identity(after) or after.st_nlink != 1:
            refuse(EXIT_RACE)
        payload = b"".join(chunks)
        if len(payload) != before.st_size:
            refuse(EXIT_RACE)
        return payload
    finally:
        os.close(descriptor)


def _existing_regular(parent_fd, leaf, *, required):
    try:
        listed = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            if required:
                refuse(EXIT_NOT_FOUND)
            return None, None
        refuse(EXIT_PATH_REFUSED)
    if stat.S_ISLNK(listed.st_mode):
        refuse(EXIT_PATH_REFUSED)
    if not stat.S_ISREG(listed.st_mode):
        refuse(EXIT_NOT_A_FILE)
    if listed.st_nlink != 1:
        refuse(EXIT_PATH_REFUSED)
    try:
        descriptor = os.open(leaf, FILE_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        _map_open_error(error, parent_fd, leaf)
    try:
        opened = os.fstat(descriptor)
        if _stable_identity(listed) != _stable_identity(opened) or opened.st_nlink != 1:
            refuse(EXIT_RACE)
        return descriptor, opened
    except BaseException:
        os.close(descriptor)
        raise


def _write_all(descriptor, payload):
    offset = 0
    while offset < len(payload):
        written = os.write(descriptor, payload[offset : offset + 1024 * 1024])
        if written <= 0:
            refuse(EXIT_INTERNAL)
        offset += written


def _same_path_identity(parent_fd, leaf, expected):
    try:
        current = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            return False
        refuse(EXIT_PATH_REFUSED)
    return (
        not stat.S_ISLNK(current.st_mode)
        and current.st_nlink == 1
        and _stable_identity(current) == _stable_identity(expected)
    )


RENAME_SWAP = 0x00000002
_RENAMEATX_NP = None


def _swap_names(first_dir_fd, first, second_dir_fd, second):
    """Exchange two names atomically (macOS renameatx_np), across two
    directories of one volume if need be.

    Both names keep existing throughout; each now names the other's object.
    """

    global _RENAMEATX_NP
    if _RENAMEATX_NP is None:
        function = ctypes.CDLL(None, use_errno=True).renameatx_np
        function.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        function.restype = ctypes.c_int
        _RENAMEATX_NP = function
    if (
        _RENAMEATX_NP(
            first_dir_fd,
            os.fsencode(first),
            second_dir_fd,
            os.fsencode(second),
            RENAME_SWAP,
        )
        != 0
    ):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def _holds_inode(parent_fd, name, expected):
    """True when `name` is still the very file `expected` was measured from.

    Only the device and inode are compared: exchanging names changes a file's
    ctime, so the stable identity used before a replace would never match a
    file this helper itself has just moved.
    """

    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (
        expected.st_dev,
        expected.st_ino,
    )


def _is_checked_original(parent_fd, name, previous, expected_sha256):
    """True when `name` holds the very file whose digest the edit checked."""

    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
    except OSError:
        return False
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (previous.st_dev, previous.st_ino)
            or opened.st_size > MAX_FILE_BYTES
        ):
            return False
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        return digest.hexdigest() == expected_sha256
    finally:
        os.close(descriptor)


STAGED_NAME = "staged"


def _create_stage(request, parent_fd):
    """Create the private staging directory of one edit, beside its target.

    The candidate is written here, and whatever an exchange displaces from the
    target lands here, so nothing this helper deletes ever carries a name
    among the workspace's own entries.  mkdir refuses a name that exists; the
    directory is then opened and proven to be one just made for this edit -- a
    directory, this user's, private to it and empty -- and is used only through
    its descriptor, so renaming or replacing its name cannot redirect a later
    operation.
    """

    for _attempt in range(32):
        name = ".farol-stage-{}-{}".format(os.getpid(), os.urandom(16).hex())
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
        except OSError as error:
            if error.errno == errno.EEXIST:
                continue
            refuse(EXIT_PATH_REFUSED)
        _test_hook(request, "after-stage-mkdir", None)
        try:
            descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        except OSError:
            # Nothing was staged, and the name may no longer be ours: it is
            # left alone rather than removed on a guess.
            refuse(EXIT_PATH_REFUSED)
        try:
            opened = os.fstat(descriptor)
            private = (
                stat.S_ISDIR(opened.st_mode)
                and opened.st_uid == os.geteuid()
                and (stat.S_IMODE(opened.st_mode) & 0o077) == 0
                and not os.listdir(descriptor)
            )
        except OSError:
            private = False
        if not private:
            # Another directory took the name: it is neither used nor removed.
            os.close(descriptor)
            refuse(EXIT_RACE)
        return name, descriptor
    refuse(EXIT_INTERNAL)


def _discard_owned(request, stage_fd, expected):
    """Delete the staged name only while it names the verified `expected`.

    POSIX has no compare-and-unlink, so the check and the unlink below are two
    operations.  The gap between them lies inside the private staging
    directory: only a process that deliberately writes in there can substitute
    an object for the one checked, and such a process is outside what this
    helper protects against.  Anything else under the name is kept.
    """

    _test_hook(request, "before-discard", None)
    if not _holds_inode(stage_fd, STAGED_NAME, expected):
        return False
    try:
        os.unlink(STAGED_NAME, dir_fd=stage_fd)
    except OSError:
        return False
    return True


def _is_unchanged_candidate(dir_fd, name, written, expected_sha256):
    """True when `name` still holds this edit's candidate, byte for byte.

    Between an exchange and its undo the candidate is visible at the target,
    so a writer of the target can write into it in place; the same inode does
    not prove that its bytes are still only this edit's.
    """

    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=dir_fd)
    except OSError:
        return False
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (written.st_dev, written.st_ino)
            or opened.st_nlink != 1
            or opened.st_size != written.st_size
            or opened.st_mtime_ns != written.st_mtime_ns
        ):
            return False
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        return digest.hexdigest() == expected_sha256
    finally:
        os.close(descriptor)


def _remove_stage(parent_fd, name, stage_fd):
    """Remove the staging directory while its name still names it.

    rmdir never removes a directory that holds anything, so a kept object
    keeps its directory.  The name is checked and then removed in two steps:
    an empty directory renamed onto it in between can be removed with it, and
    nothing with contents ever is.
    """

    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        held = os.fstat(stage_fd)
    except OSError:
        return False
    if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (
        held.st_dev,
        held.st_ino,
    ):
        return False
    try:
        os.rmdir(name, dir_fd=parent_fd)
    except OSError:
        return False
    return True


def _atomic_publish(request, parent_fd, leaf, payload, previous):
    """Publish `payload` at `leaf`, replacing `previous` or creating the file.

    Publication point.  A replace takes effect at one atomic exchange of names
    between the candidate, staged in a private directory, and the target; a
    create takes effect at one link that fails if the target exists.  Only the
    candidate is ever published: a staged name that no longer holds it is not
    linked or exchanged.  An exchange is a valid publication only when the
    object it displaced is the checked original -- the inode the edit
    measured, whose bytes still hash to the expected digest -- verified
    afterwards through a descriptor.  Any other displaced object is put back by
    exchanging again, unless a newer save has already replaced the candidate
    at the target: that save stays where it landed.  Until an undo, the
    candidate is visible at the target: a reader can see it and a writer can
    write into it.

    Outcomes.  Success: a valid publication, nothing found under the helper's
    names had to be kept, the staging directory was removed as its own, and
    the final observation, made after the helper's last filesystem operation
    on the workspace, still finds the published file at the target byte for
    byte -- same inode, a single link, size, modification time and digest.  A save after that observation is a later write: it is
    never touched, and the success stands.  Conflict (EXIT_RACE): nothing was
    published, or a displaced version was put back and the candidate came back
    unchanged -- same inode, size, modification time and bytes.  Unknown
    (EXIT_MUTATION_OUTCOME_UNKNOWN): anything else once something was
    published -- the target was replaced before the final observation, a newer
    save prevented or outran the undo, the candidate came back changed, the
    undo or the durability barrier failed, a create could not drop its staging
    link, an object had to be kept, or the staging directory could not be
    removed as the one this edit made.  An unexpected error after the exchange
    exits with EXIT_INTERNAL and no undo; the adapter reports that as unknown.

    Cleanup.  Files are deleted only inside the staging directory, and only one
    whose inode was verified immediately before: the candidate -- proven
    unchanged when it has been at the target -- or the checked original a
    valid publication displaced.  Anything else found there is kept, with its
    directory, for the owner to inspect.  The staging directory is removed with
    rmdir, which never removes a directory that holds anything.  A helper that
    is killed leaves its staging directory behind, holding the candidate or
    the displaced original.

    Who is protected.  Writers of the target, in place or by rename, and
    processes that create, rename or delete other entries of the workspace
    directory never lose an object to this helper, apart from these disclosed
    residuals: a writer that keeps the original open and writes after its
    digest was checked; a writer that opened the candidate through the target
    before its undo and keeps writing through that descriptor after it was
    proven unchanged; a save that replaces the target between the last check
    before an undo and the undo itself, which puts the older displaced version
    back at the target and keeps the newer one in staging; and a process that
    deliberately writes inside the staging directory, which can substitute
    what is published or deleted.  No isolation from same-user or root
    processes is claimed.
    """

    if len(payload) > MAX_MUTATION_BYTES:
        refuse(EXIT_FILE_TOO_LARGE)
    candidate_sha256 = hashlib.sha256(payload).hexdigest()
    stage_name, stage_fd = _create_stage(request, parent_fd)
    descriptor = None
    # What the staged name may be deleted as: the candidate until it is
    # published; None while it holds something not yet proven to be ours.
    owned = None
    # Set once staging is cleaned up or must be kept as it is.
    settled = False
    removal_attempted = False
    # Set when an object the helper did not create had to be kept.
    kept = False
    try:
        try:
            descriptor = os.open(
                STAGED_NAME,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=stage_fd,
            )
        except OSError:
            refuse(EXIT_PATH_REFUSED)
        owned = os.fstat(descriptor)
        _write_all(descriptor, payload)
        mode = 0o644 if previous is None else stat.S_IMODE(previous.st_mode)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        written = os.fstat(descriptor)
        owned = written
        os.close(descriptor)
        descriptor = None

        _test_hook(request, "before-replace", None)
        if previous is None:
            try:
                os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ENOTDIR):
                    refuse(EXIT_PATH_REFUSED)
            else:
                refuse(EXIT_RACE)
        elif not _same_path_identity(parent_fd, leaf, previous):
            refuse(EXIT_RACE)

        _test_hook(request, "before-publish", None)
        if not _holds_inode(stage_fd, STAGED_NAME, written):
            # Something replaced the candidate: it is never published, and it
            # is not this helper's to delete.
            owned = None
            refuse(EXIT_RACE)
        if previous is None:
            try:
                os.link(
                    STAGED_NAME,
                    leaf,
                    src_dir_fd=stage_fd,
                    dst_dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            except OSError:
                refuse(EXIT_RACE)
            # Published: the target is a second link to the staged file.
            owned = None
            _test_hook(request, "after-link", None)
            # A file left with two links is not the file this edit created,
            # so a staging link that cannot be dropped leaves the outcome
            # unknown.
            if not _discard_owned(request, stage_fd, written):
                settled = True
                refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
        else:
            try:
                _swap_names(stage_fd, STAGED_NAME, parent_fd, leaf)
            except OSError as error:
                # Nothing was exchanged.  A volume that cannot swap names
                # cannot give this guarantee, so the edit is refused there.
                if error.errno in (errno.ENOTSUP, errno.EINVAL):
                    refuse(EXIT_PATH_REFUSED)
                refuse(EXIT_RACE)
            # The publication point.  The staged name now holds whatever the
            # exchange displaced, and nothing there is ours until proven.
            owned = None
            _test_hook(request, "after-exchange", None)
            expected_sha256 = request.get("expectedSha256")
            if not _is_checked_original(
                stage_fd, STAGED_NAME, previous, expected_sha256
            ):
                _test_hook(request, "after-original-mismatch", None)
                if not _holds_inode(parent_fd, leaf, written):
                    # A newer save already replaced the candidate at the
                    # target.  Exchanging back would put the older displaced
                    # version over it, so nothing moves: the save stays at
                    # the target and staging keeps the displaced version.
                    settled = True
                    refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
                # Someone else's version was displaced: put it back.
                _test_hook(request, "before-undo", None)
                try:
                    _swap_names(stage_fd, STAGED_NAME, parent_fd, leaf)
                except OSError:
                    # The candidate stays over that version, which staging
                    # keeps.
                    settled = True
                    refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
                if not _is_unchanged_candidate(
                    stage_fd, STAGED_NAME, written, candidate_sha256
                ):
                    # What came back is not the untouched candidate: a newer
                    # save the undo moved into staging, or the candidate with
                    # someone's bytes written into it at the target.  Either
                    # way it is kept.
                    settled = True
                    refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
                owned = written
                refuse(EXIT_RACE)
            _test_hook(request, "after-original-check", None)
            if not _holds_inode(parent_fd, leaf, written):
                # Replaced after the exchange: the other writer's version
                # stays at the target, and staging keeps the checked original
                # for recovery.
                settled = True
                refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
            # Drop the checked original, as a replace would have.  If the
            # staged name no longer holds it, whatever is there is kept and
            # the outcome cannot be a clean success.
            kept = not _discard_owned(request, stage_fd, previous)
        _test_hook(request, "before-stage-removal", None)
        # A staging directory that cannot be removed as the one this edit
        # made -- renamed away, replaced, or holding something -- is kept, and
        # the edit cannot claim a clean result.
        if not _remove_stage(parent_fd, stage_name, stage_fd):
            kept = True
        removal_attempted = True
        settled = True
        try:
            _test_hook(request, "after-replace", None)
            os.fsync(parent_fd)
        except BaseException:
            # The directory entry already changed. Neither a failed durability
            # barrier nor a lost response may be reported as though the write
            # were refused before it acted.
            refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
        # The final observation, after the helper's last filesystem operation
        # on the workspace.  The inode alone would not see bytes written into
        # the published file in place, so the whole candidate is re-read.
        if kept or not _is_unchanged_candidate(
            parent_fd, leaf, written, candidate_sha256
        ):
            refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
        _test_hook(request, "after-final-check", None)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if not settled and owned is not None:
            _discard_owned(request, stage_fd, owned)
        if not removal_attempted:
            _remove_stage(parent_fd, stage_name, stage_fd)
        os.close(stage_fd)


def _mutation_text(value):
    if not isinstance(value, str):
        refuse(EXIT_INVALID)
    try:
        payload = value.encode("utf-8")
    except UnicodeError:
        refuse(EXIT_INVALID)
    if len(payload) > MAX_MUTATION_BYTES:
        refuse(EXIT_FILE_TOO_LARGE)
    return payload


def _expected_sha256(request, *, allow_absent):
    if "expectedSha256" not in request:
        refuse(EXIT_INVALID)
    value = request.get("expectedSha256")
    if value is None and allow_absent:
        return None
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        refuse(EXIT_INVALID)
    return value


def _payload_sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def _write_regular(request, parent_fd, leaf, expected, payload):
    if not _safe_output_name(leaf):
        refuse(EXIT_PATH_REFUSED)
    descriptor, previous = _existing_regular(parent_fd, leaf, required=False)
    try:
        before_sha256 = None
        if descriptor is not None:
            before_payload = _read_descriptor(descriptor, ceiling=MAX_MUTATION_BYTES)
            if before_payload is None:
                refuse(EXIT_FILE_TOO_LARGE)
            before_sha256 = _payload_sha256(before_payload)
        if before_sha256 != expected:
            refuse(EXIT_RACE)
        _atomic_publish(request, parent_fd, leaf, payload, previous)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return json.dumps(
        {
            "afterSha256": _payload_sha256(payload),
            "beforeSha256": before_sha256,
            "bytes": len(payload),
            "replacements": 0,
        },
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")


def _normalized_edit_text(value):
    payload = _mutation_text(value)
    try:
        return payload.decode("utf-8").replace("\r\n", "\n")
    except UnicodeError:
        refuse(EXIT_INVALID)


def _crlf_offsets(source):
    """Return where each CRLF of ``source`` lands in its LF-normalized text.

    Edits match against LF-normalized text so that a caller may spell a CRLF
    file with LF, but the published bytes are assembled from the original
    source.  The k-th CRLF at source index ``i`` becomes the LF at normalized
    index ``i - k``; this sorted list maps a normalized offset back with one
    bisection instead of a per-character table.
    """
    offsets = []
    search = 0
    while True:
        found = source.find("\r\n", search)
        if found < 0:
            return offsets
        offsets.append(found - len(offsets))
        search = found + 2


def _source_offset(crlf_offsets, normalized_offset):
    # Every CRLF that normalized before this offset occupied one extra
    # character in the source.  A normalized offset never lands between a CR
    # and its LF, because the pair is a single LF after normalization.
    return normalized_offset + bisect.bisect_left(crlf_offsets, normalized_offset)


def _line_ending_at(source, index):
    """Return the line ending a line break inserted at ``index`` receives.

    Inserted text follows the ending of the line the edit starts on: the first
    line ending at or after ``index``; on an unterminated final line the one
    before it; LF in a file with no line ending.  Untouched bytes are never
    rewritten, so a mixed-ending file keeps every ending it already had.
    """
    position = source.find("\n", index)
    if position < 0:
        position = source.rfind("\n", 0, index)
    if position < 0:
        return "\n"
    return "\r\n" if position > 0 and source[position - 1] == "\r" else "\n"


def _edit_regular(request, parent_fd, leaf):
    if not _safe_output_name(leaf):
        refuse(EXIT_PATH_REFUSED)
    expected = _expected_sha256(request, allow_absent=False)
    edits = request.get("edits")
    if not isinstance(edits, list) or not edits or len(edits) > MAX_EDITS:
        refuse(EXIT_INVALID)

    normalized = []
    aggregate_bytes = 0
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {"oldText", "newText"}:
            refuse(EXIT_INVALID)
        old_text = _normalized_edit_text(edit.get("oldText"))
        new_text = _normalized_edit_text(edit.get("newText"))
        if not old_text or old_text == new_text:
            refuse(EXIT_INVALID)
        aggregate_bytes += len(old_text.encode("utf-8")) + len(new_text.encode("utf-8"))
        if aggregate_bytes > MAX_MUTATION_BYTES:
            refuse(EXIT_FILE_TOO_LARGE)
        normalized.append((old_text, new_text))

    descriptor, previous = _existing_regular(parent_fd, leaf, required=True)
    try:
        payload = _read_descriptor(descriptor, ceiling=MAX_MUTATION_BYTES)
        if payload is None:
            refuse(EXIT_FILE_TOO_LARGE)
        before_sha256 = _payload_sha256(payload)
        if before_sha256 != expected:
            refuse(EXIT_RACE)
        has_bom = payload.startswith(codecs.BOM_UTF8)
        source_payload = payload[len(codecs.BOM_UTF8) :] if has_bom else payload
        try:
            source = source_payload.decode("utf-8")
        except UnicodeError:
            refuse(EXIT_NOT_TEXT)
        crlf_offsets = _crlf_offsets(source)
        searchable = source.replace("\r\n", "\n")

        replacements = []
        for old_text, new_text in normalized:
            first = searchable.find(old_text)
            if first < 0:
                refuse(EXIT_EDIT_NO_MATCH)
            if searchable.find(old_text, first + 1) >= 0:
                refuse(EXIT_EDIT_NOT_UNIQUE)
            replacements.append((first, first + len(old_text), new_text))
        replacements.sort(key=lambda item: item[0])
        for previous_replacement, current in zip(replacements, replacements[1:]):
            if current[0] < previous_replacement[1]:
                refuse(EXIT_EDIT_OVERLAP)

        pieces = []
        cursor = 0
        for start, end, new_text in replacements:
            source_start = _source_offset(crlf_offsets, start)
            pieces.append(source[cursor:source_start])
            ending = _line_ending_at(source, source_start)
            pieces.append(new_text if ending == "\n" else new_text.replace("\n", ending))
            cursor = _source_offset(crlf_offsets, end)
        pieces.append(source[cursor:])
        result = "".join(pieces)
        result_payload = result.encode("utf-8")
        if has_bom:
            result_payload = codecs.BOM_UTF8 + result_payload
        _atomic_publish(request, parent_fd, leaf, result_payload, previous)
    finally:
        os.close(descriptor)

    return json.dumps(
        {
            "afterSha256": _payload_sha256(result_payload),
            "beforeSha256": before_sha256,
            "bytes": len(result_payload),
            "replacements": len(replacements),
        },
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")


def _assert_directory(request, parent_fd, leaf):
    try:
        descriptor = os.open(leaf, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        # ENOTDIR on the final component means that the requested workspace
        # exists but is not a directory. Intermediate ENOTDIR remains the
        # content-free NOT_FOUND result in _open_directory.
        if error.errno == errno.ENOTDIR:
            try:
                listed = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            except OSError:
                listed = None
            if listed is not None:
                refuse(EXIT_PATH_REFUSED)
        _map_open_error(error, parent_fd, leaf)
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            refuse(EXIT_PATH_REFUSED)
    finally:
        os.close(descriptor)
    return b'{"ok":true}'


def _open_child_directory(parent_fd, name):
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except OSError:
        return None
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            return None
        return descriptor
    except OSError:
        os.close(descriptor)
        return None


def _regular_child(parent_fd, name):
    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
    except OSError:
        return False
    try:
        return stat.S_ISREG(os.fstat(descriptor).st_mode)
    except OSError:
        return False
    finally:
        os.close(descriptor)


def _bounded_sorted_names(directory_fd, limit):
    """Return all names only when the directory fits the remaining budget.

    A global lexicographic prefix cannot be selected without scanning the whole
    directory.  That would make the apparent entry ceiling a memory bound only:
    a directory with millions of entries could still consume unbounded CPU and
    hit the caller's watchdog.  Instead, inspect at most ``limit + 1`` entries.
    A directory that overflows contributes no names, which is deterministic for
    that directory and keeps the complete walk's work bounded.  A directory that
    fits is sorted only after its end has been observed.

    The second return value says that the directory overflowed its budget.
    """
    try:
        with os.scandir(directory_fd) as entries:
            names = [entry.name for entry in itertools.islice(entries, limit + 1)]
    except OSError:
        return [], False
    if len(names) > limit:
        return [], True
    names.sort(key=lambda name: (name.casefold(), name))
    return names, False


def _list_context(root_fd):
    """Catalog the context files under one already-open root descriptor.

    Exhausting a bound stops the walk rather than refusing the request.  The
    counters only ever grow and the walk order is fixed, so what comes back is a
    deterministic prefix of the full catalog for that tree, in the same shape as
    the complete answer.  This is the same degradation MAX_CONTEXT_FILES already
    applied to nested names, extended to the directory, entry, and depth bounds
    so that a merely large workspace still opens.
    """
    root_files = []
    nested_files = []
    directories = 0
    entries_seen = 0

    def exhausted():
        return (
            directories >= MAX_CONTEXT_DIRECTORIES
            or entries_seen >= MAX_CONTEXT_ENTRIES
            or len(nested_files) >= MAX_CONTEXT_FILES
        )

    def walk(directory_fd, prefix, depth, *, root=False):
        nonlocal directories, entries_seen
        directories += 1
        remaining_entries = MAX_CONTEXT_ENTRIES - entries_seen
        if remaining_entries <= 0:
            return
        names, overflowed = _bounded_sorted_names(directory_fd, remaining_entries)
        if overflowed:
            entries_seen = MAX_CONTEXT_ENTRIES
            return
        entries_seen += len(names)
        for name in names:
            if not isinstance(name, str) or name in ("", ".", "..") or "/" in name:
                continue
            relative = name if not prefix else prefix + "/" + name
            if _denied(relative.split("/")):
                continue
            if name in CONTEXT_NAME_SET and _regular_child(directory_fd, name):
                if root:
                    root_files.append(relative)
                elif len(nested_files) < MAX_CONTEXT_FILES:
                    nested_files.append(relative)
                continue
            # Naming the files already listed here is free; descending is what
            # the bounds are about.  The depth bound also keeps the recursion
            # well inside the interpreter's stack, so a pathologically deep tree
            # degrades the same bounded way instead of raising.
            if (
                name in SKIPPED_CONTEXT_DIRS
                or depth >= MAX_CONTEXT_DEPTH
                or exhausted()
            ):
                continue
            child = _open_child_directory(directory_fd, name)
            if child is None:
                continue
            try:
                walk(child, relative, depth + 1)
            finally:
                os.close(child)

    walk(root_fd, "", 0, root=True)
    root_files.sort(key=lambda item: CONTEXT_NAMES.index(item))
    nested_files.sort()
    return json.dumps(
        {"nested": nested_files[:MAX_CONTEXT_FILES], "root": root_files},
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")


def _list_directory(request, root_fd):
    scope = _search_relative(request["relative"])
    descriptor = _open_relative_directory(request, root_fd, request["relative"])
    try:
        before = os.fstat(descriptor)
        names, overflowed = _bounded_sorted_names(descriptor, MAX_SEARCH_ENTRIES)
        names = [
            name
            for name in names
            if _safe_output_name(name) and not _denied(scope + [name])
        ]
        names.sort(key=lambda name: (name.casefold(), name))
        entries = []
        for name in names:
            listed = _listed_child(descriptor, name)
            if stat.S_ISLNK(listed.st_mode):
                continue
            if stat.S_ISDIR(listed.st_mode):
                entries.append(name + "/")
            elif stat.S_ISREG(listed.st_mode) and listed.st_nlink == 1:
                entries.append(name)
            if len(entries) > MAX_LIST_RESULTS:
                break
        after = os.fstat(descriptor)
        if _stable_identity(before) != _stable_identity(after):
            refuse(EXIT_RACE)
        return json.dumps(
            {
                "entries": entries[:MAX_LIST_RESULTS],
                "truncated": overflowed or len(entries) > MAX_LIST_RESULTS,
            },
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
    finally:
        os.close(descriptor)


def _stat_directory(request, root_fd):
    """Metadata for one directory's own entries, without opening any of them.

    ``list-directory`` answers what is there.  This answers when each entry last
    changed and how large it is, which is what an inventory needs in order to
    order and bound itself without reading a single body.  The same entries are
    omitted for the same reasons -- symlinks, non-regular files, multiply linked
    files, denied names -- so nothing returned here is a name the reader would
    afterwards refuse to open.
    """
    scope = _search_relative(request["relative"])
    descriptor = _open_relative_directory(request, root_fd, request["relative"])
    try:
        before = os.fstat(descriptor)
        names, overflowed = _bounded_sorted_names(descriptor, MAX_SEARCH_ENTRIES)
        names = [
            name
            for name in names
            if _safe_output_name(name) and not _denied(scope + [name])
        ]
        names.sort(key=lambda name: (name.casefold(), name))
        entries = []
        for name in names:
            listed = _listed_child(descriptor, name)
            if stat.S_ISDIR(listed.st_mode):
                kind = "directory"
            elif stat.S_ISREG(listed.st_mode) and listed.st_nlink == 1:
                kind = "file"
            else:
                # Symlinks included: a name that resolves elsewhere is not an
                # entry of this directory, and reporting its metadata would
                # describe a file this helper would refuse to open.
                continue
            entries.append(
                {
                    "kind": kind,
                    "mtimeMs": listed.st_mtime_ns // 1_000_000,
                    "name": name,
                    "size": listed.st_size,
                }
            )
            if len(entries) > MAX_LIST_RESULTS:
                break
        after = os.fstat(descriptor)
        if _stable_identity(before) != _stable_identity(after):
            refuse(EXIT_RACE)
        return json.dumps(
            {
                "entries": entries[:MAX_LIST_RESULTS],
                "truncated": overflowed or len(entries) > MAX_LIST_RESULTS,
            },
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
    finally:
        os.close(descriptor)


def _walk_regular_files(
    directory_fd,
    root_prefix,
    output_prefix,
    rules,
    state,
    visit,
    depth=0,
    *,
    visit_directory=None,
):
    if state.get("stop"):
        return
    if state["directories"] >= MAX_SEARCH_DIRECTORIES or depth > MAX_SEARCH_DEPTH:
        state["bounded"] = True
        return
    state["directories"] += 1
    before = os.fstat(directory_fd)
    names = _sorted_directory_names(directory_fd, state)
    for name in names:
        if state.get("stop"):
            break
        root_relative = name if not root_prefix else root_prefix + "/" + name
        output_relative = name if not output_prefix else output_prefix + "/" + name
        if _denied(root_relative.split("/")):
            continue
        listed = _listed_child(directory_fd, name)
        if stat.S_ISLNK(listed.st_mode):
            continue
        if stat.S_ISDIR(listed.st_mode):
            if _ignored(rules, root_relative, directory=True):
                continue
            child = _opened_child_directory(directory_fd, name, explicit=False)
            if child is None:
                continue
            child_rules = _load_ignore_rules(child, root_relative, rules)
            try:
                if visit_directory is not None:
                    visit_directory(child, root_relative, output_relative, state)
                if state.get("stop"):
                    continue
                _walk_regular_files(
                    child,
                    root_relative,
                    output_relative,
                    child_rules,
                    state,
                    visit,
                    depth + 1,
                    visit_directory=visit_directory,
                )
            finally:
                os.close(child)
            continue
        if not stat.S_ISREG(listed.st_mode) or listed.st_nlink != 1:
            continue
        if _ignored(rules, root_relative, directory=False):
            continue
        descriptor = _opened_regular(directory_fd, name, explicit=False)
        if descriptor is None:
            continue
        try:
            visit(descriptor, root_relative, output_relative, state)
        finally:
            os.close(descriptor)
    after = os.fstat(directory_fd)
    if _stable_identity(before) != _stable_identity(after):
        refuse(EXIT_RACE)


def _glob_search(request, root_fd):
    pattern = request.get("pattern")
    compiled = _glob_expression(pattern)
    directory, prefix, rules = _scope_with_rules(request, root_fd, request["relative"])
    matches = []
    state = {"bounded": False, "directories": 0, "entries": 0, "stop": False}

    def visit(_descriptor, _root_relative, output_relative, current):
        if not _glob_matches(compiled, pattern, output_relative):
            return
        matches.append(output_relative)
        if len(matches) > MAX_GLOB_RESULTS:
            current["stop"] = True

    def visit_directory(_descriptor, _root_relative, output_relative, current):
        if not _glob_matches(compiled, pattern, output_relative):
            return
        matches.append(output_relative + "/")
        if len(matches) > MAX_GLOB_RESULTS:
            current["stop"] = True

    try:
        _walk_regular_files(
            directory,
            prefix,
            "",
            rules,
            state,
            visit,
            visit_directory=visit_directory,
        )
    finally:
        os.close(directory)
    return json.dumps(
        {
            "paths": matches[:MAX_GLOB_RESULTS],
            "resultLimited": len(matches) > MAX_GLOB_RESULTS,
            "scanLimited": state["bounded"],
        },
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")


def _grep_expression(pattern):
    if not isinstance(pattern, str) or len(pattern) > 4096 or "\x00" in pattern:
        refuse(EXIT_INVALID)
    try:
        parsed = sre_parse.parse(pattern)
        if not _safe_regex_tree(parsed):
            refuse(EXIT_INVALID)
        return re.compile(pattern)
    except re.error:
        refuse(EXIT_INVALID)


def _safe_regex_tree(tree, *, inside_repeat=False):
    """Reject the Python-regex constructs that can turn one line into a ReDoS.

    Farol does not attempt to expose every host-ripgrep expression.  Nested
    repetition, repeated alternation, backreferences, lookarounds, conditionals,
    and adjacent repetitions are the high-risk backtracking shapes.  The
    bounded linear-looking subset retains ordinary groups, alternation, classes,
    anchors, and standalone quantifiers.
    """
    previous_repeat = False
    repeat_ops = (sre_parse.MAX_REPEAT, sre_parse.MIN_REPEAT)
    for operation, argument in tree.data:
        if operation in repeat_ops:
            if inside_repeat or previous_repeat:
                return False
            child = argument[2]
            if not _safe_regex_tree(child, inside_repeat=True):
                return False
            previous_repeat = True
            continue
        if operation is sre_parse.SUBPATTERN:
            if not _safe_regex_tree(argument[-1], inside_repeat=inside_repeat):
                return False
        elif operation is sre_parse.BRANCH:
            if inside_repeat:
                return False
            if any(_regex_tree_contains_repeat(branch) for branch in argument[1]):
                return False
            if any(not _safe_regex_tree(branch) for branch in argument[1]):
                return False
        elif operation in (
            sre_parse.ASSERT,
            sre_parse.ASSERT_NOT,
            sre_parse.GROUPREF,
            sre_parse.GROUPREF_EXISTS,
        ):
            return False
        # Zero-width anchors do not separate two repetitions for safety.
        if operation is not sre_parse.AT:
            previous_repeat = False
    return True


def _regex_tree_contains_repeat(tree):
    """Return whether a parsed subtree contains any repetition operator.

    Alternation with repetition in any branch can multiply the backtracking
    states created by a repetition before or after the branch.  Reject that
    complete shape instead of trying to prove individual expressions safe.
    """
    repeat_ops = (sre_parse.MAX_REPEAT, sre_parse.MIN_REPEAT)
    for operation, argument in tree.data:
        if operation in repeat_ops:
            return True
        if operation is sre_parse.SUBPATTERN:
            if _regex_tree_contains_repeat(argument[-1]):
                return True
        elif operation is sre_parse.BRANCH:
            if any(_regex_tree_contains_repeat(branch) for branch in argument[1]):
                return True
    return False


def _grep_deadline(_signal_number, _frame):
    refuse(EXIT_TIMEOUT)


def _grep_lines(text):
    """Split text into lines at LF only, the way editors and the read tool do.

    A CR before the LF belongs to the line ending and is dropped.  Other
    separators that str.splitlines() honours (U+2028, VT, FF and the like) stay
    inside their line, so line numbers agree with every other consumer.
    """
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return [line[:-1] if line.endswith("\r") else line for line in lines]


def _match_excerpt(line, start, end):
    """At most MAX_GREP_LINE_CHARS code points of the line, showing the match.

    A line that fits is returned whole.  Otherwise the excerpt starts at the
    line start when the match ends inside that window, and otherwise shortly
    before the match, so a hit far into a long line stays visible.
    """
    if len(line) <= MAX_GREP_LINE_CHARS:
        return line, False
    if end <= MAX_GREP_LINE_CHARS:
        return line[:MAX_GREP_LINE_CHARS], True
    begin = min(start - min(start, MAX_GREP_LINE_CHARS // 4), len(line) - MAX_GREP_LINE_CHARS)
    return line[begin : begin + MAX_GREP_LINE_CHARS], True


def _clean_match_line(line):
    return "".join(
        character if character == "\t" or (ord(character) >= 32 and ord(character) != 127) else "�"
        for character in line
    )


def _grep_descriptor(request, descriptor, rendered_path, expression, matches, state, *, explicit):
    before = os.fstat(descriptor)
    if before.st_size > MAX_GREP_FILE_BYTES:
        if explicit:
            refuse(EXIT_FILE_TOO_LARGE)
        state["bounded"] = True
        return
    remaining = MAX_GREP_TOTAL_BYTES - state["bytes"]
    if before.st_size > remaining:
        state["bounded"] = True
        state["stop"] = True
        return
    payload = _read_descriptor(
        descriptor,
        ceiling=MAX_GREP_FILE_BYTES,
        request=request,
        hook_phase="before-search-post-stat",
    )
    if payload is None:
        if explicit:
            refuse(EXIT_FILE_TOO_LARGE)
        state["bounded"] = True
        return
    state["bytes"] += len(payload)
    # A directory search skips files that are not text, like ripgrep; a file
    # the caller named explicitly is refused instead of reported as no match.
    if b"\x00" in payload:
        if explicit:
            refuse(EXIT_NOT_TEXT)
        return
    try:
        text = payload.decode("utf-8")
    except UnicodeError:
        if explicit:
            refuse(EXIT_NOT_TEXT)
        return
    for number, raw_line in enumerate(_grep_lines(text), 1):
        found = expression.search(raw_line)
        if found is None:
            continue
        excerpt, truncated = _match_excerpt(
            _clean_match_line(raw_line), found.start(), found.end()
        )
        match = {
            "line": number,
            "path": rendered_path,
            "text": excerpt,
            "truncated": truncated,
        }
        charged = 1 + len(
            json.dumps(
                match,
                ensure_ascii=True,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        if state["outputBytes"] + charged > MAX_GREP_RESPONSE_BYTES:
            state["outputLimited"] = True
            state["stop"] = True
            return
        state["outputBytes"] += charged
        matches.append(match)
        if len(matches) > MAX_GREP_RESULTS:
            state["stop"] = True
            return


def _open_grep_scope(request, root_fd, relative):
    parts = _search_relative(relative)
    _refuse_if_denied(parts)
    if not parts:
        if request.get("fileOnly"):
            refuse(EXIT_NOT_A_FILE)
        directory = os.dup(root_fd)
        return "directory", directory, "", _load_ignore_rules(directory, "", [])

    parent = os.dup(root_fd)
    prefix = ""
    rules = _load_ignore_rules(parent, prefix, [])
    try:
        for index, part in enumerate(parts[:-1]):
            child = _opened_child_directory(parent, part, explicit=True)
            os.close(parent)
            parent = child
            prefix = part if not prefix else prefix + "/" + part
            rules = _load_ignore_rules(parent, prefix, rules)
            _test_hook(request, "after-search-directory", index)

        leaf = parts[-1]
        root_relative = leaf if not prefix else prefix + "/" + leaf
        listed = _listed_child(parent, leaf, missing_status=EXIT_NOT_FOUND)
        if stat.S_ISLNK(listed.st_mode):
            refuse(EXIT_PATH_REFUSED)
        if stat.S_ISDIR(listed.st_mode):
            if request.get("fileOnly"):
                refuse(EXIT_NOT_A_FILE)
            descriptor = _opened_child_directory(parent, leaf, explicit=True)
            rules = _load_ignore_rules(descriptor, root_relative, rules)
            _test_hook(request, "after-search-directory", len(parts) - 1)
            return "directory", descriptor, root_relative, rules
        descriptor = _opened_regular(parent, leaf, explicit=True)
        return "file", descriptor, root_relative, rules
    finally:
        os.close(parent)


def _read_window(request, parent_fd, leaf):
    """A bounded window of one file that another process may still be appending.

    ``read`` returns a whole file and treats every change during the read as a
    race.  That is right for a file the caller is about to act on and wrong for
    a transcript its own agent is still writing: growth is the normal state of
    the thing being observed, not evidence of tampering.

    So the snapshot here is narrower and says so.  The inode, its type and its
    link count must not change, and the file must not have become shorter --
    replacement, truncation and a swapped type all refuse.  Growth past the end
    of the window does not, because the bytes already read are still exactly the
    bytes that were at that offset.  The observed size travels back with them so
    the caller can say what it has seen rather than implying it saw the end.

    A negative offset counts back from the end, which is what a tail wants and
    what a second round trip merely to learn the size would otherwise cost.
    """
    try:
        descriptor = os.open(leaf, FILE_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        _map_open_error(error, parent_fd, leaf)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            refuse(EXIT_NOT_A_FILE)
        if before.st_nlink != 1:
            refuse(EXIT_PATH_REFUSED)
        size = before.st_size
        requested = request["offset"]
        offset = size + requested if requested < 0 else requested
        if offset < 0:
            offset = 0
        length = min(request["length"], max(0, size - offset))
        payload = b""
        while len(payload) < length:
            chunk = os.pread(descriptor, length - len(payload), offset + len(payload))
            if not chunk:
                refuse(EXIT_RACE)
            payload += chunk
        _test_hook(request, "before-post-stat", None)
        after = os.fstat(descriptor)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_mode != after.st_mode
            or after.st_nlink != 1
            or after.st_size < size
        ):
            refuse(EXIT_RACE)
        header = json.dumps(
            {"offset": offset, "returned": len(payload), "size": size},
            ensure_ascii=True,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        return header + b"\n" + payload
    finally:
        os.close(descriptor)


def _grep_search(request, root_fd):
    expression = _grep_expression(request.get("pattern"))
    return _grep_search_with_deadline(request, root_fd, expression)


def _grep_search_with_deadline(request, root_fd, expression):
    kind, descriptor, prefix, rules = _open_grep_scope(
        request,
        root_fd,
        request["relative"],
    )
    matches = []
    state = {
        "bounded": False,
        "bytes": 0,
        "directories": 0,
        "entries": 0,
        "outputBytes": 0,
        "outputLimited": False,
        "stop": False,
    }
    try:
        if kind == "file":
            # Like ripgrep, an explicitly named file overrides ignore rules.
            _grep_descriptor(
                request,
                descriptor,
                prefix,
                expression,
                matches,
                state,
                explicit=True,
            )
        else:
            def visit(file_descriptor, root_relative, _output_relative, current):
                _grep_descriptor(
                    request,
                    file_descriptor,
                    root_relative,
                    expression,
                    matches,
                    current,
                    explicit=False,
                )

            _walk_regular_files(descriptor, prefix, "", rules, state, visit)
    finally:
        os.close(descriptor)
    return json.dumps(
        {
            "matches": matches[:MAX_GREP_RESULTS],
            "resultLimited": len(matches) > MAX_GREP_RESULTS or state["outputLimited"],
            "scanLimited": state["bounded"],
        },
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")


def _window_bounds(request):
    """True when this request names one window this helper will read."""
    offset = request.get("offset")
    length = request.get("length")
    return (
        isinstance(offset, int)
        and not isinstance(offset, bool)
        and abs(offset) <= MAX_WINDOW_OFFSET
        and isinstance(length, int)
        and not isinstance(length, bool)
        and 0 < length <= MAX_WINDOW_BYTES
    )


def _dispatch(request):
    global _DENIED_PREFIXES
    global _WRITE_DENIED_PREFIXES

    if set(request) - {
        "operation",
        "root",
        "relative",
        "maxBytes",
        "offset",
        "length",
        "pattern",
        "content",
        "expectedSha256",
        "denied",
        "writeDenied",
        "edits",
        "fileOnly",
        "approvedRoot",
        "testHook",
    }:
        refuse(EXIT_INVALID)
    # Parsed before any descriptor is opened, so a malformed denied list refuses
    # the request rather than being ignored on the way to a tree.
    _DENIED_PREFIXES = _parse_denied(request)
    _WRITE_DENIED_PREFIXES = _parse_write_denied(request)
    operation = request.get("operation")
    if operation not in (
        "read",
        "assert-directory",
        "list-context",
        "list-directory",
        "stat-directory",
        "read-window",
        "glob",
        "grep",
        "write",
        "edit",
    ):
        refuse(EXIT_INVALID)
    # A source ceiling only means anything for a read, and it is validated before
    # any descriptor is opened, so a malformed request never reaches the tree.
    if operation != "read" and "maxBytes" in request:
        refuse(EXIT_INVALID)
    # A window is the only operation that takes one, and it takes both or
    # neither: half a window is a request nobody wrote on purpose.
    if operation == "read-window":
        if not _window_bounds(request):
            refuse(EXIT_INVALID)
    elif "offset" in request or "length" in request:
        refuse(EXIT_INVALID)
    if operation in (
        "list-directory",
        "stat-directory",
        "read-window",
        "glob",
        "grep",
        "write",
        "edit",
    ):
        if "relative" not in request:
            refuse(EXIT_INVALID)
        _search_relative(request["relative"])
    if operation in ("glob", "grep"):
        if "pattern" not in request:
            refuse(EXIT_INVALID)
    elif "pattern" in request:
        refuse(EXIT_INVALID)
    if "fileOnly" in request and (
        operation != "grep" or request.get("fileOnly") is not True
    ):
        refuse(EXIT_INVALID)
    write_input = None
    if operation == "write":
        if (
            "content" not in request
            or "edits" in request
            or "expectedSha256" not in request
        ):
            refuse(EXIT_INVALID)
        write_input = (
            _expected_sha256(request, allow_absent=True),
            _mutation_text(request.get("content")),
        )
    elif operation == "edit":
        if (
            "edits" not in request
            or "content" in request
            or "expectedSha256" not in request
        ):
            refuse(EXIT_INVALID)
    elif (
        "content" in request
        or "edits" in request
        or "expectedSha256" in request
    ):
        refuse(EXIT_INVALID)
    # Keyed on the operation rather than placed inside one walk: ``write`` goes
    # through ``_walk_parent_for_write`` and ``edit`` goes through
    # ``_walk_parent``, so a check living in either one alone would miss the
    # other.  Both mutations share this one, before any descriptor is opened.
    if operation in MUTATING_OPERATIONS:
        _refuse_if_write_denied(_components(request["relative"], absolute=False))
    ceiling = _source_ceiling(request) if operation == "read" else MAX_FILE_BYTES
    root_fd = _open_root(request)
    try:
        if operation == "list-context":
            if "relative" in request:
                refuse(EXIT_INVALID)
            return _list_context(root_fd)
        if operation == "list-directory":
            return _list_directory(request, root_fd)
        if operation == "stat-directory":
            return _stat_directory(request, root_fd)
        if operation == "glob":
            return _glob_search(request, root_fd)
        if operation == "grep":
            return _grep_search(request, root_fd)
        parents_created = False
        if operation == "write" and request.get("expectedSha256") is None:
            parent_fd, leaf, parents_created = _walk_parent_for_write(
                request, root_fd
            )
        else:
            parent_fd, leaf = _walk_parent(request, root_fd)
        try:
            if operation == "read":
                return _read_regular(request, parent_fd, leaf, ceiling)
            if operation == "read-window":
                return _read_window(request, parent_fd, leaf)
            if operation == "write":
                try:
                    expected, payload = write_input
                    return _write_regular(
                        request, parent_fd, leaf, expected, payload
                    )
                except Refusal as error:
                    if (
                        parents_created
                        and error.status != EXIT_MUTATION_OUTCOME_UNKNOWN
                    ):
                        refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
                    raise
                except BaseException:
                    if parents_created:
                        refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
                    raise
            if operation == "edit":
                return _edit_regular(request, parent_fd, leaf)
            return _assert_directory(request, parent_fd, leaf)
        finally:
            os.close(parent_fd)
    finally:
        os.close(root_fd)


def _dispatch_with_grep_deadline(request):
    """Bound the complete validated grep operation, including root traversal."""
    previous_alarm = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, _grep_deadline)
    signal.setitimer(signal.ITIMER_REAL, MAX_GREP_WALL_SECONDS)
    try:
        return _dispatch(request)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)


def _bounded_snapshot_limit(value, ceiling):
    if value is None:
        return ceiling
    if type(value) is not int or value < 1 or value > ceiling:
        refuse(EXIT_INVALID)
    return value


def _open_external_identity(value, grant, code):
    """Open one absolute path from `/` and require the caller-approved identity.

    Used for a linked worktree's gitdir/commondir: the relationship between
    them was already discovered and approved outside this helper (the owner
    verification flow this repository already has); this only confirms, right
    now, by descriptor, that the object at `value` is still the exact one the
    caller approved.  Any failure -- malformed grant, missing path, changed
    identity, wrong owner, group/other-writable -- collapses to one `code`,
    because none of the detail helps a caller who did not supply a valid grant
    in the first place.
    """

    def resolve():
        if not isinstance(grant, dict) or set(grant) != {"path", "device", "inode"}:
            refuse(EXIT_INVALID)
        if not isinstance(value, str) or value == "" or value != grant.get("path"):
            refuse(EXIT_INVALID)
        parts = _components(value, absolute=True)
        device_raw = grant.get("device")
        inode_raw = grant.get("inode")
        if (
            not isinstance(device_raw, str)
            or not re.fullmatch(r"[0-9]{1,20}", device_raw)
            or not isinstance(inode_raw, str)
            or not re.fullmatch(r"[0-9]{1,20}", inode_raw)
        ):
            refuse(EXIT_INVALID)
        descriptor = os.open("/", DIRECTORY_FLAGS)
        try:
            for part in parts:
                child = _open_directory(descriptor, part)
                os.close(descriptor)
                descriptor = child
            opened = os.fstat(descriptor)
            if (
                str(opened.st_dev) != device_raw
                or str(opened.st_ino) != inode_raw
                or opened.st_uid != os.getuid()
                or opened.st_mode & 0o022
            ):
                refuse(EXIT_INVALID)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    try:
        return resolve()
    except Refusal:
        refuse(code)


def _open_snapshot_destination(request):
    """Open the private destination directory the caller already created.

    Farol creates this directory itself (mode 0700, inside its own runtime
    directory) before it ever asks the helper to fill it.  The helper does not
    trust the pathname alone: it walks to it component by component the same
    way it walks the approved root, and refuses unless the object it finds is
    still the exact one the caller measured (device/inode), owned by this
    process, mode exactly 0700, and still empty.
    """

    destination = request.get("destination")
    grant = request.get("destinationRoot")
    if not isinstance(grant, dict) or set(grant) != {"path", "device", "inode"}:
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
    if not isinstance(destination, str) or destination != grant.get("path"):
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
    try:
        parts = _components(destination, absolute=True)
    except Refusal:
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
    device_raw = grant.get("device")
    inode_raw = grant.get("inode")
    if (
        not isinstance(device_raw, str)
        or not re.fullmatch(r"[0-9]{1,20}", device_raw)
        or not isinstance(inode_raw, str)
        or not re.fullmatch(r"[0-9]{1,20}", inode_raw)
    ):
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for part in parts:
            try:
                child = _open_directory(descriptor, part)
            except Refusal:
                refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
            os.close(descriptor)
            descriptor = child
        opened = os.fstat(descriptor)
        if (
            str(opened.st_dev) != device_raw
            or str(opened.st_ino) != inode_raw
            or opened.st_uid != os.getuid()
            or stat.S_IMODE(opened.st_mode) != 0o700
        ):
            refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
        names, overflowed = _bounded_sorted_names(descriptor, 1)
        if overflowed or names:
            refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


_SNAPSHOT_CORE_BOOL_KEYS = (
    "bare",
    "filemode",
    "ignorecase",
    "precomposeunicode",
    "symlinks",
)
_SNAPSHOT_CORE_DEFAULTS = {
    "repositoryformatversion": "0",
    "filemode": "true",
    "bare": "false",
    "ignorecase": "false",
    "precomposeunicode": "false",
    "symlinks": "true",
}
_SNAPSHOT_CORE_ORDER = (
    "repositoryformatversion",
    "filemode",
    "bare",
    "ignorecase",
    "precomposeunicode",
    "symlinks",
)
# Repository-format extensions that only describe how the metadata is laid
# out -- the object-name algorithm, where refs are stored, whether a
# per-worktree config file exists.  Each is structural, never executable, and
# dropping it would make Git misread a repository that uses it (a sha256 or
# reftable repository is unreadable without its extension).  Kept only with
# exactly one of the values Git itself writes; `partialClone`, `preciousObjects`
# and anything unlisted are dropped like every other key.
_SNAPSHOT_EXTENSION_VALUES = {
    "objectformat": ("sha1", "sha256"),
    "refstorage": ("files", "reftable"),
    "worktreeconfig": ("true", "false"),
}
_SNAPSHOT_EXTENSION_ORDER = ("objectformat", "refstorage", "worktreeconfig")
_SNAPSHOT_SECTION_HEADER = re.compile(r'^\[([A-Za-z0-9.-]+)(?:\s+"(?:.*)")?\]$')
_SNAPSHOT_KEY_VALUE = re.compile(r'^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$')
_SNAPSHOT_VALID_INT = re.compile(r'^[0-9]{1,9}$')
_SNAPSHOT_VALID_BOOL = re.compile(r'^(?:true|false)$', re.IGNORECASE)


def _config_key_values(text):
    """Yield `(section, key, value)` for every plain key line of a Git config
    text, sections lower-cased; a subsection name is dropped with its header,
    and a line this parser does not recognise is skipped, never copied.
    """

    section = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", ";")):
            continue
        header = _SNAPSHOT_SECTION_HEADER.match(stripped)
        if header:
            section = header.group(1).strip().lower()
            continue
        match = _SNAPSHOT_KEY_VALUE.match(stripped)
        if not match or section is None:
            continue
        yield section, match.group(1).lower(), match.group(2)


def _minimal_git_config(text):
    """Reduce an arbitrary `.git/config` to the fixed, safe subset it needs.

    Only `[core]` keys already reviewed as inert for `git status`/`rev-parse`
    survive, plus the three structural `[extensions]` keys listed in
    `_SNAPSHOT_EXTENSION_VALUES`, and only when their value is exactly the
    shape Git itself writes.  Every other section and key -- `include.path`,
    `core.fsmonitor`, `core.hooksPath`, a clean/smudge filter,
    `core.sshCommand`, an alias, a credential helper -- is dropped by
    construction: this function never copies a line, it only ever reads
    specific keys out of two sections and re-emits them in a fixed order.
    """

    values = dict(_SNAPSHOT_CORE_DEFAULTS)
    extensions = {}
    for section, key, value in _config_key_values(text):
        if section == "core":
            if key == "repositoryformatversion" and _SNAPSHOT_VALID_INT.match(value):
                values[key] = value
            elif key in _SNAPSHOT_CORE_BOOL_KEYS and _SNAPSHOT_VALID_BOOL.match(value):
                values[key] = value.lower()
        elif section == "extensions":
            allowed = _SNAPSHOT_EXTENSION_VALUES.get(key)
            if allowed is not None and value.lower() in allowed:
                extensions[key] = value.lower()
    lines = ["[core]"]
    for key in _SNAPSHOT_CORE_ORDER:
        lines.append("\t{} = {}".format(key, values[key]))
    if extensions:
        lines.append("[extensions]")
        for key in _SNAPSHOT_EXTENSION_ORDER:
            if key in extensions:
                lines.append("\t{} = {}".format(key, extensions[key]))
    return ("\n".join(lines) + "\n").encode("ascii")


def _minimal_worktree_config(text):
    """Reduce a `config.worktree` to the same inert `[core]` booleans, keeping
    only the keys the file actually sets.

    Git reads this file after `config` when `extensions.worktreeConfig` is on,
    so unlike `_minimal_git_config` it must not emit a default for a key the
    file did not set: a default `filemode = true` here would override a
    `filemode = false` in the main config, and a `repositoryformatversion`
    here would switch every extension off.  The result may be empty.
    """

    kept = []
    for section, key, value in _config_key_values(text):
        if (
            section == "core"
            and key in _SNAPSHOT_CORE_BOOL_KEYS
            and _SNAPSHOT_VALID_BOOL.match(value)
            and key not in dict(kept)
        ):
            kept.append((key, value.lower()))
    if not kept:
        return b""
    lines = ["[core]"]
    for key in _SNAPSHOT_CORE_ORDER:
        for kept_key, kept_value in kept:
            if kept_key == key:
                lines.append("\t{} = {}".format(key, kept_value))
    return ("\n".join(lines) + "\n").encode("ascii")


def _snapshot_read_all(descriptor, ceiling, *, on_too_large):
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
    if before.st_size < 0 or before.st_size > ceiling:
        refuse(on_too_large)
    chunks = []
    remaining = before.st_size
    while remaining:
        chunk = os.read(descriptor, min(1024 * 1024, remaining))
        if not chunk:
            refuse(EXIT_RACE)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _snapshot_charge_bytes(state, size):
    """Charge `size` against the copied-byte budget and refuse over it.

    Only bytes this verb actually reads and writes are charged here: the
    copied index and a rewritten config.  A cloned regular file has its own
    budget (`_snapshot_charge_cloned_bytes`), because a clone moves no data.
    """
    state["bytes"] += max(size, 0)
    if state["bytes"] > state["max_bytes"]:
        refuse(EXIT_SNAPSHOT_TOO_LARGE)


def _snapshot_charge_cloned_bytes(state, size):
    """Charge a cloned regular file's own size against the clone budget.

    `fclonefileat` costs this process no bytes -- the clone shares the
    source's extents until either side writes -- but Git may still hash every
    one of those bytes once the snapshot is handed to it, so the sizes are
    bounded too, separately and generously (`MAX_SNAPSHOT_CLONED_BYTES`).
    """
    state["cloned_bytes"] += max(size, 0)
    if state["cloned_bytes"] > state["max_cloned_bytes"]:
        refuse(EXIT_SNAPSHOT_TOO_LARGE)


def _snapshot_create_file(dest_fd, name, payload, state):
    _snapshot_charge_bytes(state, len(payload))
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        mode=0o600,
        dir_fd=dest_fd,
    )
    try:
        _write_all(descriptor, payload)
    finally:
        os.close(descriptor)


def _snapshot_read_source(source_fd, name, ceiling):
    """Read one regular file under `source_fd` whole, by descriptor, up to
    `ceiling` bytes; over it refuses as too large.
    """

    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=source_fd)
    except OSError as error:
        _map_open_error(error, source_fd, name)
    try:
        return _snapshot_read_all(
            descriptor, ceiling, on_too_large=EXIT_SNAPSHOT_TOO_LARGE
        )
    finally:
        os.close(descriptor)


def _snapshot_copy_handler(source_fd, dest_fd, name, state, _depth):
    """Copy, never clone, a file Git may rewrite in place."""
    payload = _snapshot_read_source(
        source_fd, name, state["max_bytes"] - state["bytes"]
    )
    _snapshot_create_file(dest_fd, name, payload, state)


def _snapshot_index_handler(source_fd, dest_fd, name, state, _depth):
    """Copy the index Git will read and rewrite, and record the SHA-256 of
    the exact bytes copied.

    The digest is what lets a caller take two snapshots as one instant: the
    first tells it which paths the index tracks, the second carries those
    paths and is refused (`expectedIndexSha256`) unless its index copy is
    byte-identical to the first.
    """

    payload = _snapshot_read_source(
        source_fd, name, state["max_bytes"] - state["bytes"]
    )
    state["index_sha256"] = hashlib.sha256(payload).hexdigest()
    _snapshot_create_file(dest_fd, name, payload, state)


def _snapshot_config_handler(source_fd, dest_fd, name, state, _depth):
    """Replace `.git/config` with its minimal, execution-free equivalent."""
    payload = _snapshot_read_source(source_fd, name, MAX_SNAPSHOT_CONFIG_BYTES)
    minimal = _minimal_git_config(payload.decode("utf-8", "replace"))
    _snapshot_create_file(dest_fd, name, minimal, state)


def _snapshot_worktree_config_handler(source_fd, dest_fd, name, state, _depth):
    """Replace a `config.worktree` with its minimal equivalent.

    Git reads this file when `extensions.worktreeConfig` is on, after the
    main config, so it is exactly as capable of naming a `core.fsmonitor` or
    a `core.hooksPath` as `config` itself; it gets the same treatment.
    """

    payload = _snapshot_read_source(source_fd, name, MAX_SNAPSHOT_CONFIG_BYTES)
    minimal = _minimal_worktree_config(payload.decode("utf-8", "replace"))
    _snapshot_create_file(dest_fd, name, minimal, state)


def _refuse_if_alternates(git_fd):
    """Refuse a repository whose `objects/info/alternates` exists.

    Only the entry's existence is tested -- it is never opened or read: its
    content names an object store outside the snapshot, which Git could not
    reach there, so the honest answer is a refusal before any clone is made.
    """

    try:
        objects_fd = os.open("objects", DIRECTORY_FLAGS, dir_fd=git_fd)
    except OSError:
        return
    try:
        try:
            info_fd = os.open("info", DIRECTORY_FLAGS, dir_fd=objects_fd)
        except OSError:
            return
        try:
            try:
                os.stat("alternates", dir_fd=info_fd, follow_symlinks=False)
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ENOTDIR):
                    return
            refuse(EXIT_SNAPSHOT_ALTERNATES_UNSUPPORTED)
        finally:
            os.close(info_fd)
    finally:
        os.close(objects_fd)


def _snapshot_skip_handler(_source_fd, _dest_fd, _name, _state, _depth):
    """Drop an entry on purpose: this verb writes its own replacement later."""


def _snapshot_symlink(source_fd, dest_fd, name):
    try:
        target = os.readlink(name, dir_fd=source_fd)
    except OSError:
        return
    if not isinstance(target, str) or "\x00" in target or len(target) > 4096:
        return
    try:
        os.symlink(target, name, dir_fd=dest_fd)
    except OSError:
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)


_FCLONEFILEAT = None
_ENOTSUP_CODES = frozenset(
    code
    for code in (getattr(errno, "ENOTSUP", None), getattr(errno, "EOPNOTSUPP", None))
    if code is not None
)


def _fclonefileat(source_fd, dest_dir_fd, name):
    """`fclonefileat(2)`: clone the open regular file `source_fd` to a new
    entry `name` under `dest_dir_fd`.

    The clone is an independent inode sharing the source's extents
    copy-on-write.  Taking the source as a descriptor rather than a name is
    what makes the clone descriptor-bound: the object cloned is exactly the
    one whose identity was just verified on that descriptor, whatever the
    directory now says about `name`.
    """

    global _FCLONEFILEAT
    if _FCLONEFILEAT is None:
        function = ctypes.CDLL(None, use_errno=True).fclonefileat
        function.argtypes = (
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint32,
        )
        function.restype = ctypes.c_int
        _FCLONEFILEAT = function
    if _FCLONEFILEAT(source_fd, dest_dir_fd, os.fsencode(name), 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def _snapshot_clone(source_fd, dest_fd, name, listed):
    """Attach one regular file as an APFS clone of the object `listed`
    describes: a new inode with the source's bytes as they are at this
    instant, sharing extents copy-on-write.

    The source is opened `O_NOFOLLOW` and its identity compared with `listed`
    before the clone, so a swap of `name` between the listing and this call
    is refused rather than cloned; it is compared again afterwards so a write
    made into it during the clone is refused rather than half-captured.  The
    owner's file is never linked to: its link count stays one, a later write
    through any descriptor on it is invisible in the snapshot, and no write
    through the snapshot can reach it.
    """

    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=source_fd)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            refuse(EXIT_ROOT_CHANGED)
        refuse(EXIT_PATH_REFUSED)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
            listed.st_dev,
            listed.st_ino,
        ):
            refuse(EXIT_ROOT_CHANGED)
        try:
            _fclonefileat(descriptor, dest_fd, name)
        except OSError as error:
            if error.errno == errno.EXDEV:
                refuse(EXIT_SNAPSHOT_CROSS_VOLUME)
            if error.errno in _ENOTSUP_CODES:
                refuse(EXIT_SNAPSHOT_CLONE_UNSUPPORTED)
            if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                refuse(EXIT_ROOT_CHANGED)
            refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
        after = os.fstat(descriptor)
        captured = _stable_identity(after)
        if captured != _stable_identity(opened):
            refuse(EXIT_ROOT_CHANGED)
    finally:
        os.close(descriptor)
    clone = os.stat(name, dir_fd=dest_fd, follow_symlinks=False)
    if (
        not stat.S_ISREG(clone.st_mode)
        or clone.st_nlink != 1
        or clone.st_size != opened.st_size
        or (clone.st_dev, clone.st_ino) == (listed.st_dev, listed.st_ino)
    ):
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
    # The identity the snapshot's bytes actually came from, for the
    # whole-list re-check in `_snapshot_verify_sources`.
    return captured


def _snapshot_entry(source_fd, dest_fd, name, state, depth, denied=(), prefix=()):
    # `name` came from a listing already taken; between that listing and this
    # stat, a concurrent change to the source (not only a hostile one -- a
    # build tool deleting its own output is enough) can make it vanish or
    # change kind.  `_listed_child` is the same guard every other walk in
    # this helper already uses for exactly that gap.
    listed = _listed_child(source_fd, name, missing_status=EXIT_ROOT_CHANGED)
    if stat.S_ISDIR(listed.st_mode):
        os.mkdir(name, mode=0o700, dir_fd=dest_fd)
        child_source = _open_directory(source_fd, name)
        try:
            child_dest = os.open(name, DIRECTORY_FLAGS, dir_fd=dest_fd)
            try:
                _snapshot_walk(child_source, child_dest, state, depth + 1, {}, denied, prefix)
            finally:
                os.close(child_dest)
        finally:
            os.close(child_source)
        return
    if stat.S_ISLNK(listed.st_mode):
        _snapshot_symlink(source_fd, dest_fd, name)
        return
    if not stat.S_ISREG(listed.st_mode):
        # Neither a directory, a symlink nor a regular file: skipped, which
        # matches what `git status`/`rev-parse` can report about it anyway.
        return
    if listed.st_nlink < 1:
        refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
    # A clone is a point-in-time copy of the file's bytes on its own inode:
    # a rename, replacement, deletion or in-place write of the source
    # afterwards changes nothing Git will read, and no write through the
    # snapshot reaches the owner's file.
    _snapshot_charge_cloned_bytes(state, listed.st_size)
    _snapshot_clone(source_fd, dest_fd, name, listed)


def _snapshot_walk(source_fd, dest_fd, state, depth, special, denied=(), prefix=()):
    """Recreate every entry of one already-open source directory inside one
    already-open, already-empty destination directory.

    `special` maps a name to a handler for entries *directly inside this
    call* only (`.git`, then `config`/`index` one level inside it); every
    recursive call this makes starts a fresh, empty `special`, so nothing
    below the first two levels is ever treated specially.

    `denied` (root-relative prefix tuples) and `prefix` (this call's own
    root-relative location) apply only to whole-tree walks: an entry under a
    denied prefix is excluded the same way a recursive search walk already
    excludes one (`_walk_regular_files`) -- skipped before it is charged
    against any bound, never attached, never refused.  A `special`-handled name
    (`.git`) is never subject to this check: the caller who sets `special`
    already carries its own authorization for that entry.
    """

    if depth > MAX_SNAPSHOT_DEPTH:
        refuse(EXIT_SNAPSHOT_TOO_LARGE)
    before = os.fstat(source_fd)
    remaining = state["max_entries"] - state["entries"]
    if remaining <= 0:
        refuse(EXIT_SNAPSHOT_TOO_LARGE)
    names, overflowed = _bounded_sorted_names(source_fd, remaining)
    if overflowed:
        refuse(EXIT_SNAPSHOT_TOO_LARGE)
    for index, name in enumerate(names):
        if not isinstance(name, str) or name in ("", ".", "..") or "/" in name:
            continue
        handler = special.get(name)
        if handler is None and denied and _under(prefix + (name,), denied):
            continue
        state["entries"] += 1
        if state["entries"] > state["max_entries"]:
            refuse(EXIT_SNAPSHOT_TOO_LARGE)
        _test_hook(state["request"], "snapshot-walk-entry", index)
        if handler is not None:
            handler(source_fd, dest_fd, name, state, depth)
        else:
            _snapshot_entry(source_fd, dest_fd, name, state, depth, denied, prefix + (name,))
    after = os.fstat(source_fd)
    if _stable_identity(before) != _stable_identity(after):
        refuse(EXIT_ROOT_CHANGED)


def _snapshot_linked_worktree(source_fd, dest_fd, name, state, request):
    """Handle a top-level `.git` that is a file: a linked worktree's pointer.

    The pointer is never copied or linked as-is -- its target lives outside
    the snapshot, and Git would follow it there, defeating the whole point.
    Instead the two directories a linked worktree actually needs (its own
    gitdir and the repository's common gitdir) are snapshotted into a private
    location inside the destination, and a new pointer is written in their
    place.  Both directories must already have been approved by identity by
    the caller (the same owner-verified relationship
    `resolveWorkspaceGitMetadata` already establishes); this only re-checks,
    right now, that the approved object is still there.
    """

    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=source_fd)
    except OSError as error:
        _map_open_error(error, source_fd, name)
    try:
        payload = _snapshot_read_all(
            descriptor,
            MAX_SNAPSHOT_GITLINK_BYTES,
            on_too_large=EXIT_SNAPSHOT_METADATA_UNAPPROVED,
        )
    finally:
        os.close(descriptor)
    try:
        text = payload.decode("utf-8", "strict")
    except UnicodeDecodeError:
        refuse(EXIT_SNAPSHOT_METADATA_UNAPPROVED)
    match = re.fullmatch(r"gitdir: ([^\x00\r\n]+)\r?\n?", text)
    gitdir_value = match.group(1).strip() if match else None
    if not gitdir_value or gitdir_value != match.group(1):
        refuse(EXIT_SNAPSHOT_METADATA_UNAPPROVED)

    external_gitdir = request.get("externalGitDir")
    external_commondir = request.get("externalCommonDir")
    gitdir_fd = _open_external_identity(
        gitdir_value, external_gitdir, EXIT_SNAPSHOT_METADATA_UNAPPROVED
    )
    try:
        commondir_path = (
            external_commondir.get("path")
            if isinstance(external_commondir, dict)
            else None
        )
        commondir_fd = _open_external_identity(
            commondir_path, external_commondir, EXIT_SNAPSHOT_METADATA_UNAPPROVED
        )
        try:
            destination = request["destination"].rstrip("/")
            os.mkdir(".gitmeta", mode=0o700, dir_fd=dest_fd)
            gitmeta_fd = _open_directory(dest_fd, ".gitmeta")
            try:
                os.mkdir("worktree", mode=0o700, dir_fd=gitmeta_fd)
                os.mkdir("common", mode=0o700, dir_fd=gitmeta_fd)
                worktree_dest_fd = os.open(
                    "worktree", DIRECTORY_FLAGS, dir_fd=gitmeta_fd
                )
                try:
                    _snapshot_walk(
                        gitdir_fd,
                        worktree_dest_fd,
                        state,
                        1,
                        {
                            "index": _snapshot_index_handler,
                            "config.worktree": _snapshot_worktree_config_handler,
                            "commondir": _snapshot_skip_handler,
                            "gitdir": _snapshot_skip_handler,
                        },
                    )
                    _snapshot_create_file(
                        worktree_dest_fd,
                        "commondir",
                        (destination + "/.gitmeta/common\n").encode("utf-8"),
                        state,
                    )
                finally:
                    os.close(worktree_dest_fd)
                common_dest_fd = os.open(
                    "common", DIRECTORY_FLAGS, dir_fd=gitmeta_fd
                )
                try:
                    _refuse_if_alternates(commondir_fd)
                    _snapshot_walk(
                        commondir_fd,
                        common_dest_fd,
                        state,
                        1,
                        {
                            "config": _snapshot_config_handler,
                            "config.worktree": _snapshot_worktree_config_handler,
                        },
                    )
                finally:
                    os.close(common_dest_fd)
            finally:
                os.close(gitmeta_fd)
        finally:
            os.close(commondir_fd)
    finally:
        os.close(gitdir_fd)
    _snapshot_create_file(
        dest_fd,
        name,
        ("gitdir: " + destination + "/.gitmeta/worktree\n").encode("utf-8"),
        state,
    )


def _snapshot_git_handler(request):
    def handle(source_fd, dest_fd, name, state, depth):
        listed = _listed_child(source_fd, name, missing_status=EXIT_ROOT_CHANGED)
        if stat.S_ISDIR(listed.st_mode):
            os.mkdir(name, mode=0o700, dir_fd=dest_fd)
            child_source = _open_directory(source_fd, name)
            try:
                _refuse_if_alternates(child_source)
                child_dest = os.open(name, DIRECTORY_FLAGS, dir_fd=dest_fd)
                try:
                    _snapshot_walk(
                        child_source,
                        child_dest,
                        state,
                        depth + 1,
                        {
                            "config": _snapshot_config_handler,
                            "config.worktree": _snapshot_worktree_config_handler,
                            "index": _snapshot_index_handler,
                        },
                    )
                finally:
                    os.close(child_dest)
            finally:
                os.close(child_source)
            return
        if stat.S_ISLNK(listed.st_mode):
            _snapshot_symlink(source_fd, dest_fd, name)
            return
        if not stat.S_ISREG(listed.st_mode):
            return
        _snapshot_linked_worktree(source_fd, dest_fd, name, state, request)

    return handle


def _snapshot_git_only(root_fd, destination_fd, state, request):
    """Recreate only the top-level `.git` entry: the bounded-path mode's
    metadata step.  Identical to what the whole-tree walk does for `.git`
    (`_snapshot_git_handler`); everything else under the root is left alone.
    """

    handler = _snapshot_git_handler(request)
    handler(root_fd, destination_fd, ".git", state, 0)


def _snapshot_listed_component(parent_fd, name):
    """`stat` one path component without following it, or `None` when the
    name (or a directory on the way to it) no longer exists.
    """

    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR):
            return None
        refuse(EXIT_PATH_REFUSED)


def _snapshot_clone_path(root_fd, destination_fd, parts, state, denied, index):
    """Clone exactly one caller-named, root-relative regular file (or
    recreate a symlink) into the destination, creating whatever destination
    directories its parents need.  Returns True when the path was attached
    and False when it was skipped.

    Every component is opened by descriptor, `O_NOFOLLOW`, exactly like the
    whole-tree walk.  Three outcomes are told apart on purpose.  A denied
    path -- or a path under a denied prefix -- is refused outright rather
    than silently dropped: a caller naming one directly is either a policy
    bug or an attempt to route around the exclusion.  A path that is missing
    from the working tree, or whose leaf (or a directory on the way to it)
    is neither a regular file nor a symlink, is skipped: the caller's list
    came from the index, and a tracked path that no longer exists as a file
    is exactly what Git reports as deleted (or a type change) when the
    snapshot omits it, which is the truthful statement about the owner's
    tree.  Anything else -- an unreadable component, a symlink where a
    regular file was listed a moment ago -- stays a refusal.
    """

    if _under(parts, denied):
        refuse(EXIT_PATH_REFUSED)
    source_fd = os.dup(root_fd)
    target_fd = os.dup(destination_fd)
    try:
        for depth, part in enumerate(parts[:-1]):
            if _under(parts[: depth + 1], denied):
                refuse(EXIT_PATH_REFUSED)
            listed_parent = _snapshot_listed_component(source_fd, part)
            if listed_parent is None or not stat.S_ISDIR(listed_parent.st_mode):
                return False
            child_source = _open_directory(source_fd, part)
            os.close(source_fd)
            source_fd = child_source
            try:
                os.mkdir(part, mode=0o700, dir_fd=target_fd)
            except OSError as error:
                if error.errno != errno.EEXIST:
                    refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
            child_target = _open_directory(target_fd, part)
            os.close(target_fd)
            target_fd = child_target
        name = parts[-1]
        listed = _snapshot_listed_component(source_fd, name)
        if listed is None:
            _snapshot_record_source(state, source_fd, parts, None)
            return False
        # Test seam only: lets a test replace or rename away the object this
        # walk already listed, in the exact gap between the listing above and
        # the clone below, so `_snapshot_clone`'s own identity check
        # (`EXIT_ROOT_CHANGED`) can be proven against a real race instead of
        # only argued about.
        _test_hook(state["request"], "snapshot-clone-path-entry", index)
        if stat.S_ISLNK(listed.st_mode):
            _snapshot_symlink(source_fd, target_fd, name)
            state["entries"] += 1
            if state["entries"] > state["max_entries"]:
                refuse(EXIT_SNAPSHOT_TOO_LARGE)
            _snapshot_record_source(state, source_fd, parts, _stable_identity(listed))
            return True
        if not stat.S_ISREG(listed.st_mode):
            _snapshot_record_source(state, source_fd, parts, _stable_identity(listed))
            return False
        if listed.st_nlink < 1:
            refuse(EXIT_SNAPSHOT_DESTINATION_INVALID)
        state["entries"] += 1
        if state["entries"] > state["max_entries"]:
            refuse(EXIT_SNAPSHOT_TOO_LARGE)
        _snapshot_charge_cloned_bytes(state, listed.st_size)
        captured = _snapshot_clone(source_fd, target_fd, name, listed)
        _snapshot_record_source(state, source_fd, parts, captured)
        return True
    finally:
        os.close(source_fd)
        os.close(target_fd)


def _snapshot_record_source(state, parent_fd, parts, identity):
    """Remember what one caller-named tracked path was at the instant this
    snapshot took it: the identity of the directory it was taken from, the
    leaf's name, and the leaf's own stable identity -- or `None` when the
    leaf was not there, which is itself the statement the snapshot makes
    about it (Git reports it deleted).

    The parent is remembered by identity rather than by an open descriptor
    because a tracked-path list may name thousands of files, and one held
    descriptor per file would exhaust the table.  The re-check walks back to
    the parent by descriptor, `O_NOFOLLOW` at every component exactly as the
    clone did, and requires that walk to land on this very directory inode
    before it stats the leaf inside it -- so a directory swapped in the
    meantime is refused rather than followed.
    """

    parent = os.fstat(parent_fd)
    state["sources"].append(
        (parts[:-1], (parent.st_dev, parent.st_ino), parts[-1], identity)
    )


def _snapshot_verify_sources(root_fd, state):
    """Refuse unless every tracked source is still exactly what it was when
    this snapshot took it.

    Capture is necessarily sequential, so without this the snapshot could
    hold one file from before a concurrent write and another from after it,
    and the command's report would describe a tree that never existed.  The
    check is a pure re-stat: it reads no contents, and it never repairs the
    snapshot -- the caller deletes the whole destination on any refusal.
    """

    groups = {}
    for parent_parts, parent_identity, name, identity in state["sources"]:
        groups.setdefault((parent_parts, parent_identity), []).append((name, identity))
    for (parent_parts, parent_identity), leaves in groups.items():
        parent_fd = os.dup(root_fd)
        try:
            for part in parent_parts:
                try:
                    child = _open_directory(parent_fd, part)
                except (Refusal, OSError):
                    # A directory this capture walked through moments ago is
                    # gone or is no longer a directory: the tree moved under
                    # the snapshot, which is this refusal and no other.
                    refuse(EXIT_SNAPSHOT_TREE_CHANGED)
                os.close(parent_fd)
                parent_fd = child
            current = os.fstat(parent_fd)
            if (current.st_dev, current.st_ino) != parent_identity:
                refuse(EXIT_SNAPSHOT_TREE_CHANGED)
            for name, identity in leaves:
                try:
                    now = _snapshot_listed_component(parent_fd, name)
                except Refusal:
                    refuse(EXIT_SNAPSHOT_TREE_CHANGED)
                if identity is None:
                    if now is not None:
                        refuse(EXIT_SNAPSHOT_TREE_CHANGED)
                    continue
                if now is None or _stable_identity(now) != identity:
                    refuse(EXIT_SNAPSHOT_TREE_CHANGED)
        finally:
            os.close(parent_fd)


_EXPECTED_INDEX_ABSENT = object()


def _parsed_expected_index(request):
    """The index digest the caller requires this snapshot to match, `None`
    for "the caller saw no index", or `_EXPECTED_INDEX_ABSENT` when the
    caller made no such demand.
    """

    if "expectedIndexSha256" not in request:
        return _EXPECTED_INDEX_ABSENT
    expected = request["expectedIndexSha256"]
    if expected is None:
        return None
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        refuse(EXIT_INVALID)
    return expected


def _parsed_snapshot_paths(request):
    """`None` for the whole-tree mode; otherwise the caller's deduplicated,
    validated, root-relative path list -- possibly empty, meaning "no path
    beyond `.git` itself" (the metadata-only step of the bounded mode).
    """

    if "paths" not in request:
        return None
    paths = request["paths"]
    if not isinstance(paths, list) or len(paths) > MAX_SNAPSHOT_PATHS:
        refuse(EXIT_INVALID)
    parsed = []
    seen = set()
    for value in paths:
        parts = tuple(_components(value, absolute=False))
        if parts not in seen:
            seen.add(parts)
            parsed.append(parts)
    return parsed


def _workspace_snapshot(request):
    """Build the private snapshot N02 describes and return its size.

    Two modes.  Whole-tree (no `paths` key): every regular file below the
    approved root is attached by descriptor, never opened by name.  Bounded
    (`paths` present, possibly empty): only `.git` and the caller's own
    explicit relative paths are attached -- the shape
    `native-verification-command.ts` uses once it already knows, from Git
    itself, which paths a command actually needs.  In both modes a regular
    file is attached as an APFS clone (`fclonefileat`): a point-in-time copy
    of its bytes on an inode of its own, so renaming, replacing, deleting or
    writing into the source afterwards -- through any descriptor -- changes
    nothing in the snapshot, the owner's link count stays one, and no write
    through the snapshot can reach the owner's file.  `.git/config` (and a
    linked worktree's common config) is replaced by its minimal,
    execution-free equivalent and `config.worktree` by its own; `.git/index`
    (and a linked worktree's own index) is copied, because Git may rewrite
    it in place, and the SHA-256 of the copied bytes is reported so a caller
    can pin a second snapshot to the same index (`expectedIndexSha256`).
    `denied` (root-relative prefixes) excludes matching entries from the
    whole-tree walk and refuses a bounded path that names or sits under one;
    a bounded path missing from the working tree, or present as something
    other than a regular file or symlink, is skipped and counted.  This verb
    only builds the snapshot; it never runs Git.
    """

    if set(request) - {
        "operation",
        "root",
        "approvedRoot",
        "destination",
        "destinationRoot",
        "maxEntries",
        "maxBytes",
        "maxClonedBytes",
        "expectedIndexSha256",
        "externalGitDir",
        "externalCommonDir",
        "testHook",
        "paths",
        "denied",
    }:
        refuse(EXIT_INVALID)
    max_entries = _bounded_snapshot_limit(request.get("maxEntries"), MAX_SNAPSHOT_ENTRIES)
    max_bytes = _bounded_snapshot_limit(request.get("maxBytes"), MAX_SNAPSHOT_BYTES)
    max_cloned_bytes = _bounded_snapshot_limit(
        request.get("maxClonedBytes"), MAX_SNAPSHOT_CLONED_BYTES
    )
    expected_index = _parsed_expected_index(request)
    denied = _parse_prefixes(request.get("denied"))
    parsed_paths = _parsed_snapshot_paths(request)
    root_fd = _open_root(request)
    try:
        destination_fd = _open_snapshot_destination(request)
        try:
            source_stat = os.fstat(root_fd)
            dest_stat = os.fstat(destination_fd)
            if source_stat.st_dev != dest_stat.st_dev:
                refuse(EXIT_SNAPSHOT_CROSS_VOLUME)
            state = {
                "entries": 0,
                "bytes": 0,
                "cloned_bytes": 0,
                "skipped": 0,
                "index_sha256": None,
                # S35-H1-2: one entry per caller-named tracked path, as it
                # was when this capture took it.  Whole-tree mode leaves it
                # empty: that walk holds each directory open while it
                # recreates every entry inside it, so it has no per-file gap
                # of this shape to close.
                "sources": [],
                "max_entries": max_entries,
                "max_bytes": max_bytes,
                "max_cloned_bytes": max_cloned_bytes,
                "request": request,
            }
            _test_hook(request, "before-snapshot-walk", None)
            if parsed_paths is None:
                special = {".git": _snapshot_git_handler(request)}
                _snapshot_walk(root_fd, destination_fd, state, 0, special, denied, ())
            else:
                _snapshot_git_only(root_fd, destination_fd, state, request)
                if (
                    expected_index is not _EXPECTED_INDEX_ABSENT
                    and state["index_sha256"] != expected_index
                ):
                    refuse(EXIT_SNAPSHOT_INDEX_CHANGED)
                for index, parts in enumerate(parsed_paths):
                    if not _snapshot_clone_path(
                        root_fd, destination_fd, parts, state, denied, index
                    ):
                        state["skipped"] += 1
                _test_hook(request, "before-snapshot-verify", None)
                # Every tracked path is attached; refuse unless the tree they
                # came from still says exactly what it said while they were
                # taken, so the status the caller reports is one instant.
                _snapshot_verify_sources(root_fd, state)
            return json.dumps(
                {
                    "bytes": state["bytes"],
                    "clonedBytes": state["cloned_bytes"],
                    "entries": state["entries"],
                    "indexSha256": state["index_sha256"],
                    "skipped": state["skipped"],
                },
                ensure_ascii=True,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("ascii")
        finally:
            os.close(destination_fd)
    finally:
        os.close(root_fd)


def main():
    try:
        request = _read_request()
        operation = request.get("operation")
        if operation == "workspace-snapshot":
            payload = _workspace_snapshot(request)
        elif operation == "grep":
            payload = _dispatch_with_grep_deadline(request)
        else:
            payload = _dispatch(request)
        os.write(1, MAGIC + struct.pack(">Q", len(payload)) + payload)
        return 0
    except Refusal as error:
        return error.status
    except BaseException:
        return EXIT_INTERNAL


if __name__ == "__main__":
    sys.exit(main())
