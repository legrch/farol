# Native state inspection

The Go source provides an explicit `inspect-native-state` diagnostic mode. It
does not start the normal backend, a connector, a provider, or a new journal
writer. It is preparation for examining a closed profile, not a recovery tool.
Native and exact-package qualification of this new mode remain open.

The caller selects the exact existing physical Go profile and pins the inspecting
executable's compiled build ID:

```text
farol-core inspect-native-state --profile PROFILE_ID --profile-root ABSOLUTE_ROOT --profile-device DEVICE --profile-inode INODE --expected-build BUILD_ID
```

All five options are required exactly once. Device and inode are nonzero canonical
decimal strings. No HOME override, discovery, create mode, repair flag, or process
termination option exists. The caller must retain the exact source/package
identity, own maintenance exclusion, and establish that the intended runtime is
closed before using this command in a recovery workflow. A missing file or lock
is a refusal; it is never permission to initialize a replacement.

The diagnostic qualifies the existing profile root and observes two components:

- Chat's canonical lifecycle snapshot under its existing claim lock. It returns
  the exact snapshot digest, physical root, observed backend generation, format
  version, admission/write/incarnation counts, and whether retirement metadata
  is recorded. It exposes no prompts or result bodies.
- Computer's mutation directory under its existing writer lock, opened without
  `O_CREAT`. Any record, staging file, or unknown entry refuses this narrow
  empty-directory observation. It returns physical directory and lock identity.

The result uses schema `farol-native-state-inspection/1`. Physical counters remain
decimal strings. `recoveryAuthorized` is always `false`. The two observations are
separate, not an atomic profile snapshot. They do not inspect Task state, Chat
handoff/result stores, other staging, desktop obligations, tunnel processes, or
the predecessor's authority store. Existing unknown operations remain unknown.
Recorded retirement bytes do not prove original publication, ACK, or child exit.
The Chat claim is an opaque retained fence: its contents are neither read nor
format-validated. Successful snapshot inspection does not establish an empty claim.

Exit 0 means the requested diagnostic completed and its bounded report was
written. Exit 2 rejects input before selecting native state. Exit 1 reports an
unavailable inspection or an unconfirmed output write. Failure diagnostics omit
raw filesystem errors and private content. No path retries, alternate executor,
state cleanup, mutation, successor admission, or automatic restart follows.

Pure selection, canonical-classification, and CLI tests are separate from the
authored native filesystem/lock tests. The latter use disposable roots only and
must be scheduled on the native lane. They are not ordinary-profile recovery,
installed-workflow, or packaged-command evidence. The existing closed Computer
recovery command does not consume this output or gain Go-profile recovery powers.
