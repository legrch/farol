// Package lifecycle supplies the ordinary Chat lifecycle Journal adapter.
//
// Boot supplies one stable, qualified private physical root per profile. New
// verifies its exact device/inode/UID and creates an exclusive permanent claim.
// No directory is created, chmodded, normalized or selected here. Generic New
// refuses every retained claim after Close or crash; a new generation/root does
// not discharge an unknown outcome. No PID/time lock stealing or recovery exists.
//
// The actual live Chat owner freezes admission and retains original committed
// quiescence/disposal witnesses, explicit delivery ACK and release revisions.
// Retire atomically publishes that exact known-clean evidence, verifies it and
// closes owned descriptors before returning a receipt. A failure retains the
// permanent claim and supplies no qualified proof, even if retired bytes exist.
//
// NewAfterRetirement requires a CleanRetirement port from the actual live owner
// or trusted boot's retained known-clean origin. It locks the same existing
// claim, verifies the exact physical publication and admits only a fresh EMPTY
// scope. Prior incarnation tombstones remain bounded and are never evicted. Codec
// replay validates storage format; it never restores current handles. Root/host
// owns cross-process receipt retention, exact backend-child terminal observation
// and durable initiating-client ACK. Neither journal booleans nor process absence
// alone implements the proof port. Legacy version-1 bytes are not reopened.
//
// Context is observed between synchronous native filesystem syscalls; syscall
// latency, power-loss durability, locking and quit/reopen need separate native
// qualification. CPU storage/codec fixtures and compiled source do not prove
// installed admission, live browser cleanup or boot integration.
package lifecycle
