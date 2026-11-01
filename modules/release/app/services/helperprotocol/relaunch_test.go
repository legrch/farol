package helperprotocol

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

type relaunchCodecFunc func(port.HelperRelaunchHint) ([]byte, error)

func (f relaunchCodecFunc) Relaunch(h port.HelperRelaunchHint) ([]byte, error) { return f(h) }

func TestSidecarRelaunchAddsOnlyClosedExistingPresentationArguments(t *testing.T) {
	r := requestFixture()
	r.Predecessor, r.LeaseIdentity = nil, nil
	mode := "sidecar-only"
	r.RelaunchPresentation = &mode
	s := bindFixture(t, r, codecFixture{})
	mode = "primary"
	p := r.Home + "/Library/Application Support/io.github.legrch.farol/installed-updates/" + r.OperationID + "/launch-Farol.app"
	args, err := s.BuildRelaunchArguments(context.Background(), "completed", port.HelperSelfIdentity{PID: 5678, ProcessStart: "original helper"}, &p, relaunchCodecFunc(func(port.HelperRelaunchHint) ([]byte, error) { return []byte(`{}`), nil }))
	if err != nil || len(args) != 7 || args[2] != p || args[4] != "--farol-installed-update-relaunch={}" || args[5] != "--preview-window-mode=secondary-visible" || args[6] != "--sidecar-display-only" {
		t.Fatalf("presentation binding changed: %v %v", args, err)
	}
	got, err := s.Request(context.Background())
	if err != nil || got.RelaunchPresentation == nil || *got.RelaunchPresentation != "sidecar-only" {
		t.Fatal("request did not retain its own presentation copy")
	}
}

func TestRelaunchBindsTargetAndOwnHelperWithoutDispatch(t *testing.T) {
	r := requestFixture()
	s := bindFixture(t, r, codecFixture{})
	path := r.Home + "/Library/Application Support/io.github.legrch.farol/installed-updates/" + r.OperationID + "/launch-Farol.app"
	originalPath := path
	helper := port.HelperSelfIdentity{PID: 5678, ProcessStart: "original helper"}
	encoded := []byte(`{"synthetic":"hint"}`)
	var seen port.HelperRelaunchHint
	codec := relaunchCodecFunc(func(h port.HelperRelaunchHint) ([]byte, error) {
		seen = h
		path = "/Applications/Farol.app"
		return encoded, nil
	})
	arguments, err := s.BuildRelaunchArguments(context.Background(), "completed", helper, &path, codec)
	if err != nil || len(arguments) != 5 || arguments[0] != "/usr/bin/open" || arguments[1] != "-a" || arguments[2] != originalPath || arguments[3] != "--args" || arguments[4] != "--farol-installed-update-relaunch="+string(encoded) {
		t.Fatalf("wrong original launch arguments: %v %v", arguments, err)
	}
	if seen.OperationID != r.OperationID || seen.Action != r.Action || seen.Phase != "completed" || seen.BuildID != r.Target.BuildID || seen.Helper != helper || seen.Helper.PID == r.PID {
		t.Fatalf("lost target/self identity: %+v", seen)
	}
	encoded[0] = 'X'
	if strings.Contains(arguments[4], "X") {
		t.Fatal("argument aliases codec bytes")
	}
	// A repeatable value builder grants no one-shot native launch admission.
	path = originalPath
	if _, err := s.BuildRelaunchArguments(context.Background(), "completed", helper, &path, codec); err != nil {
		t.Fatal(err)
	}
}

func TestRelaunchRefusalsAndCancellation(t *testing.T) {
	r := requestFixture()
	s := bindFixture(t, r, codecFixture{})
	helper := port.HelperSelfIdentity{PID: 5678, ProcessStart: "helper"}
	codec := relaunchCodecFunc(func(port.HelperRelaunchHint) ([]byte, error) { return []byte(`{}`), nil })
	correct := r.Home + "/Library/Application Support/io.github.legrch.farol/installed-updates/" + r.OperationID + "/launch-Farol.app"
	for _, completion := range []string{"", "verified", "launch_requested", "rolled_back", "cancel_completed", "rollback_completed"} {
		_, err := s.BuildRelaunchArguments(context.Background(), completion, helper, &correct, codec)
		requireFailure(t, err, "launch_phase", false)
	}
	for _, identity := range []port.HelperSelfIdentity{{}, {PID: 1, ProcessStart: "helper"}, {PID: 2147483648, ProcessStart: "helper"}, {PID: 2}, {PID: 2, ProcessStart: string([]byte{0xff})}} {
		_, err := s.BuildRelaunchArguments(context.Background(), "completed", identity, &correct, codec)
		requireFailure(t, err, "launch_helper_identity", false)
	}
	for _, path := range []*string{nil, func() *string { p := "/Applications/Farol.app"; return &p }()} {
		_, err := s.BuildRelaunchArguments(context.Background(), "completed", helper, path, codec)
		requireFailure(t, err, "launch_image_unconfirmed", false)
	}
	for _, failureCase := range []struct {
		raw      []byte
		err      error
		code     string
		internal bool
	}{
		{nil, nil, "launch_hint_bound", false},
		{[]byte(strings.Repeat("x", 2049)), nil, "launch_hint_bound", false},
		{nil, errors.New("helper_protocol_size"), "launch_hint_bound", false},
		{nil, errors.New("helper_protocol_encoding"), "internal", true},
		{nil, errors.New("private adapter details"), "internal", true},
	} {
		_, err := s.BuildRelaunchArguments(context.Background(), "completed", helper, &correct, relaunchCodecFunc(func(port.HelperRelaunchHint) ([]byte, error) { return failureCase.raw, failureCase.err }))
		requireFailure(t, err, failureCase.code, failureCase.internal)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.BuildRelaunchArguments(ctx, "completed", helper, &correct, codec)
	requireFailure(t, err, "canceled", false)
	ctx, cancel = context.WithCancel(context.Background())
	_, err = s.BuildRelaunchArguments(ctx, "completed", helper, &correct, relaunchCodecFunc(func(port.HelperRelaunchHint) ([]byte, error) { cancel(); return []byte(`{}`), nil }))
	requireFailure(t, err, "canceled", false)
	_, err = s.BuildRelaunchArguments(context.Background(), "completed", helper, &correct, nil)
	requireFailure(t, err, "internal", true)
	_, err = s.BuildRelaunchArguments(nil, "completed", helper, &correct, codec)
	requireFailure(t, err, "internal", true)
}

func TestRelaunchLegacyHasNoPrivatePathAndKeepsOriginalHome(t *testing.T) {
	r := requestFixture()
	r.InstallLocation = nil
	s := bindFixture(t, r, codecFixture{})
	helper := port.HelperSelfIdentity{PID: 5678, ProcessStart: "helper"}
	codec := relaunchCodecFunc(func(port.HelperRelaunchHint) ([]byte, error) { return []byte(`{}`), nil })
	arguments, err := s.BuildRelaunchArguments(context.Background(), "completed", helper, nil, codec)
	if err != nil || arguments[2] != r.Home+"/Applications/Farol.app" {
		t.Fatalf("legacy route changed: %v %v", arguments, err)
	}
	unexpected := arguments[2]
	_, err = s.BuildRelaunchArguments(context.Background(), "completed", helper, &unexpected, codec)
	requireFailure(t, err, "launch_image_unexpected", false)
}
