//go:build darwin || linux

package handoff

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

// The existing opener may create/sync a claim. This opener only acquires the
// existing descriptors/lock; all physical checks, reads and close reuse disk.
func openClosedInspectionDisk(ctx context.Context, roots Roots) (*disk, error) {
	uid := uint32(os.Geteuid())
	if !historyID(roots.ProfileID) || roots.Parent.Identity.OwnerUID != uid || roots.Chat.Identity.OwnerUID != uid || roots.Parent.Identity == roots.Chat.Identity || roots.Parent.Identity.Device != roots.Chat.Identity.Device || !filepath.IsAbs(roots.Parent.Path) || filepath.Clean(roots.Parent.Path) != roots.Parent.Path || roots.Chat.Path != filepath.Join(roots.Parent.Path, "chat") {
		return nil, fail(Invalid, false)
	}
	canonical, err := filepath.EvalSymlinks(roots.Parent.Path)
	if err != nil || canonical != roots.Parent.Path {
		return nil, fail(Refused, false)
	}
	d := &disk{roots: roots, parent: -1, dir: -1, claim: -1}
	failure := func(code Code) (*disk, error) {
		if d.close() != nil {
			code = Unavailable
		}
		return nil, fail(code, code == Unknown)
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	d.parent, err = unix.Open(roots.Parent.Path, flags, 0)
	if err != nil {
		return failure(Refused)
	}
	d.parentMeta, err = stat(d.parent)
	if err != nil || !qualified(d.parentMeta, roots.Parent.Identity) {
		return failure(Refused)
	}
	d.dir, err = unix.Openat(d.parent, "chat", flags, 0)
	if err != nil {
		return failure(Refused)
	}
	d.dirMeta, err = stat(d.dir)
	if err != nil || !qualified(d.dirMeta, roots.Chat.Identity) {
		return failure(Refused)
	}
	if ctx.Err() != nil {
		return failure(Cancelled)
	}
	d.claim, err = unix.Openat(d.dir, claimName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return failure(Refused)
	}
	d.claimMeta, err = stat(d.claim)
	if err != nil || !physical(d.claimMeta, unix.S_IFREG, 0600, uid) || unix.Flock(d.claim, unix.LOCK_EX|unix.LOCK_NB) != nil {
		return failure(Refused)
	}
	if err := d.check(); err != nil {
		// Preserve the classified preexisting UNKNOWN without attempting poison.
		if d.close() != nil {
			return nil, fail(Unavailable, false)
		}
		return nil, err
	}
	if ctx.Err() != nil {
		return failure(Cancelled)
	}
	return d, nil
}

type closedInspectionStepIdentity struct{ attempt, commit unix.Stat_t }

// The normal inventory validates every canonical handoff entry and gap. Add
// only the diagnostic's hidden-staging refusal; do not decode unrelated Chat
// files or interpret them as evidence. Keep its existing directory-name budget.
func closedInspectionNoStaging(d *disk) error {
	if d.check() != nil {
		return fail(Unavailable, false)
	}
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail(Unavailable, false)
	}
	f := os.NewFile(uintptr(fd), "chat-handoff-inspection")
	before, se := stat(fd)
	entries, readErr := f.ReadDir(2*maxSteps + 128)
	after, ae := stat(fd)
	closed := f.Close()
	if se != nil || ae != nil || !same(before, d.dirMeta) || !stable(before, after) || readErr != nil && readErr != io.EOF || closed != nil || len(entries) >= 2*maxSteps+128 || d.check() != nil {
		return fail(Unavailable, false)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".chat-handoff") {
			return fail(Refused, false)
		}
	}
	return nil
}

func withClosedInspection(ctx context.Context, roots Roots, scope port.JournalScope, inspect func(ClosedInspection) error) (err error) {
	l, err := acquireClosedInspection(ctx, roots, scope)
	if err != nil {
		return err
	}
	defer func() {
		if l.Close() != nil {
			err = fail(Unavailable, false)
		}
	}()
	return closedInspectionCallback(ctx, l.value, l.Verify, inspect)
}

func acquireClosedInspection(ctx context.Context, roots Roots, scope port.JournalScope) (_ *ClosedLease, err error) {
	chain, verify, close, err := acquireClosedInspectionChain(ctx, roots, func(chain closedInspectionChain) error {
		_, err := closedInspectionValue(roots, scope, chain)
		return err
	})
	if err != nil {
		return nil, err
	}
	value, _ := closedInspectionValue(roots, scope, chain)
	return &ClosedLease{value: value, verify: verify, close: close}, nil
}

func acquireInterruptedRetirementInspection(ctx context.Context, roots Roots, scope port.JournalScope) (*ClosedLease, error) {
	chain, verify, close, err := acquireClosedInspectionChain(ctx, roots, func(chain closedInspectionChain) error {
		_, err := interruptedRetirementInspectionValue(roots, scope, chain)
		return err
	})
	if err != nil {
		return nil, err
	}
	value, _ := interruptedRetirementInspectionValue(roots, scope, chain)
	return &ClosedLease{value: value, verify: verify, close: close}, nil
}

func acquireAcknowledgedInspection(ctx context.Context, roots Roots, expected port.HandoffBinding, handoffID string) (*AcknowledgedLease, error) {
	chain, verify, close, err := acquireClosedInspectionChain(ctx, roots, func(chain closedInspectionChain) error {
		return acknowledgedInspectionQualify(chain, expected, handoffID)
	})
	if err != nil {
		return nil, err
	}
	return &AcknowledgedLease{head: copyClosedInspectionHead(chain.head), verify: verify, close: close}, nil
}

// Retain the same read-only disk and complete canonical scanner for each exact
// predicates. The ordinary public API remains consumed-only.
func acquireClosedInspectionChain(ctx context.Context, roots Roots, qualify func(closedInspectionChain) error) (_ closedInspectionChain, verify, close func() error, err error) {
	d, err := openClosedInspectionDisk(ctx, roots)
	if err != nil {
		return closedInspectionChain{}, nil, nil, err
	}
	retained := false
	defer func() {
		if !retained && d.close() != nil {
			err = fail(Unavailable, false)
		}
	}()
	if err := closedInspectionNoStaging(d); err != nil {
		return closedInspectionChain{}, nil, nil, err
	}
	identities := make([]closedInspectionStepIdentity, 0)
	digests := make([][32]byte, 0)
	checking := false
	read := func(ctx context.Context, index int) ([]byte, bool, error) {
		var before, after closedInspectionStepIdentity
		// read checks absence/inventory for the first missing step itself. For
		// present files retain stat identity across the complete callback window.
		attemptErr := unix.Fstatat(d.dir, stepName(index, "attempt"), &before.attempt, unix.AT_SYMLINK_NOFOLLOW)
		commitErr := unix.Fstatat(d.dir, stepName(index, "commit"), &before.commit, unix.AT_SYMLINK_NOFOLLOW)
		raw, present, err := d.read(ctx, index)
		if err != nil || !present {
			return raw, present, err
		}
		if attemptErr != nil || commitErr != nil || unix.Fstatat(d.dir, stepName(index, "attempt"), &after.attempt, unix.AT_SYMLINK_NOFOLLOW) != nil || unix.Fstatat(d.dir, stepName(index, "commit"), &after.commit, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(before.attempt, after.attempt) || !stable(before.commit, after.commit) {
			return nil, false, fail(Unavailable, false)
		}
		digest := sha256.Sum256(raw)
		if checking {
			if index > len(identities) || !stable(identities[index-1].attempt, after.attempt) || !stable(identities[index-1].commit, after.commit) || digest != digests[index-1] {
				return nil, false, fail(Unavailable, false)
			}
		} else {
			if index > maxSteps {
				return nil, false, fail(Refused, false)
			}
			identities = append(identities, after)
			digests = append(digests, digest)
		}
		return raw, true, nil
	}
	value, err := closedInspectionEmptyChainScan(ctx, roots, read)
	if err != nil {
		return closedInspectionChain{}, nil, nil, err
	}
	if err := qualify(value); err != nil {
		return closedInspectionChain{}, nil, nil, err
	}
	checking = true
	recheck := func() error {
		if err := closedInspectionNoStaging(d); err != nil {
			return err
		}
		current, err := closedInspectionEmptyChainScan(ctx, roots, read)
		if err != nil {
			return err
		}
		if err := qualify(current); err != nil {
			return err
		}
		parent, pe := stat(d.parent)
		child, ce := stat(d.dir)
		claim, le := stat(d.claim)
		if current.head.Digest != value.head.Digest || len(current.stages) != len(value.stages) || pe != nil || ce != nil || le != nil || !stable(d.parentMeta, parent) || !stable(d.dirMeta, child) || !stable(d.claimMeta, claim) || d.check() != nil {
			return fail(Unavailable, false)
		}
		return nil
	}
	if err := recheck(); err != nil {
		return closedInspectionChain{}, nil, nil, err
	}
	retained = true
	return value, recheck, d.close, nil
}
