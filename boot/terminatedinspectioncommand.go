package boot

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"time"

	"github.com/legrch/farol/pkg/ipc"
)

type terminatedInspectionRetained struct {
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
}

type terminatedInspectionOutput struct {
	Schema             string                         `json:"schema"`
	BuildID            string                         `json:"inspectionBuildId"`
	ProfileID          string                         `json:"profileId"`
	ProfileRoot        inspectionRoot                 `json:"profileRoot"`
	ComputerRoot       inspectionRoot                 `json:"computerRoot"`
	ChatRoot           inspectionRoot                 `json:"chatRoot"`
	TaskRoot           inspectionRoot                 `json:"taskRoot"`
	Generation         string                         `json:"observedChatGeneration"`
	Handoff            string                         `json:"chatHandoffSha256"`
	Lifecycle          string                         `json:"chatLifecycleSha256"`
	Access             string                         `json:"computerAccessSha256"`
	Results            string                         `json:"emptyResultClaimSha256"`
	Steps              int                            `json:"emptyHandoffSteps"`
	Retained           []terminatedInspectionRetained `json:"retainedMutationResults"`
	RecoveryAuthorized bool                           `json:"recoveryAuthorized"`
}

// A private diagnostic adapter to the existing read-only Root join. Trusted
// composition supplies independently retained original facts, never discovered
// identities. No serve, executor, Consume, profile/configuration write or helper
// runs here. Even terminal zero grants no host closure or restore authority.
func runTerminatedProfileInspection(args []string, in io.Reader, out io.Writer, diagnostics io.Writer, inspect func(context.Context, terminatedProfileInspectionInput, func(terminatedProfileInspection) error) error) int {
	binding, ok := nativeInspectionBinding(args)
	if !ok || in == nil || out == nil || inspect == nil {
		fmt.Fprintln(diagnostics, "TERMINATED_PROFILE_INSPECTION_INPUT_INVALID")
		return 2
	}
	raw, err := io.ReadAll(io.LimitReader(in, 65537))
	if err != nil || len(raw) > 65536 || ipc.ValidateJSON(raw) != nil || !emptyRecoveryCanonicalFields(raw, reflect.TypeFor[terminatedProfileInspectionInput]()) {
		fmt.Fprintln(diagnostics, "TERMINATED_PROFILE_INSPECTION_INPUT_INVALID")
		return 2
	}
	var selected terminatedProfileInspectionInput
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&selected) != nil || d.Decode(new(any)) != io.EOF || selected.Profile != (ProfileBinding{}) {
		fmt.Fprintln(diagnostics, "TERMINATED_PROFILE_INSPECTION_INPUT_INVALID")
		return 2
	}
	selected.Profile = binding
	if !terminatedProfileInputValid(selected) {
		fmt.Fprintln(diagnostics, "TERMINATED_PROFILE_INSPECTION_INPUT_INVALID")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var observed *terminatedInspectionOutput
	calls := 0
	err = inspect(ctx, selected, func(v terminatedProfileInspection) error {
		calls++
		if calls != 1 || ctx.Err() != nil {
			return io.ErrUnexpectedEOF
		}
		// Metadata only: never serialize paths, private heads, original receipts,
		// binding bodies or a proof. The original claims must finish successfully
		// before any output is disclosed; a late recheck/Close error emits nothing.
		value := terminatedInspectionOutput{
			Schema: "farol-terminated-profile-inspection/1", BuildID: BuildID, ProfileID: binding.ProfileID,
			ProfileRoot:  inspectionPhysical(binding.Device, binding.Inode),
			ComputerRoot: inspectionPhysical(v.Computer.Device, v.Computer.Inode),
			ChatRoot:     inspectionPhysical(v.Chat.Device, v.Chat.Inode), TaskRoot: inspectionPhysical(v.Task.Device, v.Task.Inode),
			Generation: v.Scope.BackendGeneration, Handoff: hex.EncodeToString(v.HandoffDigest[:]),
			Lifecycle: hex.EncodeToString(v.LifecycleDigest[:]), Access: hex.EncodeToString(v.Access.Digest[:]),
			Results: hex.EncodeToString(v.ResultClaimDigest[:]), Steps: v.HandoffSteps,
		}
		for _, r := range v.Retained.Retained {
			value.Retained = append(value.Retained, terminatedInspectionRetained{r.Key, r.SHA256})
		}
		observed = &value
		return nil
	})
	if err != nil || ctx.Err() != nil || calls != 1 || observed == nil {
		fmt.Fprintln(diagnostics, "TERMINATED_PROFILE_INSPECTION_REFUSED")
		return 1
	}
	encoded, err := json.Marshal(observed)
	if err != nil {
		return 1
	}
	encoded = append(encoded, '\n')
	n, err := out.Write(encoded)
	if err != nil || n != len(encoded) {
		fmt.Fprintln(diagnostics, "TERMINATED_PROFILE_INSPECTION_OUTPUT_UNCONFIRMED")
		return 1
	}
	return 0
}
