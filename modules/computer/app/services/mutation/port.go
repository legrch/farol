package mutation

import (
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
)

// Composition selects the SAME lease for admission, preparation, publication
// and disclosure. No renewal, lookup, ACK or new authority owner exists here.
type Execution interface {
	port.ExecutionAccessRepository
	Deadline() time.Time
}
type Gate interface {
	Lock()
	Unlock()
}
