"""Synthetic guest-phase adapter: execute only the real result writer, not a VM.

The local Node test interpreter is used explicitly. The staged Node and driver
remain inert fixture text. No DNS, TCP, clipboard, credentials, or guest shell.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

NODE = shutil.which('node')
WRITER = Path(__file__).parents[1] / 'vm-e2e/driver-runtime.mjs'
FIXTURE_CASES = ['setup-page-status', 'json-endpoint', 'missing-route-fails-closed', 'loopback-only-binding']
EGRESS_CASES = ['tcp-test-net-1', 'tcp-test-net-2', 'tcp-test-net-3', 'tcp-documentation-v6', 'dns-invalid']


def publish_result(runner, target, *, diagnostic=False, status=None):
    result_dir = target.parent / 'e2e'
    result_dir.mkdir(exist_ok=True)
    context = runner.stage / 'driver.context.json'
    env = {'PATH': os.environ.get('PATH', ''), 'VM_E2E_RESULT_DIR': str(result_dir)}
    if context.exists():
        env['VM_E2E_CONTEXT_FILE'] = str(context)
    status = status or ('REPORTED' if diagnostic else 'PASS')
    cases = EGRESS_CASES if diagnostic else FIXTURE_CASES
    value = {'scenario': 'vm-e2e-egress-probe' if diagnostic else 'vm-e2e-fixture-probe',
             'status': status, 'cases': [{'id': case, 'status': status} for case in cases]}
    if status == 'FAIL':
        value['cases'] = [{'id': case, 'status': 'FAIL' if i == 0 else 'PASS'} for i, case in enumerate(cases)]
        value['reason'] = 'synthetic assertion failed'
    code = 'import fs from "node:fs"; const {writeResult}=await import(process.argv[1]); writeResult(JSON.parse(fs.readFileSync(0,"utf8")));'
    child = subprocess.run([NODE, '--input-type=module', '-e', code, WRITER.as_uri()],
                           input=json.dumps(value), env=env, text=True, capture_output=True, timeout=10)
    if child.returncode:
        raise AssertionError('real result writer failed: ' + child.stderr)
    process = {'schema': 'farol.vm-e2e.process/1', 'runId': runner.run_id,
               'token': target.stem, 'exitCode': 0,
               'contextSha256': hashlib.sha256(context.read_bytes()).hexdigest() if context.exists() else '0' * 64}
    (result_dir / 'process.json').write_text(json.dumps(process))
    return result_dir
