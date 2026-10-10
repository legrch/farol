package planresponses

import (
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

// AppServerConfig is an inert contract for future trusted composition, not a
// launcher or a second Task client. RegisteredAppName must come from the actual
// app-owned SIWC registration; no product or laboratory name is guessed here.
type AppServerConfig struct {
	Provider, ProviderName, Resource, Listen, WireAPI, EnvKey string
	RequiresOpenAIAuth, SupportsWebSockets                    bool
	RequestMaxRetries, StreamMaxRetries                       uint64
	RegisteredAppName, AgentNameHint, InitializeClientName    string
	Account                                                   inference.AccountIdentity
	Model                                                     inference.ModelSelection
	// Capability is account-bound owner evidence, not live entitlement proof.
	Capability AppServerCapability
}

type AppServerCapability struct {
	Account                         inference.AccountIdentity
	Model                           inference.ModelSelection
	ModelSupported, EffortSupported bool
}

type AppServerCode string

func (c AppServerCode) Error() string { return string(c) }

const (
	AppServerConfigRefused    AppServerCode = "APPSERVER_CONFIG_REFUSED"
	AppServerBindingRefused   AppServerCode = "APPSERVER_BINDING_REFUSED"
	AppServerLifecycleRefused AppServerCode = "APPSERVER_LIFECYCLE_REFUSED"
	AppServerLifecycleUnknown AppServerCode = "APPSERVER_LIFECYCLE_UNKNOWN"
	AppServerStaleEvidence    AppServerCode = "APPSERVER_STALE_EVIDENCE"
	AppServerMaxRenewals                    = 32
)

// Validate permits only the documented public plan provider. Zero provider
// retries are deliberate: a new process cannot authorize replay of unknown IO.
func (c AppServerConfig) Validate() error {
	if c.Provider != "openai_chatgpt_plan" || c.ProviderName != "ChatGPT plan" ||
		c.Resource != inference.PublicResource || c.Listen != "stdio://" ||
		c.WireAPI != "responses" || c.EnvKey != "ACCESS_TOKEN" ||
		c.RequiresOpenAIAuth || c.SupportsWebSockets || c.RequestMaxRetries != 0 || c.StreamMaxRetries != 0 ||
		!appServerText(c.RegisteredAppName, 120) || c.RegisteredAppName != c.AgentNameHint ||
		c.RegisteredAppName != c.InitializeClientName || !appServerAccount(c.Account) ||
		!appServerModel(c.Model) || c.Capability.Account != c.Account || c.Capability.Model != c.Model ||
		!c.Capability.ModelSupported || !c.Capability.EffortSupported {
		return AppServerConfigRefused
	}
	return nil
}

// Arguments returns detached configuration arguments only. It never accepts a
// secret value or mutates a live environment. The future process owner must
// inject the corresponding app-owned token via ACCESS_TOKEN at process creation.
// It must also isolate ambient Codex configuration/tools under its own policy;
// these values alone do not qualify a native executable or authorize a launch.
func (c AppServerConfig) Arguments() ([]string, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return []string{
		"app-server", "--listen", "stdio://",
		"-c", `model_provider="openai_chatgpt_plan"`,
		"-c", `model_providers.openai_chatgpt_plan={name="ChatGPT plan",base_url="https://api.openai.com/v1",env_key="ACCESS_TOKEN",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
		"-c", "model=" + strconv.Quote(c.Model.Slug),
		"-c", "model_reasoning_effort=" + strconv.Quote(c.Model.Effort),
	}, nil
}

// AppServerBinding contains metadata only. ProcessID is the exact process
// owner's non-reusable handle identity, not a PID to look up or signal later.
type AppServerBinding struct {
	ProcessID, ThreadID, AppName  string
	ProcessEpoch, TokenGeneration uint64
	Account                       inference.AccountIdentity
	Model                         inference.ModelSelection
}

type AppServerObservation string

const (
	AppServerKnown   AppServerObservation = "known"
	AppServerRefused AppServerObservation = "refused"
	AppServerUnknown AppServerObservation = "unknown"
)

type AppServerState string

const (
	AppServerReady          AppServerState = "ready"
	AppServerStopRequired   AppServerState = "original_stop_required"
	AppServerStartRequired  AppServerState = "new_initialize_required"
	AppServerResumeRequired AppServerState = "same_thread_resume_required"
	AppServerFencedRefused  AppServerState = "refused"
	AppServerFencedUnknown  AppServerState = "unknown"
)

// All evidence is supplied by the future app/process owner after the original
// one-shot operation. These values are not generated or independently attested
// by this contract. Unknown observations must never be retried to obtain a more
// favorable receipt, and later observations cannot unseal an unknown lifetime.
type AppServerInitialEvidence struct {
	Binding                                 AppServerBinding
	Result                                  AppServerObservation
	Initialized, ThreadConfirmed, Quiescent bool
}

type AppServerRenewalEvidence struct {
	Binding AppServerBinding
	Result  AppServerObservation
	// AtomicCommitted requires one app-owned CAS from the original generation
	// to the complete renewed credential under the exact unchanged account.
	// A lost refresh reply or uncertain store commit is Unknown, never Known.
	AtomicCommitted              bool
	Account                      inference.AccountIdentity
	FromGeneration, ToGeneration uint64
}

type AppServerStopEvidence struct {
	Binding                   AppServerBinding
	Result                    AppServerObservation
	CleanExit, OriginalJoined bool
	ExitCode                  int
}

type AppServerStartEvidence struct {
	Binding              AppServerBinding
	Result               AppServerObservation
	Initialized          bool
	InitializeClientName string
}

type AppServerResumeEvidence struct {
	Binding            AppServerBinding
	Result             AppServerObservation
	Resumed, Quiescent bool
	ThreadID           string
}

// AppServerLifecycle is an immutable, bounded policy value. Retain the returned
// value under the original owner's serialization; replacing it cannot settle a
// pending effect. It performs no RPC, process IO, credential access, or provider
// admission. Ready means only that these synthetic/owner receipts agree.
type AppServerLifecycle struct {
	config            AppServerConfig
	current           AppServerBinding
	state             AppServerState
	pendingGeneration uint64
	renewals          uint64
}

func NewAppServerLifecycle(c AppServerConfig, initial AppServerInitialEvidence) (AppServerLifecycle, error) {
	l := AppServerLifecycle{config: c, current: initial.Binding, state: AppServerFencedRefused}
	if err := c.Validate(); err != nil {
		return l, err
	}
	if !appServerBinding(initial.Binding, c) {
		// A crossed post-start receipt cannot prove a preflight refusal.
		if initial.Result != AppServerRefused || initial.Initialized || initial.ThreadConfirmed {
			return l.fence(AppServerFencedUnknown, AppServerLifecycleUnknown)
		}
		return l, AppServerBindingRefused
	}
	if initial.Result == AppServerRefused {
		if initial.Initialized || initial.ThreadConfirmed {
			return l.fence(AppServerFencedUnknown, AppServerLifecycleUnknown)
		}
		return l, AppServerLifecycleRefused
	}
	if initial.Result != AppServerKnown || !initial.Initialized || !initial.ThreadConfirmed || !initial.Quiescent {
		return l.fence(AppServerFencedUnknown, AppServerLifecycleUnknown)
	}
	l.state = AppServerReady
	return l, nil
}

func (l AppServerLifecycle) State() AppServerState     { return l.state }
func (l AppServerLifecycle) Binding() AppServerBinding { return l.current }

// BeginRenewal consumes an observed atomic token renewal. The old process is
// immediately ineligible for results; its environment is never changed.
func (l AppServerLifecycle) BeginRenewal(e AppServerRenewalEvidence) (AppServerLifecycle, error) {
	if l.state != AppServerReady {
		return l, AppServerLifecycleRefused
	}
	if e.Result == AppServerRefused && e.Binding == l.current && !e.AtomicCommitted &&
		e.Account == l.current.Account && e.FromGeneration == l.current.TokenGeneration && e.ToGeneration == 0 {
		return l.fence(AppServerFencedRefused, AppServerLifecycleRefused)
	}
	if e.Result != AppServerKnown || e.Binding != l.current || !e.AtomicCommitted ||
		e.Account != l.current.Account || e.FromGeneration != l.current.TokenGeneration ||
		e.ToGeneration == 0 || e.FromGeneration == ^uint64(0) || e.ToGeneration != e.FromGeneration+1 {
		return l.fence(AppServerFencedUnknown, AppServerLifecycleUnknown)
	}
	if l.renewals >= AppServerMaxRenewals || l.current.ProcessEpoch == ^uint64(0) {
		return l.fence(AppServerFencedRefused, AppServerLifecycleRefused)
	}
	l.pendingGeneration = e.ToGeneration
	l.state = AppServerStopRequired
	return l, nil
}

func (l AppServerLifecycle) ObserveStop(e AppServerStopEvidence) (AppServerLifecycle, error) {
	if l.state != AppServerStopRequired {
		return l, AppServerLifecycleRefused
	}
	if e.Binding != l.current || e.Result != AppServerKnown || !e.CleanExit || !e.OriginalJoined || e.ExitCode != 0 {
		return l.fence(AppServerFencedUnknown, AppServerLifecycleUnknown)
	}
	l.state = AppServerStartRequired
	return l, nil
}

func (l AppServerLifecycle) ObserveStart(e AppServerStartEvidence) (AppServerLifecycle, error) {
	if l.state != AppServerStartRequired {
		return l, AppServerLifecycleRefused
	}
	b := e.Binding
	if e.Result == AppServerRefused && !e.Initialized {
		return l.fence(AppServerFencedRefused, AppServerLifecycleRefused)
	}
	if e.Result != AppServerKnown || !e.Initialized || e.InitializeClientName != l.config.InitializeClientName ||
		!appServerBinding(b, l.config) || b.ProcessID == l.current.ProcessID ||
		b.ProcessEpoch != l.current.ProcessEpoch+1 || b.TokenGeneration != l.pendingGeneration ||
		b.ThreadID != l.current.ThreadID || b.Account != l.current.Account || b.Model != l.current.Model {
		return l.fence(AppServerFencedUnknown, AppServerLifecycleUnknown)
	}
	l.current = b
	l.state = AppServerResumeRequired
	return l, nil
}

func (l AppServerLifecycle) ObserveResume(e AppServerResumeEvidence) (AppServerLifecycle, error) {
	if l.state != AppServerResumeRequired {
		return l, AppServerLifecycleRefused
	}
	if e.Result != AppServerKnown || e.Binding != l.current || !e.Resumed || !e.Quiescent || e.ThreadID != l.current.ThreadID {
		return l.fence(AppServerFencedUnknown, AppServerLifecycleUnknown)
	}
	l.pendingGeneration = 0
	l.renewals++
	l.state = AppServerReady
	return l, nil
}

// AcceptCurrentEvent only correlates metadata. It grants no turn/start, task,
// shell or inference authority. Late old-process/token/account events cannot
// advance a newer epoch or satisfy missing initialize/resume evidence.
func (l AppServerLifecycle) AcceptCurrentEvent(b AppServerBinding) error {
	if l.state != AppServerReady || b != l.current {
		return AppServerStaleEvidence
	}
	return nil
}

func (l AppServerLifecycle) fence(state AppServerState, code AppServerCode) (AppServerLifecycle, error) {
	l.state = state
	return l, code
}

func appServerBinding(b AppServerBinding, c AppServerConfig) bool {
	return appServerText(b.ProcessID, 120) && appServerText(b.ThreadID, 120) &&
		b.ProcessEpoch > 0 && b.TokenGeneration > 0 && b.AppName == c.RegisteredAppName &&
		b.Account == c.Account && b.Model == c.Model
}

func appServerAccount(a inference.AccountIdentity) bool {
	return inference.ValidAccountIdentity(a)
}

func appServerModel(m inference.ModelSelection) bool {
	switch m.Effort {
	case "none", "minimal", "low", "medium", "high", "xhigh":
	default:
		return false
	}
	return appServerToken(m.Slug, 120) && appServerToken(m.Effort, 40) &&
		appServerText(m.CapabilityEvidence, 256) && m.CatalogueEpoch > 0
}

func appServerToken(s string, limit int) bool {
	return appServerText(s, limit) && strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_./-", r))
	}) < 0
}

func appServerText(s string, limit int) bool {
	return len(s) > 0 && len(s) <= limit && utf8.ValidString(s) && strings.TrimSpace(s) == s &&
		strings.IndexFunc(s, func(r rune) bool { return r < 32 || r == 127 }) < 0
}
