package boot

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	chatarchive "github.com/legrch/farol/modules/chat/app/services/archive"
	"github.com/legrch/farol/modules/chat/infra/results"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
)

type nativeApplication interface {
	Methods() (map[string]desktop.Method, error)
	Close() error
}

// NativeRecovery owns only current Computer publication and local owner reads.
// Publication remains an explicit state-changing Go CAS; this is not a read-only
// profile inspector or proof that a predecessor finished. Old Chat, result,
// mutation, Task, process and handoff owners are never opened or consumed.
// Explicit archive queries may inspect existing stored replies under their own
// read-only claim and current selected-owner lease; they acknowledge nothing.
// The trusted host must keep its original startup exclusion and old run marker.
// No successful call or Close supplies CleanRetirement or predecessor drain.
type NativeRecovery struct {
	ctx              context.Context
	cancel           context.CancelFunc
	calls            sync.RWMutex
	closed           atomic.Bool
	once             sync.Once
	closeErr         error
	profile          *QualifiedProfile
	computer, chat   NativeRoot
	store            *accessrepo.Store
	ingress          *ComputerIngress
	archive          *chatarchive.Service
	historyAuthority *historyReadAuthority
}

// NewNativeRecovery is selected before any full-runtime attempt. It opens only
// existing qualified state; it cannot provision, migrate, change roots, fall back
// after refusal or manufacture clean host closure. The inherited host is the
// only caller; no connector, browser, mutable filesystem or Shell is composed.
func NewNativeRecovery(ctx context.Context, launch NativeLaunch, generation string) (*NativeRecovery, error) {
	if ctx == nil || ctx.Err() != nil || launch.StartupMode != "recovery" || launch.StoreMode != "open" ||
		!validIngressID(launch.OwnerID) || !validIngressID(launch.ComputerID) || !validIngressID(generation) ||
		!validIngressID(launch.HostLifetimeID) || !validIngressID(launch.ChildLaunchID) || !validProfilePath(launch.Home) ||
		launch.PreviousHostDrainConfirmed || launch.SettingsMutations || launch.CodexRead != nil || launch.shell != nil {
		return nil, profileFailure(ProfileInvalid)
	}
	if err := refusePendingEmptyRecovery(launch.Profile); err != nil {
		return nil, err
	}
	profile, err := QualifyProfile(launch.Profile)
	if err != nil {
		return nil, err
	}
	lifetime, cancel := context.WithCancel(ctx)
	r := &NativeRecovery{ctx: lifetime, cancel: cancel, profile: profile}
	fail := func(err error) (*NativeRecovery, error) { return nil, errors.Join(err, r.Close()) }
	r.computer, r.chat, err = profile.Roots()
	if err != nil {
		return fail(err)
	}
	r.store, err = accessrepo.Open(r.computer.Path, accessrepo.Binding{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID}, accessrepo.Clock{})
	if err != nil {
		return fail(err)
	}
	readers, err := newComputerReaders(launch.Home)
	if err != nil {
		return fail(err)
	}
	r.ingress, err = newOwnerIngress(r.store, readers, wire.Context{ProfileId: launch.Profile.ProfileID, BackendGeneration: generation}, launch.OwnerID, launch.ComputerID)
	if err != nil {
		return fail(err)
	}
	if err := r.current(); err != nil {
		return fail(err)
	}
	r.historyAuthority, err = newHistoryReadAuthority(lifetime, chatport.HistoryReadScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: generation, OwnerID: launch.OwnerID}, r.current)
	if err != nil {
		return fail(err)
	}
	r.archive, err = chatarchive.New(chatport.JournalScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: generation}, chatarchive.Dependencies{Authority: r.historyAuthority, Store: results.NewArchive(results.Root{Path: r.chat.Path, ProfileID: r.chat.ProfileID, Identity: chatport.JournalRoot{Device: r.chat.Device, Inode: r.chat.Inode, OwnerUID: r.chat.OwnerUID}})})
	if err != nil {
		return fail(err)
	}
	return r, nil
}

func (r *NativeRecovery) current() error {
	if r == nil || r.ctx == nil || r.profile == nil || r.ingress == nil || r.closed.Load() || r.ctx.Err() != nil {
		return errors.New("recovery_runtime_unavailable")
	}
	return r.qualify()
}

func (r *NativeRecovery) qualify() error {
	computer, chat, err := r.profile.Roots()
	if err != nil {
		return err
	}
	if computer != r.computer || chat != r.chat {
		return profileFailure(ProfileRefused)
	}
	return nil
}

// The five original Computer method contracts are unchanged. Archive Queries
// expose stored observations only, under the current selected profile owner.
// An original publication ACK from this live generation is still required
// before each Settings query. Task
// metadata is unavailable because this owner never composes its source resolver.
func (r *NativeRecovery) Methods() (map[string]desktop.Method, error) {
	if r == nil {
		return nil, errors.New("recovery_runtime_unavailable")
	}
	r.calls.RLock()
	defer r.calls.RUnlock()
	if err := r.current(); err != nil {
		return nil, err
	}
	methods := r.ingress.ownerMethods()
	for name, method := range chatArchiveMethods(r.archive) {
		methods[name] = method
	}
	for name, method := range methods {
		handle := method.Handle
		method.Handle = func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			r.calls.RLock()
			defer r.calls.RUnlock()
			if ctx == nil {
				return invalidIngress()
			}
			if err := r.current(); err != nil {
				return nil, err
			}
			call, cancel := context.WithCancel(ctx)
			stop := context.AfterFunc(r.ctx, cancel)
			defer func() { stop(); cancel() }()
			outcome, err := handle(call, request)
			if changed := r.qualify(); changed != nil {
				r.ingress.poison()
				return nil, errors.Join(err, changed)
			}
			if r.closed.Load() || r.ctx.Err() != nil || call.Err() != nil {
				return nil, errors.Join(err, errors.New("recovery_runtime_unavailable"))
			}
			return outcome, err
		}
		methods[name] = method
	}
	return methods, nil
}

// Close stops admission, cancels and joins actual in-flight returns before
// closing owned descriptors. It never repairs old state or retires old work.
func (r *NativeRecovery) Close() error {
	if r == nil {
		return nil
	}
	r.once.Do(func() {
		r.closed.Store(true)
		if r.cancel != nil {
			r.cancel()
		}
		r.historyAuthority.close()
		r.calls.Lock()
		defer r.calls.Unlock()
		var failures []error
		if r.ingress != nil {
			failures = append(failures, r.ingress.freezeForRetirement(context.Background()))
		}
		if r.store != nil {
			failures = append(failures, r.store.Close())
		}
		if r.profile != nil {
			failures = append(failures, r.profile.Close())
		}
		r.closeErr = errors.Join(failures...)
	})
	return r.closeErr
}
