package helperprotocol

import (
	"context"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

// BuildRelaunchArguments builds values only. The Release effect owner must
// independently establish a verified target, retain the original owner lease,
// journal launch_requested, dispatch once and preserve an unknown launch. A
// private path string does not prove that a launch image was copied or verified.
func (s *Service) BuildRelaunchArguments(ctx context.Context, completion string, helper port.HelperSelfIdentity, privateLaunch *string, codec port.HelperRelaunchCodec) ([]string, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if codec == nil {
		return nil, internal()
	}
	if completion != "completed" {
		return nil, failure("launch_phase")
	}
	if helper.PID < 2 || helper.PID > 2147483647 || helper.ProcessStart == "" || !utf8.ValidString(helper.ProcessStart) {
		return nil, failure("launch_helper_identity")
	}
	// Capture the optional caller value before a trusted codec call. It must
	// not be replaced by a later path or by the shared Applications slot.
	var capturedPath *string
	if privateLaunch != nil {
		value := *privateLaunch
		capturedPath = &value
	}
	r := s.request
	if r.RelaunchPresentation != nil && (*r.RelaunchPresentation != "sidecar-only" || !r.Relaunch || r.Predecessor != nil) {
		return nil, failure("launch_presentation")
	}
	hint, err := codec.Relaunch(port.HelperRelaunchHint{OperationID: r.OperationID, Action: r.Action, Phase: completion, BuildID: r.Target.BuildID, Helper: helper})
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	if err != nil {
		if err.Error() == "helper_protocol_size" {
			return nil, failure("launch_hint_bound")
		}
		return nil, internal()
	}
	if len(hint) < 1 || len(hint) > 2048 {
		return nil, failure("launch_hint_bound")
	}
	// The native codec returns captured, single-line ASCII JSON without LF.
	// Trusted composition must not replace that contract with raw argument text.
	selected := r.Home + "/Applications/Farol.app"
	if r.InstallLocation != nil && *r.InstallLocation == "shared" {
		expected := r.Home + "/Library/Application Support/io.github.legrch.farol/installed-updates/" + r.OperationID + "/launch-Farol.app"
		if capturedPath == nil || *capturedPath != expected {
			return nil, failure("launch_image_unconfirmed")
		}
		selected = *capturedPath
	} else if capturedPath != nil {
		return nil, failure("launch_image_unexpected")
	}
	arguments := []string{"/usr/bin/open", "-a", selected, "--args", "--farol-installed-update-relaunch=" + string(append([]byte(nil), hint...))}
	if r.RelaunchPresentation != nil {
		arguments = append(arguments, "--preview-window-mode=secondary-visible", "--sidecar-display-only")
	}
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	return arguments, nil
}
