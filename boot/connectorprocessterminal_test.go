package boot

import (
	"context"
	"errors"
	"strings"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Existing root and current connector owners, with an explicit publication
// double. Durable/native storage and actual child settlement are not qualified.
type connectorProcessPublisherDouble struct {
	*connectorProcessJournalDouble
	s         *computerConnector
	result    *processsvc.TerminalResult
	publishes int
	after     func()
	err       error
	digest    string
}

// Explicit guarded capture is a test-only interleaving driver. Production uses
// the started child's lifecycle collector; external Read never publishes.
func (s *computerConnector) retainProcess(ctx context.Context, slot *connectorSlot, operation string) (string, error) {
	current, err := s.processObservation(ctx, slot)
	if err != nil {
		return "", err
	}
	s.mutations.mu.Lock()
	record := s.mutations.operations[operation]
	s.mutations.mu.Unlock()
	if record == nil || record.process == nil || record.process.service == nil {
		return "", connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	return s.retainProcessResult(ctx, operation, record, func(ctx context.Context) (*processsvc.TerminalResult, error) {
		return record.process.service.CaptureTerminal(ctx, current, record.process.workspace)
	})
}

func (p *connectorProcessPublisherDouble) PublishProcessTerminal(_ context.Context, result processsvc.TerminalResult) (string, error) {
	if !p.s.mutations.mu.TryLock() {
		return "", errors.New("publication under ledger gate")
	}
	p.s.mutations.mu.Unlock()
	if p.s.current != nil {
		if !p.s.current.guard.mu.TryLock() {
			return "", errors.New("publication under current host gate")
		}
		p.s.current.guard.mu.Unlock()
	}
	p.publishes++
	if !processsvc.ValidTerminalResult(result) || result.Intent != p.intent || result.Scope != p.scope {
		return "", errors.New("crossed original result")
	}
	copy := result.Clone()
	p.result = &copy
	if p.after != nil {
		p.after()
	}
	return p.digest, p.err
}

func TestConnectorProcessTerminalKnownPublicationSettlesOriginal(t *testing.T) {
	s, _, journal, native, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, native)
	// A running capture is read-only and does not consume a publication attempt.
	if digest, err := s.retainProcess(context.Background(), s.current, start.OperationID); digest != "" || err == nil || publisher.publishes != 0 {
		t.Fatal("running result published", digest, err)
	}
	native.terminal = true
	digest, err := s.retainProcess(context.Background(), s.current, start.OperationID)
	if err != nil || digest != publisher.digest || publisher.publishes != 1 || publisher.result == nil || string(publisher.result.Observation.Stdout) != "saved" || string(publisher.result.Observation.Stderr) != "err" {
		t.Fatal("known original terminal missing", digest, err)
	}
	if digest, err := s.retainProcess(context.Background(), s.current, start.OperationID); digest != "" || err == nil || publisher.publishes != 1 {
		t.Fatal("publication repeated", digest, err)
	}
	if s.mutations.freezeForRetirement() != nil || native.spawns != 1 || journal.reserves != 1 {
		t.Fatal("known result not settled or start repeated")
	}
}

func TestConnectorProcessTerminalLostAndLatePublicationRemainUnsettled(t *testing.T) {
	for _, fault := range []string{"lost-ack", "cancelled-caller", "bad-digest", "freeze-during-publication", "withdraw-before-capture"} {
		t.Run(fault, func(t *testing.T) {
			s, _, journal, native, _ := connectorProcessFixture(t)
			publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
			s.mutations.dependencies.repository = publisher
			start := startConnectorProcessFixture(t, s, native)
			native.terminal = true
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "lost-ack":
				publisher.err = errors.New("controlled lost ACK after saved bytes")
			case "cancelled-caller":
				publisher.after = cancel
			case "bad-digest":
				publisher.digest = "invalid"
			case "freeze-during-publication":
				publisher.after = func() {
					if s.mutations.freezeForRetirement() == nil {
						t.Fatal("publication pending but retirement passed")
					}
				}
			case "withdraw-before-capture":
				s.current.guard.close()
			}
			digest, err := s.retainProcess(ctx, s.current, start.OperationID)
			if digest != "" || err == nil {
				t.Fatal("lost/denied publication passed", digest, err)
			}
			// Valid-looking saved bytes and a fresh caller do not retry the
			// original lost publication, even before retirement freezes the ledger.
			publisher.err, publisher.after, publisher.digest = nil, nil, strings.Repeat("a", 64)
			if digest, err := s.retainProcess(context.Background(), s.current, start.OperationID); digest != "" || err == nil || publisher.publishes > 1 {
				t.Fatal("later valid-looking bytes retried publication", digest, err)
			}
			if s.mutations.freezeForRetirement() == nil {
				t.Fatal("unknown retirement upgraded")
			}
			if fault == "withdraw-before-capture" {
				if publisher.publishes != 0 || native.reads != 0 {
					t.Fatal("withdrawn capture performed IO")
				}
			} else if publisher.publishes != 1 || s.mutations.operations[start.OperationID].process.result == nil {
				t.Fatal("original memory result lost")
			}
		})
	}
}
