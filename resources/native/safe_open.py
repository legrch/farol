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

import json
import errno
import codecs
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
MAX_GREP_FILE_BYTES = 8 * 1024 * 1024
MAX_GREP_TOTAL_BYTES = 64 * 1024 * 1024
MAX_IGNORE_BYTES = 256 * 1024
MAX_GREP_WALL_SECONDS = 5.0
# One window of a file somebody else is still writing.  Large enough that a
# tail or a search step is one call, small enough that a caller cannot ask for
# a whole transcript by naming a length.
MAX_WINDOW_BYTES = 4 * 1024 * 1024

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


def _test_hook(request, phase, index=None):
    hook = request.get("testHook")
    if hook is None:
        return
    if not isinstance(hook, dict) or set(hook) != {"phase", "index"}:
        refuse(EXIT_INVALID)
    if hook.get("phase") != phase or hook.get("index") != index:
        return
    # FDs 4 and 5 exist only in the test adapter.  Production requests cannot
    # ask the public MCP surface to add them.
    try:
        os.write(4, b"R")
        if os.read(5, 1) != b"C":
            refuse(EXIT_INTERNAL)
    except OSError:
        refuse(EXIT_INTERNAL)


def _open_root(request):
    parts = _components(request.get("root"), absolute=True)
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for index, part in enumerate(parts):
            child = _open_directory(descriptor, part)
            os.close(descriptor)
            descriptor = child
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


def _atomic_publish(request, parent_fd, leaf, payload, previous):
    if len(payload) > MAX_MUTATION_BYTES:
        refuse(EXIT_FILE_TOO_LARGE)
    temporary = None
    descriptor = None
    try:
        for _attempt in range(32):
            temporary = ".farol-tmp-{}-{}".format(os.getpid(), os.urandom(16).hex())
            try:
                descriptor = os.open(
                    temporary,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                    dir_fd=parent_fd,
                )
                break
            except OSError as error:
                if error.errno != errno.EEXIST:
                    refuse(EXIT_PATH_REFUSED)
        if descriptor is None:
            refuse(EXIT_INTERNAL)

        _write_all(descriptor, payload)
        mode = 0o644 if previous is None else stat.S_IMODE(previous.st_mode)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
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
        if previous is None:
            try:
                os.link(
                    temporary,
                    leaf,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            except OSError:
                refuse(EXIT_RACE)
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except OSError:
                # The destination link already exists and the private link may
                # still exist.  This is an acted mutation whose final link
                # count and durability are not yet known to the caller.
                refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
            temporary = None
        else:
            try:
                os.replace(
                    temporary,
                    leaf,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                )
            except OSError:
                refuse(EXIT_RACE)
            temporary = None
        try:
            _test_hook(request, "after-replace", None)
            os.fsync(parent_fd)
        except BaseException:
            # The directory entry already changed. Neither a failed durability
            # barrier nor a lost response may be reported as though the write
            # were refused before it acted.
            refuse(EXIT_MUTATION_OUTCOME_UNKNOWN)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary is not None:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except OSError:
                pass


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
        crlf = "\r\n" in source
        source = source.replace("\r\n", "\n")

        replacements = []
        for old_text, new_text in normalized:
            first = source.find(old_text)
            if first < 0:
                refuse(EXIT_EDIT_NO_MATCH)
            if source.find(old_text, first + 1) >= 0:
                refuse(EXIT_EDIT_NOT_UNIQUE)
            replacements.append((first, first + len(old_text), new_text))
        replacements.sort(key=lambda item: item[0])
        for previous_replacement, current in zip(replacements, replacements[1:]):
            if current[0] < previous_replacement[1]:
                refuse(EXIT_EDIT_OVERLAP)

        pieces = []
        cursor = 0
        for start, end, new_text in replacements:
            pieces.append(source[cursor:start])
            pieces.append(new_text)
            cursor = end
        pieces.append(source[cursor:])
        result = "".join(pieces)
        if crlf:
            result = result.replace("\n", "\r\n")
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
    if b"\x00" in payload:
        return
    try:
        text = payload.decode("utf-8")
    except UnicodeError:
        return
    for number, raw_line in enumerate(text.splitlines(), 1):
        if expression.search(raw_line) is None:
            continue
        cleaned = _clean_match_line(raw_line)
        truncated = len(cleaned) > MAX_GREP_LINE_CHARS
        matches.append(
            {
                "line": number,
                "path": rendered_path,
                "text": cleaned[:MAX_GREP_LINE_CHARS],
                "truncated": truncated,
            }
        )
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
            "resultLimited": len(matches) > MAX_GREP_RESULTS,
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
        and abs(offset) <= MAX_FILE_BYTES
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


def main():
    try:
        request = _read_request()
        payload = (
            _dispatch_with_grep_deadline(request)
            if request.get("operation") == "grep"
            else _dispatch(request)
        )
        os.write(1, MAGIC + struct.pack(">Q", len(payload)) + payload)
        return 0
    except Refusal as error:
        return error.status
    except BaseException:
        return EXIT_INTERNAL


if __name__ == "__main__":
    sys.exit(main())
