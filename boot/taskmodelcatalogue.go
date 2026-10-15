package boot

import (
	"context"
	"encoding/json"

	wire "github.com/legrch/farol/gen/desktop/v1"
	modelapp "github.com/legrch/farol/modules/task/app/services/modelpolicy"
	modelct "github.com/legrch/farol/modules/task/contracts/modelpolicy"
	modelnative "github.com/legrch/farol/modules/task/infra/modelpolicy"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// This pure Task read accepts observations, not account or execution authority.
// The same Task owner validates the saved policy; Electron supplies no decision.
func taskModelCatalogueMethods() map[string]desktop.Method {
	decoder := modelnative.JSONDecoder{}
	service := modelapp.New(decoder, modelnative.SHA256Digester{}, []string{"codex"})
	contract := modelct.NewCatalogue(service, decoder)
	return map[string]desktop.Method{"task.models.describe": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("TaskModelCatalogueRequest", request.Body) != nil {
			return invalidIngress()
		}
		var body wire.TaskModelCatalogueRequest
		if json.Unmarshal(request.Body, &body) != nil {
			return invalidIngress()
		}
		result, err := contract.Describe(ctx, modelct.CatalogueRequest{Config: body.Config, Catalogue: body.Catalogue, Harness: body.Harness})
		if err != nil {
			return &desktop.Outcome{Status: "unavailable", Code: "TASK_MODEL_CATALOGUE_UNAVAILABLE"}, nil
		}
		view, err := json.Marshal(result)
		if err != nil || ctx.Err() != nil {
			return &desktop.Outcome{Status: "unavailable", Code: "TASK_MODEL_CATALOGUE_UNAVAILABLE"}, nil
		}
		return ingressOutcome(wire.TaskModelCatalogueResponse{Revision: body.Revision, View: view}, nil)
	}}}
}
