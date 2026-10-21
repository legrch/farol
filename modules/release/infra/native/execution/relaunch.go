package execution

import (
	"context"
	"os"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/native/installcopy"
	"github.com/legrch/farol/modules/release/infra/native/installmove"
	helperprocess "github.com/legrch/farol/modules/release/infra/native/process"
)

var _ port.HelperRelaunchEffects = (*runtime)(nil)

func (r *runtime) CapturePrivateTarget(ctx context.Context) (string, error) {
	path := ""
	err := r.invoke(ctx, "launch:capture", func(c context.Context) error {
		if !r.config.Files.SharedParent || r.config.Request.InstallLocation == nil || *r.config.Request.InstallLocation != "shared" {
			return fail("launch_image_unexpected", false, false, nil)
		}
		app, err := r.location(port.App)
		if err != nil {
			return err
		}
		view, err := r.reader.ReadHelper(c)
		if err != nil {
			return err
		}
		if view == nil || view.Value == nil || view.Value.Operation != operation(r.config.Request) || view.Value.Phase != "verified" {
			return fail("launch_phase", false, false, nil)
		}
		f := r.config.Files
		parent := installcopy.Directory{File: f.Operation, Identity: installcopy.Identity(f.OperationIdentity)}
		negative, err := r.image(c, app, r.config.Request.Target, func(source *os.File, id port.HelperIdentity) error {
			if id.Device != f.OperationIdentity.Device {
				return fail("exchange_unsupported", false, false, nil)
			}
			// Creating a private capture is already an operation effect. Every
			// failed image is retained under its original generated name.
			r.effected = true
			return installcopy.WithCapture(c, parent, r.until, r.fence, func(name string, destination installcopy.Directory) error {
				copy, err := installcopy.Prepare(installcopy.Directory{File: source, Identity: installcopy.Identity(id)}, destination, r.until, r.fence)
				if err != nil {
					return err
				}
				if err := copy.Run(c); err != nil {
					return err
				}
				dir := installmove.Directory{File: f.Operation, Identity: installmove.Identity(f.OperationIdentity)}
				location := installmove.Location{Parent: dir, Name: name}
				verify := func(ctx context.Context) error {
					negative, err := r.image(ctx, location, r.config.Request.Target, func(_ *os.File, held port.HelperIdentity) error {
						if held != port.HelperIdentity(destination.Identity) {
							return fail("launch_image_unconfirmed", false, true, nil)
						}
						return nil
					})
					if err != nil {
						return err
					}
					if negative {
						return fail("launch_image_unconfirmed", false, true, nil)
					}
					return r.fence(ctx)
				}
				if err := verify(c); err != nil {
					return err
				}
				if err := destination.File.Sync(); err != nil {
					return err
				}
				publication, err := installmove.PrepareCapturePublication(dir, name, installmove.Identity(destination.Identity), r.until, verify)
				if err != nil {
					return err
				}
				if err := publication.Run(c); err != nil {
					return err
				}
				location.Name = "launch-Farol.app"
				if err := verify(c); err != nil {
					return err
				}
				r.captureIdentity = port.HelperIdentity(destination.Identity)
				return nil
			})
		})
		if err != nil {
			return err
		}
		if negative {
			return fail("tree_mismatch", false, false, nil)
		}
		r.capturePath = r.config.Request.Home + "/Library/Application Support/io.github.legrch.farol/installed-updates/" + r.config.Request.OperationID + "/launch-Farol.app"
		path = r.capturePath
		return r.fence(c)
	})
	if err != nil {
		return "", err
	}
	return path, nil
}

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

func (r *runtime) LaunchTarget(ctx context.Context, self port.HelperSelfIdentity, private *string) error {
	var captured *string
	if private != nil {
		value := *private
		captured = &value
	}
	return r.invoke(ctx, "launch:open", func(c context.Context) error {
		if self != r.self || self.PID != int64(os.Getpid()) || self.ProcessStart == "" || r.config.RelaunchArguments == nil {
			return fail("launch_helper_identity", false, false, nil)
		}
		open := r.config.open
		if open == nil {
			open = helperprocess.Open
		}
		verify := func(ctx context.Context) error {
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
			var expected port.HelperIdentity
			if r.config.Files.SharedParent {
				if captured == nil || *captured != r.capturePath || r.capturePath == "" {
					return fail("launch_image_unconfirmed", false, false, nil)
				}
				location = installmove.Location{Parent: installmove.Directory{File: r.config.Files.Operation, Identity: installmove.Identity(r.config.Files.OperationIdentity)}, Name: "launch-Farol.app"}
				expected = r.captureIdentity
			} else if captured != nil {
				return fail("launch_image_unexpected", false, false, nil)
			}
			negative, err := r.image(ctx, location, r.config.Request.Target, func(_ *os.File, actual port.HelperIdentity) error {
				if r.config.Files.SharedParent && expected != actual {
					return fail("launch_image_unconfirmed", false, false, nil)
				}
				return nil
			})
			if err != nil {
				return err
			}
			if negative {
				return fail("tree_mismatch", false, false, nil)
			}
			return r.fence(ctx)
		}
		if err := verify(c); err != nil {
			return err
		}
		arguments, err := r.config.RelaunchArguments(c, self, captured)
		if err != nil {
			return err
		}
		if !launchBound(r.config.Request, r.config.Files.SharedParent, r.capturePath, arguments) {
			return fail("launch_image_unconfirmed", false, false, nil)
		}
		// The relaunch follows the Sparkle/Squirrel.Mac model: the image was
		// verified before install and again just above, LaunchServices starts
		// it, and a returned zero status is the end of the helper's work. No
		// process is looked up, measured or signalled afterwards.
		r.effected = true
		return open(c, r.until, arguments, verify)
	})
}

// launchBound requires the application path handed to /usr/bin/open to be the
// image this runtime verified: the private capture for a shared install, the
// owner's ~/Applications slot otherwise. A capability that builds arguments
// cannot redirect the launch to another image. Like the reference helper, the
// launch is still by pathname; see the release helper-recovery reference.
func launchBound(request port.HelperRequest, shared bool, capturePath string, arguments []string) bool {
	if len(arguments) != 5 || request.Home == "" {
		return false
	}
	expected := request.Home + "/Applications/Farol.app"
	if shared {
		expected = capturePath
	}
	return expected != "" && arguments[2] == expected
}
