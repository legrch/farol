package port

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

type ReservationStatus string

const (
	Reserved ReservationStatus = "reserved"
	Existing ReservationStatus = "existing"
)

type ReservationReceipt struct {
	Status ReservationStatus
	Intent task.NativeReservation
}

// ReservationJournal is an optional capability of the SAME AdmissionJournal.
// ReserveNative atomically attaches an immutable native intent to an existing
// pending active launch operation. Only a fresh known publication is Reserved;
// Existing is retained observation and never another spawn permit. Failure may
// follow publication. No timestamp, restart or absent field authorizes replay.
type ReservationJournal interface {
	ReserveNative(context.Context, task.NativeReservation) (*ReservationReceipt, error)
}

// SelectedReservation is the application port implemented by that operation's
// existing Owner route, not a separate reservation owner or journal. Selection
// is trusted composition; request IDs cannot select another admission or turn.
type SelectedReservation interface {
	ReservationJournal
	Selection() CurrentBinding
}
