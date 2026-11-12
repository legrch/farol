#!/usr/bin/env python3
"""Create-only local Dev archive; never an official release or an installer.

The caller independently accepts the assembler receipt before this process.
It must recheck the canonical app digest before and after archiving. Reuse the
release archiver's bounded no-follow members and private-data checks; no release
source/signing/channel metadata is invented for a Dev derivative.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def require(ok):
    if not ok:
        raise ValueError('VM_DEV_ARCHIVE_UNQUALIFIED')


def archive_dev(output, expected_receipt, inspect_existing=False):
    output = Path(output)
    require(output.is_absolute() and output.parent == ROOT / '_output/vm-dev'
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,80}', output.name))
    for directory in [ROOT, ROOT / '_output', output.parent, output]:
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and info.st_uid == os.getuid() and not info.st_mode & 0o022
                and directory.resolve(strict=True) == directory)
    require(re.fullmatch(r'[a-f0-9]{64}', expected_receipt))
    spec = importlib.util.spec_from_file_location('vm_dev_archive_files', ROOT / 'tooling/prepare-release-archive.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    receipt_file = output / 'vm-dev-artifact.json'
    raw = b''.join(helper.regular_chunks(receipt_file, 16384))
    require(hashlib.sha256(raw).hexdigest() == expected_receipt)
    receipt = json.loads(raw)
    app = output / 'Farol Dev.app'
    require(receipt.get('schema') == 'farol.vm-dev-artifact/1'
            and receipt.get('kind') == 'local-dev-derivative'
            and receipt.get('appName') == app.name
            and receipt.get('bundleId') == 'local.farol.dev'
            and receipt.get('environment') == 'dev'
            and receipt.get('artifactPath') == str(app)
            and receipt.get('officialRelease') is False
            and receipt.get('hostLaunch') is False and receipt.get('profileImport') is False)
    # Configure only this private imported instance, not the public release CLI.
    # Its member collection/public-byte scanning semantics stay identical.
    helper.APP_NAME = app.name
    helper.APP = app
    helper.PACKAGE = output
    members = helper.members()
    target = output / 'Farol-Dev.zip'
    if inspect_existing:
        # Reconcile only the already-created ZIP, never recreate or overwrite it.
        original = helper.regular_file(target, helper.MAX_ARCHIVE)
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream, zipfile.ZipFile(stream) as package:
            require(helper.file_identity(os.fstat(stream.fileno())) == helper.file_identity(original))
            require(package.namelist() == [name for _, name, _ in members])
            for file, name, info in members:
                entry = package.getinfo(name)
                require(entry.external_attr >> 16 == info.st_mode)
                if stat.S_ISDIR(info.st_mode):
                    require(package.read(entry) == b'')
                elif stat.S_ISLNK(info.st_mode):
                    require(package.read(entry) == os.readlink(file).encode())
                    helper.unchanged(file, info)
                else:
                    expected = hashlib.sha256()
                    for chunk in helper.regular_chunks(file, helper.MAX_EXPANDED, info): expected.update(chunk)
                    actual = hashlib.sha256()
                    with package.open(entry) as data:
                        for chunk in iter(lambda: data.read(1024 * 1024), b''): actual.update(chunk)
                    require(actual.digest() == expected.digest() and entry.file_size == info.st_size)
            helper.unchanged(target, original)
    else:
        with target.open('xb') as stream:
            os.chmod(target, 0o600)
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as package:
                for file, name, info in members:
                    helper.add_member(package, file, name, info)
            stream.flush(); os.fsync(stream.fileno())
    value = hashlib.sha256()
    for chunk in helper.regular_chunks(target, helper.MAX_ARCHIVE): value.update(chunk)
    digest = value.hexdigest()
    result = {'schema':'farol.vm-dev-archive/1', 'kind':'local-dev-derivative',
              'archiveName':target.name, 'archiveSha256':digest,
              'archiveSize':target.stat().st_size, 'receiptSHA256':expected_receipt,
              'product':'Farol Dev', 'bundleId':'local.farol.dev',
              'version':receipt['version'], 'sourceCommit':receipt['sourceCommit'],
              'sourceTreeDigest':receipt['sourceTreeDigest'],
              'buildId':receipt['parentBuildId'], 'artifactSha256':receipt['artifactSha256'],
              'launcherSHA256':receipt['launcherSHA256'], 'officialRelease':False}
    with (output / 'vm-dev-archive.json').open('x') as stream:
        os.chmod(output / 'vm-dev-archive.json', 0o600)
        json.dump(result, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    directory = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(directory)
    finally: os.close(directory)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--expected-receipt-sha256', required=True)
    parser.add_argument('--inspect-existing', action='store_true', help='Validate the original complete ZIP after an interrupted metadata step; never recreates it')
    args = parser.parse_args()
    print(json.dumps(archive_dev(args.output, args.expected_receipt_sha256, args.inspect_existing)))
