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

// The compiled harness list describes implementations, never permissions or
// runtime model availability. No Task/native provider owner is opened here.
func taskModelPolicyMethods() map[string]desktop.Method {
	contract := modelct.New(modelapp.New(modelnative.JSONDecoder{}, modelnative.SHA256Digester{}, []string{"codex"}))
	return map[string]desktop.Method{"task.model.resolve": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("TaskModelPolicyRequest", request.Body) != nil {
			return invalidIngress()
		}
		var body wire.TaskModelPolicyRequest
		if json.Unmarshal(request.Body, &body) != nil {
			return invalidIngress()
		}
		result, err := contract.Resolve(ctx, modelct.Request{Config: body.Config, Selection: body.Selection})
		if err != nil {
			return &desktop.Outcome{Status: "unavailable", Code: "TASK_MODEL_POLICY_UNAVAILABLE"}, nil
		}
		out := wire.TaskModelPolicyResponse{Revision: body.Revision, Status: result.Status}
		if result.Selection != nil {
			out.Selection = &wire.TaskModelPolicySelection{Harness: result.Selection.Harness, ModelAlias: result.Selection.ModelAlias, Model: result.Selection.Model, Effort: result.Selection.Effort}
			digest := result.ConfigSHA256
			out.ConfigSha256 = &digest
		}
		return ingressOutcome(out, nil)
	}}}
}
