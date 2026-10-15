package modelpolicy

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/modelpolicy"
)

type CatalogueRequest struct {
	Config, Catalogue []byte
	Harness           string
}

type CatalogueResponse struct {
	Harness     string                     `json:"harness"`
	Catalogue   RuntimeCatalogue           `json:"catalogue"`
	ConfigError *string                    `json:"configError"`
	Configured  []CatalogueConfiguredModel `json:"configured"`
}

type RuntimeCatalogue struct {
	Status     string                  `json:"status"`
	Source     string                  `json:"source,omitempty"`
	Scope      string                  `json:"scope,omitempty"`
	ObservedAt int64                   `json:"observedAt,omitempty"`
	Models     []CatalogueRuntimeModel `json:"models,omitempty"`
	Code       string                  `json:"code,omitempty"`
}

type CatalogueRuntimeModel struct {
	ID               string   `json:"id"`
	Model            string   `json:"model"`
	DisplayName      string   `json:"displayName"`
	Hidden           bool     `json:"hidden"`
	SupportedEfforts []string `json:"supportedEfforts"`
	DefaultEffort    *string  `json:"defaultEffort,omitempty"`
}

type CatalogueConfiguredModel struct {
	Alias           string  `json:"alias"`
	Model           string  `json:"model"`
	DefaultEffort   *string `json:"defaultEffort,omitempty"`
	Available       string  `json:"available"`
	EffortAvailable *bool   `json:"effortAvailable"`
}

// MarshalJSON emits only the fields of the observed discriminated state.
func (c RuntimeCatalogue) MarshalJSON() ([]byte, error) {
	if c.Status == "unavailable" {
		return json.Marshal(struct {
			Status string `json:"status"`
			Code   string `json:"code"`
		}{c.Status, c.Code})
	}
	if c.Status != "ready" {
		return nil, &Failure{Code: "TASK_MODEL_CATALOGUE_UNAVAILABLE"}
	}
	models := c.Models
	if models == nil {
		models = make([]CatalogueRuntimeModel, 0)
	}
	return json.Marshal(struct {
		Status     string                  `json:"status"`
		Source     string                  `json:"source"`
		Scope      string                  `json:"scope"`
		ObservedAt int64                   `json:"observedAt"`
		Models     []CatalogueRuntimeModel `json:"models"`
	}{c.Status, c.Source, c.Scope, c.ObservedAt, models})
}

type CatalogueContract struct {
	service *app.Service
	decoder port.TaskModelCatalogueDecoder
}

func NewCatalogue(service *app.Service, decoder port.TaskModelCatalogueDecoder) *CatalogueContract {
	return &CatalogueContract{service: service, decoder: decoder}
}

func (c *CatalogueContract) Describe(ctx context.Context, in CatalogueRequest) (*CatalogueResponse, error) {
	if c == nil || c.service == nil || c.decoder == nil || ctx == nil || ctx.Err() != nil {
		return nil, &Failure{Code: "TASK_MODEL_CATALOGUE_UNAVAILABLE"}
	}
	view, err := c.service.Describe(in.Config, in.Harness, in.Catalogue, c.decoder)
	if ctx.Err() != nil {
		return nil, &Failure{Code: "TASK_MODEL_CATALOGUE_UNAVAILABLE"}
	}
	if err != nil {
		if failure, ok := err.(*app.CatalogueFailure); ok && failure.Code == app.CatalogueInvalid {
			return nil, &Failure{Code: app.CatalogueInvalid}
		}
		return nil, &Failure{Code: app.CatalogueUnavailable}
	}
	if view == nil {
		return nil, &Failure{Code: app.CatalogueUnavailable}
	}
	out := &CatalogueResponse{Harness: strings.Clone(view.Harness), ConfigError: catalogueStringCopy(view.ConfigError), Configured: make([]CatalogueConfiguredModel, 0, len(view.Configured))}
	observed := view.Catalogue
	out.Catalogue = RuntimeCatalogue{Status: strings.Clone(observed.Status), Source: strings.Clone(observed.Source), Scope: strings.Clone(observed.Scope), ObservedAt: observed.ObservedAt, Code: strings.Clone(observed.Code), Models: make([]CatalogueRuntimeModel, 0, len(observed.Models))}
	for _, model := range observed.Models {
		dto := CatalogueRuntimeModel{ID: strings.Clone(model.ID), Model: strings.Clone(model.Model), DisplayName: strings.Clone(model.DisplayName), Hidden: model.Hidden, DefaultEffort: catalogueStringCopy(model.DefaultEffort), SupportedEfforts: make([]string, 0, len(model.SupportedEfforts))}
		for _, effort := range model.SupportedEfforts {
			dto.SupportedEfforts = append(dto.SupportedEfforts, strings.Clone(effort))
		}
		out.Catalogue.Models = append(out.Catalogue.Models, dto)
	}
	for _, model := range view.Configured {
		dto := CatalogueConfiguredModel{Alias: strings.Clone(model.Alias), Model: strings.Clone(model.Model), DefaultEffort: catalogueStringCopy(model.DefaultEffort), Available: strings.Clone(model.Available)}
		if model.EffortAvailable != nil {
			value := *model.EffortAvailable
			dto.EffortAvailable = &value
		}
		out.Configured = append(out.Configured, dto)
	}
	return out, nil
}

func catalogueStringCopy(value *string) *string {
	if value == nil {
		return nil
	}
	copy := strings.Clone(*value)
	return &copy
}
