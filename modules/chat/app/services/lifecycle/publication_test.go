package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// CPU storage fixture; publication/physical roots are explicit fixtures, not
// evidence of native durability, child termination or restart permission.
type durableResultFixture struct {
	resultFixture
	publication   port.ResultPublication
	stored        port.RetainRequest
	reads, fences int
	readFault     string
	readHook      func()
}

func publicationFixture() port.ResultPublication {
	return port.ResultPublication{Version: 1, Root: port.JournalRoot{Device: 11, Inode: 23, OwnerUID: 501}, StorageRoot: port.JournalRoot{Device: 11, Inode: 24, OwnerUID: 501}, Digest: [32]byte{5}, EncodedBytes: 1024}
}
func (d *durableResultFixture) Retain(ctx context.Context, r port.RetainRequest) (*port.RetainReceipt, error) {
	d.stored = r
	d.stored.Payload = append([]byte(nil), r.Payload...)
	receipt, err := d.resultFixture.Retain(ctx, r)
	if receipt != nil {
		receipt.Publication = d.publication
	}
	return receipt, err
}
func (d *durableResultFixture) Read(_ context.Context, r port.ResultRead) (*port.RetainRequest, error) {
	d.reads++
	if d.readHook != nil {
		d.readHook()
	}
	if r.Binding != d.stored.Binding || r.Result != d.stored.Result || r.Publication != d.publication {
		return nil, errors.New("fixture crossed reference")
	}
	out := d.stored
	out.Payload = append([]byte(nil), d.stored.Payload...)
	switch d.readFault {
	case "error":
		return nil, errors.New("fixture unavailable")
	case "nil":
		return nil, nil
	case "binding":
		out.Binding.TaskEpoch++
	case "result":
		out.Result.ID = "other"
	case "metadata":
		out.Conversation.ProviderReplyID = "other"
	case "bytes":
		out.Payload = append(out.Payload, 'x')
	case "changed-text":
		out.Payload[0] = 'X'
	}
	return &out, nil
}
func (d *durableResultFixture) Fence(context.Context) error {
	d.fences++
	return errors.New("fixture best-effort fence")
}

func durableConversationOwner(t *testing.T) (*Service, *conversationBrowser, *retirementJournal, *durableResultFixture) {
	t.Helper()
	b, j, r := &conversationBrowser{}, &retirementJournal{}, &durableResultFixture{publication: publicationFixture()}
	s, err := New(context.Background(), port.JournalScope{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend"}, Dependencies{Gate: gate.New(), Journal: j, Browser: b, Results: r, ResultBytesLimit: OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	return s, b, j, r
}

func TestDurablePublicationJoinsOriginalTerminalJournalAndRetirement(t *testing.T) {
	s, b, j, store := durableConversationOwner(t)
	c, _ := completedFirst(t, s, b)
	terminalCount := 0
	for _, write := range j.writes {
		if write.Entry.Kind == "finish" {
			terminalCount++
			if write.Entry.ResultPublication != store.publication {
				t.Fatal("terminal lost exact publication")
			}
		} else if write.Entry.ResultPublication != (port.ResultPublication{}) {
			t.Fatal("publication attached to nonterminal transition")
		}
	}
	if terminalCount != 1 || c.handle.retained == nil || c.handle.retained.Publication != store.publication {
		t.Fatal("live publication not committed")
	}
	proof, err := s.Retire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	known := receiptOf(t, proof)
	if store.reads != 1 || known.Write.Turns[0].ResultPublication != store.publication || j.retireCalls != 1 || store.fences != 0 {
		t.Fatal("retirement lost known readback")
	}
}

func TestDurablePublicationMissingCrossedOrLateReplyStaysUnknown(t *testing.T) {
	for _, fault := range []string{"zero", "root", "digest", "version", "size", "lost", "late"} {
		t.Run(fault, func(t *testing.T) {
			s, b, j, store := durableConversationOwner(t)
			c, _ := createPrepared(t, s)
			b.events = observations("user", "reply", "answer")
			if err := c.Send(context.Background(), 100); err != nil {
				t.Fatal(err)
			}
			observeOK(t, c)
			observeOK(t, c)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "zero":
				store.publication = port.ResultPublication{}
			case "root":
				store.publication.Root.Inode++
			case "digest":
				store.publication.Digest = [32]byte{}
			case "version":
				store.publication.Version++
			case "size":
				store.publication.EncodedBytes = port.MaxResultRecordBytes + 1
			case "lost":
				store.fault = "error"
			case "late":
				store.hook = func(port.RetainRequest) { cancel() }
			}
			writes := j.count()
			if err := c.Observe(ctx, 100); !errors.Is(err, Unsettled) {
				t.Fatal("uncertain publication accepted", err)
			}
			if c.handle.retained != nil || j.count() != writes || store.fences != 1 {
				t.Fatal("late publication became committed")
			}
			if err := c.Observe(context.Background(), 100); !errors.Is(err, Unsettled) || store.calls != 1 || store.fences != 1 {
				t.Fatal("uncertainty retried")
			}
		})
	}
}

func TestRetirementUnreadablePublicationRefusesBeforeJournalRetire(t *testing.T) {
	for _, fault := range []string{"error", "nil", "binding", "result", "metadata", "bytes", "changed-text", "late"} {
		t.Run(fault, func(t *testing.T) {
			s, b, j, store := durableConversationOwner(t)
			completedFirst(t, s, b)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store.readFault = fault
			if fault == "late" {
				store.readHook = cancel
			}
			if _, err := s.Retire(ctx); !errors.Is(err, Unsettled) {
				t.Fatal("unreadable result became clean retirement", err)
			}
			if j.retireCalls != 0 || store.reads != 1 {
				t.Fatal("retirement written before result readback")
			}
			if _, err := s.Retire(context.Background()); !errors.Is(err, Unsettled) || store.reads != 1 {
				t.Fatal("uncertain readback retried", err)
			}
		})
	}
}

func TestDurableBytesWithoutKnownTerminalJournalNeverBecomeRetirement(t *testing.T) {
	s, b, j, store := durableConversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("user", "reply", "answer")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	j.fault = "error"
	if err := c.Observe(context.Background(), 100); !errors.Is(err, Unsettled) {
		t.Fatal("lost journal outcome accepted", err)
	}
	if store.calls != 1 || c.handle.retained != nil {
		t.Fatal("orphan durable bytes became known terminal")
	}
	if _, err := s.Retire(context.Background()); !errors.Is(err, Unsettled) || j.retireCalls != 0 || store.reads != 0 {
		t.Fatal("orphan result supplied retirement", err)
	}
}
