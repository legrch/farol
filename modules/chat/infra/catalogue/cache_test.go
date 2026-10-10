package catalogue_test

import (
	"crypto/sha256"
	"fmt"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/catalogue"
)

type digester struct{}

func (digester) Digest(raw []byte) (string, error) { return fmt.Sprintf("%x", sha256.Sum256(raw)), nil }
func browserSnapshot(ticket catalogue.Ticket) selection.Snapshot {
	return selection.Snapshot{Scope: ticket.Scope(), Epoch: ticket.Epoch(), Revision: "fixture-browser-1", Source: selection.Browser, ObservedAtMillis: 10, ExpiresAtMillis: 100, Complete: true, Entries: []selection.Entry{{Slug: "fixture-control", DisplayName: "Fixture Control", Efforts: []string{"deliberate"}, DefaultEffort: "deliberate", Capabilities: caps()}}}
}
func browserPrepare(cache *catalogue.Cache, s selection.Scope, now uint64) (catalogue.BrowserPrepared, error) {
	return browserPrepareWithDigester(cache, s, now, digester{})
}
func browserPrepareWithDigester(cache *catalogue.Cache, s selection.Scope, now uint64, d port.IntentDigester) (catalogue.BrowserPrepared, error) {
	p := port.ModelPolicy{DefaultHarness: "browser", Harnesses: map[string]port.ModelHarnessPolicy{"browser": {DefaultModel: "friendly", Models: map[string]port.ConfiguredModel{"friendly": {Model: "fixture-runtime"}}}}}
	profiles := []port.BrowserModelProfile{{ID: "fixture-profile", Executor: "browser", RuntimeModel: "fixture-runtime", ModelID: "fixture-control", DefaultEffort: "deliberate", Efforts: []port.BrowserModelEffort{{Requested: "deliberate", Resolved: "deliberate"}}, Required: port.RequiredControls{Model: true}}}
	return catalogue.PrepareBrowser(cache, s, now, d, p, port.ModelRequest{}, profiles)
}

type changingDigester struct{ change func() }

func (d changingDigester) Digest(raw []byte) (string, error) {
	d.change()
	return digester{}.Digest(raw)
}
func TestBrowserRechecksAccountAndRefreshAfterApplicationResolution(t *testing.T) {
	for _, changeAccount := range []bool{true, false} {
		c := &catalogue.Cache{}
		s := scope(selection.BrowserChat)
		c.Activate(s)
		ticket := c.Begin()
		if err := c.Complete(ticket, browserSnapshot(ticket), nil); err != nil {
			t.Fatal(err)
		}
		d := changingDigester{change: func() {
			if changeAccount {
				other := s
				other.AccountID = "fixture-account-B"
				c.Activate(other)
			} else {
				newer := c.Begin()
				if err := c.Complete(newer, browserSnapshot(newer), nil); err != nil {
					t.Fatal(err)
				}
			}
		}}
		if _, err := browserPrepareWithDigester(c, s, 11, d); err == nil {
			t.Fatal("application callback changed selection without final fence")
		}
	}
}

// Real existing browser model-selection application plus controlled catalogue.
// This exercises current/stale/account-switch selection, not public UI or Send.
func TestCatalogueConsumedByExistingBrowserApplication(t *testing.T) {
	c := &catalogue.Cache{}
	a := scope(selection.BrowserChat)
	c.Activate(a)
	ticket := c.Begin()
	if err := c.Complete(ticket, browserSnapshot(ticket), nil); err != nil {
		t.Fatal(err)
	}
	prepared, err := browserPrepare(c, a, 11)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.Capture.Selection.ModelID != "fixture-control" || prepared.Capture.Resolution.RequestedAlias != "friendly" || prepared.Resolved.Pin().AccountID != a.AccountID {
		t.Fatal("lost alias/control/account boundary")
	}
	if _, err := browserPrepare(c, a, 100); err == nil {
		t.Fatal("stale catalogue reached browser path")
	}
	b := a
	b.AccountID = "fixture-account-B"
	c.Activate(b)
	if _, err := browserPrepare(c, a, 11); err == nil {
		t.Fatal("account switch kept previous catalogue")
	}
	if err := c.Complete(ticket, browserSnapshot(ticket), nil); err != catalogue.Superseded {
		t.Fatal("late old-account response published")
	}
	newTicket := c.Begin()
	if err := c.Complete(newTicket, browserSnapshot(newTicket), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := browserPrepare(c, a, 11); err == nil {
		t.Fatal("new account catalog used old account consent")
	}
	if _, err := browserPrepare(c, b, 11); err != nil {
		t.Fatal(err)
	}
	if prepared.Resolved.Pin().AccountID != a.AccountID {
		t.Fatal("running binding retargeted")
	}
}

func TestLatestRefreshAndABAAndDetachedCache(t *testing.T) {
	c := &catalogue.Cache{}
	a := scope(selection.BrowserChat)
	c.Activate(a)
	old := c.Begin()
	newer := c.Begin()
	if c.Complete(old, browserSnapshot(old), nil) != catalogue.Superseded {
		t.Fatal("stale refresh won")
	}
	s := browserSnapshot(newer)
	if err := c.Complete(newer, s, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Complete(newer, s, nil); err != catalogue.Superseded {
		t.Fatal("completed refresh ticket was reused")
	}
	s.Entries[0].Efforts[0] = "mutated"
	out, err := c.Current()
	if err != nil || out.Entries[0].Efforts[0] != "deliberate" {
		t.Fatal("cache retained input slice")
	}
	out.Entries[0].Slug = "mutated"
	out, _ = c.Current()
	if out.Entries[0].Slug != "fixture-control" {
		t.Fatal("cache exported owned slice")
	}
	pending := c.Begin()
	b := a
	b.AccountID = "fixture-account-B"
	c.Activate(b)
	c.Activate(a)
	if c.Complete(pending, browserSnapshot(pending), nil) != catalogue.Superseded {
		t.Fatal("A-B-A reused old generation")
	}
}

func TestConcurrentRefreshAndSwitch(t *testing.T) {
	c := &catalogue.Cache{}
	a := scope(selection.BrowserChat)
	c.Activate(a)
	var wg sync.WaitGroup
	for n := 0; n < 64; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ticket := c.Begin()
			_ = c.Complete(ticket, browserSnapshot(ticket), nil)
			_, _ = c.Current()
		}()
	}
	wg.Wait()
	last := c.Begin()
	if err := c.Complete(last, browserSnapshot(last), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := browserPrepare(c, a, 11); err != nil {
		t.Fatal(err)
	}
}
