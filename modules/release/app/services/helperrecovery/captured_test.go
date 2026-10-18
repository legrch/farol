package helperrecovery

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

// An observation-only service must refuse mutation without touching a port.
type capturedObservation struct{ calls int }

func (o *capturedObservation) ReadPhase(context.Context) (string, error) { o.calls++; return "", nil }
func (o *capturedObservation) Entries(context.Context) (port.HelperRecoveryEntries, error) {
	o.calls++
	return port.HelperRecoveryEntries{}, nil
}
func (o *capturedObservation) MatchesTree(context.Context, port.HelperRecoveryEntry, port.HelperBuild) (bool, error) {
	o.calls++
	return false, nil
}
func (o *capturedObservation) VerifyTree(context.Context, port.HelperRecoveryEntry, port.HelperBuild) error {
	o.calls++
	return nil
}
func TestCapturedObservationCannotBecomeRecoveryWriter(t *testing.T) {
	observer := &capturedObservation{}
	service, err := ObserveCaptured(context.Background(), port.HelperRequest{Action: "recover"}, observer)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		phase, err := service.Reconcile(context.Background())
		if phase != "" || err == nil || observer.calls != 0 {
			t.Fatal("read-only observer supplied mutation", phase, err, observer.calls)
		}
	}
}
