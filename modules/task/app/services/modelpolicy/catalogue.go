package modelpolicy

import (
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/app/port"
)

const MaxCatalogueBytes = 1 << 20
const CatalogueInvalid = "TASK_MODEL_CATALOGUE_INVALID"
const CatalogueUnavailable = "TASK_MODEL_CATALOGUE_UNAVAILABLE"
const CatalogueConfigUnavailable = "TASK_MODEL_CONFIG_UNAVAILABLE"

type CatalogueFailure struct{ Code string }

func (f *CatalogueFailure) Error() string { return f.Code }

type CatalogueView struct {
	Harness     string
	Catalogue   port.TaskRuntimeCatalogue
	ConfigError *string
	Configured  []ConfiguredModel
}
type ConfiguredModel struct {
	Alias           string
	Model           string
	DefaultEffort   *string
	Available       string
	EffortAvailable *bool
}

// Describe projects a single configured-policy and observed-catalogue snapshot.
// Every harness in the policy is validated by the same validator as Resolve.
// It neither resolves a selection nor activates a harness. Inputs must remain
// unchanged during this call; outputs retain no input or decoder-owned aliases.
func (s *Service) Describe(configJSON []byte, harness string, catalogueJSON []byte, decoder port.TaskModelCatalogueDecoder) (*CatalogueView, error) {
	if s == nil || s.decoder == nil || decoder == nil {
		return nil, &CatalogueFailure{Code: CatalogueUnavailable}
	}
	if !taskName(harness) || len(catalogueJSON) > MaxCatalogueBytes {
		return nil, &CatalogueFailure{Code: CatalogueInvalid}
	}
	catalogue, err := decoder.DecodeCatalogue(append([]byte(nil), catalogueJSON...))
	if err != nil || !validCatalogue(catalogue) {
		return nil, &CatalogueFailure{Code: CatalogueInvalid}
	}
	out := &CatalogueView{Harness: strings.Clone(harness), Catalogue: cloneCatalogue(catalogue), Configured: make([]ConfiguredModel, 0)}
	configError := CatalogueConfigUnavailable
	out.ConfigError = &configError
	if len(configJSON) > MaxPolicyBytes {
		return out, nil
	}
	policy, err := s.decoder.DecodePolicy(append([]byte(nil), configJSON...))
	if err != nil || policy == nil || !validPolicy(*policy) {
		return out, nil
	}
	entry, exists := policy.Harnesses[harness]
	if !exists {
		return out, nil
	}
	models := make(map[string]port.TaskModel, len(entry.Models))
	for alias, model := range entry.Models {
		models[strings.Clone(alias)] = port.TaskModel{Model: strings.Clone(model.Model), DefaultEffort: cloneString(model.DefaultEffort)}
	}
	order, err := decoder.ModelOrder(append([]byte(nil), configJSON...), strings.Clone(harness))
	if err != nil || len(order) != len(models) {
		return nil, &CatalogueFailure{Code: CatalogueUnavailable}
	}
	seen := make(map[string]bool, len(order))
	for _, alias := range order {
		if _, ok := models[alias]; !ok || seen[alias] {
			return nil, &CatalogueFailure{Code: CatalogueUnavailable}
		}
		seen[alias] = true
	}
	out.ConfigError = nil
	// The first runtime observation wins, including hidden entries.
	actual := make(map[string]port.TaskRuntimeModel, len(out.Catalogue.Models))
	for _, model := range out.Catalogue.Models {
		if _, exists := actual[model.Model]; !exists {
			actual[model.Model] = model
		}
	}
	for _, alias := range order {
		model := models[alias]
		row := ConfiguredModel{Alias: strings.Clone(alias), Model: strings.Clone(model.Model), DefaultEffort: cloneString(model.DefaultEffort), Available: "unknown"}
		if out.Catalogue.Status == "ready" {
			runtime, found := actual[model.Model]
			row.Available = "no"
			effort := false
			if found {
				row.Available = "yes"
				effort = model.DefaultEffort == nil
				if model.DefaultEffort != nil {
					for _, supported := range runtime.SupportedEfforts {
						effort = effort || supported == *model.DefaultEffort
					}
				}
			}
			row.EffortAvailable = &effort
		}
		out.Configured = append(out.Configured, row)
	}
	return out, nil
}

func validCatalogue(c port.TaskRuntimeCatalogue) bool {
	switch c.Status {
	case "unavailable":
		return catalogueText(c.Code, 1, 120) && c.Source == "" && c.Scope == "" && c.ObservedAt == 0 && len(c.Models) == 0
	case "ready":
		if c.Source != "model/list" || !catalogueText(c.Scope, 1, 240) || c.Code != "" || c.ObservedAt < 0 || c.ObservedAt > 9007199254740991 || len(c.Models) > 2000 {
			return false
		}
		for _, m := range c.Models {
			if !catalogueText(m.ID, 1, 160) || !runtimeModel(m.Model) || !catalogueText(m.DisplayName, 0, 240) || len(m.SupportedEfforts) > 32 || !optional(m.DefaultEffort, effortName) {
				return false
			}
			for _, effort := range m.SupportedEfforts {
				if !effortName(effort) {
					return false
				}
			}
		}
		return true
	default:
		return false
	}
}

// JavaScript schema lengths count UTF-16 code units, not UTF-8 bytes or runes.
func catalogueText(s string, min, max int) bool {
	if !utf8.ValidString(s) {
		return false
	}
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n >= min && n <= max
}
func cloneString(s *string) *string {
	if s == nil {
		return nil
	}
	value := strings.Clone(*s)
	return &value
}
func cloneCatalogue(c port.TaskRuntimeCatalogue) port.TaskRuntimeCatalogue {
	out := port.TaskRuntimeCatalogue{Status: strings.Clone(c.Status), Source: strings.Clone(c.Source), Scope: strings.Clone(c.Scope), ObservedAt: c.ObservedAt, Code: strings.Clone(c.Code), Models: make([]port.TaskRuntimeModel, 0, len(c.Models))}
	for _, m := range c.Models {
		model := port.TaskRuntimeModel{ID: strings.Clone(m.ID), Model: strings.Clone(m.Model), DisplayName: strings.Clone(m.DisplayName), Hidden: m.Hidden, DefaultEffort: cloneString(m.DefaultEffort), SupportedEfforts: make([]string, 0, len(m.SupportedEfforts))}
		for _, effort := range m.SupportedEfforts {
			model.SupportedEfforts = append(model.SupportedEfforts, strings.Clone(effort))
		}
		out.Models = append(out.Models, model)
	}
	return out
}
