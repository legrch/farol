package boot

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/pkg/ipc"
)

type preservedProfileObservationReply struct {
	Schema             string                              `json:"schema"`
	BuildID            string                              `json:"buildId"`
	Selection          chatport.PreservedRecoverySelection `json:"selection"`
	RecoveryAuthorized bool                                `json:"recoveryAuthorized"`
}

// A read-only Dev entry, not preparation or current/process authority. The
// initiating owner must separately retain host/connector/process exclusion.
func runPreservedProfileObservation(args []string, in io.Reader, out, diagnostics io.Writer) int {
	return runPreservedProfileObservationDeadline(args, in, out, diagnostics, time.Now().Add(5*time.Second))
}

func runPreservedProfileObservationDeadline(args []string, in io.Reader, out, diagnostics io.Writer, until time.Time) (code int) {
	return runPreservedProfileInspectionDeadline(args, in, out, diagnostics, until, false)
}

// Separate read-only entry; the original known-scope command keeps its input
// contract. Both entries retain the same bounded codec and original deadline.
func runPreservedProfileDiscovery(args []string, in io.Reader, out, diagnostics io.Writer) int {
	return runPreservedProfileDiscoveryDeadline(args, in, out, diagnostics, time.Now().Add(5*time.Second))
}

func runPreservedProfileDiscoveryDeadline(args []string, in io.Reader, out, diagnostics io.Writer, until time.Time) int {
	return runPreservedProfileInspectionDeadline(args, in, out, diagnostics, until, true)
}

func runPreservedProfileInspectionDeadline(args []string, in io.Reader, out, diagnostics io.Writer, until time.Time, discoverScope bool) (code int) {
	defer func() {
		if code == 1 {
			fmt.Fprintln(diagnostics, "PRESERVED_PROFILE_OBSERVATION_UNCONFIRMED")
		}
	}()
	binding, ok := nativeInspectionBinding(args)
	if !ok || !emptyRecoveryDevRoot(binding.Root) {
		return 2
	}
	original, cancel := context.WithDeadline(context.Background(), until)
	defer cancel()
	ctx, err := bindPreservedProfileContext(original)
	if err != nil {
		return 1
	}
	input, output, closeStreams, err := emptyRecoveryDeadlineStreams(in, out)
	if err != nil {
		return 2
	}
	defer func() {
		if closeStreams() != nil || code == 0 && ctx.Err() != nil {
			code = 1
		}
	}()
	rd, readOK := input.(interface{ SetReadDeadline(time.Time) error })
	wd, writeOK := output.(interface{ SetWriteDeadline(time.Time) error })
	if !readOK || !writeOK || rd.SetReadDeadline(until) != nil || wd.SetWriteDeadline(until) != nil {
		return 2
	}
	raw, err := bufio.NewReaderSize(input, 65538).ReadSlice('\n')
	if ctx.Err() != nil {
		return 1
	}
	if err != nil || len(raw) > 65537 || ipc.ValidateJSON(raw) != nil || !emptyRecoveryCanonicalFields(raw, reflect.TypeFor[preservedProfileInspectionInput]()) {
		return 2
	}
	var selected preservedProfileInspectionInput
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&selected) != nil || decoder.Decode(new(any)) != io.EOF || selected.Profile != (ProfileBinding{}) {
		return 2
	}
	selected.Profile = binding
	var reply preservedProfileObservationReply
	// Publish only after repository visitors, physical rechecks and claim closes
	// return. The host must also observe original normal close, not just a frame.
	observe := observePreservedProfile
	if discoverScope {
		observe = discoverPreservedProfile
	}
	err = observe(ctx, selected, func(v preservedProfileInspection) error {
		reply = preservedProfileObservationReply{Schema: "farol-preserved-profile-inspection/1", BuildID: BuildID, Selection: v.Plan.Selection, RecoveryAuthorized: false}
		return nil
	})
	if err != nil || ctx.Err() != nil || reply.Schema == "" {
		return 1
	}
	encoded, err := json.Marshal(reply)
	if err != nil || ctx.Err() != nil {
		return 1
	}
	encoded = append(encoded, '\n')
	n, err := output.Write(encoded)
	if err != nil || n != len(encoded) || ctx.Err() != nil {
		return 1
	}
	return 0
}
