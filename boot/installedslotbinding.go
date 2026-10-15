package boot

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	slotapp "github.com/legrch/farol/modules/release/app/services/slotbinding"
	slotnative "github.com/legrch/farol/modules/release/infra/native/slotbinding"
	"golang.org/x/sys/unix"
)

// This one-shot mode composes the existing Release publisher. The trusted host
// authenticates this executable and holds update admission, named-route custody
// and the durable unknown fence. No profile, Task, Chat or second journal opens.
func runInstalledSlotBinding(args []string, out io.Writer, diagnostics io.Writer) int {
	return publishInheritedSlotBinding(args, BuildID, 3, 4, time.Now().Add(3*time.Second), out, diagnostics)
}

func publishInheritedSlotBinding(args []string, build string, inputFD, directoryFD int, deadline time.Time, out io.Writer, diagnostics io.Writer) int {
	if len(args) != 2 || args[0] != "--build-id" || args[1] != build || !hexText(build, 64) {
		return 2
	}
	// The child owns its inherited copies. Release borrows only directory until
	// Publish returns; the original parent descriptor stays open independently.
	directory := os.NewFile(uintptr(directoryFD), "farol-installed-operation")
	if directory == nil {
		_ = unix.Close(inputFD)
		return 70
	}
	unix.CloseOnExec(directoryFD)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	data, readErr := consumeSlotBindingInput(inputFD, deadline)
	code := 70
	if readErr == nil {
		publisher, err := slotnative.New(directory)
		if err == nil {
			response, err := slotapp.New(publisher).Publish(ctx, slotapp.Request{Bytes: data})
			if err != nil || response == nil || response.Result.Decision == releaseport.SlotBindingUnknown {
				code = 75
			} else if response.Result.Decision == releaseport.SlotBindingConfirmed && response.Result.Code == "SLOT_BINDING_OK" {
				code = 0
			}
		}
	}
	if directory.Close() != nil {
		code = 75
	}
	if code == 0 {
		n, err := io.WriteString(out, "SLOT_BINDING_OK\n")
		if err != nil || n != len("SLOT_BINDING_OK\n") {
			return 75 // Visible bytes never permit replay of a lost publication ACK.
		}
	} else {
		fmt.Fprintln(diagnostics, "installed slot binding refused or unconfirmed")
	}
	return code
}

func consumeSlotBindingInput(fd int, deadline time.Time) (data []byte, result error) {
	var file *os.File
	defer func() {
		var err error
		if file == nil {
			err = unix.Close(fd)
		} else {
			err = file.Close()
		}
		if err != nil {
			data, result = nil, io.ErrClosedPipe
		}
	}()
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || (stat.Mode&unix.S_IFMT != unix.S_IFIFO && stat.Mode&unix.S_IFMT != unix.S_IFSOCK) || unix.SetNonblock(fd, true) != nil {
		return nil, io.ErrUnexpectedEOF
	}
	unix.CloseOnExec(fd)
	file = os.NewFile(uintptr(fd), "farol-slot-binding-input")
	if file == nil || file.SetReadDeadline(deadline) != nil {
		return nil, io.ErrUnexpectedEOF
	}
	data, err := io.ReadAll(io.LimitReader(file, 8193))
	if err != nil || len(data) < 1 || len(data) > 8192 {
		return nil, io.ErrUnexpectedEOF
	}
	return data, nil
}

func hexText(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
