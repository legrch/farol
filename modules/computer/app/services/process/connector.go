package process

import "github.com/legrch/farol/modules/computer/app/port"

// ConnectorReservationScope is immutable correlation selected by trusted root.
// It grants no admission, host qualification, execution or recovery authority.
// All fields are scalar values; the repository adapter retains an exact copy.
type ConnectorReservationScope struct {
	Host                           port.ConnectorHost
	OwnerID, ComputerID, CallID    string
	ComputerGeneration, Generation uint64
}
