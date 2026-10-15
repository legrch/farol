package boot

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/transport/desktop"
)

// Real root/app/contract, injected native search and authority. No subprocess,
// interpreter, Task/Chat participant, actual filesystem or provider is opened.
func TestOwnerSettingsSearchUsesPublishedGoAuthority(t *testing.T) {
	for _, mode := range []string{"allowed", "no-search", "withdrawn", "late-policy", "expired", "empty-pattern", "effect-id"} {
		t.Run(mode, func(t *testing.T) {
			root, store, native, list := settingsFixture(t)
			store.approval.Capabilities = append(store.approval.Capabilities, authority.Search)
			if mode == "no-search" {
				store.approval.Capabilities = []authority.Capability{authority.List, authority.Read}
			}
			root.publication.approval = store.approval.Clone()
			in := wire.ComputerSettingsSearchRequest{Publication: list.Publication, WorkspaceId: "work", RelativePath: ".", Pattern: "match"}
			switch mode {
			case "withdrawn":
				root.guard.deactivate()
			case "late-policy":
				native.after = func() { store.approval.Capabilities = []authority.Capability{authority.List} }
			case "expired":
				native.after = func() { store.clock.now = store.clock.now.Add(16 * time.Second) }
			case "empty-pattern":
				in.Pattern = ""
			}
			body, err := json.Marshal(in)
			if err != nil {
				t.Fatal(err)
			}
			r := desktop.Request{RequestID: "search", Body: body}
			if mode == "effect-id" {
				r.OperationID = "not-an-effect"
			}
			out, err := root.Methods()["computer.settings.search"].Handle(context.Background(), r)
			if mode == "allowed" {
				if err != nil || out == nil || out.Status != "ok" || native.calls != 1 {
					t.Fatal("published search unavailable", out, err)
				}
				encoded, _ := json.Marshal(out.Data)
				var value wire.ComputerSettingsSearchResponse
				if json.Unmarshal(encoded, &value) != nil || value.Publication != in.Publication || value.Pattern != "match" || value.WorkspaceId != "work" || len(value.Matches) == 0 {
					t.Fatal("search projection lost correlation", string(encoded))
				}
			} else if err == nil && out != nil && out.Status == "ok" {
				t.Fatal("invalid authority disclosed output", mode)
			}
			if mode != "allowed" && mode != "late-policy" && mode != "expired" && native.calls != 0 {
				t.Fatal("refused request dispatched native search")
			}
			if root.chat != nil || len(root.tasks) != 0 || len(root.turns) != 0 {
				t.Fatal("Settings search invented Task/Chat authority")
			}
		})
	}
}
