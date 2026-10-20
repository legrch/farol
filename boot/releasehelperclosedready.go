package boot

import (
	"context"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	release "github.com/legrch/farol/modules/release/domain"
	executionnative "github.com/legrch/farol/modules/release/infra/native/execution"
	releasestate "github.com/legrch/farol/modules/release/infra/native/state"
	"github.com/legrch/farol/modules/release/infra/repos/journal"
)

// closedHelperJournalObservation is the ONE production implementer of
// HelperJournalObservationAdmission. It borrows the preflight scope of the
// closed helper: custody proof is the scope's own Check, uncertainty is its
// sticky retained state, and the gate is private to this observation. It is not
// a JournalAdmission: it proves no stopped writer or exclusion and creates no
// default reader, writer, CAS or repair authority. A nil or ended scope refuses.
type closedHelperJournalObservation struct {
	helper    closedReleaseHelper
	gate      releaseport.StateGate
	operation release.Operation
	binding   releaseport.JournalDirectory
}

var _ releaseport.HelperJournalObservationAdmission = (*closedHelperJournalObservation)(nil)

func (a *closedHelperJournalObservation) JournalGate() releaseport.StateGate {
	if a == nil || a.helper.state == nil {
		return nil
	}
	return a.gate
}

// Reverify never reenters the gate; the preflight scope's Check takes only the
// native mutex. begin() refuses an ended scope or one with retained uncertainty.
func (a *closedHelperJournalObservation) ReverifyHelperJournalObservation(ctx context.Context, op release.Operation, binding releaseport.JournalDirectory) error {
	if a == nil || a.helper.state == nil || ctx == nil || op != a.operation || binding != a.binding {
		return releaseport.JournalUnproven
	}
	return a.helper.reverify(ctx, a.helper.state.request)
}

func (a *closedHelperJournalObservation) JournalUnknown(op release.Operation) bool {
	return a == nil || a.helper.state == nil || op != a.operation || a.helper.unknown() != nil
}

func (a *closedHelperJournalObservation) RetainJournalUnknown(release.Operation) {
	if a != nil {
		a.helper.retainUnknown(nil)
	}
}

// closedHelperReady is the production readiness seam. It composes only the
// existing owners over the borrowed Files: bounded journal observation, the
// read-only installation projection and the Milestone's pure policy. It never
// calls Execute, so no journal, app, install, recovery or relaunch effect occurs.
func closedHelperReady(ctx context.Context, milestone *executionapp.Milestone, helper closedReleaseHelper) (ready *executionapp.Readiness, err error) {
	s := helper.state
	if ctx == nil || milestone == nil || s == nil || s.files.Operation == nil {
		return nil, closedHelperFail(false)
	}
	request := closedHelperRequestCopy(s.request)
	build := func(b releaseport.HelperBuild) release.Build {
		return release.Build{Digest: b.Digest, Version: b.Version, BuildID: b.BuildID}
	}
	operation := release.Operation{ID: request.OperationID, Source: build(request.Source), Target: build(request.Target)}
	// The helper routes pin the update directory and the operation directory
	// beneath it; these identities are the journal's expected directory binding.
	binding := releaseport.JournalDirectory{
		Device: s.files.OperationIdentity.Device, Inode: s.files.OperationIdentity.Inode,
		ParentDevice: s.files.UpdateIdentity.Device, ParentInode: s.files.UpdateIdentity.Inode,
	}
	directory := request.Home + "/Library/Application Support/Farol Next Preview/installed-updates/" + request.OperationID
	admission := &closedHelperJournalObservation{helper: helper, gate: releasestate.New(), operation: operation, binding: binding}
	err = journal.WithObservation(ctx, directory, s.files.Operation, binding, operation, admission, func(reader *journal.Observation) error {
		return executionnative.WithObservation(ctx, executionnative.ObservationConfig{
			Request: request, Files: s.files, Journal: reader, Until: s.until,
			Reverify: helper.reverify, Unknown: helper.unknown, RetainUnknown: helper.retainUnknown,
		}, func(observation releaseport.HelperInstallationObservation) error {
			var e error
			ready, e = milestone.Inspect(ctx, observation)
			return e
		})
	})
	if err != nil {
		return nil, closedHelperFail(false, err)
	}
	return ready, nil
}
