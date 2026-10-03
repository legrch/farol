// Package state supplies the local serialization mechanism for Release owners.
package state

import (
	"sync"

	"github.com/legrch/farol/modules/release/app/port"
)

// New returns a fresh gate. Share the migration Service across consumers, never
// construct a new admission owner merely because its state gate is shared.
func New() port.StateGate { return &sync.Mutex{} }
