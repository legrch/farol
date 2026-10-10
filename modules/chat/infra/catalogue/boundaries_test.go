package catalogue_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/catalogue"
)

func TestCacheRejectsPartialRefreshWithoutRestoringOlderRows(t *testing.T) {
	c := &catalogue.Cache{}
	s := scope(selection.BrowserChat)
	c.Activate(s)
	old := c.Begin()
	if err := c.Complete(old, browserSnapshot(old), nil); err != nil {
		t.Fatal(err)
	}
	newer := c.Begin()
	partial := browserSnapshot(newer)
	partial.Complete = false
	if err := c.Complete(newer, partial, nil); err != catalogue.Invalid {
		t.Fatalf("partial snapshot became current: %v", err)
	}
	if _, err := c.Current(); err != catalogue.Invalid {
		t.Fatalf("partial refresh retained rows: %v", err)
	}
	if err := c.Complete(old, browserSnapshot(old), nil); err != catalogue.Superseded {
		t.Fatal("older response restored rows")
	}
}

func TestMalformedUnknownFieldsAndEffortDeclarations(t *testing.T) {
	for _, unknown := range []string{`{"x":0,"x":1}`, `[` + strings.Repeat(`0,`, catalogue.MaxRows) + `0]`, `"` + strings.Repeat("x", 4097) + `"`, `{"x":` + strings.Repeat("[", 18) + `0` + strings.Repeat("]", 18) + `}`} {
		for _, source := range []string{planJSON, appJSON} {
			raw := []byte(source[:len(source)-1] + `,"unknown":` + unknown + `}`)
			if _, err := catalogue.ParseSIWC(raw); err == nil {
				t.Fatal("accepted malformed SIWC unknown field")
			}
			if _, err := catalogue.ParseAppServer(raw); err == nil {
				t.Fatal("accepted malformed App Server unknown field")
			}
		}
	}
	for _, raw := range []string{
		strings.Replace(planJSON, `[{"effort":"deliberate"}]`, `[{"effort":"deliberate"},{"effort":"deliberate"}]`, 1),
		strings.Replace(planJSON, `[{"effort":"deliberate"}]`, `[]`, 1),
		strings.Replace(planJSON, `"supported_reasoning_levels":[{"effort":"deliberate"}],`, ``, 1),
	} {
		if _, err := catalogue.ParseSIWC([]byte(raw)); err != catalogue.Invalid {
			t.Fatal("accepted inconsistent SIWC effort/default")
		}
	}
	for _, raw := range []string{
		strings.Replace(appJSON, `[{"reasoningEffort":"deliberate","description":"Fixture effort"}]`, `[{"reasoningEffort":"deliberate"},{"reasoningEffort":"deliberate"}]`, 1),
		strings.Replace(appJSON, `,"defaultReasoningEffort":"deliberate"`, ``, 1),
	} {
		if _, err := catalogue.ParseAppServer([]byte(raw)); err != catalogue.Invalid {
			t.Fatal("accepted inconsistent App Server effort/default")
		}
	}
	for _, parse := range []func([]byte) (catalogue.Rows, error){catalogue.ParseSIWC, catalogue.ParseAppServer} {
		if _, err := parse([]byte{'{', '"', 0xff, '"', ':', '0', '}'}); err != catalogue.Invalid {
			t.Fatal("accepted invalid UTF8")
		}
	}
}

func TestParsedLabelsRemainValidDomainValues(t *testing.T) {
	for _, label := range []string{" padded", "padded ", "control\u0085label"} {
		encoded, _ := json.Marshal(label)
		for _, v := range []struct {
			raw, key string
			parse    func([]byte) (catalogue.Rows, error)
		}{
			{planJSON, `"display_name":"Fixture Model"`, catalogue.ParseSIWC},
			{appJSON, `"displayName":"Fixture Model"`, catalogue.ParseAppServer},
		} {
			key := strings.SplitN(v.key, ":", 2)[0]
			if _, err := v.parse([]byte(strings.Replace(v.raw, v.key, key+":"+string(encoded), 1))); err != catalogue.Invalid {
				t.Fatalf("accepted unusable label %q: %v", label, err)
			}
		}
	}
}

func TestCatalogueRowBoundsAndDuplicates(t *testing.T) {
	rows := make([]string, catalogue.MaxRows)
	for i := range rows {
		rows[i] = fmt.Sprintf(`{"slug":"m%d","display_name":"Model","visibility":"list"}`, i)
	}
	if out, err := catalogue.ParseSIWC([]byte(`{"models":[` + strings.Join(rows, ",") + `]}`)); err != nil || len(out.Entries) != catalogue.MaxRows {
		t.Fatalf("bounded catalogue: %d %v", len(out.Entries), err)
	}
	for _, extra := range []string{rows[0], `{"slug":"extra","display_name":"Model","visibility":"list"}`} {
		if _, err := catalogue.ParseSIWC([]byte(`{"models":[` + strings.Join(append(rows, extra), ",") + `]}`)); err != catalogue.Invalid {
			t.Fatal("accepted overlarge/duplicate catalogue")
		}
	}
	row := strings.TrimSuffix(strings.TrimPrefix(appJSON, `{"data":[`), `],"nextCursor":null}`)
	appRows := make([]string, catalogue.PageRows)
	for i := range appRows {
		appRows[i] = strings.Replace(strings.Replace(row, `"ui-id"`, fmt.Sprintf(`"id-%d"`, i), 1), `"fixture-model"`, fmt.Sprintf(`"m%d"`, i), 1)
	}
	if out, err := catalogue.ParseAppServer([]byte(`{"data":[` + strings.Join(appRows, ",") + `],"nextCursor":null}`)); err != nil || len(out.Entries) != catalogue.PageRows {
		t.Fatalf("bounded page: %v", err)
	}
	if _, err := catalogue.ParseAppServer([]byte(`{"data":[` + strings.Join(append(appRows, row), ",") + `],"nextCursor":null}`)); err != catalogue.Invalid {
		t.Fatal("accepted overlarge page")
	}
}

func TestConcurrentAccountsEpochsAndIndependentCaches(t *testing.T) {
	c := &catalogue.Cache{}
	a := scope(selection.BrowserChat)
	c.Activate(a)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Go(func() {
			b := a
			b.AccountID = "fixture-account-B"
			c.Activate(b)
			ticket := c.Begin()
			_ = c.Complete(ticket, browserSnapshot(ticket), nil)
			if out, err := c.Current(); err == nil && out.Scope.AccountID != "fixture-account-A" && out.Scope.AccountID != "fixture-account-B" {
				t.Error("unknown scope escaped")
			}
			c.Activate(a)
		})
	}
	wg.Wait()
	c.Activate(a)
	final := c.Begin()
	if err := c.Complete(final, browserSnapshot(final), nil); err != nil {
		t.Fatal(err)
	}
	other := &catalogue.Cache{}
	other.Activate(a)
	ticket := other.Begin()
	if err := other.Complete(ticket, browserSnapshot(ticket), nil); err != nil {
		t.Fatal(err)
	}
	c.Activate(selection.Scope{})
	if _, err := other.Current(); err != nil {
		t.Fatal("one consumer revoked another cache")
	}
}

func TestRefreshTicketBelongsToOneConsumerCache(t *testing.T) {
	a, b := &catalogue.Cache{}, &catalogue.Cache{}
	s := scope(selection.BrowserChat)
	a.Activate(s)
	b.Activate(s)
	first, second := a.Begin(), b.Begin()
	if err := b.Complete(first, browserSnapshot(first), nil); err != catalogue.Superseded {
		t.Fatalf("foreign consumer ticket accepted: %v", err)
	}
	if err := b.Complete(second, browserSnapshot(second), nil); err != nil {
		t.Fatalf("foreign ticket consumed own refresh: %v", err)
	}
	if err := a.Complete(first, browserSnapshot(first), nil); err != nil {
		t.Fatal(err)
	}
}

type blockedList struct {
	scope            selection.Scope
	entered, release chan struct{}
}

func (b blockedList) List(context.Context, selection.Scope, string) (catalogue.Page, error) {
	close(b.entered)
	<-b.release
	return catalogue.Page{Scope: b.scope, Body: []byte(appJSON)}, nil
}

func TestOldReadCannotPublishAfterConcurrentAccountReconnect(t *testing.T) {
	c := &catalogue.Cache{}
	a := scope(selection.CodexTask)
	c.Activate(a)
	old := c.Begin()
	tr := blockedList{a, make(chan struct{}), make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		s, err := catalogue.Read(context.Background(), tr, a, selection.AppServer, catalogue.Stamp{Epoch: old.Epoch(), Revision: "old", ObservedAtMillis: 10, ExpiresAtMillis: 100})
		done <- c.Complete(old, s, err)
	}()
	<-tr.entered
	b := a
	b.AccountID = "fixture-account-B"
	c.Activate(b)
	c.Activate(a)
	newer := c.Begin()
	s := read(t, selection.CodexTask, appJSON)
	s.Epoch = newer.Epoch()
	s.Revision = "reconnected"
	if err := c.Complete(newer, s, nil); err != nil {
		t.Fatal(err)
	}
	close(tr.release)
	if err := <-done; err != catalogue.Superseded {
		t.Fatalf("old read published: %v", err)
	}
	current, err := c.Current()
	if err != nil || current.Revision != "reconnected" || current.Epoch != newer.Epoch() {
		t.Fatalf("reconnected catalogue changed: %+v %v", current, err)
	}
}

func TestReaderPaginationIsBoundedAndDetached(t *testing.T) {
	s := scope(selection.CodexTask)
	stamp := catalogue.Stamp{Epoch: 1, Revision: "fixture", ObservedAtMillis: 10, ExpiresAtMillis: 100}
	tr := &transport{}
	for i := 0; i < 20; i++ {
		tr.pages = append(tr.pages, catalogue.Page{Scope: s, Body: []byte(fmt.Sprintf(`{"data":[],"nextCursor":"page-%d"}`, i))})
	}
	if out, err := catalogue.Read(context.Background(), tr, s, selection.AppServer, stamp); err != catalogue.Invalid || out.Complete || tr.calls != 20 {
		t.Fatalf("unbounded/partial read: %+v %v calls=%d", out, err, tr.calls)
	}
	first := strings.Replace(appJSON, `"nextCursor":null`, `"nextCursor":"next"`, 1)
	second := strings.Replace(appJSON, `"fixture-model"`, `"different-model"`, 1)
	tr = &transport{pages: []catalogue.Page{{Scope: s, Body: []byte(first)}, {Scope: s, Body: []byte(second)}}}
	if _, err := catalogue.Read(context.Background(), tr, s, selection.AppServer, stamp); err != catalogue.Invalid {
		t.Fatal("duplicate UI ID across pages escaped")
	}
	body := []byte(appJSON)
	tr = &transport{pages: []catalogue.Page{{Scope: s, Body: body}}}
	out, err := catalogue.Read(context.Background(), tr, s, selection.AppServer, stamp)
	if err != nil {
		t.Fatal(err)
	}
	for i := range body {
		body[i] = 'x'
	}
	if out.Entries[0].Slug != "fixture-model" || out.Entries[0].Efforts[0] != "deliberate" {
		t.Fatal("reader retained transport bytes")
	}
}

type callbackBuilder struct {
	change    func()
	pinChange func(*selection.Pin)
	body      []byte
	calls     int
}

func (b *callbackBuilder) Prepare(_ context.Context, input catalogue.InferenceInput) (catalogue.InferencePrepared, error) {
	b.calls++
	if b.change != nil {
		b.change()
	}
	if b.pinChange != nil {
		b.pinChange(&input.Pin)
	}
	return catalogue.InferencePrepared{Pin: input.Pin, Body: b.body}, nil
}

func TestInferenceCaptureAndBodyAreDetachedFromCallbacks(t *testing.T) {
	c, s := loaded(t, selection.PlanInference)
	prefs := []selection.Preference{{Slug: "fixture-model", Effort: "deliberate"}}
	request := selection.Request{Preferences: prefs}
	b := &callbackBuilder{body: []byte("controlled-request"), change: func() { prefs[0] = selection.Preference{Slug: "replacement"}; request.Requirements.Tools = true }}
	out, err := catalogue.PrepareInference(context.Background(), c, s, 11, request, "fixture", b)
	if err != nil || out.Pin.Model != "fixture-model" || out.Pin.Effort != "deliberate" || out.Pin.AccountID != s.AccountID || b.calls != 1 {
		t.Fatalf("callback changed request pin: %+v %v", out, err)
	}
	b.body[0] = 'X'
	if string(out.Body) != "controlled-request" {
		t.Fatal("builder retained returned body")
	}
	out.Body[1] = 'X'
	if string(b.body) != "Xontrolled-request" {
		t.Fatal("consumer changed builder body")
	}
	for _, change := range []func(*selection.Pin){func(p *selection.Pin) { p.Model = "other" }, func(p *selection.Pin) { p.AccountID = "other" }, func(p *selection.Pin) { p.Effort = "other" }, func(p *selection.Pin) { p.Route.Billing = selection.API }, func(p *selection.Pin) { p.Epoch++ }} {
		b := &callbackBuilder{pinChange: change}
		if out, err := catalogue.PrepareInference(context.Background(), c, s, 11, selection.Request{Slug: "fixture-model"}, "fixture", b); err != catalogue.ScopeMismatch || out.Pin.Epoch != 0 || b.calls != 1 {
			t.Fatalf("builder retarget accepted/retried: %+v %v", out, err)
		}
	}
}

func TestBrowserCaptureDetachedFromCallbackMutations(t *testing.T) {
	c := &catalogue.Cache{}
	s := scope(selection.BrowserChat)
	c.Activate(s)
	ticket := c.Begin()
	if err := c.Complete(ticket, browserSnapshot(ticket), nil); err != nil {
		t.Fatal(err)
	}
	alias, effort := "friendly", "deliberate"
	p := port.ModelPolicy{DefaultHarness: "browser", Harnesses: map[string]port.ModelHarnessPolicy{"browser": {DefaultModel: alias, Models: map[string]port.ConfiguredModel{alias: {Model: "fixture-runtime", DefaultEffort: &effort}}}}}
	request := port.ModelRequest{Model: &alias, Effort: &effort}
	profiles := []port.BrowserModelProfile{{ID: "fixture-profile", Executor: "browser", RuntimeModel: "fixture-runtime", ModelID: "fixture-control", DefaultEffort: effort, Efforts: []port.BrowserModelEffort{{Requested: effort, Resolved: effort}}, Required: port.RequiredControls{Model: true}}}
	d := changingDigester{change: func() {
		alias = "changed"
		effort = "changed"
		delete(p.Harnesses, "browser")
		profiles[0].ModelID = "changed"
		profiles[0].Efforts[0].Resolved = "changed"
	}}
	out, err := catalogue.PrepareBrowser(c, s, 11, d, p, request, profiles)
	if err != nil || out.Capture.Resolution.RequestedAlias != "friendly" || out.Capture.Selection.Effort != "deliberate" || out.Resolved.Pin().Model != "fixture-control" || out.Resolved.Pin().AccountID != s.AccountID {
		t.Fatalf("callback retargeted capture: %+v %v", out, err)
	}
}

func FuzzDeclaredCatalogue(f *testing.F) {
	for _, raw := range []string{planJSON, appJSON, `{"models":[]}`, `{"data":[],"nextCursor":null}`, `{"models":[],"unknown":{"safe":true}}`, `{"models":[],"models":[]}`} {
		f.Add([]byte(raw))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		for _, v := range []struct {
			parse   func([]byte) (catalogue.Rows, error)
			backend selection.Backend
			source  selection.Source
		}{{catalogue.ParseSIWC, selection.PlanInference, selection.SIWC}, {catalogue.ParseAppServer, selection.CodexTask, selection.AppServer}} {
			out, err := v.parse(raw)
			if err != nil {
				if err != catalogue.Invalid {
					t.Fatalf("unclassified parse error: %v", err)
				}
				if len(out.Entries) != 0 {
					t.Fatal("partial rows escaped error")
				}
				continue
			}
			s := selection.Snapshot{Scope: scope(v.backend), Source: v.source, Epoch: 1, Revision: "fixture", ObservedAtMillis: 10, ExpiresAtMillis: 100, Complete: true, Entries: out.Entries}
			if err := selection.ValidateSnapshot(s); err != nil {
				t.Fatalf("parser accepted unusable snapshot: %v", err)
			}
			for _, entry := range out.Entries {
				if entry.Capabilities.Text != selection.Unknown || entry.Capabilities.Image != selection.Unknown || entry.Capabilities.Tools != selection.Unknown {
					t.Fatal("parser inferred capability")
				}
			}
			// A successful reader must preserve the parsed account-correlated rows.
			if out.NextCursor == "" {
				tr := &transport{pages: []catalogue.Page{{Scope: s.Scope, Body: raw}}}
				got, err := catalogue.Read(context.Background(), tr, s.Scope, s.Source, catalogue.Stamp{Epoch: 1, Revision: "fixture", ObservedAtMillis: 10, ExpiresAtMillis: 100})
				if err != nil || len(got.Entries) != len(out.Entries) {
					t.Fatalf("reader/parser disagree: %v", err)
				}
			}
			if _, err := json.Marshal(out); err != nil {
				t.Fatal(err)
			}
		}
	})
}
