package modelpolicy

import (
	"errors"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
)

type cataloguePolicyStub struct{ policy *port.TaskModelPolicy }

func (d cataloguePolicyStub) DecodePolicy(raw []byte) (*port.TaskModelPolicy, error) {
	if len(raw) > 0 {
		raw[0] = 'x'
	}
	return d.policy, nil
}
func (d cataloguePolicyStub) DecodeSelection([]byte) (port.TaskModelPolicyRequest, error) {
	return port.TaskModelPolicyRequest{}, nil
}

type catalogueDecoderStub struct {
	catalogue port.TaskRuntimeCatalogue
	order     []string
	orderErr  error
}

func (d catalogueDecoderStub) DecodeCatalogue(raw []byte) (port.TaskRuntimeCatalogue, error) {
	if len(raw) > 0 {
		raw[0] = 'x'
	}
	return d.catalogue, nil
}
func (d catalogueDecoderStub) ModelOrder(raw []byte, _ string) ([]string, error) {
	if len(raw) > 0 {
		raw[0] = 'x'
	}
	return d.order, d.orderErr
}
func catalogueFixture() (*port.TaskModelPolicy, *catalogueDecoderStub) {
	effort := "high"
	policy := &port.TaskModelPolicy{DefaultHarness: "codex", Harnesses: map[string]port.TaskModelHarness{"codex": {DefaultModel: "alias", Models: map[string]port.TaskModel{"alias": {Model: "runtime", DefaultEffort: &effort}}}}}
	observedEffort := "low"
	decoder := &catalogueDecoderStub{catalogue: port.TaskRuntimeCatalogue{Status: "ready", Source: "model/list", Scope: "test", Models: []port.TaskRuntimeModel{{ID: "one", Model: "runtime", SupportedEfforts: []string{"high"}, DefaultEffort: &observedEffort}}}, order: []string{"alias"}}
	return policy, decoder
}
func TestCatalogueDefensiveCopies(t *testing.T) {
	policy, decoder := catalogueFixture()
	service := New(cataloguePolicyStub{policy}, nil, nil)
	config, raw := []byte("config"), []byte("catalogue")
	out, err := service.Describe(config, "codex", raw, decoder)
	if err != nil {
		t.Fatal(err)
	}
	if string(config) != "config" || string(raw) != "catalogue" {
		t.Fatal("decoder mutated caller bytes")
	}
	*policy.Harnesses["codex"].Models["alias"].DefaultEffort = "changed"
	*decoder.catalogue.Models[0].DefaultEffort = "changed"
	decoder.catalogue.Models[0].SupportedEfforts[0] = "changed"
	decoder.catalogue.Models[0].ID = "changed"
	decoder.order[0] = "changed"
	if *out.Configured[0].DefaultEffort != "high" || *out.Catalogue.Models[0].DefaultEffort != "low" || out.Catalogue.Models[0].SupportedEfforts[0] != "high" || out.Catalogue.Models[0].ID != "one" || out.Configured[0].Alias != "alias" {
		t.Fatalf("decoder aliases retained: %+v", out)
	}
	*out.Configured[0].DefaultEffort = "output"
	out.Catalogue.Models[0].SupportedEfforts[0] = "output"
	if *policy.Harnesses["codex"].Models["alias"].DefaultEffort != "changed" || decoder.catalogue.Models[0].SupportedEfforts[0] != "changed" {
		t.Fatal("output mutated decoder state")
	}
}
func TestCatalogueRejectsInvalidAdapterOrder(t *testing.T) {
	for _, order := range [][]string{nil, {}, {"other"}, {"alias", "alias"}} {
		policy, decoder := catalogueFixture()
		decoder.order = order
		if out, err := New(cataloguePolicyStub{policy}, nil, nil).Describe(nil, "codex", nil, decoder); out != nil || err == nil || err.Error() != CatalogueUnavailable {
			t.Fatalf("order %v: %v %v", order, out, err)
		}
	}
	policy, decoder := catalogueFixture()
	decoder.orderErr = errors.New("adapter")
	if _, err := New(cataloguePolicyStub{policy}, nil, nil).Describe(nil, "codex", nil, decoder); err == nil || err.Error() != CatalogueUnavailable {
		t.Fatalf("adapter error %v", err)
	}
	// Same cardinality still requires complete, unique membership.
	policy.Harnesses["codex"].Models["second"] = port.TaskModel{Model: "runtime"}
	decoder.orderErr = nil
	decoder.order = []string{"alias", "alias"}
	if _, err := New(cataloguePolicyStub{policy}, nil, nil).Describe(nil, "codex", nil, decoder); err == nil || err.Error() != CatalogueUnavailable {
		t.Fatal("duplicate accepted")
	}
}
func TestCatalogueMissingDependenciesAndInvalidValues(t *testing.T) {
	policy, decoder := catalogueFixture()
	for _, service := range []*Service{nil, New(nil, nil, nil)} {
		if _, err := service.Describe(nil, "codex", nil, decoder); err == nil || err.Error() != CatalogueUnavailable {
			t.Fatalf("nil service %v", err)
		}
	}
	service := New(cataloguePolicyStub{policy}, nil, nil)
	if _, err := service.Describe(nil, "codex", nil, nil); err == nil || err.Error() != CatalogueUnavailable {
		t.Fatalf("nil decoder %v", err)
	}
	for _, harness := range []string{"", "Bad", "has space"} {
		if _, err := service.Describe(nil, harness, nil, decoder); err == nil || err.Error() != CatalogueInvalid {
			t.Fatalf("harness %q: %v", harness, err)
		}
	}
	invalid := []port.TaskRuntimeCatalogue{{Status: "other"}, {Status: "unavailable"}, {Status: "ready", Source: "bad", Scope: "x"}, {Status: "ready", Source: "model/list", Scope: "x", ObservedAt: -1}, {Status: "ready", Source: "model/list", Scope: "x", ObservedAt: 9007199254740992}}
	for _, observed := range invalid {
		decoder.catalogue = observed
		if _, err := service.Describe(nil, "codex", nil, decoder); err == nil || err.Error() != CatalogueInvalid {
			t.Fatalf("catalogue %+v: %v", observed, err)
		}
	}
}

type mutatingCatalogueDecoder struct {
	*catalogueDecoderStub
	policy *port.TaskModelPolicy
}

func (d mutatingCatalogueDecoder) ModelOrder(raw []byte, harness string) ([]string, error) {
	d.policy.Harnesses[harness].Models["alias"] = port.TaskModel{Model: "mutated"}
	d.catalogue.Models[0].SupportedEfforts[0] = "mutated"
	return d.catalogueDecoderStub.ModelOrder(raw, harness)
}
func TestCatalogueSnapshotsBeforeNextAdapterCall(t *testing.T) {
	policy, decoder := catalogueFixture()
	out, err := New(cataloguePolicyStub{policy}, nil, nil).Describe(nil, "codex", nil, mutatingCatalogueDecoder{decoder, policy})
	if err != nil {
		t.Fatal(err)
	}
	if out.Configured[0].Model != "runtime" || out.Configured[0].Available != "yes" || out.Configured[0].DefaultEffort == nil || *out.Configured[0].DefaultEffort != "high" || !*out.Configured[0].EffortAvailable || out.Catalogue.Models[0].SupportedEfforts[0] != "high" {
		t.Fatalf("snapshot changed: %+v", out)
	}
}
