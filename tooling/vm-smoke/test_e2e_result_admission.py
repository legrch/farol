"""Actual Runner.main/run + actual Node writeResult; synthetic guest boundaries.

No guest-only shell is executed. The test writer does not open network sockets.
Raw result corruption happens AFTER production writeResult, at its boundary.
"""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import os
import subprocess
import unittest
from unittest.mock import patch

import test_closed_contour as fixture
from e2e_result_test_support import NODE, publish_result

vm = fixture.vm


@unittest.skipUnless(NODE, 'NOT RUN: local Node required for real result producer')
class E2EResultAdmissionTests(unittest.TestCase):
    def drive(self, *, status='PASS', mutate=None, process_exit=0, cleanup_failure=False,
              guest_failure=False, missing_process=False, malformed_process=False,
              stage_cleanup_failure=False, mutate_process=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        published = {}
        stage_to_fail = []
        original_rmtree = vm.shutil.rmtree
        diagnostic = status == 'REPORTED'
        original_builder = fixture.build_driver_dir

        def driver_builder(*args, **kwargs):
            source, manifest = original_builder(*args, **kwargs)
            manifest['entry'] = 'egress-probe-entry.mjs' if diagnostic else 'fixture-probe-entry.mjs'
            (source / 'manifest.json').write_text(json.dumps(manifest))
            return source, manifest

        def guest_hook(runner, name, target):
            if name == 'e2e':
                stage_to_fail[:] = [runner.stage]
                result_dir = publish_result(runner, target, diagnostic=diagnostic, status=status)
                result_path = result_dir / 'result.json'
                published['raw'] = result_path.read_bytes()
                if mutate:
                    mutate(result_path)
                    published['raw'] = result_path.read_bytes() if result_path.exists() else None
                process_path = result_dir / 'process.json'
                process = json.loads(process_path.read_text())
                process['exitCode'] = process_exit
                if mutate_process: mutate_process(process)
                process_path.write_text(json.dumps(process))
                if missing_process: process_path.unlink()
                if malformed_process: process_path.write_text('{}')
                if guest_failure: raise vm.Refused('SYNTHETIC_PHASE_ACK_UNKNOWN')
            if name == 'launch':
                context = runner.stage / 'driver.context.json'
                if hasattr(runner, 'e2e_context'):
                    self.assertTrue(context.is_file(), 'bound context must precede app startup')
            if name == 'cleanup' and cleanup_failure:
                raise vm.Refused('SYNTHETIC_TEARDOWN_FAILURE')

        def execute(runner):
            with patch.object(vm, 'arguments', return_value=runner.a), \
                 patch.object(vm, 'Runner', return_value=runner), \
                 contextlib.redirect_stdout(io.StringIO()):
                return vm.main()

        patches = [patch.object(fixture, 'build_driver_dir', side_effect=driver_builder)]
        if stage_cleanup_failure:
            def fail_stage_only(path, *args, **kwargs):
                if stage_to_fail and Path(path) == stage_to_fail[0]:
                    raise PermissionError('synthetic-stage-denied')
                return original_rmtree(path, *args, **kwargs)
            patches.append(patch.object(vm.shutil, 'rmtree', side_effect=fail_stage_only))
        with contextlib.ExitStack() as stack:
            for p in patches: stack.enter_context(p)
            runner, code, caught, calls, _ = fixture.drive_closed_package(
                root, {'name': 'pilot', 'network': False}, driver=True,
                guest_hook=guest_hook, execute=execute)
        self.assertIsNone(caught)
        report = json.loads((runner.out / 'result.json').read_text())
        return runner, code, report, published

    def assert_rejected(self, mutation):
        runner, code, result, sent = self.drive(mutate=mutation)
        self.assertNotEqual(code, 0, result)
        self.assertEqual(result.get('test', {}).get('status'), 'FAIL', result)
        self.assertFalse(result.get('e2e', {}).get('qualificationEligible', True), result)
        if sent.get('raw') is not None:
            self.assertEqual((runner.out / 'e2e-result.raw.json').read_bytes(), sent['raw'])
        self.assertNotIn('relaunch', result['phases'], 'failed E2E must not start another scenario')
        return runner, result

    def test_bound_positive_control_uses_actual_writer_and_keeps_scope(self):
        runner, code, result, sent = self.drive()
        self.assertEqual(code, 0, result)
        self.assertEqual(result.get('test', {}).get('status'), 'PASS', result)
        self.assertEqual(result['status'], 'NEEDS_REVIEW')
        self.assertEqual(result['lifecycle'], 'PASS')
        self.assertEqual(result['operation']['status'], 'CONFIRMED')
        self.assertFalse(result['e2e']['qualificationEligible'])
        receipt = result['e2e']['receipt']
        self.assertEqual(receipt['schema'], 'farol.vm-e2e.result/1')
        self.assertEqual(receipt['runId'], runner.run_id)
        self.assertEqual(receipt['scenario'], 'vm-e2e-fixture-probe')
        self.assertEqual(receipt['contextSha256'], hashlib.sha256((runner.out / 'e2e-context.json').read_bytes()).hexdigest())
        self.assertEqual((runner.out / 'e2e-result.raw.json').read_bytes(), sent['raw'])
        self.assertFalse(runner.effect_file.exists())

    def test_empty_null_array_malformed_and_missing_result_are_rejected(self):
        for raw in ('{}', 'null', '[]', '{broken', '', None):
            with self.subTest(raw=raw):
                def mutate(file, raw=raw):
                    if raw is None: file.unlink()
                    else: file.write_text(raw)
                self.assert_rejected(mutate)

    def test_foreign_bindings_and_unsupported_schema_status_are_rejected(self):
        for field, value in [('runId', 'run-' + '0' * 32), ('scenario', 'foreign-scenario'),
                             ('bundleSha256', '0' * 64), ('contextSha256', '0' * 64),
                             ('schema', 'farol.vm-e2e.result/999'), ('status', 'SUCCESS'),
                             ('selection', ['other-case']), ('evidenceClass', 'product')]:
            with self.subTest(field=field):
                def mutate(file, field=field, value=value):
                    record = json.loads(file.read_text()); record[field] = value
                    file.write_text(json.dumps(record))
                self.assert_rejected(mutate)
        for field in ('sourceCommit', 'buildId', 'artifactSha256', 'archiveSha256'):
            with self.subTest(artifact=field):
                def mutate(file, field=field):
                    record = json.loads(file.read_text())
                    record.setdefault('artifact', {})[field] = '0' * (40 if field == 'sourceCommit' else 64)
                    file.write_text(json.dumps(record))
                self.assert_rejected(mutate)

    def test_missing_duplicate_failed_and_incomplete_cases_never_pass(self):
        for mode in ('missing', 'duplicate', 'failed', 'not-run', 'bad-type'):
            with self.subTest(mode=mode):
                def mutate(file, mode=mode):
                    record = json.loads(file.read_text())
                    cases = record['cases']
                    if mode == 'missing': cases.pop()
                    elif mode == 'duplicate': cases.append(copy.deepcopy(cases[0]))
                    elif mode == 'failed': cases[0]['status'] = 'FAIL'
                    elif mode == 'not-run': cases[0]['status'] = 'NOT_RUN'
                    else: record['cases'] = {}
                    file.write_text(json.dumps(record))
                self.assert_rejected(mutate)

    def test_valid_fail_even_with_zero_exit_remains_fail_after_teardown(self):
        runner, code, result, sent = self.drive(status='FAIL')
        self.assertEqual(code, 1, result)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['test']['status'], 'FAIL')
        self.assertEqual(result['e2e']['receipt']['status'], 'FAIL')
        self.assertEqual(result['e2e']['reason'], 'E2E_ASSERTIONS_FAILED')
        self.assertEqual(result['operation']['status'], 'CONFIRMED')
        self.assertNotIn('relaunch', result['phases'])
        self.assertFalse(runner.effect_file.exists())

    def test_pass_result_cannot_overrule_nonzero_process_exit(self):
        runner, code, result, _ = self.drive(process_exit=7)
        self.assertEqual(code, 1, result)
        self.assertEqual(result['test']['status'], 'FAIL')
        self.assertEqual(result['e2e']['reason'], 'E2E_PROCESS_FAILED')
        self.assertEqual(result['e2e']['receipt']['status'], 'PASS')
        self.assertNotIn('relaunch', result['phases'])

    def test_process_completion_and_phase_ack_must_be_bound(self):
        for kwargs in ({'missing_process': True}, {'malformed_process': True}, {'guest_failure': True}):
            with self.subTest(kwargs=kwargs):
                runner, code, result, _ = self.drive(**kwargs)
                self.assertNotEqual(code, 0, result)
                self.assertEqual(result.get('operation', {}).get('status'), 'UNKNOWN', result)
                self.assertNotIn('relaunch', result['phases'])
                self.assertNotIn('cleanup', result['phases'])
                self.assertTrue(runner.effect_file.exists())

    def test_teardown_failure_cannot_qualify_pass(self):
        runner, code, result, _ = self.drive(cleanup_failure=True)
        self.assertEqual(code, 2, result)
        self.assertEqual(result.get('operation', {}).get('status'), 'UNKNOWN', result)
        self.assertEqual(result['test']['status'], 'PASS', 'retain measured assertions, not completed-run eligibility')
        self.assertFalse(result['e2e']['qualificationEligible'])
        self.assertTrue(runner.effect_file.exists())

    def test_primary_assertion_failure_survives_teardown_failure(self):
        runner, code, result, sent = self.drive(status='FAIL', cleanup_failure=True)
        # The assertion FAIL is kept as data, but the UNKNOWN teardown owns the exit code.
        self.assertEqual(code, 2, result)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['reason'], 'E2E_ASSERTIONS_FAILED')
        self.assertEqual(result['operation']['status'], 'UNKNOWN')
        self.assertEqual(result['operation']['error'], 'UNCLASSIFIED')
        self.assertNotIn('SYNTHETIC_TEARDOWN_FAILURE', json.dumps(result))
        self.assertEqual((runner.out / 'e2e-result.raw.json').read_bytes(), sent['raw'])
        self.assertTrue(runner.effect_file.exists())

    def test_stage_cleanup_failure_prevents_qualification(self):
        runner, code, result, _ = self.drive(stage_cleanup_failure=True)
        self.assertEqual(code, 2, result)
        self.assertEqual(result.get('operation', {}).get('status'), 'UNKNOWN', result)
        self.assertTrue(result['cleanup'].startswith('FAILED:'))
        self.assertFalse(result['e2e']['qualificationEligible'])
        self.assertTrue(runner.effect_file.exists())

    def test_foreign_process_receipt_and_bad_exit_types_stay_unknown(self):
        for key, value in [('runId', 'run-' + '0' * 32), ('token', '0000-e2e'),
                           ('contextSha256', '0' * 64), ('schema', 'unsupported'),
                           ('exitCode', True), ('exitCode', '0')]:
            with self.subTest(key=key, value=value):
                runner, code, report, _ = self.drive(mutate_process=lambda item: item.update({key: value}))
                self.assertEqual(code, 2, report)
                self.assertEqual(report['operation']['status'], 'UNKNOWN')
                self.assertTrue(runner.effect_file.exists())
                self.assertNotIn('cleanup', report['phases'])

    def test_phase_failure_is_preserved_even_when_fail_receipt_also_exists(self):
        runner, code, report, _ = self.drive(status='FAIL', guest_failure=True)
        # The operation is UNKNOWN, so the exit is 2 even though a FAIL receipt exists.
        self.assertEqual(code, 2, report)
        self.assertEqual(report['reason'], 'UNCLASSIFIED')
        self.assertNotIn('SYNTHETIC_PHASE_ACK_UNKNOWN', json.dumps(report))
        self.assertEqual(report['e2e']['reason'], 'E2E_ASSERTIONS_FAILED')
        self.assertEqual(report['operation']['status'], 'UNKNOWN')
        self.assertTrue(runner.effect_file.exists())

    def test_context_required_and_driver_not_silently_ignored_in_qa_mode(self):
        with self.assertRaisesRegex(vm.Refused, 'E2E_DRIVER_REQUIRES_CLOSED'):
            vm.arguments(['--artifact', 'synthetic.zip', '--e2e-driver', '/synthetic'])

    def test_pure_node_result_and_entry_contracts_join_python_discovery(self):
        # The existing vm:test Python discovery reaches these new Node leaves.
        # The entrypoint suite replaces HTTP, TCP and DNS with in-memory doubles.
        root = Path(__file__).parents[2]
        child = subprocess.run([NODE, '--experimental-vm-modules', '--test', '--test-reporter=tap',
                                'tooling/vm-e2e/result-contract.test.mjs',
                                'tooling/vm-e2e/driver-entries.synthetic.test.mjs'],
                               cwd=root, capture_output=True, text=True, timeout=20,
                               env={'PATH': os.environ.get('PATH', ''), 'NODE_NO_WARNINGS': '1'})
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        self.assertRegex(child.stdout, r'(?m)^# tests [1-9]\d*$')
        self.assertIn('# fail 0', child.stdout)

    def test_observed_egress_fails_the_run_and_downgrades_network_policy(self):
        for name, details in (('flag', {'externalConnectable': True}),
                              ('probe', {'externalConnectable': False,
                                         'probes': [{'endpoint': '192.0.2.1:443', 'connectable': True}]})):
            with self.subTest(case=name):
                def mutate(file, details=details):
                    value = json.loads(file.read_text())
                    value.setdefault('details', {}).update(details)
                    file.write_text(json.dumps(value))
                runner, code, result, _ = self.drive(status='REPORTED', mutate=mutate)
                self.assertEqual(code, 1, result)
                self.assertEqual(result['test']['status'], 'FAIL')
                self.assertEqual(result['e2e']['reason'], 'CLOSED_CONTOUR_EGRESS_OBSERVED')
                self.assertEqual(result['status'], 'FAIL')
                self.assertEqual(result['networkPolicy']['runtimeEgress'], 'observed')
                self.assertNotIn('verified', result['networkPolicy']['receipt'])

    def test_reported_probe_without_connectivity_stays_diagnostic_and_unverified(self):
        runner, code, result, _ = self.drive(status='REPORTED')
        self.assertEqual(code, 0, result)
        self.assertEqual(result['test']['status'], 'REPORTED')
        self.assertEqual(result['status'], 'NEEDS_REVIEW')
        self.assertFalse(result['e2e']['qualificationEligible'])
        self.assertEqual(result['networkPolicy'], {
            'mode': 'guest-offline-local-fixtures', 'machineNetwork': False,
            'receipt': 'machine.json-offline-configured', 'runtimeEgress': 'not-verified'})


if __name__ == '__main__':
    unittest.main()
