package boot

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	handoff "github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/pkg/ipc"
)

// This command records trusted host facts after the original exact child ended.
// It never constructs NativeRuntime, a Chat owner, provider or live admission.
// The executable's compiled BuildID must match the retiring publication.
func recordNativeTerminal(ctx context.Context, profile ProfileBinding, in wire.CoreTerminalObservation, acknowledge func(wire.CoreRetirementAcknowledged) error) (result error) {
	qualified, err := QualifyProfile(profile)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, qualified.Close()) }()
	_, chat, err := qualified.Roots()
	if err != nil {
		return err
	}
	launch := NativeLaunch{Profile: profile, HostLifetimeID: in.HostLifetimeId, ChildLaunchID: in.ChildLaunchId}
	retirement, err := newNativeRetirement(ctx, launch, in.BackendGeneration, chat)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, retirement.repo.Close()) }()
	digest, err := retirementDigest(in.ReceiptDigest)
	if err != nil {
		return err
	}
	ack, err := retirementDigest(in.AckDigest)
	if err != nil {
		return err
	}
	var code *int
	if in.ExitCode != "" {
		value, err := strconv.ParseInt(in.ExitCode, 10, 32)
		if err != nil || strconv.FormatInt(value, 10) != in.ExitCode {
			return handoff.Invalid
		}
		n := int(value)
		code = &n
	}
	mode := chatport.HandoffGracefulStop
	if in.Forced {
		mode = chatport.HandoffForcedStop
	}
	err = retirement.service.ObserveTerminal(ctx, chatport.HandoffTerminal{
		Publication:    chatport.HandoffPublication{Binding: retirement.binding, HandoffID: in.HandoffId, ReceiptDigest: digest},
		KnownACKDigest: ack, Kind: chatport.HandoffNormalExit, StopMode: mode,
		ExitCode: code, Signal: in.Signal,
	})
	if err != nil {
		return err
	}
	// A failed reply must not leave a complete-looking publication eligible for
	// another host. Keep the qualified store open until this one reply finishes.
	if acknowledge == nil {
		err = handoff.Invalid
	} else {
		err = acknowledge(wire.CoreRetirementAcknowledged{HandoffId: in.HandoffId, ReceiptDigest: in.ReceiptDigest, AckDigest: in.AckDigest})
	}
	if err != nil || ctx.Err() != nil {
		return errors.Join(handoff.Unknown, err, ctx.Err(), retirement.repo.Fence(context.WithoutCancel(ctx)))
	}
	return nil
}

func runNativeTerminal(args []string, in io.ReadCloser, out io.WriteCloser, diagnostics io.Writer) int {
	flags := flag.NewFlagSet("record-native-terminal", flag.ContinueOnError)
	flags.SetOutput(diagnostics)
	profile := flags.String("profile", "", "exact backend profile ID")
	root := flags.String("profile-root", "", "selected existing physical private profile root")
	device := flags.String("profile-device", "", "selected root device, canonical decimal")
	inode := flags.String("profile-inode", "", "selected root inode, canonical decimal")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	dev, err := strconv.ParseUint(*device, 10, 64)
	if err != nil || dev == 0 || strconv.FormatUint(dev, 10) != *device {
		return 2
	}
	ino, err := strconv.ParseUint(*inode, 10, 64)
	if err != nil || ino == 0 || strconv.FormatUint(ino, 10) != *inode {
		return 2
	}
	raw, err := io.ReadAll(io.LimitReader(in, 8193))
	if err != nil || len(raw) > 8192 || ipc.ValidateJSON(raw) != nil || wire.Validate("CoreTerminalObservation", raw) != nil {
		return 2
	}
	var observation wire.CoreTerminalObservation
	if json.Unmarshal(raw, &observation) != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := recordNativeTerminal(ctx, ProfileBinding{ProfileID: *profile, Root: *root, Device: dev, Inode: ino}, observation, func(response wire.CoreRetirementAcknowledged) error {
		encoded, err := json.Marshal(response)
		if err != nil {
			return err
		}
		encoded = append(encoded, '\n')
		n, err := out.Write(encoded)
		if err == nil && n != len(encoded) {
			err = io.ErrShortWrite
		}
		return err
	}); err != nil {
		fmt.Fprintln(diagnostics, "farol terminal record: refused or unknown")
		return 1
	}
	return 0
}
