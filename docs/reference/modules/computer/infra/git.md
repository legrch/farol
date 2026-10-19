# Source-bound managed Git transport

Status: **unselected implementation candidate**. This is a credential-free
protocol adapter, not an activated network policy, a new MCP Git API, or proof
of SSH, native sandbox, package, installed or GitHub acceptance.

## Purpose and architecture

Normal Git remains normal Git. Stage, commit, configuration, attributes, worktrees
and project hooks stay in the developer environment governed by the existing
[Computer process owner](process.md). The owner still selects an ordinary scoped
Shell, not a catalog of Farol replacements for Git subcommands.

Network destination filtering alone cannot enforce a repository, ref or outgoing
commit inside an encrypted SSH connection. Giving the entire Git/hook process
tree the owner's unrestricted SSH agent and network also broadens arbitrary hook
code. A typed *transport boundary*, not a second Git executor, separates these
powers:

```text
ordinary sandboxed Git + its normal pre-push hook
                |
         original local duplex stream
                |
  Computer infra/git: authenticated source/ref/pack gate
                |
       already-authenticated original remote stream
                |
       ordinary git-receive-pack service
```

The adapter never dials, starts a process, invokes an SSH or credential helper,
reads Git configuration, changes remotes, writes Git metadata or grants access.
The existing Computer owner supplies both original streams and the original
admission/custody barrier. Do not select the adapter from an arbitrary command
string or interpret the absence of a runtime binding as permission to fall back.
Current `NoNetwork` boot and platform qualification are unchanged.

There is no shared kernel broker or generic external-effect framework in this
packet: only this real Computer consumer is implemented. Reuse this evidence
when another consumer actually needs identical semantics; do not build speculative
cross-module infrastructure or another permission/journal database.

## Implemented pieces

- `modules/computer/domain/egress`: immutable `Plan`, bounded source manifests,
  operation/workspace/runtime/grant/repository binding, destination and source
  seals, exact feature ref, expected old OID, task base and intended head.
- `modules/computer/app/port/egress`: consumer-owned interfaces for the existing
  custody owner, immutable known-object reader and already-authenticated peer.
- `modules/computer/infra/git`: one-use stream gate, strict pkt-line protocol,
  source/graph/ancestry validation, bounded PACK parsing, canonical upload,
  sanitized report status and separate readback interpretation.

The pure domain exposes `Plan.Canonical()` as immutable deterministic JSON.
Infrastructure `git.IntentDigest(plan)` computes its SHA-256 for trusted composition
and the existing custody owner; nil and zero plans have no digest. The gate caches
that binding and readback refuses an unbound plan. Stream ports declare methods
structurally, without putting hashing or stream implementations in pure layers.

A Plan constructor is **not an authority issuer**. Its source manifest is trusted
input only after the existing owner has proved task ownership and immutable source
custody. Commit authorship, a matching checkout path, a syntactically valid seal
or a permissive fake callback are not those proofs. `BeforeRelease` must record
MAY_HAVE_EFFECT durably through the original existing owner before returning
success. `Check` re-observes that same admission across yields and upload chunks;
neither callback may mint a new lease, extend a deadline or retry an old effect.

The endpoint is a canonical effective SSH service target. The destination seal
must additionally bind real repository identity, configuration resolution, host
key and approved authentication selection in trusted native composition. A peer
that merely asserts `Binding() == Target` does not authenticate itself. No actual
SSH identity implementation is supplied by these interfaces.

## What is enforced before any ref-update byte is sent

1. One immutable operation binding and a bounded context; one run per gate.
   Cross-restart non-replay remains the existing durable owner's responsibility.
2. The supplied peer's target matches the plan; its real ref advertisement
   matches the exact expected old target OID, or confirms target absence.
3. The client requests exactly one authorized full feature ref and exact head.
   Delete, extra refs, push options, certificates, shallow prelude, tag/mirror
   semantics and unsupported capabilities are refused.
4. All incoming pack objects are fully buffered and validated before release.
   PACK v2/v3, SHA-1/SHA-256, direct objects, OFS_DELTA, REF_DELTA and thin known
   bases are supported within explicit hard limits. Object type, length, native
   Git OID and independent SHA-256 must match the approved source manifest.
5. Every introduced object is reachable from the intended head. Commit/tree link
   types and closure are checked; both task base and nonzero remote predecessor
   must be actual ancestors proved from authenticated commit bytes. Known remote
   objects terminate content closure, not ancestry proof. Gitlinks refer to a
   different repository and grant no submodule access.
6. The outgoing pack is reconstructed from verified source bytes, sorted by OID,
   with a fixed compression policy and no thin deltas. Raw client compression,
   order, extra known objects, capability spelling and trailing data are never
   relayed. Original Git object bytes and commit OIDs remain identical. This
   prevents unapproved payloads hidden in the pack representation; it is not a
   claim to eliminate timing or all information-theoretic side channels.
7. Source/authority is checked again, the existing durable pre-effect barrier
   must succeed, and current authority is checked before each upload chunk.

The expected old OID travels unchanged in receive-pack's update command. The real
receiver's compare-and-swap protects against a concurrent writer *after* the
advertisement. A separate read followed by an unconditional push is not equivalent.
The `+` in a client's force refspec cannot bypass this gate's ancestry proof.
Existing remote protection and server hooks remain authoritative.

The adapter negotiates the deliberately bounded v0/v1 receive-pack push subset
with ordinary `report-status`; `report-status-v2`, sideband, push certificates and
push options are not selected. This version accepts conservative ASCII feature
refs and service-relative repository paths; unsupported forms refuse rather than
get silently rewritten. Blob content and tree filenames may contain arbitrary
bytes allowed by Git. Source manifests must cover the relevant new closure and
known boundary objects; an incomplete manifest fails closed. Large repositories
need an appropriately bounded admitted slice, not a blanket full-history grant.
An empty pack is allowed for a new ref pointing to an authenticated known commit;
a client flush without an update is separately reported as no update requested.

Default input/canonical pack limit: 32 MiB each. Expanded-object work: 64 MiB.
Single object: 8 MiB. Combined manifest: 16,384 objects. Delta depth: 32.
Advertisement: 2 MiB / 16,384 refs. Explicit absolute ceilings protect allocation
and traversal; zero never means unlimited. Delta reconstruction, known object
reads and commit/tree traversal have their own checked bounds. This buffered
first version is intentionally not an unbounded streaming publisher.

## Result and uncertainty contract

`Result` is a bounded observation to persist through the existing owner, not a new
receipt store. It records source-intent digest, last protocol stage, input and
canonical pack hashes, object count, actual attempted bytes and separate facts:

- `not_attempted` / `no_update_requested`: no ref-update attempt from this gate.
- `unknown`: an update may have taken effect; no attributable complete status.
- `accepted_report` / `rejected_report`: a structurally valid remote report for
  the exact ref. Neither is a promise that the ref remains unchanged afterward.
- `ReleaseFenceAttempted`, `ReleaseFenced`, `RemoteMayHaveEffects`, `ClientNotified` and
  `StreamCleanupUncertain` remain separate; root/group/descendant closure is NOT
  inferred from stream closure, client ACK, a ref report or readback.

Authentication, discovery and opening receive-pack can have external observations
before any ref update; `not_attempted` is not a claim of zero network/audit events.
A rejected push may have uploaded objects; retain `RemoteMayHaveEffects` after
release. A failed durable barrier must be reconciled by its original owner even
when no update bytes were sent. No automatic retry is implemented.

`Reconcile` accepts a *new*, independently authorized remote observation and
classifies target observed / other observed / unobserved without changing the
original outcome. Seeing the desired SHA after a lost response does not prove this
particular attempt produced it. Unrelated concurrent work is never overwritten.
Errors retain original causes via `Unwrap`, but public `Error`/`Code` omit arbitrary
transport/config/hook text. Remote failure prose is not copied into receipts.

## Native composition still required before activation

This packet is intentionally not reachable from boot, MCP or installed Shell.
Lead must implement and independently qualify the existing-owner joins below:

1. **Source custody and admission.** Resolve the real Git worktree/common-dir,
   current source/base/ref, clean state, workflow ownership and physical roots.
   Bind the existing owner/task/network grant, exact endpoint and original
   deadline. Capture the permitted immutable object set without lazy fetching,
   replacements, config evaluation under credential authority or unapproved
   source disclosure. A manifest sealed by untrusted workload code is insufficient.
2. **Local channel provenance and hooks.** The local stream must belong to the
   admitted Git process and normal hook lifecycle, not any process that finds a
   socket path/token or inherits an endpoint. Preserve existing hooks and their
   failures; do not disable them or run repository code under credential authority.
   Normal-Git fixture success does not prove a hostile hook cannot impersonate
   the client, skip a hook, change configuration, or borrow the channel. Native
   process/FD provenance and meaningful confinement tests are mandatory.
3. **Qualified remote stream.** Use the existing process owner with a new explicit
   qualified network selection. Resolve approved `pushurl`, URL rewrites, SSH
   config/includes and the effective service. Constrain host key, authentication,
   channel command and destination; reject unsupported ProxyCommand, forwarding,
   ControlMaster or helper behavior instead of silently ignoring owner settings.
   Do not expose keys, tokens, the unrestricted agent socket or network permission
   to Git/hooks. Reusing the real owner SSH agent can occur only on this trusted,
   native-qualified side. An address proxy cannot inspect encrypted Git refspecs.
4. **Lifecycle and readback.** Bind `Custody` to the existing original reservation
   and uncertainty mechanism, including failed journal publication, cancellation,
   reconnect, source drift and revoked grants. Supply interruptible owned streams,
   bounded object reads and safe closure without numeric PID reuse. Verify exact
   remote SHA independently, retaining observation time and endpoint binding.
5. **Real acceptance.** Run pinned-toolchain CI, independent security review,
   native macOS sandbox tests, packaged external MCP and one separately authorized
   private-repository PR lifecycle. Keep installed permissions and production
   unchanged until the complete selected route is accepted.

No endpoint-selection constructor, manifest parser or passing portable test can
substitute for these joins. A mock Custody is acceptable only in fixtures. Do not
wire this candidate to a generic unconfined command executor to obtain a demo.

## Verification

Pure protocol tests and race checks (from the repository's supported Go toolchain):

```sh
go test -race ./modules/computer/domain/egress ./modules/computer/infra/git
go vet ./modules/computer/domain/egress ./modules/computer/app/port/egress ./modules/computer/infra/git
```

Explicit real-Git interoperability fixtures:

```sh
go test -race -tags farol_git_transport ./modules/computer/infra/git -run '^TestGitInterop' -count=1
```

These require Git with SHA-256 repository support. They use temporary local source
and bare repositories over pipes, no network/SSH/user keys or real project profiles.
They exercise original hooks, exact SHA preservation, receiver `fsck`, refusal,
fast-forward/CAS concurrency and a lost reply after an actual ref update. The
fixture's transport selector, synthetic HOME and O_EXCL fence are **test-only**;
they must not be copied into production or presented as native sandbox evidence.
No test silently skips missing Git or converts a failed gate into a pass.

Fuzz entrypoints: `FuzzPacket`, `FuzzDelta`, `FuzzPack`. Native, full project CI,
independent review and installed evidence are separately recorded by the integration
owner; this document does not claim them from protocol-test counts.

## Primary protocol references

- [Git pack protocol](https://git-scm.com/docs/gitprotocol-pack): advertisement,
  exact old/new ref update and report status.
- [Git pack format](https://git-scm.com/docs/gitformat-pack): object headers,
  checksums, OFS/REF deltas and delta instructions.
- [Git hooks](https://git-scm.com/docs/githooks): ordinary pre-push and receiver
  hooks and their failure semantics.
- [Git remote helpers](https://git-scm.com/docs/gitremote-helpers): existing
  transport extension points; no replacement Git command language is necessary.
- [OpenSSH client configuration](https://man.openbsd.org/ssh_config): effective
  configuration, agent identity, host key and connection-multiplexing boundaries.

Implementation follows [ADR-0001](../../../../decisions/0001-application-operations.md).
Existing source, package and installed distinctions in
[Sandbox approvals](../../../../sandbox-approvals.md) remain binding.
