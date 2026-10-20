package boot

import (
	"context"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/app/services/helperrecovery"
)

// helperRecoveryPolicies is the production releaseport.HelperRecoveryPolicies:
// boot adapts the ORIGINAL recovery application owner (helperrecovery, the 1:1
// port of resources/native/update_helper.py inspect_recovery and reconcile) so the
// pure execution package never imports a sibling service. It holds no state and
// supplies no native admission: Observe binds only read-only observation ports and
// Bind binds the admitted runtime the caller already holds under custody.
//
// A typed-nil service is never returned as a non-nil interface; a nil owner
// result is reported as the absent policy the Milestone refuses with
// recovery_policy_required.
type helperRecoveryPolicies struct{}

var _ releaseport.HelperRecoveryPolicies = helperRecoveryPolicies{}

func (helperRecoveryPolicies) Observe(ctx context.Context, request releaseport.HelperRequest, observation releaseport.HelperRecoveryObservation) (releaseport.HelperRecoveryInspection, error) {
	service, err := helperrecovery.ObserveCaptured(ctx, request, observation)
	if err != nil || service == nil {
		return nil, err
	}
	return service, nil
}

func (helperRecoveryPolicies) Bind(ctx context.Context, request releaseport.HelperRequest, runtime releaseport.HelperRecoveryRuntime) (releaseport.HelperRecoveryReconciliation, error) {
	service, err := helperrecovery.NewCaptured(ctx, request, runtime)
	if err != nil || service == nil {
		return nil, err
	}
	return service, nil
}
