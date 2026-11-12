package process

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// In-memory pins only. No native runtime/resource qualification or launch.
type runtimeReasonFilesystem struct{ *measurementFilesystemDouble }

func (f *runtimeReasonFilesystem) pinGitRuntimeFile(ctx context.Context, pin ExecutablePin) (executableMeasurement, error) {
	return f.pinExecutable(ctx, pin)
}
func (f *runtimeReasonFilesystem) pinPythonAlias(ctx context.Context) (executableMeasurement, error) {
	return f.pinExecutable(ctx, ExecutablePin{Path: "/synthetic/python-alias", SHA256: strings.Repeat("a", 64)})
}
func TestRetainedPinFailureKeepsItsOriginReason(t *testing.T) {
	for _, timing := range []string{"initial-final-check", "retained-recheck"} {
		for _, origin := range []string{"executable", "git-resource", "python-resource", "python-alias"} {
			t.Run(timing+"/"+origin, func(t *testing.T) {
				_, command, launch, fs := rootMeasurementFixture(t)
				launch.gitRuntimeResources = gitRuntimeFixture()
				launch.gitRuntimeResources.Python = &PythonRuntimeResources{Files: []ExecutablePin{{Path: "/synthetic/runtime.py", SHA256: strings.Repeat("a", 64)}}}
				fs.directories[gitRuntimeTemplates] = directoryFacts{identity: authority.RootIdentity{Device: "1", Inode: "templates"}, mode: os.ModeDir | 0755, uid: 0}
				path := launch.pins[0].Path
				reason := processsvc.RefusalRuntimeIntegrity
				switch origin {
				case "executable":
					reason = processsvc.RefusalExecutableIntegrity
				case "git-resource":
					path = launch.gitRuntimeResources.Files[0].Path
				case "python-resource":
					path = "/synthetic/runtime.py"
				case "python-alias":
					path = "/synthetic/python-alias"
				}
				drift := func() {
					for _, pin := range fs.images {
						if pin.path == path {
							pin.fail = true
							return
						}
					}
					t.Fatal("selected pin missing")
				}
				if timing == "initial-final-check" {
					fs.inspectHook = func(string) { drift() }
				}
				measurement, err := retainLaunchFiles(context.Background(), command, launch, &runtimeReasonFilesystem{fs})
				if timing == "retained-recheck" {
					if err != nil {
						t.Fatal(err)
					}
					drift()
					err = measurement.Recheck(context.Background())
				}
				if measurement != nil {
					measurement.Close()
				}
				var failure *processsvc.NativeFailure
				if !errors.As(err, &failure) || failure.Unknown || failure.Reason != reason {
					t.Errorf("wanted known %s refusal, got %#v (%v)", reason, failure, err)
				}
				fs.assertCloses(t, 1)
			})
		}
	}
}
