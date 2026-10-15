// Package modelpolicy publishes Task's pure model-policy decision. It grants no
// account, provider, process, workspace or Task lifecycle authority.
package modelpolicy

import (
	"context"

	app "github.com/legrch/farol/modules/task/app/services/modelpolicy"
)

type Request struct {
	Config, Selection []byte
}

type Selection struct {
	Harness, ModelAlias, Model string
	Effort                     *string
}

type Response struct {
	Status       string
	Selection    *Selection
	ConfigSHA256 string
}

type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

type Contract struct{ service *app.Service }

func New(service *app.Service) *Contract { return &Contract{service: service} }

func (c *Contract) Resolve(ctx context.Context, in Request) (*Response, error) {
	if c == nil || c.service == nil || ctx == nil || ctx.Err() != nil {
		return nil, &Failure{Code: "TASK_MODEL_POLICY_UNAVAILABLE"}
	}
	result := c.service.Resolve(in.Config, in.Selection)
	if ctx.Err() != nil {
		return nil, &Failure{Code: "TASK_MODEL_POLICY_UNAVAILABLE"}
	}
	out := &Response{Status: string(result.Status)}
	switch result.Status {
	case app.Ready:
		if result.Selection == nil || len(result.ConfigSHA256) != 64 {
			return nil, &Failure{Code: "TASK_MODEL_POLICY_UNAVAILABLE"}
		}
		selected := result.Selection
		out.Selection = &Selection{Harness: selected.Harness, ModelAlias: selected.ModelAlias, Model: selected.Model}
		if selected.Effort != nil {
			effort := *selected.Effort
			out.Selection.Effort = &effort
		}
		out.ConfigSHA256 = result.ConfigSHA256
	case app.ConfigMissing, app.ConfigInvalid, app.SelectionInvalid, app.HarnessMissing, app.HarnessUnsupported, app.ModelMissing, app.Unavailable:
	default:
		return nil, &Failure{Code: "TASK_MODEL_POLICY_UNAVAILABLE"}
	}
	return out, nil
}
