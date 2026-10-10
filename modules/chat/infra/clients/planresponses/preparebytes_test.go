package planresponses

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

type prepareByteWriter struct {
	t      *testing.T
	wanted []byte
	calls  int
}

func (w *prepareByteWriter) RoundTrip(r *http.Request) (*http.Response, error) {
	w.calls++
	got, err := io.ReadAll(r.Body)
	if err != nil || !bytes.Equal(got, w.wanted) {
		w.t.Fatalf("different prepared/actual original bytes %q vs %q error=%v", got, w.wanted, err)
	}
	return &http.Response{StatusCode: 429, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader([]byte(`{"error":{"code":"rate_limit_exceeded"}}`)))}, nil
}
func TestPreparedBytesUseActualImmutableTransportBuilder(t *testing.T) {
	r := inference.Request{Model: inference.ModelSelection{Slug: "model", Effort: "high", CapabilityEvidence: "capability", CatalogueEpoch: 1}, Input: []inference.InputItem{{Kind: "message", Role: "user", Content: "café λ🙂"}}, DeadlineMillis: uint64(time.Now().Add(time.Minute).UnixMilli())}
	transport := New(nil)
	first, err := transport.PrepareRequest(r)
	if err != nil {
		t.Fatal(err)
	}
	retained := append([]byte(nil), first...)
	first[0] = 'X'
	second, err := transport.PrepareRequest(r)
	if err != nil || !bytes.Equal(second, retained) {
		t.Fatal("caller edited original builder bytes")
	}
	w := &prepareByteWriter{t: t, wanted: second}
	got := New(&http.Client{Transport: w}).Infer(context.Background(), inference.Credential{AccessToken: "synthetic-composition-credential"}, r)
	if got.State != inference.Failed || got.Code != UsageLimited || w.calls != 1 {
		t.Fatal(got)
	}
}
func TestPreparedBytesRejectStrictGrammarWithoutEffects(t *testing.T) {
	r := inference.Request{Model: inference.ModelSelection{Slug: "model", Effort: "high", CapabilityEvidence: "capability", CatalogueEpoch: 1}, Input: []inference.InputItem{{Kind: "function_call", CallID: "call", Name: "observe", Arguments: `{"a":1,"a":2}`}, {Kind: "function_call_output", CallID: "call", Content: "data"}}}
	c := New(nil)
	if _, err := c.PrepareRequest(r); err == nil || c.Preflight(r) == nil {
		t.Fatal("strict preparation accepted duplicate original keys")
	}
	var zero *Client
	if _, err := zero.PrepareRequest(r); err == nil {
		t.Fatal("nil client accepted wire")
	}
}
