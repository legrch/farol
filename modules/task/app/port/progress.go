package port

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

// Fingerprint returns the lowercase SHA-256 of the supplied canonical bytes.
// Trusted composition injects one deterministic implementation for persisted
// intentions and reconnect comparisons; it performs no IO and retains no input.
type Fingerprint func([]byte) string

// ProgressFactory creates an independent gate for one Dispatch. The recorder
// belongs to app policy and may persist lineage through the injected Journal.
// Gates are never shared across operations or service instances.
type ProgressFactory func(func(context.Context, task.Reference) error) Progress

// Record serializes concurrent callbacks. Its first failure is sticky. Close
// joins callbacks already inside the gate, seals it, then calls inspect exactly
// once under the same gate if no Record failed. All later Record/Close calls fail
// without invoking callbacks. Provider.Dispatch must still join all callbacks
// before returning; the gate does not make a late provider event terminal proof.
// Neither callback may reenter the gate or acquire Computer. Journal IO here is
// separate from the synchronous, no-IO CurrentTaskAdmission projection.
type Progress interface {
	Record(context.Context, task.Reference) error
	Close(inspect func() error) error
}
