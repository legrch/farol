package boot

import (
	"context"
	"errors"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/infra/modelruntime"
)

// This is the existing Browser route's detached policy capture, not a catalogue
// discovery result or SIWC entitlement. The private account grant remains the
// authority; no model value can reconstruct it.
type chatBrowserModel struct {
	original modelruntime.BrowserCapture
	clock    chatport.AccountClock
}

func captureChatBrowserModel(ctx context.Context, account *capturedChatAccount, capture chatport.ModelSelectionCapture, scope chatport.AccountScope, observation chatport.AccountObservation, clock chatport.AccountClock) (*chatBrowserModel, error) {
	if ctx == nil || account == nil || account.grant == nil || clock == nil {
		return nil, errors.New("chat_model_capture_invalid")
	}
	var original modelruntime.BrowserCapture
	err := account.grant.WithCurrent(ctx, scope, account.approvalID, observation, func(approval chatport.AccountApproval) error {
		var err error
		original, err = modelruntime.CaptureBrowser(capture, modelruntime.BrowserSource{Approval: approval, Observation: observation}, clock.NowMillis())
		return err
	})
	if err != nil {
		return nil, err
	}
	return &chatBrowserModel{original: original, clock: clock}, nil
}

// Called under the SAME account gate. This mints only a per-turn detached model
// correlation value from fresh verification facts; it cannot change the account,
// model, configuration epoch or capability evidence chosen at admission.
func (m *chatBrowserModel) forDispatch(approval chatport.AccountApproval, observation chatport.AccountObservation) (func() error, error) {
	if m == nil || m.clock == nil || approval != m.original.Source().Approval {
		return nil, errors.New("chat_model_approval_crossed")
	}
	capture := m.original.Capture()
	source := modelruntime.BrowserSource{Approval: approval, Observation: observation}
	dispatch, err := modelruntime.CaptureBrowser(capture, source, m.clock.NowMillis())
	if err != nil || dispatch.Resolved().Pin() != m.original.Resolved().Pin() || dispatch.Resolved().Capabilities() != m.original.Resolved().Capabilities() {
		return nil, errors.New("chat_model_selection_crossed")
	}
	// No IO or owner reentry. The final check runs account -> exact Chat guard,
	// so gate wait consumes this original observation's freshness interval.
	return func() error {
		return modelruntime.RecheckBrowser(dispatch, capture, source, m.clock.NowMillis())
	}, nil
}
