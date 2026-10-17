package boot

import (
	"context"
	"errors"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	browser "github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/results"
	"github.com/legrch/farol/transport/desktop"
	"sync"
	"sync/atomic"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	chatarchive "github.com/legrch/farol/modules/chat/app/services/archive"
	chathandoff "github.com/legrch/farol/modules/chat/app/services/handoff"
	chatlifecycle "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/gate"
	chatrepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// NativeLaunch is supplied by the trusted desktop launcher. The explicit create
// mode belongs only to known first provisioning; open never falls back to create.
// Root qualification owns no approval or live membership. HOME is independent
// from the physical profile and selects only the already trusted filesystem port.
type NativeLaunch struct {
	Profile                   ProfileBinding
	OwnerID, ComputerID, Home string
	StoreMode                 string
	// Recovery is an explicit existing-store route, never a constructor fallback.
	StartupMode                   string
	HostLifetimeID, ChildLaunchID string
	PreviousHostDrainConfirmed    bool
	SettingsMutations             bool
	CodexRead                     *NativeCodexReadSelection
	// Only Run's bounded inherited-host decoder constructs this selection.
	shell *connectorShellConfig
}
type NativeRuntime struct {
	cancel           context.CancelFunc
	browser          *BrowserExchange
	conversations    *ChatIngress
	chatComputer     *ChatComputerIngress
	results          *results.Native
	profile          *QualifiedProfile
	store            *accessrepo.Store
	journal          *chatrepo.Repository
	chat             *chatlifecycle.Service
	ingress          *ComputerIngress
	connector        *computerConnector
	mutations        *SettingsMutationIngress
	settingsDelivery *SettingsDeliveryIngress
	settingsStore    *SettingsStoreExchange
	mutationStore    *mutationrepo.Repository
	closed           atomic.Bool
	closeOnce        sync.Once
	closeErr         error
	retirement       *nativeRetirement
	historyAuthority *historyReadAuthority
	history          *chathandoff.HistoryReader
	retiredArchive   *chatarchive.Service
	codexRead        *nativeCodexRead
}

func NewNativeRuntime(ctx context.Context, launch NativeLaunch, generation string) (*NativeRuntime, error) {
	if launch.StartupMode != "" && launch.StartupMode != "normal" {
		return nil, profileFailure(ProfileInvalid)
	}
	if launch.CodexRead != nil && !launch.CodexRead.valid() {
		return nil, profileFailure(ProfileInvalid)
	}
	if ctx == nil || ctx.Err() != nil || !validIngressID(launch.OwnerID) || !validIngressID(launch.ComputerID) || !validIngressID(generation) || !validProfilePath(launch.Home) || (launch.StoreMode != "create" && launch.StoreMode != "open") {
		return nil, profileFailure(ProfileInvalid)
	}
	if (launch.HostLifetimeID != "" || launch.ChildLaunchID != "") && (!validIngressID(launch.HostLifetimeID) || !validIngressID(launch.ChildLaunchID)) {
		return nil, profileFailure(ProfileInvalid)
	}
	if launch.SettingsMutations && launch.HostLifetimeID == "" {
		return nil, profileFailure(ProfileInvalid)
	}
	if err := refusePendingEmptyRecovery(launch.Profile); err != nil {
		return nil, err
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
	journalRoot := chatrepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	limits := chatrepo.Limits{Bytes: 1048576, Records: 4096}
	if launch.HostLifetimeID != "" {
		runtime.retirement, err = newNativeRetirement(ctx, launch, generation, chat)
		if err != nil {
			return fail(err)
		}
		runtime.journal, err = runtime.retirement.openJournal(ctx, launch.StoreMode, journalRoot, limits)
	} else {
		// Legacy/test launch without an exact host lifetime can create only the
		// original strict owner. It receives no retirement or successor capability.
		runtime.journal, err = chatrepo.New(ctx, journalRoot, limits)
	}
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
	runtime.results, err = results.NewNative(ctx, lifetime, results.Root{Path: chat.Path, ProfileID: chat.ProfileID, Identity: chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}}, scope, results.TextLimits(), launch.StoreMode)
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
	fileOwners, err := newComputerFileOwners(launch.Home)
	if err != nil {
		return fail(err)
	}
	runtime.ingress, err = newComputerIngress(runtime.store, runtime.chat, fileOwners, wire.Context{ProfileId: launch.Profile.ProfileID, BackendGeneration: generation}, launch.OwnerID, launch.ComputerID)
	if err != nil {
		return fail(err)
	}
	connectorJournal, err := accessrepo.NewConnectorJournal(runtime.store)
	if err != nil {
		return fail(err)
	}
	runtime.connector, err = newComputerConnector(lifetime, runtime.ingress, connectorJournal, accessrepo.Clock{}, func(ctx context.Context, binding wire.ComputerConnectorBinding, methods map[string]desktop.Method) (connectorEndpoint, error) {
		return desktop.StartConnector(ctx, binding, methods)
	})
	if err != nil {
		return fail(err)
	}
	runtime.chatComputer, err = NewChatComputerIngress(runtime.conversations, runtime.ingress)
	if err != nil {
		return fail(err)
	}
	if launch.SettingsMutations {
		runtime.mutationStore, err = mutationrepo.New(ctx, mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID})
		if err != nil {
			return fail(err)
		}
		runtime.mutations, err = settingsMutationIngress(runtime.ingress, computerMutationDependencies{repository: runtime.mutationStore, native: fileOwners, digester: filesystem.Digester{}})
		if err != nil {
			return fail(err)
		}
		runtime.settingsStore, err = NewSettingsStoreExchange(lifetime, peer)
		if err != nil {
			return fail(err)
		}
		runtime.settingsDelivery, err = NewSettingsDeliveryIngress(runtime.mutations, runtime.settingsStore)
		if err != nil {
			return fail(err)
		}
		if _, _, err := qualified.Roots(); err != nil {
			return fail(err)
		}
		// External MCP and Settings share the same mutation journal, native owner,
		// retained attempt map and retirement fence. No second executor is opened.
		runtime.connector.mutations = runtime.mutations
		if launch.shell != nil {
			// Unsupported or changed native support withholds only Shell. The
			// established file Computer keeps its own independently valid route.
			factory, shellErr := newConnectorShellFactory(lifetime, *launch.shell, accessrepo.Clock{})
			if shellErr == nil {
				runtime.connector.processes = factory.selectShell
			}
		}
	}
	if runtime.retirement != nil {
		runtime.historyAuthority, err = newHistoryReadAuthority(lifetime, chatport.HistoryReadScope{ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration, OwnerID: launch.OwnerID}, func() error {
			_, _, err := qualified.Roots()
			return err
		})
		if err != nil {
			return fail(err)
		}
		if launch.StoreMode == "create" {
			runtime.history, err = chathandoff.NewEmptyHistoryReader(scope, runtime.historyAuthority)
		} else {
			runtime.history, err = chathandoff.NewHistoryReader(runtime.retirement.history, chathandoff.HistoryDependencies{Authority: runtime.historyAuthority, Results: runtime.results, ResultBytesLimit: chatlifecycle.OutputBytesLimit})
		}
		if err != nil {
			return fail(err)
		}
		runtime.retiredArchive, err = chatarchive.New(scope, chatarchive.Dependencies{Authority: runtime.historyAuthority, Store: results.NewRetiredArchive(results.Root{Path: launch.Profile.Root, ProfileID: scope.ProfileID, Identity: chatport.JournalRoot{Device: launch.Profile.Device, Inode: launch.Profile.Inode, OwnerUID: chat.OwnerUID}})})
		if err != nil {
			return fail(err)
		}
	}
	if launch.CodexRead != nil {
		runtime.selectNativeCodexRead(lifetime, *launch.CodexRead)
		runtime.connector.codexRead = &connectorCodexRead{hostID: launch.CodexRead.HostID, reader: selectedCodexReadFunc(runtime.ReadSelectedCodex)}
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
	r.closeOnce.Do(func() {
		r.closed.Store(true)
		r.closeErr = r.closeResources()
	})
	return r.closeErr
}

func (r *NativeRuntime) closeResources() error {
	r.historyAuthority.close()
	if r.cancel != nil {
		r.cancel()
	}
	var failures []error
	failures = append(failures, r.closeCodexRead())
	if r.ingress != nil {
		_, err := r.ingress.guard.deactivate()
		failures = append(failures, err)
	}
	if r.connector != nil {
		failures = append(failures, r.connector.Shutdown())
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
	if r.mutationStore != nil {
		failures = append(failures, r.mutationStore.Close())
	}
	if r.retirement != nil {
		failures = append(failures, r.retirement.repo.Close())
	}
	if r.profile != nil {
		failures = append(failures, r.profile.Close())
	}
	return errors.Join(failures...)
}

// Real time is read only in composition; the Chat application receives a port.
type browserClock struct{}

func (browserClock) NowMillis() uint64 { return uint64(time.Now().UnixMilli()) }
func (r *NativeRuntime) Methods() (map[string]desktop.Method, error) {
	if r == nil || r.closed.Load() || r.ingress == nil || r.browser == nil || r.conversations == nil || r.chatComputer == nil {
		return nil, errors.New("native_runtime_unavailable")
	}
	merged := make(map[string]desktop.Method)
	if r.history != nil {
		for name, method := range chatHistoryMethods(conversation.NewHistory(r.history)) {
			merged[name] = method
		}
	}
	if r.retiredArchive != nil {
		for name, method := range retiredArchiveMethods(r.retiredArchive) {
			merged[name] = method
		}
	}
	for _, source := range []map[string]desktop.Method{r.ingress.Methods(), r.connector.Methods(), r.browser.Methods(), r.conversations.Methods(), r.chatComputer.Methods(), r.retirementMethods()} {
		for name, method := range source {
			if _, exists := merged[name]; exists {
				return nil, errors.New("native_method_conflict")
			}
			merged[name] = method
		}
	}
	// The owner engine is reachable only through Go delivery policy. There is
	// no second public edit/ACK path around durable pending publication.
	if r.settingsDelivery != nil {
		for _, source := range []map[string]desktop.Method{r.settingsDelivery.Methods(), r.settingsStore.Methods()} {
			for name, method := range source {
				if _, exists := merged[name]; exists {
					return nil, errors.New("native_method_conflict")
				}
				merged[name] = method
			}
		}
	}
	return merged, nil
}
