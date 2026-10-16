package boot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"

	"github.com/legrch/farol/boot/container"
	"github.com/legrch/farol/transport/desktop"
)

// BuildID is set by the build via -ldflags; it cannot be overridden by a client.
var BuildID = "development"

func Serve(ctx context.Context, profileID string, in io.ReadCloser, out io.WriteCloser) error {
	return serve(ctx, profileID, nil, in, out)
}

func serve(ctx context.Context, profileID string, launch *NativeLaunch, in io.ReadCloser, out io.WriteCloser) (result error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return err
	}
	generation := hex.EncodeToString(bytes[:])
	var native nativeApplication
	methods := map[string]desktop.Method{}
	if launch == nil || launch.StartupMode != "recovery" {
		methods = taskModelPolicyMethods()
		for name, method := range taskModelCatalogueMethods() {
			if _, exists := methods[name]; exists {
				return errors.New("task_method_conflict")
			}
			methods[name] = method
		}
		for name, method := range taskCurrentSettingsMethods() {
			if _, exists := methods[name]; exists {
				return errors.New("task_method_conflict")
			}
			methods[name] = method
		}
	}
	if launch != nil {
		var err error
		if launch.StartupMode == "recovery" {
			native, err = NewNativeRecovery(ctx, *launch, generation)
		} else {
			native, err = NewNativeRuntime(ctx, *launch, generation)
		}
		if err != nil {
			return err
		}
		defer func() { result = errors.Join(result, native.Close()) }()
		nativeMethods, err := native.Methods()
		if err != nil {
			return err
		}
		for name, method := range nativeMethods {
			if _, exists := methods[name]; exists {
				return errors.New("native_method_conflict")
			}
			methods[name] = method
		}
	}
	server, err := container.New(BuildID, profileID, generation, methods)
	if err != nil {
		return err
	}
	return server.Serve(ctx, in, out)
}

// Run parses only currently implemented command modes; diagnostics never use stdout.
func Run(args []string, in io.ReadCloser, out io.WriteCloser, diagnostics io.Writer) int {
	if len(args) > 0 && args[0] == "observe-preserved-profile" {
		return runPreservedProfileObservation(args[1:], in, out, diagnostics)
	}
	if len(args) > 0 && args[0] == "prepare-preserved-recovery" {
		return runPreservedProfilePreparation(args[1:], in, out, diagnostics)
	}
	if len(args) > 0 && args[0] == "publish-installed-slot-binding" {
		return runInstalledSlotBinding(args[1:], out, diagnostics)
	}
	if len(args) > 0 && args[0] == "prepare-empty-recovery" {
		return runEmptyRecoveryPreparation(args[1:], in, out, diagnostics)
	}
	if len(args) > 0 && args[0] == "inspect-empty-recovery" {
		return runEmptyRecoveryInspection(args[1:], in, out, diagnostics)
	}
	if len(args) > 0 && args[0] == "inspect-prepared-empty-recovery" {
		return runPreparedEmptyInspection(args[1:], in, out, diagnostics)
	}
	if len(args) > 0 && args[0] == "prepare-installed-empty-recovery" {
		return runInstalledEmptyRecoveryPreparation(args[1:], in, out, diagnostics)
	}
	if len(args) > 0 && args[0] == "inspect-native-state" {
		return runNativeStateInspection(args[1:], out, diagnostics, inspectNativeState)
	}
	if len(args) > 0 && args[0] == "inspect-terminated-profile" {
		return runTerminatedProfileInspection(args[1:], in, out, diagnostics, inspectTerminatedProfile)
	}
	if len(args) > 0 && args[0] == "record-native-terminal" {
		return runNativeTerminal(args[1:], in, out, diagnostics)
	}
	if len(args) < 1 || args[0] != "serve" {
		fmt.Fprintln(diagnostics, "usage: farol serve --profile <id>")
		return 2
	}
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(diagnostics)
	profile := flags.String("profile", "", "exact backend profile ID")
	root := flags.String("profile-root", "", "selected existing physical private profile root")
	device := flags.String("profile-device", "", "selected root device, canonical decimal")
	inode := flags.String("profile-inode", "", "selected root inode, canonical decimal")
	owner := flags.String("owner", "", "trusted current owner identity")
	computer := flags.String("computer", "", "trusted current Computer identity")
	home := flags.String("home", "", "explicit independent selected HOME")
	startupMode := flags.String("startup-mode", "normal", "normal runtime or explicit existing-profile recovery")
	storeMode := flags.String("store-mode", "", "known first create or existing open; no fallback")
	settingsMutations := flags.Bool("settings-mutations", false, "qualified version 2 profile mutation storage; no migration")
	hostLifetime := flags.String("host-lifetime", "", "trusted initiating host lifetime")
	previousDrain := flags.Bool("previous-host-drain-confirmed", false, "trusted exact-profile previous host drain witness; never inferred from journal")
	childLaunch := flags.String("child-launch", "", "exact child launch identity")
	shellFD := flags.Int("shell-support-fd", 0, "optional inherited trusted Shell metadata descriptor; only 3 is supported")
	var codexReadHost, codexReadTemp codexReadLaunchFlag
	flags.Var(&codexReadHost, "codex-read-host", "optional trusted selected Codex host slot; requires codex-read-temp")
	flags.Var(&codexReadTemp, "codex-read-temp", "exact canonical trusted temp parent for the optional Codex read selection")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *profile == "" {
		return 2
	}
	if (*startupMode != "normal" && *startupMode != "recovery") || (*shellFD != 0 && *shellFD != 3) {
		return 2
	}
	codexRead, err := decodeCodexReadLaunch(codexReadHost, codexReadTemp, *root != "")
	if err != nil {
		fmt.Fprintln(diagnostics, err)
		return 2
	}
	if *startupMode == "recovery" && (*root == "" || *storeMode != "open" || *hostLifetime == "" || *childLaunch == "" || *settingsMutations || *previousDrain || *shellFD != 0 || codexRead != nil) {
		return 2
	}
	var launch *NativeLaunch
	if *root != "" {
		dev, err := strconv.ParseUint(*device, 10, 64)
		if err != nil || strconv.FormatUint(dev, 10) != *device || dev == 0 {
			return 2
		}
		ino, err := strconv.ParseUint(*inode, 10, 64)
		if err != nil || strconv.FormatUint(ino, 10) != *inode || ino == 0 {
			return 2
		}
		launch = &NativeLaunch{Profile: ProfileBinding{ProfileID: *profile, Root: *root, Device: dev, Inode: ino}, OwnerID: *owner, ComputerID: *computer, Home: *home, StoreMode: *storeMode, StartupMode: *startupMode, HostLifetimeID: *hostLifetime, ChildLaunchID: *childLaunch, PreviousHostDrainConfirmed: *previousDrain, SettingsMutations: *settingsMutations, CodexRead: codexRead}
	} else if *device != "" || *inode != "" || *owner != "" || *computer != "" || *home != "" || *storeMode != "" || *hostLifetime != "" || *childLaunch != "" || *previousDrain || *settingsMutations || *shellFD != 0 {
		return 2
	}
	if *shellFD == 3 {
		raw, err := readShellLaunchPipe()
		if err != nil {
			fmt.Fprintln(diagnostics, "SHELL_LAUNCH_METADATA_INVALID")
			return 2
		}
		launch.shell, err = decodeShellLaunch(raw, *launch)
		if err != nil {
			fmt.Fprintln(diagnostics, "SHELL_LAUNCH_METADATA_INVALID")
			return 2
		}
	}
	if err := serve(context.Background(), *profile, launch, in, out); err != nil {
		fmt.Fprintln(diagnostics, "farol backend:", err)
		return 1
	}
	return 0
}
