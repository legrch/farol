package boot

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

// Real selection policy and original lifecycle owner; journal, native Computer
// and browser boundaries remain injected. No runtime/provider proof is implied.
func readSelectionInput(a wire.ChatComputerAdmissionResponse) wire.ChatReadIntentResolve {
	low, standard := "low", "standard"
	return wire.ChatReadIntentResolve{Admission: a,
		Policy:    wire.ChatModelPolicy{DefaultHarness: "browser", Harnesses: []wire.ChatHarnessPolicy{{Name: "browser", DefaultModel: "chatgpt", Models: []wire.ChatConfiguredModel{{Alias: "chatgpt", Model: "controlled-model", DefaultEffort: &low}}}}},
		Requested: wire.ChatModelRequest{Effort: &low, Mode: &standard},
		Profiles:  []wire.ChatBrowserModelProfile{{Id: "configured", Executor: "browser", RuntimeModel: "controlled-model", ModelId: "controlled-model", DefaultEffort: "low", Mode: "standard", Efforts: []wire.ChatModelEffort{{Requested: "low", Resolved: "low"}}, Required: wire.BrowserRequiredControls{Model: true, Effort: true, Mode: true}}},
	}
}
func resolveReadSelectionFixture(t *testing.T, s *ComputerIngress, a wire.ChatComputerAdmissionResponse) wire.ChatReadIntentResolved {
	t.Helper()
	got, err := s.resolveRead(context.Background(), "resolve-original-selection", readSelectionInput(a))
	expected := readIntentPromotion(a)
	if err != nil || got == nil || got.Admission != a || got.Selection != expected.Selection || got.Resolution != expected.Resolution || got.Required != expected.Required {
		t.Fatal("resolve", got, err)
	}
	return *got
}
func TestReadIntentSelectionRequiresApprovalAndCannotBeInventedByPromotion(t *testing.T) {
	f, s, a := readIntentUnapprovedFixture(t)
	entries, claims := len(f.journal.entries), len(s.used)
	if out, err := s.resolveRead(context.Background(), "unapproved-selection", readSelectionInput(a)); err == nil || out != nil {
		t.Fatal("unapproved resolved", out, err)
	}
	if len(s.used) != claims || len(f.journal.entries) != entries {
		t.Fatal("unapproved selection changed owner")
	}
	approveReadAccountFixture(t, s, a)
	entries, claims = len(f.journal.entries), len(s.used)
	if out, err := s.promoteRead(context.Background(), "invented-selection", readIntentPromotion(a)); err == nil || out != nil {
		t.Fatal("unowned selection promoted", out, err)
	}
	if len(s.used) != claims || len(f.journal.entries) != entries || f.physical.sends != 0 {
		t.Fatal("missing capture performed effect")
	}
}
func TestReadIntentSelectionPinsDetachedPolicyAndExactReplay(t *testing.T) {
	f, s, a := readIntentUnapprovedFixture(t)
	approveReadAccountFixture(t, s, a)
	in := readSelectionInput(a)
	before := len(f.journal.entries)
	got, err := s.resolveRead(context.Background(), "resolve-once", in)
	if err != nil || got == nil {
		t.Fatal(got, err)
	}
	want := *got
	claims := len(s.used)
	got.Selection.ModelId = "changed-by-caller"
	in.Policy.Harnesses[0].Models[0].Model = "new-config-model"
	in.Profiles[0].ModelId = "new-profile"
	if _, err = s.resolveRead(context.Background(), "changed-config", in); err == nil {
		t.Fatal("silently re-resolved configuration")
	}
	replay, err := s.resolveRead(context.Background(), "duplicate-ui-request", readSelectionInput(a))
	if err != nil || replay == nil || *replay != want || len(s.used) != claims || len(f.journal.entries) != before || f.physical.sends != 0 {
		t.Fatal("capture not exact/detached", replay, err)
	}
	h, err := s.promoteRead(context.Background(), "first-send", readIntentPromotion(a))
	if err != nil || h == nil {
		t.Fatal(h, err)
	}
	c, _ := s.capturedRead(a)
	if *c.modelCapture != want {
		t.Fatal("promotion changed pinned model")
	}
	if _, err = s.resolveRead(context.Background(), "queued-config-change", in); err == nil || f.physical.sends != 0 {
		t.Fatal("queued selection changed")
	}
}
func TestReadIntentSelectionRefusesCrossedPromotion(t *testing.T) {
	for _, variant := range []string{"account", "model", "effort", "mode", "required", "digest", "translation", "requested"} {
		t.Run(variant, func(t *testing.T) {
			f, s, a := readIntentFixture(t)
			in := readIntentPromotion(a)
			switch variant {
			case "account":
				in.Selection.AccountId = "another"
			case "model":
				in.Selection.ModelId = "another"
			case "effort":
				in.Selection.Effort = "high"
			case "mode":
				in.Selection.Mode = "pro"
			case "required":
				in.Required.Effort = false
			case "digest":
				in.Resolution.ConfigSHA256 = string(make([]byte, 64))
			case "translation":
				in.Resolution.TranslationId = "another"
			case "requested":
				in.Resolution.RequestedEffort = "high"
			}
			entries, claims := len(f.journal.entries), len(s.used)
			if out, err := s.promoteRead(context.Background(), "crossed-promotion", in); err == nil || out != nil || len(f.journal.entries) != entries || len(s.used) != claims || f.physical.sends != 0 {
				t.Fatal("crossed selection reached lifecycle", out, err)
			}
		})
	}
}
func TestReadIntentSelectionRefusesInvalidPolicyBeforeClaim(t *testing.T) {
	for _, variant := range []string{"duplicate-harness", "duplicate-model", "unsupported-runtime", "duplicate-profile", "unsupported-effort", "wrong-mode", "connector", "owner", "task", "withdrawn", "revoked", "authority", "cancelled"} {
		t.Run(variant, func(t *testing.T) {
			f, s, a := readIntentUnapprovedFixture(t)
			approval := approveReadAccountFixture(t, s, a)
			in := readSelectionInput(a)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch variant {
			case "duplicate-harness":
				in.Policy.Harnesses = append(in.Policy.Harnesses, in.Policy.Harnesses[0])
			case "duplicate-model":
				h := &in.Policy.Harnesses[0]
				h.Models = append(h.Models, h.Models[0])
			case "unsupported-runtime":
				in.Policy.Harnesses[0].Models[0].Model = "unsupported"
			case "duplicate-profile":
				in.Profiles = append(in.Profiles, in.Profiles[0])
			case "unsupported-effort":
				*in.Requested.Effort = "ultra"
			case "wrong-mode":
				*in.Requested.Mode = "pro"
			case "connector":
				in.Profiles[0].Required.Connector = true
			case "owner":
				in.Admission.OwnerId = "crossed"
			case "task":
				in.Admission.TaskId = "crossed"
			case "withdrawn":
				if _, err := s.withdrawRead(ctx, "withdraw", wire.ChatReadIntentWithdraw{Admission: a}); err != nil {
					t.Fatal(err)
				}
			case "revoked":
				if _, err := s.revokeReadAccount(ctx, "revoke", wire.ChatReadIntentAccountRevoke{Admission: a, ApprovalId: approval.ApprovalId}); err != nil {
					t.Fatal(err)
				}
			case "authority":
				if _, err := s.Deactivate(ctx, "withdraw-authority"); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			}
			entries, claims := len(f.journal.entries), len(s.used)
			if out, err := s.resolveRead(ctx, "invalid-selection", in); err == nil || out != nil || len(f.journal.entries) != entries || len(s.used) != claims || f.physical.sends != 0 {
				t.Fatal("invalid selection had effects", out, err)
			}
			c, err := s.capturedRead(a)
			if err == nil && c.modelCapture != nil {
				t.Fatal("invalid capture retained")
			}
		})
	}
}
func TestReadIntentSelectionWireRefusalIsClassified(t *testing.T) {
	f, s, a := readIntentUnapprovedFixture(t)
	approveReadAccountFixture(t, s, a)
	in := readSelectionInput(a)
	in.Profiles[0].RuntimeModel = "unsupported"
	r := s.Methods()["chat.readintent.resolve"]
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := r.Handle(context.Background(), desktop.Request{RequestID: "resolve", OperationID: "unsupported-selection", Body: raw})
	if err != nil || out == nil {
		t.Fatal(out, err)
	}
	if out.Status != "refused" || out.Code != "CHAT_MODEL_PROFILE_UNSUPPORTED" || f.physical.sends != 0 {
		t.Fatal(out)
	}
}

// Keep the expected bytes independent from resolver internals. The canonical
// policy hash above is also exercised by the framed read/promote integration.
func TestReadSelectionFixtureHasFullProof(t *testing.T) {
	f, s, a := readIntentFixture(t)
	c, _ := s.capturedRead(a)
	want := readIntentPromotion(a)
	if !reflect.DeepEqual(c.modelCapture.Selection, want.Selection) || c.modelCapture.Resolution.ConfigSHA256 == "" || f.physical.sends != 0 {
		t.Fatal("fixture lacks selection proof")
	}
}
