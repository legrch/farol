#!/bin/sh
set -eu

# A fixed guest Dev entrypoint, selected before Electron or Go opens storage.
# No host profile path, environment file, or caller-selected command is read.
unset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE FAROL_PROFILE_MODE
unset FAROL_ACCEPTANCE_PROFILE FAROL_E2E FAROL_E2E_APP_DATA FAROL_E2E_TEST_ROOT FAROL_E2E_TEST_PROOF
export FAROL_ENVIRONMENT=dev
export ELECTRON_FORCE_IS_PACKAGED=true
launcher_path=$0
case "$launcher_path" in
  /*) ;;
  *) launcher_path="$PWD/$launcher_path" ;;
esac
macos_dir=${launcher_path%/*}
contents_dir=${macos_dir%/*}
exec "$contents_dir/Resources/app/farol-backend" run-desktop-launcher
