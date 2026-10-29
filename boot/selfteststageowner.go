package boot

import (
	"context"
	"errors"
	"sync"
)

// computerStageOwner retains the qualified profile for one synchronous staging
// attempt at a time. It is not a process fence or authority to publish. The
// caller must separately establish staging eligibility and the original lease.
// Callbacks must not call Close or reenter this owner.
type computerStageOwner struct {
	mu       sync.Mutex
	profile  *QualifiedProfile
	closed   bool
	active   chan struct{}
	closeErr error
	release  func(int) error
}

func newComputerStageOwner(profile *QualifiedProfile) (*computerStageOwner, error) {
	if profile == nil || profile.owner == nil {
		return nil, profileFailure(ProfileUnavailable)
	}
	return &computerStageOwner{profile: profile, release: closeStageDescriptor}, nil
}

// run registers before borrowing, so Close joins the actual callback and fd
// close, not merely cancellation of its context. No owner mutex is held while
// native code or a publication callback executes.
func (o *computerStageOwner) run(ctx context.Context, use func(int, NativeRoot) error) (err error) {
	if o == nil || ctx == nil || ctx.Err() != nil || use == nil {
		return profileFailure(ProfileUnavailable)
	}
	o.mu.Lock()
	if o.closed || o.active != nil || o.closeErr != nil || o.release == nil {
		o.mu.Unlock()
		return profileFailure(ProfileUnavailable)
	}
	done := make(chan struct{})
	o.active = done
	o.mu.Unlock()
	fd := -1
	defer func() {
		if fd >= 0 {
			if closeErr := o.release(fd); closeErr != nil {
				err = errors.Join(err, closeErr)
				o.mu.Lock()
				o.closeErr = errors.Join(o.closeErr, closeErr)
				o.mu.Unlock()
			}
		}
		o.mu.Lock()
		o.active = nil
		close(done)
		o.mu.Unlock()
	}()
	var root NativeRoot
	fd, root, err = duplicateComputerDescriptor(o.profile)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	err = use(fd, root)
	// Losing the original profile after a possible effect remains visible to
	// the caller, which owns the original publication/UNKNOWN classification.
	_, _, checkErr := o.profile.Roots()
	return errors.Join(err, checkErr)
}

func (o *computerStageOwner) Close() error {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	o.closed = true
	done := o.active
	o.mu.Unlock()
	if done != nil {
		<-done
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.closeErr
}
