#!/usr/bin/env python3
"""Offline, disposable composition; never overlay producer code in a product tree."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile


def git(root, *args):
    environment = os.environ.copy()
    environment.update({"GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"})
    return subprocess.check_output(["git", "-C", str(root), *args], env=environment)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def unpack(root, ref, destination, paths=()):
    raw = git(root, "archive", "--format=tar", ref, *paths)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        archive.extractall(destination, filter="data")


def run(command, root, environment, log, timeout, expected_tests=()):
    try:
        result = subprocess.run(command, cwd=root, env=environment,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                timeout=timeout, check=False)
        raw, status = result.stdout, result.returncode
    except subprocess.TimeoutExpired as error:
        raw, status = (error.stdout or b"") + b"\nWITNESS_TIMEOUT\n", 124
    log.write_bytes(raw)
    receipt = {"command": command, "exit": status, "log_sha256": digest(raw)}
    if expected_tests:
        events = [json.loads(line) for line in raw.splitlines() if line.startswith(b"{")]
        started = {event["Test"] for event in events if event.get("Action") == "run" and "Test" in event}
        passed = {event["Test"] for event in events if event.get("Action") == "pass" and "Test" in event}
        receipt["tests_started"] = sorted(started)
        receipt["tests_passed"] = sorted(passed)
        if not set(expected_tests).issubset(started & passed):
            receipt["exit"] = status or 1
            receipt["failure"] = "Declared witness tests did not all run and pass"
        for event in events:
            print(event.get("Output", ""), end="", flush=True)
    else:
        print(raw.decode("utf-8", errors="replace"), end="", flush=True)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inference-root", type=Path, required=True)
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--context-root", type=Path, required=True)
    parser.add_argument("--inference-ref", required=True)
    parser.add_argument("--pins", default="currentconsumerpins.json",
                        help="Pin asset filename beside this script")
    parser.add_argument("--fixture", default="currentconsumerwitness.go.txt",
                        help="Fixture asset filename beside this script")
    parser.add_argument("--output", type=Path, required=True,
                        help="New disposable directory outside all three input checkouts")
    args = parser.parse_args()
    asset_root = Path(__file__).resolve().parent
    if any(Path(name).name != name for name in (args.pins, args.fixture)):
        raise SystemExit("Use asset filenames, not external paths")
    pin_path = asset_root / args.pins
    pins = json.loads(pin_path.read_text())
    roots = {"inference": args.inference_root.resolve(),
             "models": args.models_root.resolve(), "context": args.context_root.resolve()}
    output = args.output.resolve()
    if any(output == root or output.is_relative_to(root) or root.is_relative_to(output)
           for root in roots.values()):
        raise SystemExit("Assembly must be outside, and must not contain, input checkouts")
    if output.exists():
        raise SystemExit("Output already exists; preserve the original receipt")
    if len(args.inference_ref) != 40 or any(c not in "0123456789abcdef" for c in args.inference_ref):
        raise SystemExit("Use an exact full inference commit")
    if git(roots["inference"], "rev-parse", args.inference_ref + "^{commit}").decode().strip() != args.inference_ref:
        raise SystemExit("Inference commit mismatch")
    # Prove that the input commits exist locally; this script never fetches.
    for lane in ("models", "context"):
        expected = pins[lane]
        actual = git(roots[lane], "rev-parse", expected["commit"] + "^{tree}").decode().strip()
        if actual != expected["tree"]:
            raise SystemExit(lane + " tree mismatch")
        for name, expected_hash in expected["files_sha256"].items():
            if digest(git(roots[lane], "show", expected["commit"] + ":" + name)) != expected_hash:
                raise SystemExit(lane + " file mismatch: " + name)
    output.mkdir(parents=True)
    assembly = output / "assembly"
    assembly.mkdir()
    unpack(roots["inference"], args.inference_ref, assembly)
    for lane in ("models", "context"):
        expected = pins[lane]
        for name in expected["paths"]:
            if (assembly / name).exists():
                raise SystemExit("Producer overlay would replace inference source: " + name)
        unpack(roots[lane], expected["commit"], assembly, expected["paths"])
    fixture = asset_root / args.fixture
    fixture_bytes = fixture.read_bytes()
    test_path = assembly / "modules/chat/infra/clients/planresponses/consumerwitness_test.go"
    test_path.write_bytes(fixture_bytes)
    manifest = {"kind": "offline-controlled-composition-only", "inference_commit": args.inference_ref,
                "inference_tree": git(roots["inference"], "rev-parse", args.inference_ref + "^{tree}").decode().strip(),
                "producers": pins, "script_sha256": digest(Path(__file__).read_bytes()),
                "fixture_sha256": digest(fixture_bytes), "pins_sha256": digest(pin_path.read_bytes()),
                "fixture_asset": args.fixture, "pins_asset": args.pins, "commands": []}
    # Hash all exact assembled Go inputs, not only the displayed producer types.
    manifest["assembled_files_sha256"] = {
        str(path.relative_to(assembly)): digest(path.read_bytes())
        for path in sorted(assembly.rglob("*.go")) if path.is_file()
    }
    for name in ("go.mod", "go.sum"):
        manifest["assembled_files_sha256"][name] = digest((assembly / name).read_bytes())
    environment = os.environ.copy()
    settings = {"GOPROXY": "off", "GOTOOLCHAIN": "local", "GOFLAGS": "",
                "GOWORK": "off", "GOENV": "off", "GOSUMDB": "off"}
    environment.update(settings)
    manifest["tool_settings"] = settings
    expected_tests = re.findall(r"(?m)^func (TestConsumerWitness\w*)\(", fixture_bytes.decode())
    if not expected_tests:
        raise SystemExit("Fixture declares no witness tests")
    manifest["expected_tests"] = expected_tests
    version = subprocess.check_output(["go", "version"], env=environment).decode().strip()
    manifest["go_version"] = version
    if "go1.26.2 " not in version:
        raise SystemExit("Use the declared Go 1.26.2 toolchain")
    package = "./modules/chat/infra/clients/planresponses"
    commands = [(["go", "test", "-json", "-race", "-count=1", "-timeout", "60s", "-run", "^TestConsumerWitness", "-v", package], "test.log", 90, expected_tests),
                (["go", "vet", package], "vet.log", 60, ())]
    for command, name, timeout, tests in commands:
        receipt = run(command, assembly, environment, output / name, timeout, tests)
        manifest["commands"].append(receipt)
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        if receipt["exit"] != 0:
            raise SystemExit(receipt["exit"])
    print("WITNESS_PASS " + digest((output / "manifest.json").read_bytes()))


if __name__ == "__main__":
    main()
