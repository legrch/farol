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

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/pkg/ipc"
)

// Trusted Dev-only maintenance, with no runtime, provider or terminal recorder.
// The initiating native host independently owns promotion/connector fences,
// attestation and actual process closure; input and success grant none of them.
func runPreservedProfilePreparation(args []string, in io.Reader, out, diagnostics io.Writer) int {
	return runPreservedProfilePreparationDeadline(args, in, out, diagnostics, time.Now().Add(5*time.Second))
}

// Private real-pipe test seam. Every phase retains the original absolute budget;
// production has no CLI/environment budget override or abandoned IO goroutine.
func runPreservedProfilePreparationDeadline(args []string, in io.Reader, out, diagnostics io.Writer, deadline time.Time) (code int) {
	defer func() {
		if code == 1 {
			fmt.Fprintln(diagnostics, "PRESERVED_RECOVERY_PREPARATION_REFUSED_OR_UNKNOWN")
		}
	}()
	binding, ok := nativeInspectionBinding(args)
	if !ok || !emptyRecoveryDevRoot(binding.Root) {
		return 2
	}
	original, cancel := context.WithDeadline(context.Background(), deadline)
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
	if !readOK || !writeOK || rd.SetReadDeadline(deadline) != nil || wd.SetWriteDeadline(deadline) != nil {
		return 2
	}
	reader := bufio.NewReaderSize(input, 65538)
	raw, err := reader.ReadSlice('\n')
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
	write := func(value any) error {
		if ctx.Err() != nil {
			return handoff.Unknown
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		encoded = append(encoded, '\n')
		if ctx.Err() != nil {
			return handoff.Unknown
		}
		n, err := output.Write(encoded)
		if err != nil || n != len(encoded) || ctx.Err() != nil {
			return handoff.Unknown
		}
		return nil
	}
	ack, err := preparePreservedProfileRecovery(ctx, selected, func(publication chatport.HandoffPublication) error {
		if err := write(struct {
			Schema      string                      `json:"schema"`
			BuildID     string                      `json:"buildId"`
			Publication chatport.HandoffPublication `json:"publication"`
		}{"farol-preserved-recovery-prepared/1", BuildID, publication}); err != nil {
			return err
		}
		// A fresh initiating-host frame for this exact whole publication, never
		// an ACK recovered from the original journals or inferred from a PID.
		raw, err := reader.ReadSlice('\n')
		if ctx.Err() != nil || err != nil || len(raw) > 4096 || ipc.ValidateJSON(raw) != nil {
			return handoff.Unknown
		}
		var response struct{ Publication chatport.HandoffPublication }
		if !emptyRecoveryCanonicalFields(raw, reflect.TypeOf(response)) {
			return handoff.Unknown
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&response) != nil || decoder.Decode(new(any)) != io.EOF || response.Publication != publication || ctx.Err() != nil {
			return handoff.Unknown
		}
		return nil
	})
	if err != nil || ctx.Err() != nil {
		return 1
	}
	if write(struct {
		Schema          string                          `json:"schema"`
		BuildID         string                          `json:"buildId"`
		Acknowledgement wire.CoreRetirementAcknowledged `json:"acknowledgement"`
	}{"farol-preserved-recovery-acknowledged/1", BuildID, ack}) != nil || ctx.Err() != nil {
		return 1
	}
	return 0
}
