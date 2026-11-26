# Startup recovery availability

> **Retired window and routes.** Since 2026-10-27 every start with a compiled Go
> core is fresh, so the startup recovery window (`#farol-startup-recovery`, its
> host, session and preload bridge) is never opened and its TypeScript was
> removed. The startup preserving-maintenance library (`recovery/maintenance`,
> `receipt`, `selection`, `retained-records`, `diagnostics`), its write-ahead
> attempt receipts and the Go `serve --startup-mode recovery` route were removed
> afterwards. Sections below that describe them, the recovery `state`/`read`/Quit
> API and the stored-reply reader of that window are historical. Still live:
> independent fresh admission, the stored-reply archive reader
> (`apps/desktop/recovery/archive.ts`, `apps/desktop/renderer/recovery/archive.tsx`)
> shown from the chat history, and the operator-run closed preserved recovery
> commands in `tooling/`.

An unconfirmed predecessor still fences consumption of its Chat journal and
replay of its effects. Independent fresh admission, described below, creates a
separate current Chat session without consuming that predecessor. The earlier
preserving-maintenance and restricted Recovery routes retain their original
requirements; neither is proof of a successful historical operation.

Recovery reads only an existing stable private Settings document. Missing, corrupt, unsafe or changed Settings remain unavailable without defaults, repair, migration or a backend launch. Valid Settings remain visible even when the separately selected local read owner cannot start. Approved folder selection, directory navigation and file size/SHA-256 metadata use the existing Go authority and filesystem owners, with a fresh Computer-only publication. This does not resume Chat, mutations, commands or connection actions.

The recovery document uses the existing attested shell/preload entries. Its fixed local fragment and explicit host-only preload argument select only `state`, `read` and Quit IPC. The host validates the exact main frame before dispatch and after each result, parses closed requests, projects only folder labels/roots/revision, independent read readiness and bounded folder/archive data, and retains publications and saved configuration internally. Normal desktop IPC handlers are absent. Renderer responses are parsed and correlated again; unknown/unavailable reads pause the controls without automatic repetition. New browser UI source under `apps/desktop/renderer` retains the same host-import restrictions as `src/ui`.

Quit stops new view requests, waits for the original pending load/start and exact child Close, then releases its own startup exclusion. A known unconfirmed child cleanup cannot become a clean UI Quit. No predecessor clean receipt is written, marker removed, saved configuration changed or old operation repeated. A second launch can reveal this window but retains `reopen-failed` as its normal-readiness acknowledgement; the primary emits `primary-recovery`, distinct from `primary-started`.

This is partial startup availability and custody. Interrupted operation outcomes, retained history, automatic safe retirement, tunnel reconnection and descendants still need independent recovery before normal admission resumes. No reboot-based automatic retirement or installed acceptance is claimed.

The explicit native runner uses `node tests/e2e/startup-recovery.e2e.mjs --run-native --saved-settings` for its positive fresh-Home lane. `--run-native` is the required first flag; no environment variable substitutes for it. Flags must appear in the order documented by `tests/e2e/fixtures/startup-recovery-arguments.ts`; this runner does not accept the writable runner's `--source-sha` or `--build-id` arguments. It qualifies the current checkout and built Go bytes internally. `EXPLICIT_NATIVE_RECOVERY_LANE_REQUIRED` means the entire argument vector differs, not that a second opt-in variable is missing. Plain `--run-native` selects the negative corrupt-Settings fixture and must report BLOCKED rather than Home.

The saved-Settings fixture explicitly seeds historical Setup completion and `general.openAtLaunch=home`; neither is a real Finish/current-attachment receipt. It checks two hidden fresh-Home lifetimes with current writable launch claims, clean Quit and preservation of original journals/UNKNOWN in place. Failed marker/Quit bytes are copied into run-history. This is not the legacy read-only Recovery UI, a Shell execution, arbitrary descendant cleanup, package/installed or live-provider acceptance. Native execution and its exact qualified build remain separate evidence.

## Explicit Go recovery composition (retired)

The Go executable no longer accepts `serve --startup-mode recovery`; `normal`
and `fresh` are the only startup modes, and the typed desktop launcher rejects
any other value before profile consumption or spawn. The removed route held the
Computer authority claim and exposed only the original publication, Settings
list/search/snapshot and recovery-only `chat.archive.list`/`chat.archive.read`
methods. The existing-only archive adapter remains composed by the normal runtime
for retired replies.

`ProductSettingsStore.loadExisting()` reads an existing stable private `config.json` with bounded descriptor/name checks, without creating defaults, directories, permission repairs, renames or migration. Unsafe, missing, corrupt or changed inputs cannot become a usable saved Settings snapshot. Existing-only Go storage selection never provisions a profile and does not require or repair old mutation journals; base profile roots still require their original physical qualification.

The saved-Settings runner also accepts `--run-native --saved-settings --force-quit`. It sends one SIGKILL through the first fresh test-owned Electron handle, waits for its exact observed direct children to disappear without child signals, then checks a second same-profile fresh Home and ordinary clean Quit. Original journal/UNKNOWN custody and failed-run copies are checked independently; any timeout retains the failure/profile without replay.

With `--run-native --saved-settings --normal-host-crash`, an actual ordinary hidden Electron lifetime first creates its Go profile and marker. One SIGKILL targets that exact idle host; the fixture observes its direct children disappearing, then checks two fresh-Home lifetimes while preserving its original marker bytes in run-history and native journal data in place. Browser surfaces use the local fixture, with no connector configuration, workspace mutation or provider Send. This does not qualify interrupted effects, arbitrary descendants or machine restart.

## Stored-result observation Queries

The removed recovery Go owner composed a current selected-profile history-read authority and the independent existing-only archive adapter without opening old result storage during startup. Explicit `chat.archive.list` and `chat.archive.read` Queries expose bounded `stored_unconfirmed` observations, not normal accepted history. They do not require or mint an old Consume/ACK origin and cannot acknowledge, retire, resume or repeat an operation. A real retained result UNKNOWN is preserved; a busy or absent archive refuses only that query. Paging streams beyond the mutable queue’s capacity and exact content reads pin a selected record digest. See [the owning storage contract](reference/modules/chat/infra/results/durable.md#recovery-observations) for custody, limits and test evidence. The desktop recovery API retains only `state`, `read` and Quit: closed read variants select an explicit archive page or a listed key/digest. A private-pipe adapter pins the current profile/backend response without creating an effect identity. The session keeps independent folder/archive readiness, exact listed metadata, one read in flight and the original exclusion checks before/after each query. A known inactive folder publication does not veto archive reads; uncertain publication still closes the original child. Saved Settings become visible while that same child starts, and the renderer observes readiness for at most 20 seconds without restarting it.

The existing recovery document offers Workspaces and Stored replies. Loading each page and stored text requires an explicit action. The archive text field is a bounded UTF-8 `string` rather than the protocol’s short, single-line `text` primitive, so empty copies, newlines and up to 8192 bytes retain their exact representation. Copies are rendered as escaped plain text with an unconditional unconfirmed-outcome label, independent of the recorded outcome. Unknown/unavailable reads pause only their read surface; no ACK, continuation, replay, resumption or normal history origin is exposed. An unsafe response, changed selected metadata or lost startup exclusion withholds the text. Quit retains the original pending startup and same-child cleanup.

The variant `node tests/e2e/startup-recovery.e2e.mjs --run-native --saved-settings --stored-replies` seeds 33 synthetic Go result records and an original UNKNOWN after the producer closes. It verifies disk custody under fresh startup, without original ACK/terminal or Browser Send. The ordinary fresh shell has no stored-answer UI adapter: that portion is explicitly NOT RUN, the aggregate is PARTIAL and exits nonzero. `--backend-crash` remains a retired stored-read UI journey and exits NOT RUN before launch; it is not a native recovery pass.

## Retained copies across original process loss

Recovery observes the original private pipe through its existing verified-context getter, without another backend request, child, renewal or cleanup action. Lost pipe availability withdraws both read surfaces while retaining saved Settings and already displayed unconfirmed copies. State observation never re-enables a paused surface. The renderer observes local session state once per second while a read surface is available and stops after both are unavailable; startup retains its separate twenty-second observation budget. This is read availability, not original effect settlement or predecessor retirement.

The explicit native archive runner also accepts `--run-native --saved-settings --stored-replies --force-quit` or `--run-native --saved-settings --stored-replies --backend-crash`, with exactly one selected fault journey. Host loss uses the original Electron handle SIGKILL after stored reads, observes its direct children disappearing and reopens the same profile. Backend loss revalidates the exact original child PID/parent/command, suspends only that Go child, starts one explicit stored-copy UI read, then sends SIGKILL to the same child. The pending UI call is not proof the backend received or processed it. The original UI must pause both read surfaces without restarting Go, retain its preceding stored copy, preserve all original records/UNKNOWN and ordinary Quit; the second same-profile recovery must read the copies again. Every failure retains its original report/profile without replay or a second cleanup attempt. These synthetic read-only cases do not qualify a lost workspace/provider effect, arbitrary descendant, reboot, installed or live tunnel recovery.

## Recovery navigation

The title region is draggable, with controls excluded. The recovery screen offers
**Check previous operations**, which invokes the existing explicit stored-result
observation once through the same archive cursor. It shares that cursor with the
Stored replies view, so opening the view never repeats the original query. An empty
archive observation does not prove that the predecessor is settled. A refused,
unavailable or unknown observation remains visible without a retry action.

**Open with commands paused** opens the existing workspace/reply reader in the same
recovery window. It does not create a writable host, resume connection actions,
release startup exclusion, retire a predecessor or rewrite an outcome. Quit is a
secondary action. There is no clean Continue action on this branch: the existing
archive observer cannot prove predecessor settlement. Normal startup continues
only through the separate qualified startup admission path described above.

## Dev maintenance attempt receipts (retired)

The write-ahead `farol-state/startup-maintenance-receipts/<attempt-id>.json`
receipts belonged to the startup preserving-maintenance path and are no longer
written. Receipts left by earlier Dev builds are historical evidence only and
never supply retry authority.

## Unconfirmed connector Quit: diagnostic and later recovery boundary

`drainComputerConnector` preserves a small closed set of local cleanup error
codes for Operations while retaining `outcome_unknown`. It recognizes only an
exact own Error message data property; unknown text, getters, stacks and causes
are not added to Operations. Its cleanup ordering and final confirmation gates
are unchanged. A later cleanup exception can still supersede an earlier failure
under that ordering; the recorded code identifies the propagated failure, not
every preceding cause. This diagnostic change cannot recover an exception lost
by an older build or turn an existing failed Quit into a clean one.

The following is a prospective plan, not an executed recovery or a new admission
route. Apply it only under a separately scoped runtime grant:

1. Pin the original failed run, failed Quit, Settings, physical roots, journals
   and prior maintenance receipts. Preserve their bytes and UNKNOWN records.
   A previous clean Quit, a dead numeric PID or absent processes cannot substitute
   for the original owner's verified terminal/drain. Correlate process start,
   writer, executable and generation; PID reuse does not transfer ownership.
2. Inspect the existing selection/maintenance contract against those exact
   identities before considering a constructor or maintenance effect. Admission
   must retain the original promotion lease/native handle, owner/work absence,
   Computer fence, roots/journals, pending/archive guards and all required
   handoff/ACK/terminal witnesses. An old UNKNOWN attempt is not SAFE_TO_APPLY.
   If the native contract cannot qualify the actual state, stop with its exact
   blocker; do not remove markers, waive descendants or repair journals.
3. If separately admitted, use only the operator-run closed preserved recovery
   command once, with its exact selection and original identity checks. The
   removed startup preserving-maintenance path is not available. Preserve the
   original failed run and UNKNOWN. An ambiguous result stops this route without
   retry. Read-only Recovery availability remains separate from
   `primary-started` or successful retirement.
4. Build only after the existing shared-output ownership preflight admits the
   exact checkout/profile and no original writer owns those outputs. Do not
   bypass `DEV_BUILD_LIVE_OUTPUTS_REFUSED`, substitute another profile to hide
   the owner, or rebuild underneath it. A dependency cycle between admissible
   recovery and build is a blocker to resolve explicitly, not permission to
   modify the retained profile. Use clean committed bytes and the ordinary
   build/package entrypoints with their source/resource attestation intact.
5. Qualify the new build independently on disposable native fixtures before
   any admitted preserved-profile launch. Then require actual normal readiness,
   exact child terminal/drain and a fresh clean Quit receipt. Package, installed,
   live connector and update acceptance remain independent gates.

Offline contract tests demonstrate diagnostic projection and refusal propagation
through controlled ports. They do not establish original-child cleanup, native
leases, arbitrary interrupted-effect recovery or any successful live handoff.

## Independent fresh admission

Ordinary compiled-Go desktop startup selects fresh admission, including after a
clean Quit. It never sets `previousHostDrainConfirmed`, calls previous `Consume`,
replays stored work, or feeds connector/process records into the owner-settings
Completed consumer. Explicit previous-session maintenance keeps its own guards.

The host retains its startup promotion lease and singleton ownership while
preserving the original run marker and optional Quit bytes in a private,
append-only `run-history/<UUID>` directory. It refuses an alive or unidentified
marker owner. A dead marker owner permits preservation only, not a claim that
the old process or operation succeeded. Settings integrity remains mandatory;
no reset, default repair or permission migration qualifies an interrupted profile.

The new Go child obtains the existing exclusive Computer owner before creating
new Chat state. It holds the existing fresh-session, lifecycle, handoff and result
claims when present. The fresh-session claim is a retained flock resource, not a
permanent restriction on future capabilities. Busy, partial or changed claims
refuse. Each new `chat/fresh-<generation-hash>/chat` is created exclusively and
never reopened. Original Chat, mutation and Task journals remain in place.
Historical UNKNOWN stays UNKNOWN. Every native request rechecks retained claims.

Desktop holds the existing MCP exclusive lifetime lock through Go admission.
Active MCP leases refuse startup; safe old instance markers are retained as
history. Original prepared launches are revoked, not replayed. Incomplete
reconciliation still refuses. The
in-memory current-start permission neither fabricates an old stop ACK nor
survives a new stop revision or a new lifecycle owner.

Fresh admission forwards separately qualified mutation storage, Shell resources
and Codex read selection. Their existing authority and confinement still apply.
The existing mutation writer lock also protects a read-only process-history
inspection before new mutable work is composed. All canonical records, output
chunks and original owner/profile/computer bindings must qualify within the
existing 128-record bound. Corruption, unsupported records, changed roots or
excess inventory refuse as `FRESH_SESSION_PROCESS_SAFETY_UNCONFIRMED`.

After the existing core and MCP owner locks exclude the old owners, a canonical
writable process reservation without a terminal, or a terminal without confirmed
group cleanup, remains untouched historical uncertainty. It does not block a new
fresh runtime or remove its independently approved capabilities. Flock does not
prove group cleanup: the watchdog remains responsible for its existing EOF-driven
group stop, and escaped `setsid` descendants remain outside that guarantee.

Fresh startup also preserves legacy `shell-*` execution-fence markers as
`unresolved-shell-*` in the same private directory. It holds MCP exclusion,
waits for new native Go admission, then borrows the existing exclusive execution
admission lock before renaming. Bytes, inode and modification time are retained,
including empty or partial marker contents. Unsafe files and destination
collisions refuse without overwriting history. If preservation fails after Go
admission, startup aborts that unreturned core. Ordinary prepare/Stop/admission
keeps its existing refusal while original shell markers remain.

The read-only `core.fresh.status` observation reports only whether this history
contains an interrupted writable command. Desktop combines this observation
with the preserved legacy Shell markers and records one summary in the
existing Activity log: “Interrupted command: outcome unknown.” The notice is
deduplicated against retained summaries and can be marked read normally. It
contains no command or output, changes no historical record and admits no replay.
No new PID scanner, cleanup retry or lease protocol is introduced.

`core.fresh.close` freezes and drains only this session and is admitted once.
It drains current Settings delivery, process publication and mutation owners,
Codex read, Chat and browser exchanges. A no-op Cancel after reap does not create
UNKNOWN; original exit, successful supervisor Wait, confirmed group cleanup
and durable publication settle a process. Descendants that escape through
`setsid` remain explicitly unverified and are outside this group guarantee. Known results with unverified cleanup remain
recorded without being rewritten. The host still requires the original child's
actual normal, unforced exit. Unknown drain or terminal is never retried. This
protocol records no previous-session retirement, ACK or terminal.

Disposable native tests qualify two new Go runtime generations with real file
edit receipts and delivery ACKs while retaining the original UNKNOWN and history.
The Settings-store/consent peer is explicit fixture input. A separate read-only
CLI journey qualifies two real Go child processes over framed IPC. Controlled
collector tests qualify reap→Cancel→publication ordering. None of these proves
one assembled writable Shell→Quit→Electron-reopen journey, live provider tools,
actual owner-profile admission, package or installed acceptance. These remain
separate gates. No live recovery is implied by these tests.

### Watchdog group observation

The live watchdog performs its existing anchored-group TERM and KILL. Root exit
with inherited pipes still open schedules the same group stop; the grace period
is at most 500 ms and never extends the original command deadline. Refused or
unknown signals remain fenced without another signal attempt. After the original
helper Wait and complete root/output reports, Go queries only that retained
PGID with signal zero. ESRCH confirms the group. A bounded, read-only observation
allows ordinary reap latency; live/reused groups and errors stay unverified.
Go sends no TERM/KILL after helper reap, where numeric PGID reuse is possible.

The existing legacy v4–v6 records do not carry a kernel boot-session UUID. No
ordinary fresh-start reboot exception is inferred from mtime, a PID, or an
unbound run marker. The explicit preserved cold-inspection route still requires
its independently pinned before-session and retains all original guards.
