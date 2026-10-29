package boot

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

type fileWorkspaceHold struct {
	closed   int
	closeErr error
}

func (h *fileWorkspaceHold) Check(mutation.DirectoryIdentity) error {
	if h.closed != 0 {
		return errors.New("closed")
	}
	return nil
}
func (h *fileWorkspaceHold) Close() error { h.closed++; return h.closeErr }

type fileWorkspaceNative struct {
	result  *port.MutationReceipt
	err     error
	calls   int
	request port.MutationRequest
}

func (n *fileWorkspaceNative) MutateScratch(_ context.Context, r port.MutationRequest, _ mutation.ScratchCleanupBinding) (*port.MutationReceipt, error) {
	n.calls++
	n.request = r
	return n.result, n.err
}

func TestSelfTestFileWorkspaceRetainsPublishedCustody(t *testing.T) {
	_, run, journal, _ := selfTestFileFixture(t)
	creation, ok := journal.records[mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: run.operation, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}]
	if !ok {
		t.Fatal("missing creation fixture")
	}
	cleanup, err := mutation.NewScratchCleanup(&creation)
	if err != nil {
		t.Fatal(err)
	}
	identity := mutation.DirectoryIdentity{Device: "1", Inode: "20"}
	for _, mode := range []string{"write", "edit", "old close unknown", "native unknown", "missing new handle"} {
		t.Run(mode, func(t *testing.T) {
			directory, previous, current := &fileWorkspaceHold{}, &fileWorkspaceHold{}, &fileWorkspaceHold{}
			native := &fileWorkspaceNative{result: &port.MutationReceipt{ScratchFile: identity, ScratchFileHold: current}}
			w := &selfTestBoundWorkspace{native: native, binding: cleanup.Binding(), directory: directory}
			if mode == "edit" || mode == "old close unknown" {
				w.previous, w.expected = previous, &identity
			}
			if mode == "old close unknown" {
				previous.closeErr = errors.New("lost close")
			}
			if mode == "native unknown" {
				native.err = errors.New("lost result")
			}
			if mode == "missing new handle" {
				native.result.ScratchFileHold = nil
			}
			out, err := w.Mutate(context.Background(), port.MutationRequest{})
			if native.calls != 1 || native.request.ScratchDirectoryHold != directory || !native.request.HoldScratchFile {
				t.Fatal("custody not forwarded")
			}
			if mode == "write" || mode == "edit" {
				if err != nil || out == nil || out.ScratchFileHold != nil || w.custody != current || w.published != identity {
					t.Fatal("new handle not retained", out, err)
				}
			} else if err == nil || out != nil {
				t.Fatal("uncertainty accepted", out, err)
			}
			if mode == "edit" || mode == "old close unknown" {
				if previous.closed != 1 || !w.previousCloseAttempted || native.request.ScratchPreviousFile != previous {
					t.Fatal("old handle not settled once")
				}
			} else if previous.closed != 0 {
				t.Fatal("unowned old handle closed")
			}
			if mode == "native unknown" && w.custody != current {
				t.Fatal("receipt plus error lost new handle")
			}
			if _, err := w.Mutate(context.Background(), port.MutationRequest{}); err == nil || native.calls != 1 {
				t.Fatal("native mutation repeated")
			}
		})
	}
}
