// Portable pure-domain clock-property regression; no host clock manipulation.
package authority_test

import (
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestExecutionLeaseRetainsMonotonicDeadlineAtPersistedOwnerCeiling(t *testing.T) {
	at := time.Now()
	if at == at.Round(0) {
		t.Fatal("native clock sample lacks monotonic reading")
	}
	p := authority.Participant{ParticipantID: "controlled-original-participant", Grant: authority.Grant{
		ComputerID: "controlled-computer", ComputerGeneration: 1,
		Policy: authority.Policy{FilePolicy: authority.RootScopedFiles, ExpiresAt: at.Add(time.Hour)},
	}}
	for _, tc := range []struct {
		name      string
		remaining time.Duration
	}{
		{"uncapped-control", time.Hour}, {"persisted-owner-ceiling", 2 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ownerExpiry := at.Add(tc.remaining).Round(0)
			a := authority.Approval{ComputerID: "controlled-computer", Generation: 1,
				FilePolicy: authority.RootScopedFiles, ExpiresAt: ownerExpiry}
			lease, err := authority.Lease(p, a, at, authority.VerificationExecutionLifetime)
			if err != nil {
				t.Fatal(err)
			}
			deadline := lease.Deadline()
			if tc.remaining < authority.VerificationExecutionLifetime && !deadline.Equal(ownerExpiry) {
				t.Fatal("lease lost original owner expiry ceiling")
			}
			if lease.Check(deadline) == nil {
				t.Fatal("exact fixed deadline admitted")
			}
			if deadline == deadline.Round(0) {
				t.Fatal("persisted wall expiry discarded the operation's monotonic deadline")
			}
		})
	}
}
