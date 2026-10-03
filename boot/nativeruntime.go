package boot

import (
	"context"
	"errors"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	browser "github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/results"
	"github.com/legrch/farol/transport/desktop"
	"time"

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
	cancel        context.CancelFunc
	browser       *BrowserExchange
	conversations *ChatIngress
	results       *results.Memory
	profile       *QualifiedProfile
	store         *accessrepo.Store
	journal       *chatrepo.Repository
	chat          *chatlifecycle.Service
	ingress       *ComputerIngress
	closed        bool
	closeErr      error
}

func NewNativeRuntime(ctx context.Context, launch NativeLaunch, generation string) (*NativeRuntime, error) {
	if ctx == nil || ctx.Err() != nil || !validIngressID(launch.OwnerID) || !validIngressID(launch.ComputerID) || !validIngressID(generation) || !validProfilePath(launch.Home) || (launch.StoreMode != "create" && launch.StoreMode != "open") {
		return nil, profileFailure(ProfileInvalid)
	}
	qualified, err := QualifyProfile(launch.Profile)
	if err != nil {
		return nil, err
	}
	lifetime, cancel := context.WithCancel(ctx)
	runtime := &NativeRuntime{profile: qualified, cancel: cancel}
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
	scope := chatport.JournalScope{ProfileID: launch.Profile.ProfileID, BackendGeneration: generation}
	peer := wire.Context{ProfileId: launch.Profile.ProfileID, BackendGeneration: generation}
	runtime.browser, err = NewBrowserExchange(lifetime, peer)
	if err != nil {
		return fail(err)
	}
	physical, err := browser.New(lifetime, browser.Scope{ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration}, runtime.browser, browserClock{})
	if err != nil {
		return fail(err)
	}
	runtime.results, err = results.NewMemory(lifetime, scope, results.TextLimits())
	if err != nil {
		return fail(err)
	}
	runtime.chat, err = chatlifecycle.New(ctx, scope, chatlifecycle.Dependencies{Gate: gate.New(), Journal: runtime.journal, Browser: physical, Results: runtime.results, ResultBytesLimit: chatlifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		return fail(err)
	}
	runtime.conversations, err = NewChatIngress(conversation.New(runtime.chat), peer, launch.OwnerID)
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
	if r.cancel != nil {
		r.cancel()
	}
	var failures []error
	if r.ingress != nil {
		_, err := r.ingress.guard.deactivate()
		failures = append(failures, err)
	}
	if r.chat != nil {
		failures = append(failures, r.chat.FreezeAdmissions(context.Background()))
	}
	if r.results != nil {
		failures = append(failures, r.results.Close())
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

// Real time is read only in composition; the Chat application receives a port.
type browserClock struct{}

func (browserClock) NowMillis() uint64 { return uint64(time.Now().UnixMilli()) }
func (r *NativeRuntime) Methods() (map[string]desktop.Method, error) {
	if r == nil || r.closed || r.ingress == nil || r.browser == nil || r.conversations == nil {
		return nil, errors.New("native_runtime_unavailable")
	}
	merged := make(map[string]desktop.Method)
	for _, source := range []map[string]desktop.Method{r.ingress.Methods(), r.browser.Methods(), r.conversations.Methods()} {
		for name, method := range source {
			if _, exists := merged[name]; exists {
				return nil, errors.New("native_method_conflict")
			}
			merged[name] = method
		}
	}
	return merged, nil
}
