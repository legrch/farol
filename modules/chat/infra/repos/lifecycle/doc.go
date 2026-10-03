// Package lifecycle supplies the ordinary Chat lifecycle Journal adapter.
//
// Boot supplies one qualified, stable private physical root PER PROFILE, not a
// new directory per backend incarnation or request. New verifies its exact
// device/inode/UID and creates an exclusive permanent claim before exposing a
// repository. No directory is created, chmodded, normalized or selected here.
// Claim and snapshot names do not depend on BackendGeneration. A retained claim
// refuses every new owner, including a different backend generation, even after
// Close or a crash. No PID/time lock stealing, history restore or replay exists.
//
// The current port cannot express safe retirement/reconciliation of an earlier
// incarnation. Boot must not bypass that limitation by supplying another empty
// root. Future reopen needs explicit owner-qualified unresolved-publication and
// lifecycle/delivery settlement evidence; this adapter adds no recovery API.
//
// Quiescence/disposal origin is not reconstructed from journal booleans. The
// current port stores settled projections without the exact cleanup witness;
// recovery would require that original evidence before any retirement decision.
// Context is observed between synchronous local filesystem syscalls. A kernel
// syscall cannot be interrupted here; qualified storage latency/cancellation and
// filesystem power-loss guarantees remain native acceptance requirements.
//
// Native filesystem/durability qualification is separate from the injected
// storage and codec tests. A compiled adapter is not installed admission proof.
package lifecycle
