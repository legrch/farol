package boot

// Real Go source owner -> existing framed publication -> same Computer/Task
// metadata owner. Persistence and native/provider boundaries remain controlled
// CPU fixtures; this does not qualify an installed host or enable Task lifecycle.
import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	sourcect "github.com/legrch/farol/modules/task/contracts/currentsource"
	"github.com/legrch/farol/modules/task/domain"
)

const sourceFixtureNow = int64(1791108000000)

func currentSourcePublicationFixture(t *testing.T) (*taskPublicationFixture, *wire.TaskCurrentSourceFacts) {
	t.Helper()
	p := newTaskPublicationFixture(t)
	p.ingress.taskCurrentSource = newTaskCurrentSource()
	p.store.clock.now = time.UnixMilli(sourceFixtureNow)
	// Frozen shared synthetic facts from Task's owning-service fixture. No live
	// settings/profile/process evidence or positive source DTO is supplied here.
	raw, err := os.ReadFile("testdata/task-current-source.json")
	if err != nil {
		t.Fatal(err)
	}
	var facts map[string]any
	if err := json.Unmarshal(raw, &facts); err != nil {
		t.Fatal(err)
	}
	route := facts["nativeHosts"].(map[string]any)["route"].(map[string]any)
	route["observeThreadId"] = "10000000-0000-4000-8000-000000000004"
	route["observeTurnId"] = "turn-exact"
	raw, err = json.Marshal(facts)
	if err != nil {
		t.Fatal(err)
	}
	workspace := facts["computer"].(map[string]any)["workspaces"].([]any)[0].(map[string]any)
	approvedWorkspace := make(map[string]any)
	for _, key := range []string{"workspaceId", "root", "access", "rootIdentity", "gitMetadata", "gitHistoryApproved"} {
		approvedWorkspace[key] = workspace[key]
	}
	workspaces := []any{approvedWorkspace}
	p.approval, err = json.Marshal(map[string]any{
		"ownerId": "owner", "computerId": "computer", "generation": 11,
		"workspaces": workspaces, "excludedPaths": []any{},
		"capabilities": []string{"workspace.list", "workspace.read", "workspace.write"},
		"network":      "none", "commands": "none", "expiresAt": sourceFixtureNow + 2*60*60*1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	return p, &wire.TaskCurrentSourceFacts{Snapshot: string(raw), NowMillis: strconv.FormatInt(sourceFixtureNow, 10)}
}

func sourcePublicationRequest(t *testing.T, p *taskPublicationFixture, facts *wire.TaskCurrentSourceFacts) wire.ComputerAuthorityPublishRequest {
	t.Helper()
	p.sequence++
	d, err := p.ingress.Deactivate(context.Background(), "source-withdraw-"+strconv.Itoa(p.sequence))
	if err != nil {
		t.Fatal(err)
	}
	return wire.ComputerAuthorityPublishRequest{Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: strconv.Itoa(p.sequence), Approval: p.approval, TaskCurrentSettings: facts}
}

func TestTaskCurrentSourceRealOwnerInOriginalFramedPublication(t *testing.T) {
	p, facts := currentSourcePublicationFixture(t)
	request := sourcePublicationRequest(t, p, facts)
	peer := taskWireTestConnectMethods(t, p.ingress.Methods(), p.f.profile.peer)
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	receipt := taskWireTestData[wire.ComputerAuthorityPublication](t, peer.call("computer.authority.publish", "source-publish", string(raw)), "ComputerAuthorityPublication")
	if receipt.Fence != request.Fence || receipt.SettingsRevision != request.SettingsRevision || receipt.PublishOperationId != "source-publish" || p.store.updates != 1 {
		t.Fatal("original publication correlation lost", receipt)
	}
	selected, read, err := p.ingress.currentCodexPublication(context.Background(), p.input.HostID, p.input.ScratchRoot)
	if err != nil || read == nil || read.ThreadId != "10000000-0000-4000-8000-000000000004" || read.TurnId != "turn-exact" ||
		selected.Selection.Binding.ModelAlias != "preferred" || selected.Selection.Binding.Model != "fixture-model-v4" || selected.Selection.Binding.Effort != "high" ||
		selected.Selection.Binding.Project.Path != "/fixture/project" || selected.Selection.Binding.Writer.Path != "/fixture/writer" ||
		selected.Selection.Binding.Writer.Device != "18446744073709551615" || selected.Selection.Binding.Writer.Inode != "9007199254740993" ||
		selected.HostGeneration != 7 || selected.ComputerGeneration != 11 || selected.Selection.Binding.ConfigDigest == "" || selected.Followup.Witness.SchemaSHA256 != strings.Repeat("d", 64) {
		t.Fatal("real Task derivation was not joined intact", selected, read, err)
	}
	assertTaskReadMetadataHasNoEffects(t, p)
}

func TestTaskCurrentSourceMalformedOrUnavailableNeverFallsBack(t *testing.T) {
	for _, fault := range []string{"json", "empty", "clock-leading", "clock-negative-zero", "clock-fraction", "clock-unsafe", "clock-too-long", "unavailable", "canceled-after-resolve", "withdrawn-during-resolve", "approval-generation", "approval-root"} {
		t.Run(fault, func(t *testing.T) {
			p, facts := currentSourcePublicationFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "json":
				facts.Snapshot = "{"
			case "empty":
				facts.Snapshot = ""
			case "clock-leading":
				facts.NowMillis = "01791108000000"
			case "clock-negative-zero":
				facts.NowMillis = "-0"
			case "clock-fraction":
				facts.NowMillis = "1791108000000.0"
			case "clock-unsafe":
				facts.NowMillis = "9007199254740992"
			case "clock-too-long":
				facts.NowMillis = "-90071992547409910"
			case "unavailable":
				p.ingress.taskCurrentSource = nil
			case "canceled-after-resolve", "withdrawn-during-resolve":
				p.ingress.taskCurrentSource = sourceResolverFunc(func(c context.Context, in sourcect.Request) (*sourcect.Response, error) {
					result, err := newTaskCurrentSource().Resolve(c, in)
					if fault == "canceled-after-resolve" {
						cancel()
					} else if _, e := p.ingress.Deactivate(c, "source-reentrant-withdraw"); e != nil {
						t.Fatal(e)
					}
					return result, err
				})
			case "approval-generation", "approval-root":
				var approval map[string]any
				if err := json.Unmarshal(p.approval, &approval); err != nil {
					t.Fatal(err)
				}
				if fault == "approval-generation" {
					approval["generation"] = 12
				} else {
					approval["workspaces"].([]any)[0].(map[string]any)["root"] = "/other/writer"
				}
				p.approval, _ = json.Marshal(approval)
			}
			request := sourcePublicationRequest(t, p, facts)
			claims, revision := len(p.ingress.used), p.store.revision
			result, err := p.ingress.Publish(ctx, "refused-source-publish", request)
			if result != nil || err == nil || p.store.updates != 0 || p.store.revision != revision || p.ingress.publication != nil || p.ingress.guard.active {
				t.Fatal("failed derivation published or changed approval", result, err)
			}
			if fault != "withdrawn-during-resolve" && len(p.ingress.used) != claims {
				t.Fatal("failed derivation consumed an effect claim")
			}
			assertTaskReadMetadataHasNoEffects(t, p)
		})
	}
}

type sourceResolverFunc func(context.Context, sourcect.Request) (*sourcect.Response, error)

func (f sourceResolverFunc) Resolve(ctx context.Context, in sourcect.Request) (*sourcect.Response, error) {
	return f(ctx, in)
}

func TestTaskCurrentSourceAbsenceClearsPreviousPair(t *testing.T) {
	for _, absent := range []string{"omitted-computer-only", "settings-invalid", "expired", "missing-policy"} {
		t.Run(absent, func(t *testing.T) {
			p, facts := currentSourcePublicationFixture(t)
			request := sourcePublicationRequest(t, p, facts)
			if _, err := p.ingress.Publish(context.Background(), "initial-source-publish", request); err != nil {
				t.Fatal(err)
			}
			switch absent {
			case "omitted-computer-only":
				facts = nil
			case "settings-invalid":
				facts.Snapshot = `{"status":"settings-invalid"}`
			case "expired":
				facts.NowMillis = "1791111000000"
			case "missing-policy":
				var parsed map[string]any
				_ = json.Unmarshal([]byte(facts.Snapshot), &parsed)
				parsed["tasks"] = nil
				raw, _ := json.Marshal(parsed)
				facts.Snapshot = string(raw)
			}
			request = sourcePublicationRequest(t, p, facts)
			if _, err := p.ingress.Publish(context.Background(), "absent-source-publish", request); err != nil {
				t.Fatal(err)
			}
			if p.ingress.publication.taskCodex != nil || p.ingress.publication.taskCodexRead != nil || p.store.updates != 2 {
				t.Fatal("absence retained an old source or exact read")
			}
			if _, _, err := p.ingress.currentCodexPublication(context.Background(), p.input.HostID, p.input.ScratchRoot); !errors.Is(err, task.ErrUnavailable) {
				t.Fatal("absence invented Task authority", err)
			}
			assertTaskReadMetadataHasNoEffects(t, p)
		})
	}
}

func TestTaskCurrentSourceClosedIngressRejectsPositiveLegacySelection(t *testing.T) {
	for _, field := range []string{"taskCodex", "taskCodexRead"} {
		p, facts := currentSourcePublicationFixture(t)
		request := sourcePublicationRequest(t, p, facts)
		raw, _ := json.Marshal(request)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		body[field] = map[string]any{}
		raw, _ = json.Marshal(body)
		peer := taskWireTestConnectMethods(t, p.ingress.Methods(), p.f.profile.peer)
		response := peer.call("computer.authority.publish", "legacy-source-publish", string(raw))
		if response.Result == nil || response.Result.Status == "ok" || p.store.updates != 0 || p.ingress.publication != nil {
			t.Fatal("legacy positive source route admitted", field, response)
		}
	}
}
