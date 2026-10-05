package results

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

func codecResultFixture() resultRecord {
	return resultRecord{Version: 1, Root: port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 3}, StorageRoot: port.JournalRoot{Device: 1, Inode: 4, OwnerUID: 3}, Request: conversationResultFixture()}
}
func TestResultCodecCanonicalClosedAndBinaryPayload(t *testing.T) {
	r := codecResultFixture()
	raw, err := encodeResult(r)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeResult(raw)
	if err != nil || decoded.Request.Binding != r.Request.Binding || decoded.Request.Conversation != r.Request.Conversation || !bytes.Equal(decoded.Request.Payload, r.Request.Payload) {
		t.Fatal("roundtrip", err)
	}
	for _, bad := range [][]byte{
		append([]byte(" "), raw...), append(raw, '\n'), append(raw, raw...),
		bytes.Replace(raw, []byte(`"Version":1`), []byte(`"Version":1,"Version":1`), 1),
		bytes.Replace(raw, []byte(`"Version":1`), []byte(`"Version":2`), 1),
		bytes.Replace(raw, []byte(`"Version":1`), []byte(`"Version":1,"unknown":true`), 1),
		bytes.Replace(raw, []byte(`"Version":1`), []byte(`"Version":1.0`), 1),
		[]byte(strings.Repeat("[", 25) + strings.Repeat("]", 25)), []byte{255}, nil, make([]byte, port.MaxResultRecordBytes+1),
	} {
		if _, err := decodeResult(bad); err == nil {
			t.Fatal("noncanonical/unknown schema accepted")
		}
	}
	r.Request.Conversation = port.RetainedConversation{}
	r.Request.Payload = []byte{0, 255, 1}
	raw, err = encodeResult(r)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err = decodeResult(raw)
	if err != nil || !bytes.Equal(decoded.Request.Payload, r.Request.Payload) {
		t.Fatal("binary generic payload altered", err)
	}
	r.Request.Payload = nil
	a, _ := encodeResult(r)
	r.Request.Payload = []byte{}
	b, _ := encodeResult(r)
	if !bytes.Equal(a, b) {
		t.Fatal("empty bytes lack canonical spelling")
	}
}
func TestResultCodecDigestCoversRootsBindingResultMetadataAndPayload(t *testing.T) {
	original := codecResultFixture()
	raw, _ := encodeResult(original)
	p := resultPublication(original, raw)
	for _, mutate := range []func(*resultRecord){
		func(r *resultRecord) { r.Root.Inode++ }, func(r *resultRecord) { r.StorageRoot.Inode++ },
		func(r *resultRecord) { r.Request.Binding.TaskEpoch++ }, func(r *resultRecord) { r.Request.Result.ID = "changed" },
		func(r *resultRecord) { r.Request.Conversation.ProviderReplyID = "changed" }, func(r *resultRecord) { r.Request.Conversation.Evidence.EvidenceID = "changed" }, func(r *resultRecord) { r.Request.Payload = []byte("changed") },
	} {
		r := original
		mutate(&r)
		changed, err := encodeResult(r)
		if err != nil || resultPublication(r, changed).Digest == p.Digest {
			t.Fatal("record field not digested", err)
		}
	}
	a := resultKey(original.Request)
	q := original.Request
	q.Payload = []byte("different-content")
	q.Result.ID = "different-result"
	q.Conversation = port.RetainedConversation{}
	if resultKey(q) != a {
		t.Fatal("content enters filename")
	}
	q.Binding.BackendGeneration = "other"
	if resultKey(q) == a {
		t.Fatal("backend missing from filename")
	}
}
func TestResultCodecMaximumMetadataBoundAndInvalidRequests(t *testing.T) {
	r := codecResultFixture()
	id := strings.Repeat("<", 120)
	b := &r.Request.Binding
	b.ProfileID = id
	b.BackendGeneration = id
	b.OwnerID = id
	b.SessionID = id
	b.TaskID = id
	b.ParticipantID = id
	b.TurnID = id
	b.OperationID = id
	r.Request.Result.ID = id
	r.Request.Result.Code = strings.Repeat("X", 120)
	r.Request.Payload = bytes.Repeat([]byte("x"), 8192)
	s := port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: id, ModelID: id, Effort: strings.Repeat("x", 40), Mode: "standard", ToolsEnabled: true, ConnectorID: id, ConnectorGrantID: id}
	f := (port.SelectionFacts{Model: port.ControlFact{Value: id, Literal: strings.Repeat("<", 256), Source: port.FactPublicControl}, Effort: port.ControlFact{Value: s.Effort, Literal: strings.Repeat("<", 256), Source: port.FactPublicControl}, Mode: port.ControlFact{Value: s.Mode, Literal: strings.Repeat("<", 256), Source: port.FactPublicControl}, Connector: port.ControlFact{Value: id, Literal: strings.Repeat("<", 256), Source: port.FactPublicControl}, ObservedAtMillis: 1}).Projection()
	resolution := port.ModelResolution{RequestedAlias: id, RequestedExecutor: id, RequestedEffort: id, RequestedMode: "standard", Resolved: s, ConfigSHA256: strings.Repeat("a", 64), TranslationID: id}
	r.Request.Conversation = port.RetainedConversation{ProviderConversationID: id, ProviderUserTurnID: id, ProviderReplyID: id, Requested: s, Observed: f, Complete: true, Evidence: port.SelectionEvidence{Requested: s, Admitted: s, Observed: f, Resolution: resolution, ResolutionSource: "configured", AdmissionSource: "chat-policy", ObservationSource: "field-facts", PinnedSource: "configured-pinned-scope", EvidenceID: id}}
	raw, err := encodeResult(r)
	if err != nil || len(raw) > port.MaxResultRecordBytes {
		t.Fatal("max record rejected", err)
	}
	if _, err := decodeResult(raw); err != nil {
		t.Fatal("max roundtrip", err)
	}
	for _, mutate := range []func(*resultRecord){
		func(r *resultRecord) { r.Version = 2 }, func(r *resultRecord) { r.StorageRoot = r.Root },
		func(r *resultRecord) { r.Request.Payload = make([]byte, 8193) }, func(r *resultRecord) { r.Request.Conversation.Complete = false },
		func(r *resultRecord) { r.Request.Binding.TaskEpoch = 0 }, func(r *resultRecord) { r.Request.Result.Code = "raw error" },
	} {
		bad := r
		mutate(&bad)
		if _, err := encodeResult(bad); err == nil {
			t.Fatal("invalid record encoded")
		}
	}
	// A missing field can decode to a valid zero value; re-encoding still rejects
	// the noncanonical omission rather than silently upgrading old schemas.
	var object map[string]json.RawMessage
	_ = json.Unmarshal(raw, &object)
	delete(object, "Version")
	bad, _ := json.Marshal(object)
	if _, err := decodeResult(bad); err == nil {
		t.Fatal("missing schema field accepted")
	}
}
