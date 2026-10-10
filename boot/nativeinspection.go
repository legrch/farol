package boot

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"time"

	chatrepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

type inspectionRoot struct {
	Device string `json:"device"`
	Inode  string `json:"inode"`
}
type nativeStateInspection struct {
	Schema             string         `json:"schema"`
	BuildID            string         `json:"inspectionBuildId"`
	ProfileID          string         `json:"profileId"`
	ProfileRoot        inspectionRoot `json:"profileRoot"`
	ChatRoot           inspectionRoot `json:"chatRoot"`
	BackendGeneration  string         `json:"observedChatGeneration"`
	ChatSnapshotSHA256 string         `json:"chatSnapshotSha256"`
	ChatVersion        int            `json:"chatVersion"`
	ChatWriteCount     int            `json:"chatWriteCount"`
	ChatTurnCount      int            `json:"chatTurnCount"`
	ChatPlanCount      int            `json:"chatPlanCount,omitempty"`
	ChatIncarnations   int            `json:"chatIncarnationCount"`
	ChatRetirement     bool           `json:"chatRetirementRecorded"`
	ComputerRoot       inspectionRoot `json:"computerRoot"`
	MutationRoot       inspectionRoot `json:"emptyMutationRoot"`
	MutationLock       inspectionRoot `json:"mutationLock"`
	RecoveryAuthorized bool           `json:"recoveryAuthorized"`
}

func inspectionPhysical(device, inode uint64) inspectionRoot {
	return inspectionRoot{strconv.FormatUint(device, 10), strconv.FormatUint(inode, 10)}
}

// This observes two components separately under their existing locks. It is not
// a whole-profile inventory, atomic quiescence proof or recovery authorization.
// No normal runtime, journal constructor, authority publisher or executor opens.
func inspectNativeState(ctx context.Context, binding ProfileBinding) (result *nativeStateInspection, err error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, profileFailure(ProfileInvalid)
	}
	q, err := QualifyProfile(binding)
	if err != nil {
		return nil, err
	}
	defer func() {
		if q.Close() != nil {
			result, err = nil, profileFailure(ProfileCleanupUnknown)
		}
	}()
	computer, chat, err := q.Roots()
	if err != nil {
		return nil, err
	}
	c, err := chatrepo.Inspect(ctx, chatrepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, chatrepo.Limits{Bytes: 1048576, Records: 4096})
	if err != nil {
		return nil, err
	}
	m, err := mutationrepo.InspectEmpty(ctx, mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID})
	if err != nil {
		return nil, err
	}
	currentComputer, currentChat, err := q.Roots()
	if err != nil || currentComputer != computer || currentChat != chat || ctx.Err() != nil {
		return nil, profileFailure(ProfileUnavailable)
	}
	return &nativeStateInspection{
		Schema: "farol-native-state-inspection/1", BuildID: BuildID, ProfileID: binding.ProfileID,
		ProfileRoot: inspectionPhysical(binding.Device, binding.Inode), ChatRoot: inspectionPhysical(chat.Device, chat.Inode),
		BackendGeneration: c.Scope.BackendGeneration, ChatSnapshotSHA256: hex.EncodeToString(c.SnapshotDigest[:]), ChatVersion: c.Version,
		ChatWriteCount: c.WriteCount, ChatTurnCount: c.TurnCount, ChatIncarnations: len(c.Incarnations), ChatRetirement: c.Retirement != nil,
		ChatPlanCount: c.PlanCount,
		ComputerRoot:  inspectionPhysical(computer.Device, computer.Inode), MutationRoot: inspectionPhysical(m.MutationsDevice, m.MutationsInode), MutationLock: inspectionPhysical(m.LockDevice, m.LockInode),
		RecoveryAuthorized: false,
	}, nil
}

func nativeInspectionBinding(args []string) (ProfileBinding, bool) {
	values := make(map[string]string)
	if len(args) != 10 {
		return ProfileBinding{}, false
	}
	for i := 0; i < len(args); i += 2 {
		name := args[i]
		if values[name] != "" || args[i+1] == "" {
			return ProfileBinding{}, false
		}
		switch name {
		case "--profile", "--profile-root", "--profile-device", "--profile-inode", "--expected-build":
			values[name] = args[i+1]
		default:
			return ProfileBinding{}, false
		}
	}
	device, de := strconv.ParseUint(values["--profile-device"], 10, 64)
	inode, ie := strconv.ParseUint(values["--profile-inode"], 10, 64)
	b := ProfileBinding{ProfileID: values["--profile"], Root: values["--profile-root"], Device: device, Inode: inode}
	return b, de == nil && ie == nil && strconv.FormatUint(device, 10) == values["--profile-device"] && strconv.FormatUint(inode, 10) == values["--profile-inode"] && values["--expected-build"] == BuildID && validProfileBinding(b)
}

func runNativeStateInspection(args []string, out io.Writer, diagnostics io.Writer, inspect func(context.Context, ProfileBinding) (*nativeStateInspection, error)) int {
	binding, ok := nativeInspectionBinding(args)
	if !ok || inspect == nil {
		fmt.Fprintln(diagnostics, "NATIVE_STATE_INSPECTION_INPUT_INVALID")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	value, err := inspect(ctx, binding)
	if err != nil || value == nil || ctx.Err() != nil {
		fmt.Fprintln(diagnostics, "NATIVE_STATE_INSPECTION_UNAVAILABLE")
		return 1
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return 1
	}
	raw = append(raw, '\n')
	n, err := out.Write(raw)
	if err != nil || n != len(raw) {
		fmt.Fprintln(diagnostics, "NATIVE_STATE_INSPECTION_OUTPUT_UNCONFIRMED")
		return 1
	}
	return 0
}
