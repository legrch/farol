package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	taskport "github.com/legrch/farol/modules/task/app/port"
	settingsapp "github.com/legrch/farol/modules/task/app/services/currentsettings"
	modelapp "github.com/legrch/farol/modules/task/app/services/modelpolicy"
	settingsct "github.com/legrch/farol/modules/task/contracts/currentsettings"
	settingsnative "github.com/legrch/farol/modules/task/infra/currentsettings"
	modelnative "github.com/legrch/farol/modules/task/infra/modelpolicy"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// Clock-free comparison owns no settings writer, Task/provider or admission.
func taskCurrentSettingsMethods() map[string]desktop.Method {
	policy := modelapp.New(modelnative.JSONDecoder{}, modelnative.SHA256Digester{}, []string{"codex"})
	contract := settingsct.New(settingsapp.New(settingsnative.JSONDecoder{}, taskSettingsIdentity{policy}))
	return map[string]desktop.Method{"task.settings.compare": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("TaskCurrentSettingsCompareRequest", request.Body) != nil {
			return invalidIngress()
		}
		var body wire.TaskCurrentSettingsCompareRequest
		if json.Unmarshal(request.Body, &body) != nil {
			return invalidIngress()
		}
		result, err := contract.Compare(ctx, settingsct.Request{Before: []byte(body.Before), Candidate: []byte(body.Candidate)})
		if err != nil || result == nil {
			return &desktop.Outcome{Status: "unavailable", Code: "TASK_CURRENT_SETTINGS_UNAVAILABLE"}, nil
		}
		return ingressOutcome(wire.TaskCurrentSettingsCompareResponse{BeforeRevision: body.BeforeRevision, CandidateRevision: body.CandidateRevision, Changed: result.Changed}, nil)
	}}}
}

// Root maps independent owning-app values through the consumer-owned port.
type taskSettingsIdentity struct{ policy *modelapp.Service }

func (a taskSettingsIdentity) IdentifyTaskPolicy(raw []byte) (taskport.TaskSettingsPolicyIdentity, error) {
	identity := a.policy.Identity(raw)
	var kind taskport.TaskSettingsPolicyKind
	switch identity.Status {
	case modelapp.Ready:
		kind = taskport.TaskSettingsPolicyValid
	case modelapp.ConfigMissing:
		kind = taskport.TaskSettingsPolicyMissing
	case modelapp.ConfigInvalid:
		kind = taskport.TaskSettingsPolicyInvalid
	default:
		return taskport.TaskSettingsPolicyIdentity{}, errors.New("TASK_CURRENT_SETTINGS_UNAVAILABLE")
	}
	return taskport.TaskSettingsPolicyIdentity{Kind: kind, SHA256: identity.ConfigSHA256}, nil
}
