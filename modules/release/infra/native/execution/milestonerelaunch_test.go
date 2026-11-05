package execution

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	"github.com/legrch/farol/modules/release/infra/native/helperprotocol"
)

// These witnesses run the application Milestone's relaunch end to end over the
// real installation runtime in the owner's slot (legacy) mode: a real apply to
// `verified`, the journal writes, the self measurement, the argument capability
// and the pre-launch image verification. Only three things are symbolic, as in
// the other composition witnesses: route/lease/admission, the OS launch seam
// (the unexported Config.open, which stands in for /usr/bin/open), and the
// measured self identity. They do not qualify LaunchServices or the selected
// helper.
//
// The shared-install path cannot run end to end here: its Applications parent
// must be root-owned (installmove.SharedApplicationsParent requires uid 0), so
// a non-root run cannot even apply into it. Canonical slot binding is covered
// by launchBound with synthetic paths.

// recordingOpen is the scripted stand-in for /usr/bin/open. It records every
// call and, like the production open, runs the operation fence before and after
// the child; err is what a nonzero status returns.
type recordingOpen struct {
	f         *relaunchLifecycle
	opens     int
	arguments [][]string
	phases    []string // journal phase observed at each open
	err       error
}

func (p *recordingOpen) open(ctx context.Context, _ time.Time, arguments []string, fence func(context.Context) error) error {
	p.opens++
	p.arguments = append(p.arguments, append([]string(nil), arguments...))
	p.phases = append(p.phases, p.f.diskPhase(p.f.t))
	if err := fence(ctx); err != nil {
		return err
	}
	if p.err != nil {
		return p.err
	}
	return fence(ctx)
}

// relaunchLifecycle is a lifecycle fixture whose target carries a scratch
// executable, with the launch capabilities recorded.
type relaunchLifecycle struct {
	*lifecycleFixture
	t    *testing.T
	fake *recordingOpen
	app  string // the installed image a launch must run

	measures, builds int
	atMeasure        []string
	atBuild          []string
	phases           []string // distinct journal phases seen by Reverify, in order
}

const relaunchSelfStart = "declared fixture helper birth"

// newRelaunchLifecycle builds the fixture over open, the stand-in for
// /usr/bin/open. exe is the target's executable: empty keeps the inert image,
// the gated native lane passes a real scratch program.
func newRelaunchLifecycle(t *testing.T, exe string, open func(*relaunchLifecycle) openFunc) *relaunchLifecycle {
	t.Helper()
	f := &relaunchLifecycle{lifecycleFixture: newLifecycleFixtureWithExecutable(t, newCompositionFixture(t), exe), t: t}
	f.app = filepath.Join(f.config.Files.Applications.Name(), "Farol.app")
	if open != nil {
		f.config.open = open(f)
	}
	original := f.config.Reverify
	f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
		if err := original(ctx, request); err != nil {
			return err
		}
		if phase := f.diskPhase(t); phase != "" && (len(f.phases) == 0 || f.phases[len(f.phases)-1] != phase) {
			f.phases = append(f.phases, phase)
		}
		return nil
	}
	f.config.MeasureSelf = func(_ context.Context, until time.Time) (port.HelperSelfIdentity, error) {
		f.measures++
		f.atMeasure = append(f.atMeasure, f.diskPhase(t))
		if until.After(f.config.Until) {
			t.Fatal("measurement renewed the original bound")
		}
		return port.HelperSelfIdentity{PID: int64(os.Getpid()), ProcessStart: relaunchSelfStart}, nil
	}
	f.config.RelaunchArguments = func(_ context.Context, self port.HelperSelfIdentity) ([]string, error) {
		f.builds++
		f.atBuild = append(f.atBuild, f.diskPhase(t))
		app := f.app
		hint, err := helperprotocol.JSONCodec{}.Relaunch(port.HelperRelaunchHint{
			OperationID: f.config.Request.OperationID, Action: f.config.Request.Action, Phase: "completed",
			BuildID: f.config.Request.Target.BuildID, Helper: self,
		})
		if err != nil {
			return nil, err
		}
		return []string{"/usr/bin/open", "-a", app, "--args", "--farol-installed-update-relaunch=" + string(hint)}, nil
	}
	return f
}

func newFakeRelaunchLifecycle(t *testing.T) *relaunchLifecycle {
	t.Helper()
	var recording *recordingOpen
	f := newRelaunchLifecycle(t, "", func(f *relaunchLifecycle) openFunc {
		recording = &recordingOpen{f: f}
		return recording.open
	})
	f.fake = recording
	return f
}

// relaunchRequest is the live (no closed proof) legacy-slot request.
func (f *relaunchLifecycle) relaunchRequest(action string, relaunch bool) port.HelperRequest {
	request := f.config.Request
	request.Action, request.Relaunch = action, relaunch
	location := "legacy"
	request.InstallLocation = &location
	f.config.Request, f.owner.request = request, request
	return request
}

func (f *relaunchLifecycle) prepare(t *testing.T, action string, relaunch bool) (*executionapp.Milestone, *executionapp.Readiness) {
	t.Helper()
	m, err := executionapp.NewMilestone(context.Background(), f.relaunchRequest(action, relaunch))
	must(t, err)
	ready, err := f.inspect(t, m)
	must(t, err)
	if ready == nil {
		t.Fatal("inspection produced no readiness")
	}
	return m, ready
}

// run executes with the very admitted runtime as the launch port, exactly as
// the boot composition does.
func (f *relaunchLifecycle) run(t *testing.T, m *executionapp.Milestone, ready *executionapp.Readiness) (*executionapp.Result, error) {
	t.Helper()
	var result *executionapp.Result
	err := withAdmittedInstallation(context.Background(), f.config, milestoneRoutes, func(native AdmittedInstallation) error {
		var runtime executionapp.AdmittedRuntime = native
		var e error
		result, e = m.Execute(context.Background(), runtime, ready, native)
		return e
	})
	return result, err
}

type relaunchHintWire struct {
	OperationID string `json:"operationId"`
	Action      string `json:"action"`
	Phase       string `json:"phase"`
	BuildID     string `json:"buildId"`
	Helper      struct {
		PID          int64  `json:"pid"`
		ProcessStart string `json:"processStart"`
	} `json:"helper"`
}

func relaunchHintOf(t *testing.T, argument string) (hint relaunchHintWire) {
	t.Helper()
	const prefix = "--farol-installed-update-relaunch="
	if !strings.HasPrefix(argument, prefix) {
		t.Fatal("not the relaunch hint", argument)
	}
	must(t, json.Unmarshal([]byte(strings.TrimPrefix(argument, prefix)), &hint))
	return hint
}

// describe unrolls a classified error chain so a failed witness names its cause.
func describe(err error) string {
	var parts []string
	var walk func(error)
	walk = func(e error) {
		for e != nil {
			switch v := e.(type) {
			case *port.HelperRecoveryFailure:
				parts = append(parts, "recovery:"+v.Code+"/"+v.Phase)
			case *executionapp.Failure:
				parts = append(parts, "failure:"+v.Code+"/"+v.Phase)
			default:
				parts = append(parts, e.Error())
			}
			switch v := e.(type) {
			case interface{ Unwrap() []error }:
				for _, c := range v.Unwrap() {
					walk(c)
				}
				return
			case interface{ Unwrap() error }:
				e = v.Unwrap()
			default:
				return
			}
		}
	}
	walk(err)
	return strings.Join(parts, " <- ")
}

func containsInOrder(got, want []string) bool {
	next := 0
	for _, g := range got {
		if next < len(want) && g == want[next] {
			next++
		}
	}
	return next == len(want)
}

func TestMilestoneRelaunchApplyCompletes(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	var checked []string
	f.config.verifyExecutables = func(_ context.Context, until time.Time, path string) error {
		if until.After(f.config.Until) || f.diskPhase(t) != "launch_requested" || f.fake.opens != 0 {
			t.Fatal("signature verification escaped the original launch fence")
		}
		checked = append(checked, path)
		return nil
	}
	m, ready := f.prepare(t, "apply", true)
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "completed"}) {
		t.Fatal("verified apply with relaunch did not complete", result)
	}
	f.physical(t, f.repo, "completed")
	// The journal moved verified -> launch_requested -> completed, and each
	// launch step ran with launch_requested already durable.
	if want := []string{"verified", "launch_requested", "completed"}; !containsInOrder(f.phases, want) {
		t.Fatalf("journal order %v does not contain %v", f.phases, want)
	}
	if len(checked) != 1 || checked[0] != f.app {
		t.Fatalf("signature verification did not use the canonical installed slot: %q, want %q", checked, f.app)
	}
	if f.measures != 1 || f.builds != 1 || f.fake.opens != 1 {
		t.Fatal("measure, arguments and open must each run once", f.measures, f.builds, f.fake.opens)
	}
	for step, phases := range map[string][]string{"measure": f.atMeasure, "arguments": f.atBuild, "open": f.fake.phases} {
		if len(phases) != 1 || phases[0] != "launch_requested" {
			t.Fatalf("%s did not run at launch_requested: %v", step, phases)
		}
	}
	// The one open names the owner's slot and carries the protocol hint built
	// with phase "completed" and this helper's own identity.
	arguments := f.fake.arguments[0]
	if len(arguments) != 5 || arguments[0] != "/usr/bin/open" || arguments[1] != "-a" || arguments[2] != f.app || arguments[3] != "--args" {
		t.Fatalf("argv %q (image %s)", arguments, f.app)
	}
	hint := relaunchHintOf(t, arguments[4])
	if hint.OperationID != f.config.Request.OperationID || hint.Action != "apply" || hint.Phase != "completed" ||
		hint.BuildID != f.config.Request.Target.BuildID || hint.Helper.PID != int64(os.Getpid()) || hint.Helper.ProcessStart != relaunchSelfStart {
		t.Fatalf("hint %+v", hint)
	}
	if f.owner.retained() != nil {
		t.Fatal("a completed relaunch retained uncertainty", f.owner.retained())
	}
	lifecycleRequireTree(t, f.app, f.target)
	if _, err := os.Lstat(filepath.Join(f.path, "launch-Farol.app")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a legacy install published a private capture", err)
	}
}

// A clean returned nonzero open is the original launch_failed: the helper
// reports the launch_requested phase with the code, the journal keeps
// launch_requested and nothing is retained as unknown.
func TestMilestoneRelaunchCleanLaunchFailure(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.fake.err = fail("launch_failed", false, false, errors.New("open exited with status 1"))
	m, ready := f.prepare(t, "apply", true)
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "launch_requested", Code: "launch_failed"}) {
		t.Fatal("clean launch failure was not reported", result)
	}
	f.physical(t, f.repo, "launch_requested")
	if f.fake.opens != 1 || f.owner.retained() != nil {
		t.Fatal("clean failure retried or retained uncertainty", f.fake.opens, f.owner.retained())
	}
}

// An open whose outcome is unknown (a timeout, a lost fence, an unclean child)
// keeps its uncertain classification: the journal stays launch_requested, it is
// never completed and never reported as the clean launch_failed.
func TestMilestoneRelaunchUnknownOpenOutcomeNeverCompletes(t *testing.T) {
	for name, cause := range map[string]error{
		"timeout":       context.DeadlineExceeded,
		"unclean child": errors.New("open exited without joined output"),
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeRelaunchLifecycle(t)
			f.fake.err = fail("launch_failed", true, true, cause)
			m, ready := f.prepare(t, "apply", true)
			result, err := f.run(t, m, ready)
			var failure *executionapp.Failure
			if result != nil || !errors.As(err, &failure) {
				t.Fatal("an unknown open outcome did not fail", result, describe(err))
			}
			if failure.Code == "launch_failed" && !failure.Uncertain || failure.Phase == "completed" {
				t.Fatal("an unknown open outcome was reported as clean or complete", failure)
			}
			if got := f.diskPhase(t); got != "launch_requested" {
				t.Fatal("an unknown open outcome moved the journal to", got)
			}
			if f.fake.opens != 1 || !failure.Uncertain && f.owner.retained() == nil {
				t.Fatal("an unknown open outcome was neither uncertain nor retained", f.fake.opens, failure)
			}
		})
	}
}

// Rollback launches the accepted source from its restored absolute slot.
func TestMilestoneRelaunchRollbackLaunchesRestoredSource(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	m, ready := f.prepare(t, "apply", false)
	result, err := f.run(t, m, ready)
	must(t, err)
	if result == nil || *result != (executionapp.Result{Phase: "verified"}) {
		t.Fatal("setup apply", result)
	}
	if f.measures != 0 || f.fake.opens != 0 {
		t.Fatal("a non-relaunch apply launched", f.measures, f.fake.opens)
	}
	// An unclean manual rollback restores the old app. Its first journal read
	// occurs at launch, before the helper publishes rollback_completed.
	f.config.QuitNote = "predecessor_drain_unconfirmed"
	f.config.open = func(ctx context.Context, until time.Time, args []string, fence func(context.Context) error) error {
		requirePredecessorCompatibleJournal(t, f.path, "rollback_launch_requested")
		return f.fake.open(ctx, until, args, fence)
	}
	m, ready = f.prepare(t, "rollback", true)
	result, err = f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "rollback_completed"}) {
		t.Fatal("rollback with relaunch did not complete", result)
	}
	f.physical(t, f.repo, "rollback_completed")
	requirePredecessorCompatibleJournal(t, f.path, "rollback_completed")
	if f.measures != 1 || f.builds != 0 || f.fake.opens != 1 || f.fake.arguments[0][2] != f.app {
		t.Fatal("restored source did not launch once", f.measures, f.builds, f.fake.opens)
	}
	hint := relaunchHintOf(t, f.fake.arguments[0][4])
	if hint.BuildID != f.config.Request.Source.BuildID || hint.Phase != "rollback_completed" {
		t.Fatal("wrong source launch hint", hint)
	}
	lifecycleRequireTree(t, f.app, f.source)
}

// A missing capability refuses with nothing opened. The journal has already
// moved to launch_requested, so the stage is retained for reconciliation rather
// than reported complete.
func TestMilestoneRelaunchWithoutCapabilitiesRefusesBeforeOpen(t *testing.T) {
	for name, disable := range map[string]func(*relaunchLifecycle){
		"missing self measurement":    func(f *relaunchLifecycle) { f.config.MeasureSelf = nil },
		"missing argument capability": func(f *relaunchLifecycle) { f.config.RelaunchArguments = nil },
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeRelaunchLifecycle(t)
			disable(f)
			m, ready := f.prepare(t, "apply", true)
			result, err := f.run(t, m, ready)
			var failure *executionapp.Failure
			if result != nil || !errors.As(err, &failure) {
				t.Fatal("launch without a capability succeeded", result, describe(err))
			}
			if f.fake.opens != 0 {
				t.Fatal("a launch was attempted", f.fake.opens)
			}
			if got := f.diskPhase(t); got != "launch_requested" {
				t.Fatal("journal phase", got)
			}
		})
	}
}

// A compromised argument builder cannot redirect the verified slot to a
// private GUI image. The launch intent is retained and open is never called.
func TestMilestoneRelaunchRejectsPrivateGUIPath(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.config.RelaunchArguments = func(_ context.Context, _ port.HelperSelfIdentity) ([]string, error) {
		private := filepath.Join(f.path, "launch-Farol.app")
		return []string{"/usr/bin/open", "-a", private, "--args", "--farol-installed-update-relaunch={}"}, nil
	}
	m, ready := f.prepare(t, "apply", true)
	result, err := f.run(t, m, ready)
	var refusal *executionapp.Failure
	if result != nil || !errors.As(err, &refusal) || refusal.Code != "launch_image_unconfirmed" {
		t.Fatalf("private image was not refused: result=%+v error=%v", result, describe(err))
	}
	if f.fake.opens != 0 || f.diskPhase(t) != "launch_requested" {
		t.Fatalf("private image was opened or intent lost: opens=%d phase=%s", f.fake.opens, f.diskPhase(t))
	}
	if _, statErr := os.Lstat(filepath.Join(f.path, "launch-Farol.app")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("private GUI was created", statErr)
	}
}

func TestMilestoneRelaunchRefusesInvalidInstalledExecutableSignature(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	checked := 0
	f.config.verifyExecutables = func(_ context.Context, _ time.Time, slot string) error {
		checked++
		if slot != f.app || f.diskPhase(t) != "launch_requested" {
			t.Fatal("signature check did not inspect the installed slot under launch intent", slot)
		}
		return &port.HelperRecoveryFailure{Code: "launch_signature_refused", Phase: "refused"}
	}
	m, ready := f.prepare(t, "apply", true)
	result, err := f.run(t, m, ready)
	var failure *executionapp.Failure
	if result != nil || !errors.As(err, &failure) || failure.Code != "launch_signature_refused" {
		t.Fatalf("invalid executable launched or completed: result=%+v error=%v", result, describe(err))
	}
	if checked != 1 || f.fake.opens != 0 || f.diskPhase(t) != "launch_requested" {
		t.Fatalf("signature refusal lost the launch intent: checks=%d opens=%d phase=%s", checked, f.fake.opens, f.diskPhase(t))
	}
}

// Without a launch port the Milestone refuses before it writes anything past
// verified: nothing is journalled, measured or opened.
func TestMilestoneRelaunchWithoutALaunchPortRefusesBeforeAnyLaunchEffect(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	m, ready := f.prepare(t, "apply", true)
	var result *executionapp.Result
	err := withAdmittedInstallation(context.Background(), f.config, milestoneRoutes, func(native AdmittedInstallation) error {
		var e error
		result, e = m.Execute(context.Background(), native, ready, nil)
		return e
	})
	var failure *executionapp.Failure
	if result != nil || !errors.As(err, &failure) || failure.Code != "launch_unavailable" || !failure.Uncertain {
		t.Fatal("launch without a port was not refused", result, describe(err))
	}
	if got := f.diskPhase(t); got != "verified" || f.fake.opens != 0 || f.measures != 0 {
		t.Fatal("launch effect without a port", got, f.fake.opens, f.measures)
	}
}

func TestPostSwapContentMismatchRollsBackAndRelaunchesPrevious(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	m, ready := f.prepare(t, "apply", true)
	reverify := f.config.Reverify
	changed := false
	f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
		if err := reverify(ctx, request); err != nil {
			return err
		}
		if !changed && f.diskPhase(t) == "new_installed" {
			changed = true
			return os.WriteFile(filepath.Join(f.app, "Contents/Info.plist"), []byte("invalid target content"), 0644)
		}
		return nil
	}
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if !changed || result == nil || result.Phase != "rollback_completed" || result.Code != "target_verification" || f.fake.opens != 1 || f.fake.arguments[0][2] != f.app {
		t.Fatal(result, f.fake.arguments)
	}
	lifecycleRequireTree(t, f.app, f.source)
	f.physical(t, f.repo, "rollback_completed")
}

func TestSidecarPostSwapCompensationRelaunchesPrevious(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	mode := "sidecar-only"
	f.config.Request.RelaunchPresentation = &mode
	m, ready := f.prepare(t, "apply", true)
	reverify := f.config.Reverify
	changed := false
	f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
		if err := reverify(ctx, request); err != nil {
			return err
		}
		if !changed && f.diskPhase(t) == "new_installed" {
			changed = true
			return os.WriteFile(filepath.Join(f.app, "Contents/Info.plist"), []byte("invalid target content"), 0644)
		}
		return nil
	}
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if !changed || result == nil || result.Phase != "rollback_completed" || result.Code != "target_verification" || f.fake.opens != 1 || f.fake.arguments[0][2] != f.app {
		t.Fatal(result, f.fake.arguments)
	}
	if len(f.fake.arguments[0]) != 7 || f.fake.arguments[0][5] != "--preview-window-mode=secondary-visible" || f.fake.arguments[0][6] != "--sidecar-display-only" {
		t.Fatal("compensation dropped Sidecar", f.fake.arguments)
	}
	lifecycleRequireTree(t, f.app, f.source)
	f.physical(t, f.repo, "rollback_completed")
}

func TestPostSwapMetadataOnlyChangeVerifiesAndRelaunchesTarget(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	m, ready := f.prepare(t, "apply", true)
	reverify := f.config.Reverify
	changed := false
	f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
		if err := reverify(ctx, request); err != nil {
			return err
		}
		if !changed && f.diskPhase(t) == "new_installed" {
			changed = true
			stamp := time.Now().Add(time.Hour)
			return os.Chtimes(f.app, stamp, stamp)
		}
		return nil
	}
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if !changed || result == nil || result.Phase != "completed" || f.fake.opens != 1 {
		t.Fatal(result, f.fake.arguments)
	}
	lifecycleRequireTree(t, f.app, f.target)
}
