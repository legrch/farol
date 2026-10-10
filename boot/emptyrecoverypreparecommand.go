package boot

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"reflect"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/pkg/ipc"
)

// No public runtime method exposes this mode. The Go entry also confines its
// physical profile to its selected Dev or installed namespace. The commands
// cannot substitute for each other or grant ordinary runtime authority.
// The exact, independently verified
// native host owns profile lease/process closure before starting this child.
// ACK is a separate initiating-host message, not a recorded journal projection.
func runEmptyRecoveryPreparation(args []string, in io.Reader, out, diagnostics io.Writer) int {
	return runEmptyRecoveryPreparationDeadline(args, in, out, diagnostics, time.Now().Add(5*time.Second))
}

// Private test seam selects a shorter deadline on REAL disposable pipes. The
// production command always uses five seconds and refuses noninterruptible I/O
// before effects; it never abandons an outstanding read/write goroutine.
func runEmptyRecoveryPreparationDeadline(args []string, in io.Reader, out, diagnostics io.Writer, deadline time.Time) int {
	return runSelectedEmptyRecoveryPreparationDeadline(args, in, out, diagnostics, deadline, false)
}

// Installed maintenance has its own exact namespace and selection. It never
// weakens the Dev command or supplies normal runtime/replay authority.
func runInstalledEmptyRecoveryPreparation(args []string, in io.Reader, out, diagnostics io.Writer) int {
	return runSelectedEmptyRecoveryPreparationDeadline(args, in, out, diagnostics, time.Now().Add(5*time.Second), true)
}

func runSelectedEmptyRecoveryPreparationDeadline(args []string, in io.Reader, out, diagnostics io.Writer, deadline time.Time, installed bool) (code int) {
	binding, ok := nativeInspectionBinding(args)
	allowedRoot := emptyRecoveryDevRoot(binding.Root)
	if installed {
		allowedRoot = emptyRecoveryInstalledRoot(binding.Root)
	}
	if !ok || !allowedRoot {
		return 2
	}
	input, output, closeStreams, err := emptyRecoveryDeadlineStreams(in, out)
	if err != nil {
		return 2
	}
	defer func() {
		if closeStreams() != nil {
			code = 1
		}
	}()
	in, out = input, output
	rd, readOK := in.(interface{ SetReadDeadline(time.Time) error })
	wd, writeOK := out.(interface{ SetWriteDeadline(time.Time) error })
	if !readOK || !writeOK || rd.SetReadDeadline(deadline) != nil || wd.SetWriteDeadline(deadline) != nil {
		return 2
	}
	reader := bufio.NewReaderSize(in, 65538)
	raw, err := reader.ReadSlice('\n')
	if err != nil || len(raw) > 65537 || ipc.ValidateJSON(raw) != nil || !emptyRecoveryCanonicalFields(raw, reflect.TypeFor[emptyRecoveryInspectionInput]()) {
		return 2
	}
	var selected emptyRecoveryInspectionInput
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&selected) != nil || d.Decode(new(any)) != io.EOF || selected.Profile != (ProfileBinding{}) {
		return 2
	}
	if selected.InstalledEmpty != installed || installed && (selected.UnacknowledgedDev || selected.Interrupted != nil || len(selected.Mutations) != 0) {
		return 2
	}
	selected.Profile = binding
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	write := func(value any) error {
		b, err := json.Marshal(value)
		if err != nil {
			return err
		}
		b = append(b, '\n')
		n, err := out.Write(b)
		if err == nil && n != len(b) {
			err = io.ErrShortWrite
		}
		return err
	}
	ack, err := prepareEmptyRecovery(ctx, selected, func(publication chatport.HandoffPublication) error {
		if err := write(struct {
			Schema      string                      `json:"schema"`
			BuildID     string                      `json:"buildId"`
			Publication chatport.HandoffPublication `json:"publication"`
		}{"farol-empty-recovery-prepared/1", BuildID, publication}); err != nil {
			return err
		}
		raw, err := reader.ReadSlice('\n')
		if err != nil || len(raw) > 4096 || ipc.ValidateJSON(raw) != nil {
			return handoff.Unknown
		}
		var response struct{ Publication chatport.HandoffPublication }
		if !emptyRecoveryCanonicalFields(raw, reflect.TypeOf(response)) || json.Unmarshal(raw, &response) != nil || response.Publication != publication || ctx.Err() != nil {
			return handoff.Unknown
		}
		return nil
	})
	if err != nil || ctx.Err() != nil {
		fmt.Fprintln(diagnostics, "EMPTY_RECOVERY_PREPARATION_REFUSED_OR_UNKNOWN")
		return 1
	}
	if write(struct {
		Schema          string `json:"schema"`
		BuildID         string `json:"buildId"`
		Acknowledgement any    `json:"acknowledgement"`
	}{"farol-empty-recovery-acknowledged/1", BuildID, ack}) != nil {
		return 1
	}
	return 0
}

// Trusted launch identity and held native claims are still required separately.
// Scope is deliberately narrower than the general inspection/serve modes.
// Disposable qualification uses the same Dev namespace under a private parent.
func emptyRecoveryDevRoot(root string) bool {
	if !validProfilePath(root) || filepath.Base(root) != "go-core" {
		return false
	}
	state := filepath.Dir(root)
	if filepath.Base(state) != "farol-next-state" {
		return false
	}
	name := filepath.Base(filepath.Dir(state))
	return name == "Farol Dev" || name == "Farol DEV"
}

// Same physical layout as production startup; the trusted host still pins the
// owner HOME, executable, original records, leases and process absence.
func emptyRecoveryInstalledRoot(root string) bool {
	if !validProfilePath(root) || filepath.Base(root) != "go-core" {
		return false
	}
	state := filepath.Dir(root)
	return filepath.Base(state) == "farol-next-state" && filepath.Base(filepath.Dir(state)) == "Farol Next Preview"
}
