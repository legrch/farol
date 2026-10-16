package boot

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/archive"
	"github.com/legrch/farol/transport/desktop"
)

type archiveStoreFixture struct{ calls int }

func (s *archiveStoreFixture) ListStoredReplies(context.Context, chatport.ArchiveListSelection) (*chatport.ArchivePage, error) {
	s.calls++
	return &chatport.ArchivePage{Entries: []chatport.ArchiveSummary{}}, nil
}
func (s *archiveStoreFixture) ReadStoredReply(context.Context, chatport.ArchiveReadSelection) (*chatport.ArchivedReply, error) {
	s.calls++
	return nil, archive.Unavailable
}
func TestArchiveIngressRejectsEffectsAuthorityFieldsAndInvalidSelections(t *testing.T) {
	store := &archiveStoreFixture{}
	a, err := newHistoryReadAuthority(context.Background(), chatport.HistoryReadScope{ProfileID: "profile", BackendGeneration: "recovery", OwnerID: "owner"}, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	s, err := archive.New(chatport.JournalScope{ProfileID: "profile", BackendGeneration: "recovery"}, archive.Dependencies{Authority: a, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	methods := chatArchiveMethods(s)
	for _, tc := range []struct{ method, body, operation string }{
		{"list", `{"after":""}`, "effect"},
		{"list", `{"after":"","ownerId":"other"}`, ""},
		{"list", `{"after":"../journal"}`, ""},
		{"read", `{"key":"` + strings.Repeat("a", 64) + `","digest":"` + strings.Repeat("a", 64) + `","profileId":"other"}`, ""},
		{"read", `{"key":"` + strings.Repeat("a", 64) + `","digest":"` + strings.Repeat("a", 64) + `"}`, "effect"},
		{"read", `{"key":"` + strings.Repeat("a", 64) + `","digest":"` + strings.Repeat("0", 64) + `"}`, ""},
	} {
		out, err := methods["chat.archive."+tc.method].Handle(context.Background(), desktop.Request{Body: json.RawMessage(tc.body), OperationID: tc.operation})
		if err != nil || out == nil || out.Status != "refused" || len(out.Data) != 0 || store.calls != 0 {
			t.Fatal("invalid query reached archive", out, err)
		}
	}
	out, err := methods["chat.archive.list"].Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{"after":""}`)})
	if err != nil || out.Status != "ok" || store.calls != 1 || wire.Validate("ChatArchivePage", out.Data) != nil || string(out.Data) != `{"observation":"stored_unconfirmed","entries":[],"next":"","unresolved":false}` {
		t.Fatal("unconfirmed empty observation not exact", out, err)
	}
	a.close()
	out, err = methods["chat.archive.list"].Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{"after":""}`)})
	if err != nil || out.Status != "refused" || len(out.Data) != 0 || store.calls != 1 {
		t.Fatal("closed authority reached archive", out, err)
	}
}

func TestArchiveWireRejectsPromotedProofsInBothResponseShapes(t *testing.T) {
	raw, err := os.ReadFile("../api/desktop/v1/fixtures/chat-archive.json")
	if err != nil || wire.Validate("ChatArchiveReply", raw) != nil {
		t.Fatal("invalid synthetic archive fixture", err)
	}
	for _, kind := range []string{"provenance", "outcome", "ack", "complete", "owner"} {
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		switch kind {
		case "provenance":
			value["observation"] = "completed"
		case "outcome":
			value["summary"].(map[string]any)["recordedOutcome"] = "accepted"
		case "ack":
			value["acknowledged"] = true
		case "complete":
			value["complete"] = true
		case "owner":
			value["ownerId"] = "other"
		}
		changed, err := json.Marshal(value)
		if err != nil || wire.Validate("ChatArchiveReply", changed) == nil {
			t.Fatal("promoted archive proof accepted", kind, err)
		}
	}
	if wire.Validate("ChatHistoryResult", raw) == nil {
		t.Fatal("archive DTO became accepted historical result")
	}
}
