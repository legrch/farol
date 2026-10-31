"""Version 2: descriptor-bound one-shot custody, never placement or rollback.

Descriptors 6/7 inherit the owner's promotion/updater locks; 8 supplies the
hash-attested ordinary promotion descriptor library. No installed code executes.
"""
import ctypes
import fcntl
import hashlib
import json
import os
import re
import stat
import sys


def bounded(fd, limit):
    raw = bytearray()
    while len(raw) <= limit:
        part = os.read(fd, min(8192, limit + 1 - len(raw)))
        if not part:
            break
        raw.extend(part)
    if not raw or len(raw) > limit:
        raise RuntimeError("REPLACEMENT_INPUT_INVALID")
    return bytes(raw)


library = bounded(8, 65536)
if hashlib.sha256(library).hexdigest() != "be78ebefca9280329b766c0aee9dbfdd9adfdab2020f373df236441fdb476ec6":
    raise RuntimeError("REPLACEMENT_LIBRARY_INVALID")
b = {"__name__": "attested_promotion_library"}
exec(compile(library, "<attested-promotion-library>", "exec"), b)


def ident(info):
    return [str(info.st_dev), str(info.st_ino)]


def check(fd, name, expected):
    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if ident(info) != expected or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise RuntimeError("REPLACEMENT_INODE_CHANGED")
    return info


def private(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RuntimeError("REPLACEMENT_DIRECTORY_UNSAFE")


def bytes_at(fd, name):
    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 65536:
        raise RuntimeError("REPLACEMENT_RECORD_UNSAFE")
    f = os.open(name, b["FILE_FLAGS"], dir_fd=fd)
    try:
        if ident(os.fstat(f)) != ident(info):
            raise RuntimeError("REPLACEMENT_RECORD_CHANGED")
        raw = os.read(f, 65537)
        after = os.fstat(f)
        if len(raw) != info.st_size or (after.st_mtime_ns, after.st_ctime_ns) != (info.st_mtime_ns, info.st_ctime_ns):
            raise RuntimeError("REPLACEMENT_RECORD_CHANGED")
        return raw
    finally:
        os.close(f)


def stamp(info):
    return {"identity": ident(info), "mode": str(info.st_mode), "uid": str(info.st_uid), "gid": str(info.st_gid), "size": str(info.st_size) if stat.S_ISREG(info.st_mode) else None}


def updater(fd):
    result = []
    known = {"ready.json", "last-update.json", "lock", "notice-preferences.json", "preferences.json", "automatic-update-preference.json", "install-on-quit-preference.json", "installed-execution", "adopted-baseline.json"}
    for name in sorted(os.listdir(fd)):
        if name not in known and not re.fullmatch(r"(?:download-)?[a-f0-9]{32}", name):
            raise RuntimeError("REPLACEMENT_UPDATER_UNEXPECTED")
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022 or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise RuntimeError("REPLACEMENT_UPDATER_UNSAFE")
        item = {"name": name, **stamp(info)}
        if stat.S_ISDIR(info.st_mode):
            child = b["open_directory"](fd, name)
            try:
                private(child)
                item["children"] = []
                for leaf in sorted(os.listdir(child)):
                    meta = os.stat(leaf, dir_fd=child, follow_symlinks=False)
                    if not (stat.S_ISDIR(meta.st_mode) or stat.S_ISREG(meta.st_mode)) or meta.st_uid != os.geteuid() or meta.st_mode & 0o022:
                        raise RuntimeError("REPLACEMENT_UPDATER_UNSAFE")
                    part = {"name": leaf, **stamp(meta)}
                    if leaf == "journal.json":
                        part["sha256"] = hashlib.sha256(bytes_at(child, leaf)).hexdigest()
                    item["children"].append(part)
            finally:
                os.close(child)
        elif name.endswith(".json"):
            item["sha256"] = hashlib.sha256(bytes_at(fd, name)).hexdigest()
        result.append(item)
    return result


def publish(fd, name, raw):
    f = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
    try:
        offset = 0
        while offset < len(raw):
            n = os.write(f, raw[offset:])
            if n <= 0:
                raise RuntimeError("REPLACEMENT_WRITE_UNKNOWN")
            offset += n
        os.fsync(f)
    finally:
        os.close(f)
    os.fsync(fd)
    if bytes_at(fd, name) != raw:
        raise RuntimeError("REPLACEMENT_WRITE_UNKNOWN")


def exclusive(src, name, dst, target):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameatx_np
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(src, os.fsencode(name), dst, os.fsencode(target), 4) != 0:
        raise OSError(ctypes.get_errno(), "REPLACEMENT_RENAME_REFUSED")
    os.fsync(src)
    os.fsync(dst)


def run(r):
    schema = r.get("schema")
    if schema not in ("farol.installed-replacement-native/1", "farol.installed-replacement-native/2", "farol.installed-replacement-native/3", "farol.installed-replacement-native/4") or r.get("action") not in ("custody", "complete", "initialize-clean-lock") or not re.fullmatch("[a-f0-9]{32}", r.get("operationId", "")):
        raise RuntimeError("REPLACEMENT_INPUT_INVALID")
    if schema == "farol.installed-replacement-native/1":
        if "installLocation" in r or r.get("action") == "initialize-clean-lock":
            raise RuntimeError("REPLACEMENT_INPUT_INVALID")
    elif r.get("installLocation") not in ("legacy", "shared"):
        raise RuntimeError("REPLACEMENT_INPUT_INVALID")
    adopted = schema == "farol.installed-replacement-native/3"
    if adopted != (r.get("snapshot", {}).get("receiptKind") == "adopted") or adopted and r.get("action") == "initialize-clean-lock":
        raise RuntimeError("REPLACEMENT_INPUT_INVALID")
    if schema == "farol.installed-replacement-native/4" and (r.get("snapshot", {}).get("receiptKind") != "normal" or r.get("action") == "initialize-clean-lock"):
        raise RuntimeError("REPLACEMENT_INPUT_INVALID")
    opened = []
    def directory(target):
        fd = b["open_absolute_directory"](target)
        opened.append(fd)
        return fd
    try:
        home = directory(r["home"])
        apps = b["open_applications"](r, home)
        opened.append(apps)
        profile = directory(r["userData"])
        private(profile)
        state = b["open_directory"](profile, "farol-state")
        opened.append(state)
        private(state)
        s = r["snapshot"]
        if ident(os.fstat(apps)) != s["applicationsIdentity"] or ident(os.fstat(profile)) != s["profileIdentity"] or ident(os.fstat(state)) != s["stateIdentity"]:
            raise RuntimeError("REPLACEMENT_PARENT_CHANGED")
        name = ".farol-replacement-" + r["operationId"]
        def locks(updates):
            for parent, entry, inherited, expected in ((state, "promotion.lease", 6, r["promotionIdentity"]), (updates, "lock", 7, s["updaterLockIdentity"])):
                info = check(parent, entry, expected)
                held = os.fstat(inherited)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or ident(held) != expected:
                    raise RuntimeError("REPLACEMENT_LOCK_CHANGED")
                probe = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    try:
                        fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    except BlockingIOError:
                        pass
                    else:
                        raise RuntimeError("REPLACEMENT_LOCK_NOT_HELD")
                    fcntl.flock(inherited, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(probe)
        if r["action"] == "initialize-clean-lock":
            updates = b["open_directory"](profile, "installed-updates")
            opened.append(updates)
            private(updates)
            if ident(os.fstat(updates)) != s["updaterIdentity"] or updater(updates) != s["updater"]:
                raise RuntimeError("REPLACEMENT_UPDATER_CHANGED")
            if any(item["name"] in ("lock", "ready.json", "last-update.json") or re.fullmatch(r"(?:download-)?[a-f0-9]{32}", item["name"]) for item in s["updater"]):
                raise RuntimeError("REPLACEMENT_UPDATE_RECEIPT_UNCONFIRMED")
            info = check(state, "promotion.lease", r["promotionIdentity"])
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or ident(os.fstat(6)) != r["promotionIdentity"]:
                raise RuntimeError("REPLACEMENT_LOCK_CHANGED")
            probe = os.open("promotion.lease", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state)
            try:
                try:
                    fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    raise RuntimeError("REPLACEMENT_LOCK_NOT_HELD")
                fcntl.flock(6, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(probe)
            b["recheck_parent"](r, home, apps)
            check(profile, "installed-updates", s["updaterIdentity"])
            lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=updates)
            opened.append(lock)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.fsync(lock)
            os.fsync(updates)
            held = os.fstat(lock)
            named = check(updates, "lock", ident(held))
            if not stat.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_mode & 0o077 or held.st_size != 0 or stamp(held) != stamp(named) or bytes_at(updates,"lock") != b"":
                raise RuntimeError("REPLACEMENT_UPDATER_LOCK_UNSAFE")
            if [item for item in updater(updates) if item["name"] != "lock"] != s["updater"]:
                raise RuntimeError("REPLACEMENT_UPDATER_CHANGED")
            b["recheck_parent"](r, home, apps)
            check(profile,"installed-updates",s["updaterIdentity"])
            return {"status":"created","identity":ident(held)}
        if r["action"] == "custody":
            updates = b["open_directory"](profile, "installed-updates")
            opened.append(updates)
            private(updates)
            locks(updates)
            if ident(os.fstat(updates)) != s["updaterIdentity"] or updater(updates) != s["updater"]:
                raise RuntimeError("REPLACEMENT_UPDATER_CHANGED")
            app = b["open_directory"](apps, "Farol.app")
            opened.append(app)
            check(apps, "Farol.app", s["appIdentity"])
            baseline_parent, baseline_name = (updates, "adopted-baseline.json") if adopted else (apps, "Farol.app.receipt.json")
            check(baseline_parent, baseline_name, s["receiptIdentity"])
            if adopted:
                try:
                    os.stat("Farol.app.receipt.json", dir_fd=apps, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise RuntimeError("REPLACEMENT_BASELINE_COLLISION")
            if b["digest_tree"](app) != s["appSha256"] or hashlib.sha256(bytes_at(baseline_parent, baseline_name)).hexdigest() != s["receiptSha256"]:
                raise RuntimeError("REPLACEMENT_SNAPSHOT_CHANGED")
            # Refuse occupied custody BEFORE publishing intent; mkdir remains
            # authoritative and non-overwriting even if an external actor races.
            try:
                os.stat(name, dir_fd=apps, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise RuntimeError("REPLACEMENT_CUSTODY_OCCUPIED")
            b["recheck_parent"](r, home, apps)
            # Allocate beneath the pinned owner-private profile. A shared
            # parent must never supply the directory we write our intent into.
            os.mkdir(name, 0o700, dir_fd=profile)
            os.fsync(profile)
            custody = b["open_directory"](profile, name)
            opened.append(custody)
            private(custody)
            if os.fstat(custody).st_dev != os.fstat(updates).st_dev or os.fstat(custody).st_dev != os.fstat(app).st_dev:
                raise RuntimeError("REPLACEMENT_CROSS_DEVICE")
            publish(custody, "intent.json", r["intentText"].encode())
            custody_identity = ident(os.fstat(custody))
            check(profile, name, custody_identity)
            b["recheck_parent"](r, home, apps)
            publish(state, "installed-replacement.pending", r["intentText"].encode())
            exclusive(profile, name, apps, name)
            check(apps, name, custody_identity)
            locks(updates)
            check(apps, "Farol.app", s["appIdentity"])
            exclusive(apps, "Farol.app", custody, "previous.app")
            check(custody, "previous.app", s["appIdentity"])
            locks(updates)
            check(baseline_parent, baseline_name, s["receiptIdentity"])
            if hashlib.sha256(bytes_at(baseline_parent, baseline_name)).hexdigest() != s["receiptSha256"]:
                raise RuntimeError("REPLACEMENT_RECEIPT_CHANGED")
            if not adopted:
                exclusive(apps, "Farol.app.receipt.json", custody, "previous.receipt.json")
                if hashlib.sha256(bytes_at(custody, "previous.receipt.json")).hexdigest() != s["receiptSha256"]:
                    raise RuntimeError("REPLACEMENT_RECEIPT_CHANGED")
            exclusive(profile, "installed-updates", custody, "installed-updates")
            check(custody, "installed-updates", s["updaterIdentity"])
            locks(updates)
            if updater(updates) != s["updater"]:
                raise RuntimeError("REPLACEMENT_UPDATER_CHANGED")
            return {"custodyIdentity": ident(os.fstat(custody)), "pendingIdentity": ident(os.stat("installed-replacement.pending", dir_fd=state, follow_symlinks=False))}
        b["recheck_parent"](r, home, apps)
        custody = b["open_directory"](apps, name)
        opened.append(custody)
        private(custody)
        check(apps, name, r["custodyIdentity"])
        updates = b["open_directory"](custody, "installed-updates")
        opened.append(updates)
        baseline_parent, baseline_name = (updates, "adopted-baseline.json") if adopted else (custody, "previous.receipt.json")
        locks(updates)
        check(state, "installed-replacement.pending", r["pendingIdentity"])
        check(custody, "previous.app", s["appIdentity"])
        previous = b["open_directory"](custody, "previous.app")
        opened.append(previous)
        if b["digest_tree"](previous) != s["appSha256"]:
            raise RuntimeError("REPLACEMENT_PREVIOUS_APP_CHANGED")
        check(custody, "installed-updates", s["updaterIdentity"])
        check(baseline_parent, baseline_name, s["receiptIdentity"])
        if updater(updates) != s["updater"] or hashlib.sha256(bytes_at(baseline_parent, baseline_name)).hexdigest() != s["receiptSha256"] or bytes_at(state, "installed-replacement.pending") != r["intentText"].encode():
            raise RuntimeError("REPLACEMENT_CUSTODY_CHANGED")
        new_receipt = ident(os.stat("Farol.app.receipt.json", dir_fd=apps, follow_symlinks=False))
        if hashlib.sha256(bytes_at(apps, "Farol.app.receipt.json")).hexdigest() != r["newReceiptSha256"]:
            raise RuntimeError("REPLACEMENT_NEW_RECEIPT_CHANGED")
        app = b["open_directory"](apps, "Farol.app")
        opened.append(app)
        new_app = ident(os.fstat(app))
        if b["digest_tree"](app) != r["candidateSha256"]:
            raise RuntimeError("REPLACEMENT_NEW_APP_CHANGED")

        def recheck_completion_names():
            # A held digest is not proof that the shared named slot stayed put.
            b["recheck_parent"](r, home, apps)
            check(apps, name, r["custodyIdentity"])
            check(custody, "previous.app", s["appIdentity"])
            check(baseline_parent, baseline_name, s["receiptIdentity"])
            check(custody, "installed-updates", s["updaterIdentity"])
            check(apps, "Farol.app", new_app)
            check(apps, "Farol.app.receipt.json", new_receipt)
            if hashlib.sha256(bytes_at(apps, "Farol.app.receipt.json")).hexdigest() != r["newReceiptSha256"]:
                raise RuntimeError("REPLACEMENT_NEW_RECEIPT_CHANGED")
            if hashlib.sha256(bytes_at(baseline_parent, baseline_name)).hexdigest() != s["receiptSha256"] or updater(updates) != s["updater"]:
                raise RuntimeError("REPLACEMENT_CUSTODY_CHANGED")

        recheck_completion_names()
        publish(custody, "completed.json", r["completionText"].encode())
        locks(updates)
        recheck_completion_names()
        check(state, "installed-replacement.pending", r["pendingIdentity"])
        # Retirement is last. An unknown post-rename fsync/readback is fenced
        # by one exclusive NEW marker, never rollback or retry of the transition.
        try:
            exclusive(state, "installed-replacement.pending", custody, "completed-intent.json")
            if bytes_at(custody, "completed-intent.json") != r["intentText"].encode():
                raise RuntimeError("REPLACEMENT_COMPLETION_UNKNOWN")
            recheck_completion_names()
        except BaseException as original:
            try:
                publish(state, "installed-replacement.pending", b'{"schema":"farol.installed-replacement-unknown/1"}\n')
            except FileExistsError:
                pass
            except BaseException:
                raise RuntimeError("REPLACEMENT_COMPLETION_AND_FENCE_UNKNOWN") from original
            raise
        return {"completed": True}
    finally:
        for fd in reversed(opened):
            os.close(fd)


try:
    result = run(json.loads(bounded(3, 4 * 1024 * 1024)))
    os.write(1, (json.dumps(result, separators=(",", ":")) + "\n").encode())
except BaseException as error:
    # Public classified failure only; no paths, metadata or private record bytes.
    message = str(error)
    os.write(2, ((message if re.fullmatch(r"REPLACEMENT_[A-Z_]+", message) else "REPLACEMENT_NATIVE_REFUSED_OR_UNKNOWN") + "\n").encode())
    raise SystemExit(1)
