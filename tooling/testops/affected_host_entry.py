"""Fixed container bridge: host identity is data, never a plan or command."""
import json
import re
import sys

sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from affected_run import main
from affected_host import cancellation_state


def entry(argv):
    if len(argv) not in {4, 5} or len(argv) == 5 and argv[4] != "--focused":
        raise ValueError("AFFECTED_HOST_ENTRY_ARGUMENTS")
    if not re.fullmatch(r"[a-f0-9]{12}", argv[3]):
        raise ValueError("AFFECTED_HOST_CONTROL_NONCE_REQUIRED")
    expected = json.loads(argv[1])
    if (not isinstance(expected, dict) or set(expected) != {
            "head", "tree", "workingSourceSha256", "dirty", "trackedAndUntrackedFiles"}
            or expected.get("dirty") is not False
            or any(not re.fullmatch(r"[a-f0-9]{40}", str(expected.get(key, ""))) for key in ("head", "tree"))
            or not re.fullmatch(r"[a-f0-9]{64}", str(expected.get("workingSourceSha256", "")))
            or type(expected.get("trackedAndUntrackedFiles")) is not int or expected["trackedAndUntrackedFiles"] < 1):
        raise ValueError("AFFECTED_HOST_CLEAN_IDENTITY_REQUIRED")
    # Reuse the inner runner's closed parser and its complete fresh discovery.
    sys.argv = [argv[0], "--base", argv[2], *argv[4:]]
    return main(expected_source=expected,
                host_cancelled=lambda: cancellation_state(Path("/testops-host-control"), argv[3]))


if __name__ == "__main__":
    raise SystemExit(entry(sys.argv))
