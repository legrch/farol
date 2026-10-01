"""Explicit closed migration of obsolete NEW install bindings, not an update.

Uses the separately attested closed-repair descriptor library. Never invokes its
apply/rollback entrypoint, consumes a download, edits an old receipt, signals a
process, copies a profile or writes a successful Quit. All moves are reversible.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import types


def bounded_input(fd):
    raw = bytearray()
    while len(raw) <= 65536:
        chunk = os.read(fd, min(8192, 65537 - len(raw)))
        if not chunk:
            break
        raw.extend(chunk)
    if not raw or len(raw) > 65536:
        raise ValueError("INPUT_INVALID")
    return bytes(raw)


# fd7 contains verified library bytes supplied by the same pinned host launcher.
# A non-main module name excludes the historical repair entrypoint completely.
library = {"__name__": "farol_closed_repair_library"}
exec(compile(bounded_input(7), "<verified-closed-repair>", "exec"), library)
b = types.SimpleNamespace(**library)
SCHEMA = "farol.preview-retirement/1"


def private_directory(parent, name):
    fd = b.open_directory(parent, name)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(fd)
        b.refuse("RETIREMENT_DIRECTORY_UNSAFE")
    return fd


def run(request):
    b.shape(request, "schema home action operationId expectedPreview targetBuildId closedRecoveryId hook")
    if request["schema"] != SCHEMA or request["action"] not in ("retire", "restore"):
        b.refuse("RETIREMENT_INPUT_INVALID")
    for key, length in (("operationId", 32), ("expectedPreview", 64), ("targetBuildId", 64)):
        b.hex_value(request[key], length)
    if request["closedRecoveryId"] is not None and not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", request["closedRecoveryId"]):
        b.refuse("RETIREMENT_INPUT_INVALID")
    if request["hook"] not in (None, "parent_opened", "updates_moved", "preview_moved", "journal_moved"):
        b.refuse("RETIREMENT_INPUT_INVALID")
    home = request["home"]
    b.components(home)
    user_data = home + "/Library/Application Support/Farol Next Preview"
    locations = (home + "/Applications", user_data, user_data + "/farol-next-state")
    descriptors = [b.open_absolute_directory(p) for p in locations]
    applications, profile, state = descriptors
    locks = []
    history = None
    try:
        for fd in (profile, state):
            if stat.S_IMODE(os.fstat(fd).st_mode) & 0o077:
                b.refuse("RETIREMENT_DIRECTORY_UNSAFE")
        op = request["operationId"]
        history_name = ".farol-preview-retirement-" + op
        updates_name = "installed-updates-retired-" + op
        entries = [(profile, "installed-updates", profile, updates_name),
                   (applications, b.APP_NAME, None, b.APP_NAME),
                   (applications, b.NORMAL_RECEIPT, None, b.NORMAL_RECEIPT),
                   (applications, b.REPAIR_RECEIPT, None, b.REPAIR_RECEIPT),
                   (applications, b.JOURNAL, None, b.JOURNAL)]

        def guard():
            for location, fd in zip(locations, descriptors):
                reopened = b.open_absolute_directory(location)
                try:
                    if b.identity(os.fstat(fd)) != b.identity(os.fstat(reopened)):
                        b.refuse("RETIREMENT_PARENT_CHANGED")
                finally:
                    os.close(reopened)
            if history is not None:
                reopened = private_directory(applications, history_name)
                try:
                    if b.identity(os.fstat(reopened)) != b.identity(os.fstat(history)):
                        b.refuse("RETIREMENT_PARENT_CHANGED")
                finally:
                    os.close(reopened)
            b.lease_check(state)
            # Farol.app is handled by the normal installer, never overwritten
            # here. Its predecessor (including V0) must already be preserved.
            for name in ("Farol.app", "Farol.app.receipt.json", "Farol.app.repair.json"):
                if b.present(applications, name) is not None:
                    b.refuse("RETIREMENT_PRODUCT_SLOT_OCCUPIED")
            if b.present(state, "running.json") is not None:
                b.refuse("RETIREMENT_APP_NOT_CLOSED")
            quit_raw = b.read_private(state, "last-quit.json", 8192, optional=True)
            if quit_raw is not None:
                quit_record = b.strict_json(quit_raw)
                b.shape(quit_record, "schema at drained unconfirmed")
                b.canonical_at(quit_record["at"])
                if type(quit_record["schema"]) is not int or quit_record["schema"] != 1 or quit_record["drained"] is not True or quit_record["unconfirmed"] != []:
                    b.refuse("RETIREMENT_QUIT_UNCONFIRMED")
            else:
                if request["closedRecoveryId"] is None:
                    b.refuse("RETIREMENT_CLOSED_RECOVERY_REQUIRED")
                recovery = private_directory(state, "closed-recovery-" + request["closedRecoveryId"])
                try:
                    record = b.read_json(recovery, "completed.json")
                    b.shape(record, "schema operationId expectedRunSha256 expectedQuitSha256 phase retainedShellReservations")
                    if record["schema"] != "farol.closed-computer-recovery/1" or record["operationId"] != request["closedRecoveryId"] or record["phase"] != "retired_unconfirmed":
                        b.refuse("RETIREMENT_CLOSED_RECOVERY_INVALID")
                    if type(record["retainedShellReservations"]) is not int or not 0 <= record["retainedShellReservations"] <= 4096:
                        b.refuse("RETIREMENT_CLOSED_RECOVERY_INVALID")
                    for file, key in (("running.json", "expectedRunSha256"), ("last-quit.json", "expectedQuitSha256")):
                        b.hex_value(record[key], 64)
                        if hashlib.sha256(b.read_private(recovery, file, 8192)).hexdigest() != record[key]:
                            b.refuse("RETIREMENT_CLOSED_RECOVERY_CHANGED")
                    failure = b.read_json(recovery, "last-quit.json")
                    b.shape(failure, "schema at drained unconfirmed")
                    b.canonical_at(failure["at"])
                    if type(failure["schema"]) is not int or failure["schema"] != 1 or failure["drained"] is not False or failure["unconfirmed"] != ["connector"]:
                        b.refuse("RETIREMENT_CLOSED_RECOVERY_INVALID")
                finally:
                    os.close(recovery)
            b.native_check(state, locks)
            # This one-time route is conservative: a remote task or mutation
            # journal needs its owning live reconciliation, never archive it.
            parent = state
            opened = []
            try:
                for name in ("secure-mcp-connector", "computer-authority"):
                    if b.present(parent, name) is None:
                        break
                    parent = private_directory(parent, name)
                    opened.append(parent)
                else:
                    for name in ("mutations", "codex-task-journal", "claude-task-journal", "mcp-lifecycle"):
                        if b.present(parent, name) is None:
                            continue
                        child = private_directory(parent, name)
                        try:
                            names = b.sorted_names(child)
                            if name == "mcp-lifecycle":
                                if any(s.startswith(("active-", "reconciling-", "shell-fence-")) for s in names):
                                    b.refuse("RETIREMENT_NATIVE_WORK_UNCONFIRMED")
                            elif names:
                                b.refuse("RETIREMENT_NATIVE_JOURNAL_UNCONFIRMED")
                        finally:
                            os.close(child)
            finally:
                for fd in reversed(opened):
                    os.close(fd)
            try:
                table = subprocess.run(["/bin/ps", "-ww", "-axo", "command="], check=True, capture_output=True, timeout=5,
                                       env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}).stdout
                if not table.strip() or len(table) > 4 * 1024 * 1024 or os.fsencode(user_data) in table or os.fsencode(home + "/Applications/" + b.APP_NAME + "/") in table:
                    b.refuse("RETIREMENT_PROCESS_UNVERIFIED")
            except (OSError, subprocess.SubprocessError):
                b.refuse("RETIREMENT_PROCESS_UNVERIFIED")

        def hook(phase):
            if phase is not None and request["hook"] == phase:
                os.write(4, b"R")
                if os.read(5, 1) != b"C":
                    b.refuse("RETIREMENT_TEST_INTERRUPTION")

        guard()
        hook("parent_opened")
        guard()
        existing = b.present(applications, history_name)
        if existing is None:
            if request["action"] == "restore":
                b.refuse("RETIREMENT_RESTORE_HISTORY_REQUIRED")
            os.mkdir(history_name, 0o700, dir_fd=applications)
            os.fsync(applications)
        history = private_directory(applications, history_name)
        entries = [(a, n, history if d is None else d, t) for a, n, d, t in entries]

        def select(entry):
            a, name, destination, target = entry
            source = b.present(a, name)
            saved = b.present(destination, target)
            if (source is None) == (saved is None):
                b.refuse("RETIREMENT_PAIR_CHANGED")
            return (a, name, source) if source is not None else (destination, target, saved)

        # Genuine old repair chain, including exact predecessor/quarantine,
        # remains anchored before and after each rename. No fresh repair apply.
        def anchor():
            preview_fd, preview_name, _ = select(entries[1])
            actual, metadata, target_inode = b.measured(preview_fd, preview_name)
            if actual["digest"] != request["expectedPreview"]:
                b.refuse("RETIREMENT_PREDECESSOR_CHANGED")
            repair_fd, repair_name, _ = select(entries[3])
            receipt = b.repair_receipt(b.read_json(repair_fd, repair_name), home, user_data)
            journal_fd, journal_name, _ = select(entries[4])
            journal = b.read_json(journal_fd, journal_name)
            b.shape(journal, "schema phase receipt sourceInode targetInode updatesInode")
            if journal["schema"] != "farol.next.closed-repair-journal/1" or journal["phase"] != "installed" or receipt["phase"] != "installed" or journal["receipt"] != receipt or journal["targetInode"] != target_inode or receipt["target"] != actual or receipt["sourceCommit"] != metadata["sourceCommit"] or receipt["sourceTreeDigest"] != metadata["sourceTreeDigest"]:
                b.refuse("RETIREMENT_REPAIR_UNCONFIRMED")
            prior = private_directory(applications, ".farol-repair-" + receipt["operationId"])
            try:
                companion, companion_metadata, source_inode = b.measured(prior, "previous.app")
            finally:
                os.close(prior)
            normal_fd, _, _ = select(entries[2])
            b.normal_anchor(normal_fd, home, user_data, companion, companion_metadata)
            if companion != receipt["source"] or journal["sourceInode"] != source_inode or receipt["quarantined"] != (journal["updatesInode"] is not None):
                b.refuse("RETIREMENT_REPAIR_UNCONFIRMED")
            if journal["updatesInode"] is not None:
                quarantine = private_directory(profile, "installed-updates-quarantine-" + receipt["operationId"])
                try:
                    if journal["updatesInode"] != [os.fstat(quarantine).st_dev, os.fstat(quarantine).st_ino]:
                        b.refuse("RETIREMENT_REPAIR_UNCONFIRMED")
                finally:
                    os.close(quarantine)

        def old_updates():
            source, name, _ = select(entries[0])
            updates = private_directory(source, name)
            try:
                names = b.sorted_names(updates)
                ready = b.read_json(updates, "ready.json")
                required = {"schema", "handle", "manifest", "operation", "downloadId"}
                optional = {"preparation", "helper", "archiveReleased"}
                if not isinstance(ready, dict) or not required <= set(ready) or not set(ready) <= required | optional or ready["schema"] != "farol.ready-update/1" or not isinstance(ready["manifest"], dict):
                    b.refuse("RETIREMENT_DOWNLOAD_METADATA_INVALID")
                if ready["operation"] is not None or ready.get("preparation") is not None or ready.get("helper") is not None or ready.get("archiveReleased", False) is not False:
                    b.refuse("RETIREMENT_UPDATE_OPERATION_PENDING")
                b.hex_value(ready["downloadId"], 32)
                b.components(ready["handle"])
                expected_parent = user_data + "/installed-updates/download-" + ready["downloadId"] + "/github-updates"
                if os.path.dirname(ready["handle"]) != expected_parent or not re.fullmatch(r"[0-9a-f-]{36}\.zip", os.path.basename(ready["handle"])) or set(names) != {"ready.json", "download-" + ready["downloadId"]}:
                    b.refuse("RETIREMENT_UPDATE_OPERATION_PENDING")
                download = private_directory(updates, "download-" + ready["downloadId"])
                os.close(download)
                # Retain the entire uncertain tree by inode. No archive/package
                # read, deletion, extraction, linkage fabrication or replay.
            finally:
                os.close(updates)

        anchor()
        old_updates()
        prepared = b.read_json(history, "prepared.json", optional=True)
        if prepared is None:
            if b.sorted_names(history):
                b.refuse("RETIREMENT_HISTORY_UNCONFIRMED")
            prepared = {"schema": SCHEMA, "operationId": op, "previewDigest": request["expectedPreview"], "targetBuildId": request["targetBuildId"], "entries": []}
            for entry in entries:
                fd, name, info = select(entry)
                record = {"name": entry[1], "inode": [info.st_dev, info.st_ino]}
                if stat.S_ISREG(info.st_mode):
                    record["sha256"] = hashlib.sha256(b.read_private(fd, name)).hexdigest()
                prepared["entries"].append(record)
            b.publish(history, "prepared.json", prepared)
        b.shape(prepared, "schema operationId previewDigest targetBuildId entries")
        if prepared["schema"] != SCHEMA or prepared["operationId"] != op or prepared["previewDigest"] != request["expectedPreview"] or prepared["targetBuildId"] != request["targetBuildId"] or len(prepared["entries"]) != len(entries):
            b.refuse("RETIREMENT_HISTORY_CHANGED")
        allowed = {"prepared.json", "phase.json", *(e[1] for e in entries[1:])}
        if not set(b.sorted_names(history)) <= allowed:
            b.refuse("RETIREMENT_HISTORY_UNCONFIRMED")
        phase = b.read_json(history, "phase.json", optional=True)
        if phase is not None:
            b.shape(phase, "schema operationId phase")
            if phase["schema"] != SCHEMA or phase["operationId"] != op or phase["phase"] not in ("retired", "restoring", "restored") or (request["action"] == "retire" and phase["phase"] != "retired"):
                b.refuse("RETIREMENT_PHASE_CHANGED")
        if request["action"] == "restore":
            b.publish(history, "phase.json", {"schema": SCHEMA, "operationId": op, "phase": "restoring"})
        sequence = list(enumerate(entries))
        if request["action"] == "restore":
            sequence.reverse()
        for index, entry in sequence:
            guard()
            anchor()
            old_updates()
            fd, name, info = select(entry)
            expected = prepared["entries"][index]
            b.shape(expected, "name inode" + (" sha256" if "sha256" in expected else ""))
            if expected["name"] != entry[1] or expected["inode"] != [info.st_dev, info.st_ino] or ("sha256" in expected and hashlib.sha256(b.read_private(fd, name)).hexdigest() != expected["sha256"]):
                b.refuse("RETIREMENT_PAIR_CHANGED")
            a, original, destination, target = entry
            wanted_fd, wanted_name = (destination, target) if request["action"] == "retire" else (a, original)
            if (fd, name) != (wanted_fd, wanted_name):
                os.rename(name, wanted_name, src_dir_fd=fd, dst_dir_fd=wanted_fd)
                os.fsync(fd)
                os.fsync(wanted_fd)
            if request["action"] == "retire":
                hook({0: "updates_moved", 1: "preview_moved", 4: "journal_moved"}.get(index))
        guard()
        anchor()
        old_updates()
        final = "retired" if request["action"] == "retire" else "restored"
        b.publish(history, "phase.json", {"schema": SCHEMA, "operationId": op, "phase": final})
        return {"schema": SCHEMA, "operationId": op, "phase": final, "history": locations[0] + "/" + history_name,
                "retainedUpdates": user_data + "/" + updates_name, "previewDigest": request["expectedPreview"],
                "downloadOutcome": "unconfirmed_not_replayed", "installation": "not_performed"}
    finally:
        for fd in reversed(locks):
            os.close(fd)
        if history is not None:
            os.close(history)
        for fd in reversed(descriptors):
            os.close(fd)


try:
    result = run(b.strict_json(bounded_input(3)))
    print(json.dumps(result, separators=(",", ":")))
except b.Refusal as error:
    print(json.dumps({"schema": SCHEMA, "code": str(error)}))
    sys.exit(1)
except (OSError, ValueError, TypeError, KeyError):
    print(json.dumps({"schema": SCHEMA, "code": "RETIREMENT_OUTCOME_UNCONFIRMED"}))
    sys.exit(1)
