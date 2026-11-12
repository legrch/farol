"""Product identities for VM tooling, never pinned in harness source.

The release identity is read from the checked-in product contract
(resources.json). The Dev identity is owned by the desktop environment module;
its JavaScript caller (vm-dev.mjs / vm-dev-artifact.mjs) derives it from
tooling/harness-identity.ts and passes it in FAROL_VM_DEV_IDENTITY. Both are
validated for shape here; a missing or malformed identity refuses.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT = "FAROL_VM_DEV_IDENTITY"
_NAME = re.compile(r"[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+){0,3}")
_EXECUTABLE = re.compile(r"[A-Za-z][A-Za-z0-9]{0,63}")
_BUNDLE = re.compile(r"[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+")
_KEYS = {"product", "appName", "bundleId", "archiveName", "executable"}


def _refuse():
    raise ValueError("VM_DEV_IDENTITY_INVALID")


def _checked(value):
    if not (isinstance(value, dict) and set(value) == _KEYS and
            all(isinstance(value[k], str) for k in _KEYS)):
        _refuse()
    product = value["product"]
    if not (_NAME.fullmatch(product) and _EXECUTABLE.fullmatch(value["executable"]) and
            _BUNDLE.fullmatch(value["bundleId"]) and value["appName"] == product + ".app" and
            value["archiveName"] == product.replace(" ", "-") + ".zip"):
        _refuse()
    return dict(value)


def dev_identity(environ=None):
    """The caller-selected Dev identity; refuses rather than guessing a default."""
    raw = (os.environ if environ is None else environ).get(ENVIRONMENT)
    if not isinstance(raw, str) or len(raw) > 1024:
        _refuse()
    try:
        value = json.loads(raw)
    except ValueError:
        _refuse()
    return _checked(value)


def release_identity(root=ROOT):
    """The published product identity from the checked-in resource contract."""
    try:
        product = json.loads((Path(root) / "resources.json").read_text(encoding="utf-8"))["product"]
        name, bundle = product["name"], product["bundleId"]
    except (OSError, ValueError, KeyError, TypeError):
        _refuse()
    if not isinstance(name, str) or not isinstance(bundle, str):
        _refuse()
    return _checked(dict(product=name, appName=name + ".app", bundleId=bundle,
                         archiveName=name.replace(" ", "-") + ".zip", executable=name))
