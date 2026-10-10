package catalogue_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/catalogue"
)

const planJSON = `{"models":[{"slug":"fixture-model","display_name":"Fixture Model","visibility":"list","supported_reasoning_levels":[{"effort":"deliberate"}],"default_reasoning_level":"deliberate"}]}`
const appJSON = `{"data":[{"id":"ui-id","model":"fixture-model","displayName":"Fixture Model","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"deliberate","description":"Fixture effort"}],"defaultReasoningEffort":"deliberate"}],"nextCursor":null}`

func scope(backend selection.Backend) selection.Scope {
	provider := "openai"
	if backend == selection.CodexTask {
		provider = "codex"
	}
	if backend == selection.BrowserChat {
		provider = "farol"
	}
	return selection.Scope{Route: selection.Route{Provider: provider, Backend: backend, Billing: selection.Plan}, AccountID: "fixture-account-A"}
}
func caps() selection.Capabilities {
	return selection.Capabilities{Text: selection.Yes, Image: selection.No, Tools: selection.No, Revision: "fixture-capability-1", Provenance: "controlled-product-profile"}
}

type transport struct {
	pages  []catalogue.Page
	calls  int
	err    error
	cancel context.CancelFunc
}

func (f *transport) List(_ context.Context, _ selection.Scope, _ string) (catalogue.Page, error) {
	f.calls++
	if f.cancel != nil {
		f.cancel()
	}
	if f.err != nil {
		return catalogue.Page{}, f.err
	}
	if f.calls > len(f.pages) {
		return catalogue.Page{}, errors.New("fixture network unavailable")
	}
	return f.pages[f.calls-1], nil
}
func read(t *testing.T, backend selection.Backend, raw string) selection.Snapshot {
	t.Helper()
	s := scope(backend)
	source := selection.SIWC
	if backend == selection.CodexTask {
		source = selection.AppServer
	}
	f := &transport{pages: []catalogue.Page{{Scope: s, Body: []byte(raw)}}}
	out, err := catalogue.Read(context.Background(), f, s, source, catalogue.Stamp{Epoch: 1, Revision: "fixture-catalogue-1", ObservedAtMillis: 10, ExpiresAtMillis: 100})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDeclaredSourceMappingPreservesUnknowns(t *testing.T) {
	for _, backend := range []selection.Backend{selection.PlanInference, selection.CodexTask} {
		raw := planJSON
		if backend == selection.CodexTask {
			raw = appJSON
		}
		out := read(t, backend, raw)
		if len(out.Entries) != 1 || out.Entries[0].Slug != "fixture-model" || out.Entries[0].DefaultEffort != "deliberate" || out.Entries[0].Capabilities.Text != selection.Unknown {
			t.Fatalf("unexpected mapping: %+v", out)
		}
		if _, err := selection.Resolve(out, out.Scope, 11, selection.Request{Slug: "fixture-model", Requirements: selection.Requirements{Text: true}}); err == nil {
			t.Fatal("catalogue alone granted text support")
		}
	}
	raw := `{"models":[{"slug":"fixture-model","display_name":"Fixture Model","visibility":"list","unknown":{"safe":true}}]}`
	out := read(t, selection.PlanInference, raw)
	if len(out.Entries[0].Efforts) != 0 || out.Entries[0].DefaultEffort != "" {
		t.Fatal("invented effort metadata")
	}
	if _, err := catalogue.ParseSIWC([]byte(appJSON)); err == nil {
		t.Fatal("accepted App Server as account-specific SIWC")
	}
	emptyLabel := read(t, selection.CodexTask, strings.Replace(appJSON, `"displayName":"Fixture Model"`, `"displayName":""`, 1))
	if emptyLabel.Entries[0].DisplayName != "fixture-model" {
		t.Fatal("empty display label did not preserve runtime name")
	}
}

func TestHostileDeclaredCatalogues(t *testing.T) {
	vectors := []string{
		`{"models":[],"models":[]}`, planJSON + ` {}`, `{"models":null}`,
		strings.Replace(planJSON, `"visibility":"list"`, `"visibility":"surprise"`, 1),
		strings.Replace(planJSON, `"slug":"fixture-model"`, `"slug":"fixture model"`, 1),
		strings.Replace(planJSON, `"display_name":"Fixture Model"`, `"display_name":"bad\nlabel"`, 1),
		strings.Replace(planJSON, `"default_reasoning_level":"deliberate"`, `"default_reasoning_level":"max"`, 1),
		`{"models":[{"slug":"m","display_name":"M","visibility":"list"},{"slug":"m","display_name":"M","visibility":"list"}]}`,
		`{"models":[],"unknown":` + strings.Repeat(`[`, 18) + `0` + strings.Repeat(`]`, 18) + `}`,
		`{"models":[],"unknown":"` + strings.Repeat(`x`, 4097) + `"}`,
		strings.Repeat(" ", catalogue.MaxBytes+1),
	}
	for n, v := range vectors {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			if _, err := catalogue.ParseSIWC([]byte(v)); err == nil {
				t.Fatal("accepted hostile/invalid boundary")
			}
		})
	}
	for _, v := range []string{
		strings.Replace(appJSON, `"nextCursor":null`, `"nextCursor":42`, 1),
		strings.Replace(appJSON, `,"nextCursor":null`, "", 1),
		strings.Replace(appJSON, `"defaultReasoningEffort":"deliberate"`, `"defaultReasoningEffort":"max"`, 1),
		strings.Replace(appJSON, `"hidden":false`, `"hidden":"false"`, 1),
	} {
		if _, err := catalogue.ParseAppServer([]byte(v)); err == nil {
			t.Fatal("accepted invalid App Server response")
		}
	}
}

func TestReaderNeverPublishesPartialOrForeignList(t *testing.T) {
	s := scope(selection.CodexTask)
	source := selection.AppServer
	stamp := catalogue.Stamp{Epoch: 1, Revision: "fixture", ObservedAtMillis: 10, ExpiresAtMillis: 100}
	page := strings.Replace(appJSON, `"nextCursor":null`, `"nextCursor":"page-2"`, 1)
	foreign := s
	foreign.AccountID = "fixture-account-B"
	for name, f := range map[string]*transport{
		"partial":                {pages: []catalogue.Page{{Scope: s, Body: []byte(page)}}},
		"duplicate across pages": {pages: []catalogue.Page{{Scope: s, Body: []byte(page)}, {Scope: s, Body: []byte(appJSON)}}},
		"foreign account":        {pages: []catalogue.Page{{Scope: foreign, Body: []byte(appJSON)}}},
		"missing network":        {err: errors.New("do not expose private provider error")},
		"repeating cursor":       {pages: []catalogue.Page{{Scope: s, Body: []byte(`{"data":[],"nextCursor":"page-2"}`)}, {Scope: s, Body: []byte(`{"data":[],"nextCursor":"page-2"}`)}}},
	} {
		t.Run(name, func(t *testing.T) {
			out, err := catalogue.Read(context.Background(), f, s, source, stamp)
			if err == nil || out.Complete || len(out.Entries) != 0 || strings.Contains(err.Error(), "private") {
				t.Fatalf("partial/raw error escaped: %+v %v", out, err)
			}
		})
	}
	f := &transport{pages: []catalogue.Page{{Scope: s, Body: []byte(appJSON)}}}
	invalid := s
	invalid.AccountID = ""
	if _, err := catalogue.Read(context.Background(), f, invalid, source, stamp); err == nil || f.calls != 0 {
		t.Fatal("invalid identity disclosed to transport")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := catalogue.Read(ctx, f, s, source, stamp); err == nil || f.calls != 0 {
		t.Fatal("cancelled request contacted transport")
	}
	ctx, cancel = context.WithCancel(context.Background())
	f.cancel = cancel
	if out, err := catalogue.Read(ctx, f, s, source, stamp); err == nil || out.Complete {
		t.Fatal("cancelled final list published complete snapshot")
	}
}

func TestEvidenceIsDetachedAndAccountEpochBound(t *testing.T) {
	s := read(t, selection.PlanInference, planJSON)
	evidence := catalogue.Evidence{Scope: s.Scope, Epoch: s.Epoch, Models: map[string]selection.Capabilities{"fixture-model": caps()}}
	out, err := catalogue.WithEvidence(s, evidence)
	if err != nil {
		t.Fatal(err)
	}
	out.Entries[0].Efforts[0] = "changed"
	evidence.Models["fixture-model"] = selection.Capabilities{}
	if s.Entries[0].Efforts[0] != "deliberate" || s.Entries[0].Capabilities.Text != selection.Unknown {
		t.Fatal("source evidence mutated")
	}
	evidence.Epoch++
	if _, err := catalogue.WithEvidence(s, evidence); err == nil {
		t.Fatal("stale evidence applied")
	}
}
