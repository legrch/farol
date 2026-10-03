package boot

import (
	"context"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	chatlifecycle "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/gate"
	chatrepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// NativeLaunch is supplied by the trusted desktop launcher. The explicit create
// mode belongs only to known first provisioning; open never falls back to create.
// Root qualification owns no approval or live membership. HOME is independent
// from the physical profile and selects only the already trusted filesystem port.
type NativeLaunch struct {
	Profile                   ProfileBinding
	OwnerID, ComputerID, Home string
	StoreMode                 string
}
type NativeRuntime struct {
	profile  *QualifiedProfile
	store    *accessrepo.Store
	journal  *chatrepo.Repository
	chat     *chatlifecycle.Service
	ingress  *ComputerIngress
	closed   bool
	closeErr error
}

func NewNativeRuntime(ctx context.Context, launch NativeLaunch, generation string) (*NativeRuntime, error) {
	if ctx == nil || ctx.Err() != nil || !validIngressID(launch.OwnerID) || !validIngressID(launch.ComputerID) || !validIngressID(generation) || !validProfilePath(launch.Home) || (launch.StoreMode != "create" && launch.StoreMode != "open") {
		return nil, profileFailure(ProfileInvalid)
	}
	qualified, err := QualifyProfile(launch.Profile)
	if err != nil {
		return nil, err
	}
	runtime := &NativeRuntime{profile: qualified}
	fail := func(err error) (*NativeRuntime, error) { return nil, errors.Join(err, runtime.Close()) }
	computer, chat, err := qualified.Roots()
	if err != nil {
		return fail(err)
	}
	binding := accessrepo.Binding{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID}
	if launch.StoreMode == "create" {
		runtime.store, err = accessrepo.Create(computer.Path, binding, accessrepo.Clock{})
	} else {
		runtime.store, err = accessrepo.Open(computer.Path, binding, accessrepo.Clock{})
	}
	if err != nil {
		return fail(err)
	}
	runtime.journal, err = chatrepo.New(ctx, chatrepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, chatrepo.Limits{Bytes: 1048576, Records: 4096})
	if err != nil {
		return fail(err)
	}
	if _, _, err := qualified.Roots(); err != nil {
		return fail(err)
	}
	runtime.chat, err = chatlifecycle.New(ctx, chatport.JournalScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: generation}, chatlifecycle.Dependencies{Gate: gate.New(), Journal: runtime.journal})
	if err != nil {
		return fail(err)
	}
	runtime.ingress, err = NewComputerIngress(runtime.store, runtime.chat, filesystem.New(launch.Home), wire.Context{ProfileId: launch.Profile.ProfileID, BackendGeneration: generation}, launch.OwnerID, launch.ComputerID)
	if err != nil {
		return fail(err)
	}
	return runtime, nil
}

// Close releases only this lifetime's descriptors once. It neither unlinks a
// journal claim nor qualifies clean retirement. EOF/exit alone cannot authorize
// reopen, admission restoration, a new root or recovery of an unknown publication.
// Root/host still must retain an actual clean-retirement receipt, explicit durable
// initiating ACK and this backend's exact terminal observation before successor.
func (r *NativeRuntime) Close() error {
	if r == nil {
		return nil
	}
	if r.closed {
		return r.closeErr
	}
	r.closed = true
	var failures []error
	if r.ingress != nil {
		_, err := r.ingress.guard.deactivate()
		failures = append(failures, err)
	}
	if r.chat != nil {
		failures = append(failures, r.chat.FreezeAdmissions(context.Background()))
	}
	if r.journal != nil {
		failures = append(failures, r.journal.Close())
	}
	if r.store != nil {
		failures = append(failures, r.store.Close())
	}
	if r.profile != nil {
		failures = append(failures, r.profile.Close())
	}
	r.closeErr = errors.Join(failures...)
	return r.closeErr
}
