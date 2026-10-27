"""Isolated, opt-in Linux source-gate pilot; existing root CI stays authoritative."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dag import Budget, Job, Outcome, run, Blocked
from volumes import locked as volume_lock
from testops import identity
from gate_observer import COMMANDS, TOOLS, evidence_file, validate_stage_logs, natural_retirement
from dependency_seal import ALGORITHM, reference
from deadline import JOB_SECONDS

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "node@sha256:e929171d35b9df7773a3ec5b068e387fa109441dc90f91e6560af5d39b7e9bf1"
LABEL = "farol.testops.task"


def host_record(directory, name, value):
    """Create one host-owned record without replacing or following a destination."""
    if (not re.fullmatch(r"[a-z0-9-]+\.json", name) or not directory.is_absolute()
            or directory.resolve(strict=True) != directory):
        raise Blocked("PHYSICAL_HOST_RECORD_DIRECTORY_REQUIRED")
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
            raise Blocked("PRIVATE_HOST_RECORD_DIRECTORY_REQUIRED")
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=descriptor)
        with os.fdopen(fd, "w") as output:
            output.write(json.dumps(value, indent=2) + "\n")
    finally:
        os.close(descriptor)


def wait_container(child, job, name, directory, options, docker, stop, deadline_hit, engine):
    """Retain the original child even if cleanup or evidence persistence fails."""
    try:
        return child.wait(timeout=JOB_SECONDS[job.id] + 120), False
    except subprocess.TimeoutExpired:
        deadline_hit.set()
        stop.set()
        evidence = {"schema": 1, "container": name, "status": "DEADLINE_EXCEEDED",
                    "originalDockerPid": child.pid, "timeoutSeconds": JOB_SECONDS[job.id] + 120}
        try:
            host_record(directory, "original-docker-deadline.json", evidence)
            cidfile = directory / (".original-container-" + job.id + ".cid")
            docker.stop_owned_after_deadline(cidfile, name, options.scope, directory, engine)
            return child.wait(timeout=30), True
        except Exception as error:
            # Never repeat an unknown/denied cleanup effect. This second record
            # cannot overwrite the original deadline, and a failed write must
            # not release custody of the original process.
            evidence.update(status="UNKNOWN_DRAINING_ORIGINAL", error=type(error).__name__)
            try:
                host_record(directory, "original-docker-draining.json", evidence)
            finally:
                code = child.wait()
            return code, True
    finally:
        if child.returncode is None:
            child.wait()


def memory_events_closed(raw):
    if not isinstance(raw, str):
        return False
    values = {}
    allowed = {"low", "high", "max", "oom", "oom_kill", "oom_group_kill", "sock_throttled"}
    for line in raw.splitlines():
        row = line.split()
        if len(row) != 2 or row[0] not in allowed or row[0] in values or not re.fullmatch(r"0|[1-9][0-9]*", row[1]):
            return False
        values[row[0]] = int(row[1])
    return ({"low", "high", "max", "oom", "oom_kill"} <= set(values)
            and all(value == 0 for key, value in values.items() if key.startswith("oom")))


def job_file(directory, relative):
    try:
        return evidence_file(directory, relative)
    except ValueError as error:
        raise Blocked(str(error)) from error
    except OSError as error:
        raise Blocked("PHYSICAL_JOB_EVIDENCE_FILE_REQUIRED") from error


def receipt(job, report, source, directory):
    dependencies = source.get("dependencyTree", {})
    if (not isinstance(dependencies, dict) or dependencies.get("algorithm") != ALGORITHM
            or not re.fullmatch(r"[a-f0-9]{64}", str(dependencies.get("treeSha256", "")))
            or not re.fullmatch(r"[a-f0-9]{64}", str(source.get("dependencyReferenceSha256", "")))
            or type(dependencies.get("files")) is not int or dependencies["files"] <= 0
            or type(dependencies.get("logicalBytes")) is not int or dependencies["logicalBytes"] < 0):
        raise Blocked("DEPENDENCY_BINDING_REQUIRED")
    if (not isinstance(report, dict) or type(report.get("schema")) is not int or report.get("schema") != 1
            or report.get("id") != job.id or report.get("source") != source
            or report.get("sourceAfter") != source or report.get("commands") != COMMANDS[job.id]
            or report.get("complete") is not True or report.get("status") != "PASS"
            or report.get("terminal") is not True or type(report.get("exitCode")) is not int
            or report["exitCode"] != 0 or report.get("descendantsDrained") is not True
            or report.get("deadlineSeconds") != JOB_SECONDS[job.id] or report.get("timedOut") is not False
            or report.get("toolHashes") != TOOLS
            or len(report.get("stages", [])) != len(COMMANDS[job.id])):
        raise Blocked("ORIGINAL_COMPLETE_JOB_REPORT_REQUIRED")
    if not natural_retirement(report.get("descendantRetirement")):
        raise Blocked("ORIGINAL_DESCENDANT_RETIREMENT_REQUIRED")
    for stage, command in zip(report["stages"], COMMANDS[job.id]):
        if (stage.get("command") != command or type(stage.get("exitCode")) is not int
                or stage["exitCode"] != 0 or stage.get("terminal") is not True):
            raise Blocked("ORIGINAL_STAGE_REPORT_REQUIRED")
    try:
        validate_stage_logs(report["stages"], directory)
    except (ValueError, OSError) as error:
        raise Blocked(str(error)) from error
    cgroup = report.get("cgroup", {})
    if (cgroup.get("memory.max") != str(3072 * 1024 * 1024)
            or cgroup.get("cpu.max") != "200000 100000"
            or cgroup.get("pids.max") != "256"
            or not memory_events_closed(cgroup.get("memory.events"))):
        raise Blocked("CONTAINER_RESOURCE_CAP_OR_OOM_MISMATCH")
    if job.id == "checks-source" and not report.get("cloud"):
        raise Blocked("CLOUD_REPORT_REQUIRED")
    if job.id == "checks-source":
        cloud = report["cloud"]
        relative = Path(cloud.get("path", ""))
        if (relative.is_absolute() or relative.parts[:3] != ("_output", "evidence", "test-scopes")
                or ".." in relative.parts or len(relative.parts) != 5):
            raise Blocked("CLOUD_REPORT_PATH_INVALID")
        try:
            data = job_file(directory, Path(*relative.parts[1:]))
        except (Blocked, OSError) as error:
            raise Blocked("ORIGINAL_CLOUD_REPORT_MISSING_OR_CHANGED") from error
        if hashlib.sha256(data).hexdigest() != cloud.get("sha256"):
            raise Blocked("ORIGINAL_CLOUD_REPORT_MISSING_OR_CHANGED")
    if job.id == "pilot-selftests" and any(type(s.get("casesPassed")) is not int or s["casesPassed"] <= 0 for s in report["stages"]):
        raise Blocked("SELFTEST_CASE_REPORT_REQUIRED")
    return {"schema": 1, "id": job.id, "source": source, "exitCode": 0, "complete": True,
            "originalReportSha256": hashlib.sha256(job_file(directory, "job-report.json")).hexdigest(),
            "originalReport": report}


class Docker:
    def __init__(self, binary, socket, config):
        if not binary.is_absolute() or not binary.is_file():
            raise Blocked("EXPLICIT_DOCKER_EXECUTABLE_REQUIRED")
        socket = socket.resolve(strict=True)
        if not socket.is_absolute() or not stat.S_ISSOCK(socket.stat().st_mode):
            raise Blocked("EXPLICIT_LOCAL_UNIX_DOCKER_SOCKET_REQUIRED")
        self.prefix = [str(binary), "--config", str(config), "--host", "unix://" + str(socket)]
        self.config = config
        self.env = {"PATH": "/usr/bin:/bin", "HOME": "/var/empty", "LANG": "C", "LC_ALL": "C"}

    def read(self, *args):
        return subprocess.check_output(self.prefix + list(args), env=self.env, stdin=subprocess.DEVNULL, timeout=15)

    def engine(self):
        template = ('{"ID":{{json .ID}},"OSType":{{json .OSType}},'
                    '"Architecture":{{json .Architecture}},"NCPU":{{json .NCPU}},'
                    '"MemTotal":{{json .MemTotal}},"ServerVersion":{{json .ServerVersion}}}')
        value = json.loads(self.read("info", "--format", template))
        if (value.get("OSType") != "linux" or value.get("Architecture") not in {"aarch64", "arm64"}
                or value.get("NCPU", 0) < 4 or value.get("MemTotal", 0) < 8 * 1024**3):
            raise Blocked("SUPPORTED_LOCAL_LINUX_CAPACITY_REQUIRED")
        return {"idSha256": hashlib.sha256(value["ID"].encode()).hexdigest(),
                "os": value["OSType"], "arch": value["Architecture"],
                "cpus": value["NCPU"], "memoryBytes": value["MemTotal"], "version": value["ServerVersion"]}

    def volume(self, name, scope, source=None):
        if not re.fullmatch(re.escape(scope) + r"-[a-z0-9-]{1,64}", name):
            raise Blocked("VOLUME_OUTSIDE_OWNED_SCOPE")
        values = json.loads(self.read("volume", "inspect", name))
        if (len(values) != 1 or values[0].get("Labels", {}).get(LABEL) != scope.removeprefix("farol-testops-")
                or values[0].get("Driver") != "local" or values[0].get("Options")):
            raise Blocked("OWNED_VOLUME_LABEL_REQUIRED")
        if source and values[0].get("Labels", {}).get("farol.testops.source") != source:
            raise Blocked("FROZEN_SOURCE_VOLUME_LABEL_REQUIRED")

    def require_engine(self, expected):
        if not isinstance(expected, dict) or not expected or self.engine() != expected:
            raise Blocked("ENGINE_IDENTITY_CHANGED")

    def removed(self, name, directory, engine):
        self.require_engine(engine)
        result = subprocess.run(self.prefix + ["container", "inspect", "--format", "{{json .State}}", name], env=self.env,
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        record = {"schema": 1, "container": name, "exitCode": result.returncode,
                  "stdout": result.stdout.decode(), "stderr": result.stderr.decode(), "engine": engine}
        host_record(directory, "original-container-retirement.json", record)
        self.require_engine(engine)
        return container_absent(record, name)

    def stop_owned_after_deadline(self, cidfile, name, scope, directory, engine):
        self.require_engine(engine)
        # CID evidence is outside the container's writable bind. Never stop by
        # a guessed PID, port, image, project prefix or unverified container name.
        if cidfile.is_symlink() or not cidfile.is_file() or cidfile.stat().st_size > 128:
            raise Blocked("ORIGINAL_CONTAINER_ID_UNCONFIRMED")
        cid = cidfile.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", cid):
            raise Blocked("ORIGINAL_CONTAINER_ID_INVALID")
        template = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},'
                    '"User":{{json .Config.User}},"NetworkMode":{{json .HostConfig.NetworkMode}},'
                    '"PidMode":{{json .HostConfig.PidMode}},"Privileged":{{json .HostConfig.Privileged}},'
                    '"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}}}')
        result = subprocess.run(self.prefix + ["container", "inspect", "--format", template, cid],
                                env=self.env, stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        record = {"container": cid, "exitCode": result.returncode,
                  "stdout": result.stdout.decode(), "stderr": result.stderr.decode()}
        host_record(directory, "deadline-container-readback.json", record)
        self.require_engine(engine)
        if container_absent(record, cid):
            return {"containerId": cid, "alreadyAbsent": True}
        if result.returncode != 0:
            raise Blocked("DEADLINE_CONTAINER_READBACK_UNCONFIRMED")
        state = json.loads(result.stdout)
        validate_disposable_container(state, cid, name, scope)
        self.require_engine(engine)
        stopped = subprocess.run(self.prefix + ["stop", "--time", "5", cid], env=self.env,
                                 stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        record = {"containerId": cid, "exitCode": stopped.returncode,
                  "stdout": stopped.stdout.decode(), "stderr": stopped.stderr.decode()}
        host_record(directory, "deadline-container-stop.json", record)
        self.require_engine(engine)
        if stopped.returncode != 0 and not container_absent(
                {"container": cid, **record}, cid):
            raise Blocked("DEADLINE_CONTAINER_STOP_UNCONFIRMED")
        return {"containerId": cid, "alreadyAbsent": False}


def container_absent(record, name):
    return (type(record.get("exitCode")) is int and record["exitCode"] == 1
            and record.get("container") == name and record.get("stdout", "").strip() in {"", "[]"}
            and record.get("stderr", "").strip() in {
                "Error: No such object: " + name, "Error: No such container: " + name,
                "Error response from daemon: No such container: " + name})


def validate_disposable_container(value, cid, name, scope):
    if (not isinstance(value, dict) or value.get("Id") != cid or value.get("Name") != "/" + name
            or (value.get("Labels") or {}).get(LABEL) != scope.removeprefix("farol-testops-")
            or value.get("User") != "501:20" or value.get("NetworkMode") != "none"
            or value.get("PidMode") != "" or value.get("Privileged") is not False
            or value.get("ReadonlyRootfs") is not True):
        raise Blocked("DEADLINE_CLEANUP_OWNERSHIP_OR_ISOLATION_UNCONFIRMED")


def container_command(job, directory, source, options, docker, nonce, *, dependency_volume=None):
    name = options.scope + "-" + nonce + "-" + job.id
    args = ["run", "--rm", "--pull", "never", "--platform", "linux/arm64", "--sig-proxy=false",
            "--cidfile", str(directory.parent / (".original-container-" + job.id + ".cid")),
            "--name", name, "--label", LABEL + "=" + options.scope.removeprefix("farol-testops-"),
            "--network", "none", "--cpus", "2", "--memory", "3072m", "--pids-limit", "256",
            "--user", "501:20", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--mount", f"type=volume,source={options.source_volume},target=/workspace,readonly",
            "--mount", f"type=volume,source={options.seed_volume},target=/testops-seed,readonly",
            "--mount", f"type=volume,source={options.sdk_volume},target=/usr/local/go,readonly",
            "--mount", f"type=bind,source={directory},target=/workspace/_output",
            "--mount", f"type=bind,source={docker.config / 'passwd'},target=/etc/passwd,readonly",
            "--mount", f"type=bind,source={docker.config / 'group'},target=/etc/group,readonly",
            "--mount", f"type=bind,source={docker.config / 'bin'},target=/testops-bin,readonly",
            "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777",
            "--tmpfs", "/workspace/node_modules/.vite-temp:rw,nosuid,nodev,size=128m,mode=1777",
            "--tmpfs", "/workspace/node_modules/.vite:rw,nosuid,nodev,size=256m,mode=1777",
            "--workdir", "/workspace"]
    if dependency_volume is not None:
        if not re.fullmatch(re.escape(options.scope) + r"-[a-z0-9-]{1,64}", dependency_volume):
            raise Blocked("DEPENDENCY_VOLUME_OUTSIDE_OWNED_SCOPE")
        args += ["--mount", "type=volume,source=" + dependency_volume +
                 ",target=/workspace/node_modules,readonly,volume-nocopy,volume-subpath=node_modules"]
    environment = {"HOME": "/tmp/testops-home", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0",
                   "npm_config_cache": "/workspace/_output/npm-cache", "npm_config_update_notifier": "false",
                   "GOROOT": "/usr/local/go", "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOSUMDB": "off",
                   "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin:/testops-bin",
                   "GOMAXPROCS": "2", "GOFLAGS": "-p=2", "GOPATH": "/workspace/_output/gopath",
                   "GOCACHE": "/workspace/_output/go-build-cache", "GOMODCACHE": "/workspace/_output/go-mod-cache"}
    for key, value in environment.items():
        args += ["--env", key + "=" + value]
    # Each job starts from the same immutable private cache seed, with independent
    # writable copies. Setup is measured, never hidden as free parallel work.
    setup = ('mkdir -p /tmp/testops-home; '
             'if [ "$1" = checks-source ] || [ "$1" = core ]; then '
             'cp -a /testops-seed/testops/go-mod-cache /workspace/_output/go-mod-cache; '
             'cp -a /testops-seed/testops/go-build-cache /workspace/_output/go-build-cache; fi; '
             'exec /usr/bin/python3 -I tooling/testops/gate_observer.py "$1" "$2"')
    args += [IMAGE, "sh", "-ec", setup, "sh", job.id, json.dumps(source, separators=(",", ":"))]
    return name, docker.prefix + args


def execute_container(job, directory, binding, options, docker, nonce, engine, stop, deadline_hit):
    if docker.engine() != engine:
        return Outcome("BLOCKED", True, reason="ENGINE_IDENTITY_CHANGED")
    if stop.is_set():
        return Outcome("BLOCKED", True, reason="CANCELLED_BEFORE_DOCKER")
    inner = directory / "inner"
    inner.mkdir(mode=0o700)
    name, command = container_command(job, inner, binding, options, docker, nonce,
                                      dependency_volume=options.dependency_volume)
    host_record(directory, "docker-command.json", command)
    retired = False
    try:
        with (directory / "docker.stdout.log").open("xb") as stdout, (directory / "docker.stderr.log").open("xb") as stderr:
            if stop.is_set():
                return Outcome("BLOCKED", True, reason="CANCELLED_BEFORE_DOCKER")
            child = subprocess.Popen(command, env=docker.env, stdin=subprocess.DEVNULL,
                                     stdout=stdout, stderr=stderr, start_new_session=True)
            code, timed_out = wait_container(child, job, name, directory, options, docker, stop, deadline_hit, engine)
        host_record(directory, "original-docker-terminal.json",
                    {"schema": 1, "container": name, "exitCode": code, "terminal": True})
        retired = docker.removed(name, directory, engine)
        if not retired:
            return Outcome("UNKNOWN", False, reason="ORIGINAL_CONTAINER_RETIREMENT_UNCONFIRMED")
        if timed_out:
            return Outcome("FAIL", True, reason="ORIGINAL_CONTAINER_DEADLINE_EXCEEDED")
        if code != 0:
            return Outcome("FAIL", True, reason="ORIGINAL_CONTAINER_EXIT:" + str(code))
        report = json.loads(job_file(inner, "job-report.json"))
        validated = receipt(job, report, binding, inner)
        return Outcome("PASS", True, validated)
    except Blocked as error:
        return Outcome("FAIL" if retired else "UNKNOWN", retired, reason=str(error))
    except Exception as error:
        return Outcome("UNKNOWN", False, reason="ORIGINAL_DOCKER_OUTCOME:" + type(error).__name__)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--source-volume", required=True)
    parser.add_argument("--seed-volume", required=True)
    parser.add_argument("--sdk-volume", required=True)
    parser.add_argument("--dependency-volume", help="Optional owned volume with sealed node_modules mounted read-only")
    parser.add_argument("--dependency-reference", type=Path, required=True)
    parser.add_argument("--dependency-reference-sha256", required=True)
    parser.add_argument("--jobs", type=int, choices=(1, 2), required=True)
    parser.add_argument("--output", required=True)
    options = parser.parse_args()
    if type(os.geteuid()) is not int or os.geteuid() != 501:
        raise Blocked("QUALIFIED_HOST_UID_501_REQUIRED")
    if not re.fullmatch(r"farol-testops-[a-f0-9]{8}", options.scope):
        raise Blocked("OWNED_SCOPE_REQUIRED")
    # Only system Git resolves the host source. Docker receives a fresh empty
    # client config, explicit local socket and non-secret environment allowlist.
    os.environ["PATH"] = "/usr/bin:/bin"
    source = identity(ROOT)
    if source["dirty"]:
        raise Blocked("CLEAN_COMMITTED_SOURCE_REQUIRED")
    parent = ROOT / "_output/testops"
    if parent.is_symlink() or not parent.is_dir():
        raise Blocked("OWNED_OUTPUT_PARENT_REQUIRED")
    if (options.dependency_reference.is_symlink()
            or not options.dependency_reference.resolve(strict=True).is_relative_to(parent.resolve(strict=True))):
        raise Blocked("DEPENDENCY_REFERENCE_OUTSIDE_OWNED_EVIDENCE")
    def source_binding():
        declared = reference(options.dependency_reference, options.dependency_reference_sha256,
                             hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest(),
                             IMAGE, TOOLS["/usr/local/bin/node"])
        return {**identity(ROOT), "dependencyReferenceSha256": options.dependency_reference_sha256,
                "dependencyTree": {k: declared[k] for k in ("algorithm", "treeSha256", "files", "logicalBytes")}}
    source = source_binding()
    config = parent / ("docker-client-" + uuid.uuid4().hex)
    config.mkdir(mode=0o700)
    state = {"retain": False}
    try:
        return gate(options, parent, source, source_binding, config, state)
    finally:
        # The private client config is per run, but containers bind-mount it. Keep it
        # while any container's retirement is unconfirmed (unknown-effect evidence).
        # Borrowed volumes are never removed here; see `testops.py volumes`.
        if not state["retain"]:
            shutil.rmtree(config)


def gate(options, parent, source, source_binding, config, state):
    (config / "config.json").write_text("{}\n")
    (config / "passwd").write_text("root:x:0:0:root:/root:/bin/sh\ntestops:x:501:20:TestOps:/tmp/testops-home:/bin/sh\n")
    (config / "group").write_text("root:x:0:\nstaff:x:20:testops\n")
    (config / "bin").mkdir(mode=0o700)
    for tool in ("task", "gitleaks"):
        (config / "bin" / tool).symlink_to("/testops-seed/testops/linux-tools-bootstrap-03/bin/" + tool)
    docker = Docker(options.docker, options.socket, config)
    engine = docker.engine()
    volumes = [options.source_volume, options.seed_volume, options.sdk_volume]
    if options.dependency_volume is not None:
        volumes.append(options.dependency_volume)
    # Admit volumes under the lifecycle lock: a concurrent prune cannot remove
    # them between its check and its rm, and this command line names them after.
    with volume_lock(ROOT, 120):
        for volume in volumes:
            docker.volume(volume, options.scope, source["head"] if volume == options.source_volume else None)
    jobs = [Job(key, cpu=2, memory_mib=3072, effects="owned-fixture") for key in COMMANDS]
    nonce = uuid.uuid4().hex[:12]
    stop = threading.Event()
    deadline_hit = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    def execute(job, directory, binding):
        return execute_container(job, directory, binding, options, docker, nonce, engine, stop, deadline_hit)

    # Until the scheduler reports every container retired, keep the bind-mounted config.
    state["retain"] = True
    result = run(ROOT, jobs, Budget(options.jobs, 4, 6144), "linux", source_binding,
                 execute, options.output, stop)
    state["retain"] = bool(result.get("leaseRetained"))
    result["engine"] = engine
    if deadline_hit.is_set():
        result["schedulerStatus"] = result["status"]
        result["status"] = "UNKNOWN" if result["leaseRetained"] else "FAIL"
        result["stopReason"] = "ORIGINAL_CONTAINER_DEADLINE_EXCEEDED"
    result["cachePolicy"] = "Separate writable copies of the same retained seed; all container/setup time included"
    result["linuxSourceOnly"] = True
    result["dependencyMount"] = ({"volume": options.dependency_volume, "subpath": "node_modules", "readOnly": True}
                                 if options.dependency_volume is not None else None)
    result["nativePackageInstalledAcceptance"] = "NOT_RUN"
    (parent / options.output / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "source": source, "report": str(parent / options.output / "report.json")}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
