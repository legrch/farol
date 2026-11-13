"""The Dev identity can never be the published release identity. Synthetic only."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('dev_identity_guard', Path(__file__).parents[1] / 'vm_dev_identity.py')
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


def environ(**changes):
    value = {'product': 'Example Dev', 'appName': 'Example Dev.app', 'bundleId': 'local.example.dev',
             'archiveName': 'Example-Dev.zip', 'executable': 'Example'}
    value.update(changes)
    return {identity.ENVIRONMENT: json.dumps(value)}


class DevIdentityTests(unittest.TestCase):
    def test_synthetic_dev_identity_is_admitted(self):
        self.assertEqual(identity.dev_identity(environ())['bundleId'], 'local.example.dev')

    def test_release_bundle_id_or_product_is_refused_in_any_case(self):
        release = identity.release_identity()
        product = release['product']
        cases = [
            dict(bundleId=release['bundleId']),
            dict(bundleId=release['bundleId'].upper()),
            dict(product=product, appName=product + '.app',
                 archiveName=product.replace(' ', '-') + '.zip'),
            dict(product=product.upper(), appName=product.upper() + '.app',
                 archiveName=product.upper().replace(' ', '-') + '.zip'),
        ]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'VM_DEV_IDENTITY_INVALID'):
                identity.dev_identity(environ(**changes))


if __name__ == '__main__':
    unittest.main()
