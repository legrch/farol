# Saved current Task source

The normal Go-aware desktop publication selects `app/services/currentsource`
through `contracts/currentsource`. It derives the saved Codex source and optional
exact thread/turn read reference. It does not launch a provider, issue admission,
activate Task lifecycle or register Task tools.

The call graph is `GoComputerAuthority.withdraw().publish` → the existing
`computer.authority.publish` effect → boot's Task contract → current-settings
decoder and existing configured-model policy owner → the existing Computer
publication join. The Task app uses a consumer-owned model resolver; boot maps
the independent model-policy values. There is no application-service import of
a sibling service and no second selection engine.

Electron parses/defaults ProductSettings and transports an immutable JSON facts
snapshot with the same sampled millisecond clock used for approval mapping. This
is its remaining schema/transport responsibility. Go owns workspace selection,
provenance and schema joins, model/config identity, generation matching, excluded
path and Git restrictions, grant eligibility, and optional exact-read selection.
The former production TypeScript eligibility functions are retained only as a
test oracle. A Go failure cannot select that oracle or another saved route.

`TaskCurrentSourceFacts` contains bounded `snapshot` and canonical signed safe
integer `nowMillis` strings. The enclosing frame limit also applies. The closed
publication schema refuses the former positive `taskCodex` and `taskCodexRead`
input fields. Normal desktop publication always supplies facts. Computer-only
Go consumers may omit them to publish no Task metadata; omission clears the old
source/read pair and grants no fallback.

The pure owner returns `available` with source and optional read, or `absent`
without either. Invalid facts, dependency failure or cancellation refuse the
publication before its effect claim or approval write. A known ineligible source
or explicit settings-invalid boundary sentinel yields absence. The existing Go
publication parser still joins the derived metadata to this same approved
workspace, identity, Git visibility and generation before the original durable
publication. Its withdrawal, correlation, unknown-storage and retained-client
fences remain authoritative. Saved metadata is never physical qualification.

Portable tests compare the real composed Go owner with the preserved TypeScript
oracle, and exercise real Go derivation through the existing framed publication
with controlled persistence. They cover provenance/time/UUID refusal, complete
model identity, clearing an old pair, cancellation and withdrawal during
derivation, crossed approval, and refusal of the retired positive ingress.
Native, packaged, installed and live-provider acceptance remains NOT RUN.

This capability's source cutover retires the active TypeScript source/read
projection. Task catalogue/setup policy, normal selected-reader activation,
provider lifecycle and durable host qualification have separate owners and
acceptance gates. Full settings-schema ownership is also a later capability;
this cutover does not make a reduced facts DTO a complete settings validator.
