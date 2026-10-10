package planresponses

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

// These are controlled public-URL transport fixtures, never live SIWC evidence.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixtureRequest() inference.Request {
	return inference.Request{Model: inference.ModelSelection{Slug: "fixture-model", CapabilityEvidence: "fixture-capability-v1", CatalogueEpoch: 1}, Input: []inference.InputItem{{Kind: "message", Role: "user", Content: "Summarize selected text."}}, DeadlineMillis: uint64(time.Now().Add(time.Minute).UnixMilli())}
}
func fixtureCredential() inference.Credential {
	return inference.Credential{AccessToken: "controlled-oauth-token"}
}
func streamResponse(wire string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream; charset=utf-8"}}, Body: io.NopCloser(strings.NewReader(wire))}
}

func TestRestrictedProductionRequestAndExplicitHistory(t *testing.T) {
	r := fixtureRequest()
	r.Model.Effort = "high"
	r.Input = []inference.InputItem{
		{Kind: "message", Role: "developer", Content: "fixed policy"},
		{Kind: "message", Role: "user", Content: "prior"},
		{Kind: "function_call", CallID: "call_1", Name: "lookup", Arguments: `{"q":"prior"}`},
		{Kind: "function_call_output", CallID: "call_1", Content: "prior result"},
		{Kind: "message", Role: "assistant", Content: "prior reply"},
		{Kind: "message", Role: "user", Content: "selected paragraph"},
	}
	var requests atomic.Int32
	client := New(&http.Client{Transport: roundTripFunc(func(httpRequest *http.Request) (*http.Response, error) {
		requests.Add(1)
		if httpRequest.Method != "POST" || httpRequest.URL.String() != Endpoint || httpRequest.Header.Get("Authorization") != "Bearer controlled-oauth-token" || httpRequest.Header.Get("Accept") != "text/event-stream" {
			t.Error("wrong restricted request")
		}
		var body map[string]json.RawMessage
		if json.NewDecoder(httpRequest.Body).Decode(&body) != nil {
			t.Fatal("invalid request JSON")
		}
		wantKeys := []string{"model", "input", "store", "stream", "reasoning"}
		if len(body) != len(wantKeys) {
			t.Fatalf("unexpected body keys: %v", body)
		}
		for _, key := range wantKeys {
			if _, exists := body[key]; !exists {
				t.Fatalf("missing %s", key)
			}
		}
		if string(body["store"]) != "false" || string(body["stream"]) != "true" || string(body["reasoning"]) != `{"effort":"high"}` {
			t.Fatal("unsupported defaults or effort changed")
		}
		var items []map[string]any
		if json.Unmarshal(body["input"], &items) != nil || len(items) != len(r.Input) {
			t.Fatal("history lost")
		}
		want := []map[string]any{
			{"type": "message", "role": "developer", "content": "fixed policy"},
			{"type": "message", "role": "user", "content": "prior"},
			{"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": `{"q":"prior"}`},
			{"type": "function_call_output", "call_id": "call_1", "output": "prior result"},
			{"type": "message", "role": "assistant", "content": "prior reply"},
			{"type": "message", "role": "user", "content": "selected paragraph"},
		}
		if !reflect.DeepEqual(items, want) {
			t.Fatal("history order/fields changed")
		}
		return streamResponse(created("response_1") + delta("Summary.") + terminal("response_1", "completed")), nil
	})})
	got := client.Infer(context.Background(), fixtureCredential(), r)
	if got.State != inference.Completed || got.Text != "Summary." || requests.Load() != 1 {
		t.Fatalf("%+v requests=%d", got, requests.Load())
	}
}

func TestDefaultRequestOmitsOptionalFields(t *testing.T) {
	raw, ok := requestBody(fixtureRequest())
	if !ok {
		t.Fatal("valid fixture rejected")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 4 {
		t.Fatal("unsupported default emitted")
	}
	if _, exists := fields["reasoning"]; exists {
		t.Fatal("implicit reasoning effort")
	}
}

func TestInvalidRequestNeverTouchesTransport(t *testing.T) {
	cases := map[string]func(*inference.Request){
		"system":                  func(r *inference.Request) { r.Input[0].Role = "system" },
		"empty_kind":              func(r *inference.Request) { r.Input[0].Kind = "" },
		"unknown_kind":            func(r *inference.Request) { r.Input[0].Kind = "computer_call" },
		"unknown_effort":          func(r *inference.Request) { r.Model.Effort = "unlimited" },
		"effort_without_evidence": func(r *inference.Request) { r.Model.Effort = "high"; r.Model.CapabilityEvidence = "" },
		"empty_model":             func(r *inference.Request) { r.Model.Slug = "" },
		"invalid_utf8":            func(r *inference.Request) { r.Input[0].Content = "\xff" },
		"oversized":               func(r *inference.Request) { r.Input[0].Content = strings.Repeat("x", inference.MaxInputBytes+1) },
		"unresolved_call": func(r *inference.Request) {
			r.Input = []inference.InputItem{{Kind: "function_call", CallID: "call_1", Name: "lookup", Arguments: `{}`}}
		},
		"output_before_call": func(r *inference.Request) {
			r.Input = []inference.InputItem{{Kind: "function_call_output", CallID: "call_1", Content: "result"}}
		},
		"duplicate_argument_key": func(r *inference.Request) {
			r.Input = []inference.InputItem{{Kind: "function_call", CallID: "call_1", Name: "lookup", Arguments: `{"x":1,"x":2}`}, {Kind: "function_call_output", CallID: "call_1", Content: "result"}}
		},
		"missing_deadline": func(r *inference.Request) { r.DeadlineMillis = 0 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := fixtureRequest()
			mutate(&r)
			var count atomic.Int32
			client := New(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { count.Add(1); return streamResponse(""), nil })})
			got := client.Infer(context.Background(), fixtureCredential(), r)
			if got.State != inference.NotSent || count.Load() != 0 {
				t.Fatalf("invalid request dispatched: %+v count=%d", got, count.Load())
			}
		})
	}
}

func TestDeadlineBeforeDoAndNoKeyBilling(t *testing.T) {
	var count atomic.Int32
	client := New(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		count.Add(1)
		return nil, errors.New("PRIVATE_DIAGNOSTIC")
	})})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := client.Infer(ctx, fixtureCredential(), fixtureRequest()); got.State != inference.NotSent || got.Code != inference.Cancelled {
		t.Fatalf("%+v", got)
	}
	r := fixtureRequest()
	r.DeadlineMillis = uint64(time.Now().Add(-time.Second).UnixMilli())
	if got := client.Infer(context.Background(), fixtureCredential(), r); got.State != inference.NotSent {
		t.Fatalf("%+v", got)
	}
	for _, token := range []string{"", "sk-controlled-api-key", "invalid\nheader"} {
		if got := client.Infer(context.Background(), inference.Credential{AccessToken: token}, fixtureRequest()); got.State != inference.NotSent {
			t.Fatalf("token admitted: %+v", got)
		}
	}
	if count.Load() != 0 {
		t.Fatal("pre-send refusal performed I/O")
	}
}

func TestHTTPRejectionNoRetryNoRedirectAndSanitized(t *testing.T) {
	for _, status := range []int{301, 302, 307, 400, 401, 403, 429, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var count atomic.Int32
			original := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { t.Error("caller redirect policy invoked"); return nil }, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				count.Add(1)
				if r.URL.String() != Endpoint {
					t.Error("unauthorized endpoint")
				}
				return &http.Response{StatusCode: status, Header: http.Header{"Location": {"https://example.invalid/steal"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"untrusted-secret","message":"PRIVATE_PROVIDER_MESSAGE"}}`))}, nil
			})}
			client := New(original)
			got := client.Infer(context.Background(), fixtureCredential(), fixtureRequest())
			if got.State != inference.Failed || got.HTTPStatus != status || count.Load() != 1 || got.Text != "" {
				t.Fatalf("%+v count=%d", got, count.Load())
			}
			public, _ := json.Marshal(got)
			if strings.Contains(string(public), "PRIVATE") || strings.Contains(string(public), "untrusted-secret") {
				t.Fatal("raw diagnostic retained")
			}
			if original.CheckRedirect == nil {
				t.Fatal("caller HTTP client mutated")
			}
		})
	}
}

func TestCatalogueModelDenialIsKnownFailure(t *testing.T) {
	var count atomic.Int32
	client := New(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		count.Add(1)
		return &http.Response{StatusCode: 400, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"code":"invalid_request_error","param":"model","message":"PRIVATE_PROVIDER_MESSAGE"}}`))}, nil
	})})
	got := client.Infer(context.Background(), fixtureCredential(), fixtureRequest())
	if got.State != inference.Failed || got.Code != ModelDenied || count.Load() != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestDoFailureAfterEntryIsUnknownAndOneShot(t *testing.T) {
	var count atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	client := New(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		count.Add(1)
		cancel()
		return nil, errors.New("PRIVATE_TRANSPORT_DIAGNOSTIC")
	})})
	got := client.Infer(ctx, fixtureCredential(), fixtureRequest())
	if got.State != inference.Unknown || got.Text != "" || got.Code != TransportUnknown || count.Load() != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestRedirectRefusalDoesNotDependOnConstructor(t *testing.T) {
	var count atomic.Int32
	client := &Client{http: http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		count.Add(1)
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://example.invalid/steal"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}}
	got := client.Infer(context.Background(), fixtureCredential(), fixtureRequest())
	if got.State != inference.Failed || count.Load() != 1 {
		t.Fatalf("%+v count=%d", got, count.Load())
	}
}

type cancelBody struct {
	prefix *strings.Reader
	ctx    context.Context
	closed atomic.Bool
}

func (b *cancelBody) Read(p []byte) (int, error) {
	if b.prefix.Len() != 0 {
		return b.prefix.Read(p)
	}
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}
func (b *cancelBody) Close() error { b.closed.Store(true); return nil }

func TestCancellationAndAbsoluteDeadlineMidstreamAreUnknown(t *testing.T) {
	for _, mode := range []string{"cancel", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var count atomic.Int32
			var body *cancelBody
			client := New(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				count.Add(1)
				body = &cancelBody{prefix: strings.NewReader(created("response_1") + delta("PRIVATE_PARTIAL")), ctx: r.Context()}
				if mode == "cancel" {
					cancel()
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: body}, nil
			})})
			r := fixtureRequest()
			if mode == "deadline" {
				r.DeadlineMillis = uint64(time.Now().Add(30 * time.Millisecond).UnixMilli())
			}
			got := client.Infer(ctx, fixtureCredential(), r)
			if got.State != inference.Unknown || got.Text != "" || got.Code != inference.Cancelled || count.Load() != 1 || !body.closed.Load() {
				t.Fatalf("%+v count=%d", got, count.Load())
			}
		})
	}
}

func TestContentTypeIsRequired(t *testing.T) {
	for _, mime := range []string{"", "application/json", "text/html", "text/plain"} {
		t.Run(mime, func(t *testing.T) {
			client := New(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				r := streamResponse(created("r") + terminal("r", "completed"))
				r.Header.Set("Content-Type", mime)
				return r, nil
			})})
			got := client.Infer(context.Background(), fixtureCredential(), fixtureRequest())
			if got.State != inference.Unknown || got.Code != StreamInvalid || got.Text != "" {
				t.Fatalf("%+v", got)
			}
		})
	}
}
