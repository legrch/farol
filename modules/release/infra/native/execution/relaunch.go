package execution

import (
	"context"
	"github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"os"

	"github.com/legrch/farol/modules/release/app/port"
	helperprocess "github.com/legrch/farol/modules/release/infra/native/process"
)

var _ port.HelperRelaunchEffects = (*runtime)(nil)

func (r *runtime) SelfIdentity(ctx context.Context) (port.HelperSelfIdentity, error) {
	var self port.HelperSelfIdentity
	err := r.invoke(ctx, "launch:self", func(c context.Context) (result error) {
		if err := r.fence(c); err != nil {
			return err
		}
		if r.config.MeasureSelf == nil {
			return fail("launch_helper_identity", false, false, nil)
		}
		measured, err := r.config.MeasureSelf(c, r.until)
		if err != nil {
			return err
		}
		if measured.PID != int64(os.Getpid()) || measured.ProcessStart == "" {
			return fail("launch_helper_identity", false, false, nil)
		}
		r.self = measured
		self = r.self
		return r.fence(c)
	})
	if err != nil {
		return port.HelperSelfIdentity{}, err
	}
	return self, nil
}

func (r *runtime) LaunchTarget(ctx context.Context, self port.HelperSelfIdentity) error {
	return r.invoke(ctx, "launch:open", func(c context.Context) error {
		if self != r.self || self.PID != int64(os.Getpid()) || self.ProcessStart == "" || r.config.RelaunchArguments == nil {
			return fail("launch_helper_identity", false, false, nil)
		}
		open := r.config.open
		if open == nil {
			open = helperprocess.Open
		}
		verify := func(ctx context.Context, signatures bool) error {
			if err := r.fence(ctx); err != nil {
				return err
			}
			view, err := r.reader.ReadHelper(ctx)
			if err != nil {
				return err
			}
			if view == nil || view.Value == nil || view.Value.Operation != operation(r.config.Request) || view.Value.Phase != "launch_requested" {
				return fail("launch_phase", false, false, nil)
			}
			location, err := r.location(port.App)
			if err != nil {
				return err
			}
			// Verify the permanent slot that LaunchServices will actually open.
			negative, err := r.image(ctx, location, r.config.Request.Target, func(app *os.File, _ port.HelperIdentity) error {
				if !signatures {
					return nil
				}
				check := r.config.verifyExecutables
				if check == nil {
					check = helperprocess.VerifyExecutableSignatures
				}
				slot := r.config.Request.Home + "/Applications/Farol.app"
				if r.config.Files.SharedParent {
					slot = "/Applications/Farol.app"
				}
				return check(ctx, r.until, slot)
			})
			if err != nil {
				return err
			}
			if negative {
				return fail("tree_mismatch", false, false, nil)
			}
			return r.fence(ctx)
		}
		if err := verify(c, true); err != nil {
			return err
		}
		arguments, err := r.config.RelaunchArguments(c, self)
		if err != nil {
			return err
		}
		if !launchBound(r.config.Request, r.config.Files.SharedParent, arguments) {
			return fail("launch_image_unconfirmed", false, false, nil)
		}
		// The relaunch follows the Sparkle/Squirrel.Mac model: the image was
		// verified before install and again just above, LaunchServices starts
		// it, and a returned zero status is the end of the helper's work. No
		// process is looked up, measured or signalled afterwards.
		r.effected = true
		return open(c, r.until, arguments, func(ctx context.Context) error { return verify(ctx, false) })
	})
}

// launchBound requires the application path handed to /usr/bin/open to be the
// permanent slot this runtime verified. A capability that builds arguments
// cannot redirect the launch to another image.
// Like the reference helper, the
// launch is still by pathname; see the release helper-recovery reference.
func launchBound(request port.HelperRequest, shared bool, arguments []string) bool {
	if !helperprocess.ValidOpenArguments(arguments) || request.Home == "" {
		return false
	}
	if request.RelaunchPresentation == nil {
		if len(arguments) != 5 {
			return false
		}
	} else if *request.RelaunchPresentation != "sidecar-only" || len(arguments) != 7 {
		return false
	}
	expected := request.Home + "/Applications/Farol.app"
	if shared {
		expected = "/Applications/Farol.app"
	}
	return expected != "" && arguments[2] == expected
}

// LaunchPrevious never opens previous.app: rollback has restored the accepted
// source into the canonical absolute slot before this method is reachable.
func (r *runtime) LaunchPrevious(ctx context.Context) error {
	self, err := r.SelfIdentity(ctx)
	if err != nil {
		return err
	}
	return r.invoke(ctx, "launch:previous", func(c context.Context) error {
		verify := func(ctx context.Context) error {
			if err := r.fence(ctx); err != nil {
				return err
			}
			view, err := r.reader.ReadHelper(ctx)
			if err != nil {
				return err
			}
			if view == nil || view.Value == nil || view.Value.Operation != operation(r.config.Request) || view.Value.Phase != "rollback_launch_requested" {
				return fail("launch_phase", false, false, nil)
			}
			negative, err := r.tree(ctx, port.App, r.config.Request.Source)
			if err != nil {
				return err
			}
			if negative {
				return fail("tree_mismatch", false, false, nil)
			}
			return nil
		}
		if err := verify(c); err != nil {
			return err
		}
		hint, err := (helperprotocol.JSONCodec{}).Relaunch(port.HelperRelaunchHint{OperationID: r.config.Request.OperationID, Action: r.config.Request.Action, Phase: "rollback_completed", BuildID: r.config.Request.Source.BuildID, Helper: self})
		if err != nil {
			return err
		}
		app := r.config.Request.Home + "/Applications/Farol.app"
		if r.config.Files.SharedParent {
			app = "/Applications/Farol.app"
		}
		open := r.config.open
		if open == nil {
			open = helperprocess.Open
		}
		arguments := []string{"/usr/bin/open", "-a", app, "--args", "--farol-installed-update-relaunch=" + string(hint)}
		if mode := r.config.Request.RelaunchPresentation; mode != nil {
			if *mode != "sidecar-only" {
				return fail("launch_image_unconfirmed", false, false, nil)
			}
			arguments = append(arguments, "--preview-window-mode=secondary-visible", "--sidecar-display-only")
		}
		return open(c, r.until, arguments, verify)
	})
}
