package archive

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestReadPreservesStoredTextAsUnconfirmedOnly(t *testing.T) {
	s, _, store := fixture(t)
	query := ReadQuery{Key: store.reply.Summary.Key, Digest: store.reply.Summary.Digest}
	reply, err := s.Read(context.Background(), query)
	if err != nil || reply.Observation != Observation || reply.Text != "stored" || reply.Summary.RecordedOutcome != "completed" {
		t.Fatal("missing stored data", reply, err)
	}
	if store.selectedRead.ProfileID != "profile" || store.selectedRead.OwnerID != "owner" || store.selectedRead.Key != query.Key || store.selectedRead.Digest != query.Digest {
		t.Fatal("read lost selected authority or record")
	}
	// An absent provider CID is retained as absent, not invented for recovery.
	store.reply.Summary.ConversationID = ""
	if reply, err := s.Read(context.Background(), query); err != nil || reply.Summary.ConversationID != "" {
		t.Fatal("missing historical CID manufactured or rejected", err)
	}
}
func TestReadRefusesChangedDataAndWithdrawnOriginalLease(t *testing.T) {
	for _, kind := range []string{"withdraw", "scope", "cancel", "profile", "owner", "key", "digest", "bytes", "utf8", "nil", "error"} {
		t.Run(kind, func(t *testing.T) {
			s, a, store := fixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			query := ReadQuery{Key: store.reply.Summary.Key, Digest: store.reply.Summary.Digest}
			switch kind {
			case "withdraw":
				store.afterIO = func() { a.closed = true }
			case "scope":
				store.afterIO = func() { a.scope.OwnerID = "replacement" }
			case "cancel":
				store.afterIO = cancel
			case "profile":
				store.reply.Summary.ProfileID = "other"
			case "owner":
				store.reply.Summary.OwnerID = "other"
			case "key":
				store.reply.Summary.Key = strings.Repeat("b", 64)
			case "digest":
				store.reply.Summary.Digest[0]++
			case "bytes":
				store.reply.Text += "late"
			case "utf8":
				store.reply.Text = string([]byte{255, 255, 255, 255, 255, 255})
			case "nil":
				store.reply = nil
			case "error":
				store.err = errors.New("read unavailable")
			}
			if reply, err := s.Read(ctx, query); reply != nil || err == nil {
				t.Fatal("unsafe retained text exposed", reply, err)
			}
		})
	}
}
func TestReadRequiresExactOpaqueKeyAndDigestBeforeIO(t *testing.T) {
	s, _, store := fixture(t)
	for _, query := range []ReadQuery{{}, {Key: strings.Repeat("a", 64)}, {Key: "../claim", Digest: [32]byte{1}}} {
		if reply, err := s.Read(context.Background(), query); reply != nil || !errors.Is(err, Invalid) || store.readCalls != 0 {
			t.Fatal("unselected read reached archive", err)
		}
	}
}
