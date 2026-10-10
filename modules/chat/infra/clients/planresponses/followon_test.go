package planresponses

import (
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

// These are inert policy vectors. They launch no Codex process, use no token,
// and do not qualify SIWC registration, a native process, or provider resume.
func appServerFixture() (AppServerConfig, AppServerBinding) {
	a := inference.AccountIdentity{Issuer: "https://auth.openai.com", Subject: "fixture-subject", ClientID: "fixture-client", HostID: "urn:uuid:11111111-1111-4111-8111-111111111111", Epoch: 4}
	m := inference.ModelSelection{Slug: "fixture-model", Effort: "high", CapabilityEvidence: "fixture-capability", CatalogueEpoch: 7}
	c := AppServerConfig{
		Provider: "openai_chatgpt_plan", ProviderName: "ChatGPT plan", Resource: inference.PublicResource,
		Listen: "stdio://", WireAPI: "responses", EnvKey: "ACCESS_TOKEN",
		RegisteredAppName: "fixture-registered-app", AgentNameHint: "fixture-registered-app", InitializeClientName: "fixture-registered-app",
		Account: a, Model: m, Capability: AppServerCapability{Account: a, Model: m, ModelSupported: true, EffortSupported: true},
	}
	b := AppServerBinding{ProcessID: "original-process-handle", ProcessEpoch: 2, TokenGeneration: 3, ThreadID: "retained-thread", AppName: c.RegisteredAppName, Account: a, Model: m}
	return c, b
}

func appServerReady(t *testing.T) AppServerLifecycle {
	t.Helper()
	c, b := appServerFixture()
	l, err := NewAppServerLifecycle(c, AppServerInitialEvidence{Binding: b, Result: AppServerKnown, Initialized: true, ThreadConfirmed: true, Quiescent: true})
	if err != nil || l.State() != AppServerReady {
		t.Fatalf("original receipt: %s %v", l.State(), err)
	}
	return l
}

func appServerRenewal(l AppServerLifecycle) AppServerRenewalEvidence {
	b := l.Binding()
	return AppServerRenewalEvidence{Binding: b, Result: AppServerKnown, AtomicCommitted: true, Account: b.Account, FromGeneration: b.TokenGeneration, ToGeneration: b.TokenGeneration + 1}
}

func appServerStop(l AppServerLifecycle) AppServerStopEvidence {
	return AppServerStopEvidence{Binding: l.Binding(), Result: AppServerKnown, CleanExit: true, OriginalJoined: true}
}

func appServerStart(l AppServerLifecycle) AppServerStartEvidence {
	b := l.Binding()
	b.ProcessID = "new-process-handle"
	b.ProcessEpoch++
	b.TokenGeneration++
	return AppServerStartEvidence{Binding: b, Result: AppServerKnown, Initialized: true, InitializeClientName: b.AppName}
}

func TestAppServerConfigRestrictsPlanPreview(t *testing.T) {
	c, _ := appServerFixture()
	args, err := c.Arguments()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"app-server", "--listen", "stdio://", "-c", `model_provider="openai_chatgpt_plan"`,
		"-c", `model_providers.openai_chatgpt_plan={name="ChatGPT plan",base_url="https://api.openai.com/v1",env_key="ACCESS_TOKEN",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
		"-c", `model="fixture-model"`, "-c", `model_reasoning_effort="high"`,
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("configuration args: %q", args)
	}
	args[0] = "changed"
	again, err := c.Arguments()
	if err != nil || again[0] != "app-server" {
		t.Fatal("arguments were not detached")
	}
	if strings.Contains(strings.Join(again, " "), c.RegisteredAppName) {
		t.Fatal("initialization identity belongs to initialize, not launch arguments")
	}
	cases := map[string]func(*AppServerConfig){
		"backend-api":            func(c *AppServerConfig) { c.Resource = "https://chatgpt.com/backend-api" },
		"public-resource-suffix": func(c *AppServerConfig) { c.Resource += "/" },
		"websocket":              func(c *AppServerConfig) { c.SupportsWebSockets = true },
		"native-auth":            func(c *AppServerConfig) { c.RequiresOpenAIAuth = true },
		"alternate-env-key":      func(c *AppServerConfig) { c.EnvKey = "OPENAI_API_KEY" },
		"env-value":              func(c *AppServerConfig) { c.EnvKey = "fixture-secret-value" },
		"alternate-listen":       func(c *AppServerConfig) { c.Listen = "ws://fixture.invalid" },
		"wire":                   func(c *AppServerConfig) { c.WireAPI = "chat" },
		"provider":               func(c *AppServerConfig) { c.Provider = "openai" },
		"provider-name":          func(c *AppServerConfig) { c.ProviderName = "Other plan" },
		"request-retries":        func(c *AppServerConfig) { c.RequestMaxRetries = 1 },
		"stream-retries":         func(c *AppServerConfig) { c.StreamMaxRetries = 1 },
		"unregistered-app":       func(c *AppServerConfig) { c.RegisteredAppName = "" },
		"wrong-agent-hint":       func(c *AppServerConfig) { c.AgentNameHint = "different-app" },
		"wrong-initialize-name":  func(c *AppServerConfig) { c.InitializeClientName = "different-app" },
		"invalid-app": func(c *AppServerConfig) {
			c.RegisteredAppName = "bad\nname"
			c.AgentNameHint = c.RegisteredAppName
			c.InitializeClientName = c.RegisteredAppName
		},
		"unproved-model":             func(c *AppServerConfig) { c.Capability.ModelSupported = false },
		"unproved-effort":            func(c *AppServerConfig) { c.Capability.EffortSupported = false },
		"missing-effort":             func(c *AppServerConfig) { c.Model.Effort = ""; c.Capability.Model = c.Model },
		"missing-model-evidence":     func(c *AppServerConfig) { c.Model.CapabilityEvidence = ""; c.Capability.Model = c.Model },
		"unknown-catalogue-epoch":    func(c *AppServerConfig) { c.Model.CatalogueEpoch = 0; c.Capability.Model = c.Model },
		"crossed-capability-account": func(c *AppServerConfig) { c.Capability.Account.Epoch++ },
		"crossed-capability-model":   func(c *AppServerConfig) { c.Capability.Model.Effort = "low" },
		"missing-account-epoch":      func(c *AppServerConfig) { c.Account.Epoch = 0; c.Capability.Account = c.Account },
		"non-SIWC-issuer": func(c *AppServerConfig) {
			c.Account.Issuer = "https://fixture.invalid"
			c.Capability.Account = c.Account
		},
		"unissued-client": func(c *AppServerConfig) {
			c.Account.ClientID = "dynamic_agent_client"
			c.Capability.Account = c.Account
		},
		"unsupported-host":   func(c *AppServerConfig) { c.Account.HostID = "fixture-host"; c.Capability.Account = c.Account },
		"empty-host-suffix":  func(c *AppServerConfig) { c.Account.HostID = "did:key:"; c.Capability.Account = c.Account },
		"unsupported-effort": func(c *AppServerConfig) { c.Model.Effort = "arbitrary"; c.Capability.Model = c.Model },
		"injected-model":     func(c *AppServerConfig) { c.Model.Slug = "model\" -c bad=true"; c.Capability.Model = c.Model },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			changed := c
			mutate(&changed)
			if changed.Validate() != AppServerConfigRefused {
				t.Fatal("invalid preview configuration accepted")
			}
			if args, err := changed.Arguments(); args != nil || err != AppServerConfigRefused {
				t.Fatal("refused configuration produced arguments")
			}
		})
	}
}

func TestAppServerInitialIdentityAndUncertainty(t *testing.T) {
	c, b := appServerFixture()
	for _, mutate := range []func(*AppServerBinding){
		func(b *AppServerBinding) { b.AppName = "other-app" },
		func(b *AppServerBinding) { b.Account.Epoch++ },
		func(b *AppServerBinding) { b.Model.Effort = "low" },
		func(b *AppServerBinding) { b.ProcessEpoch = 0 },
		func(b *AppServerBinding) { b.TokenGeneration = 0 },
		func(b *AppServerBinding) { b.ThreadID = "" },
	} {
		crossed := b
		mutate(&crossed)
		l, err := NewAppServerLifecycle(c, AppServerInitialEvidence{Binding: crossed, Result: AppServerKnown, Initialized: true, ThreadConfirmed: true, Quiescent: true})
		if err != AppServerLifecycleUnknown || l.State() != AppServerFencedUnknown {
			t.Fatal("crossed post-start binding accepted or downgraded to refusal")
		}
	}
	for _, initial := range []AppServerInitialEvidence{
		{Binding: b, Result: AppServerUnknown, Initialized: true, ThreadConfirmed: true, Quiescent: true},
		{Binding: b, Result: AppServerRefused, Initialized: true},
		{Binding: b, Result: AppServerKnown, ThreadConfirmed: true, Quiescent: true},
		{Binding: b, Result: AppServerKnown, Initialized: true, Quiescent: true},
		{Binding: b, Result: AppServerKnown, Initialized: true, ThreadConfirmed: true},
	} {
		l, err := NewAppServerLifecycle(c, initial)
		if err != AppServerLifecycleUnknown || l.State() != AppServerFencedUnknown || l.AcceptCurrentEvent(b) == nil {
			t.Fatal("uncertain/pending original process accepted")
		}
	}
}

func TestAppServerSyntheticRenewStopInitializeSameThreadResume(t *testing.T) {
	original := appServerReady(t)
	l, err := original.BeginRenewal(appServerRenewal(original))
	if err != nil || l.State() != AppServerStopRequired || original.State() != AppServerReady {
		t.Fatal("renewal did not produce an immutable stop requirement")
	}
	if l.AcceptCurrentEvent(original.Binding()) != AppServerStaleEvidence {
		t.Fatal("old token event accepted after renewal")
	}
	if next, err := l.ObserveStart(appServerStart(l)); err == nil || next.State() != AppServerStopRequired {
		t.Fatal("new process accepted before original stop proof")
	}
	l, err = l.ObserveStop(appServerStop(l))
	if err != nil || l.State() != AppServerStartRequired {
		t.Fatal("clean original stop not retained")
	}
	l, err = l.ObserveStart(appServerStart(l))
	if err != nil || l.State() != AppServerResumeRequired {
		t.Fatal("new initialize did not require resume")
	}
	if l.AcceptCurrentEvent(l.Binding()) == nil {
		t.Fatal("initialized process treated as resumed")
	}
	l, err = l.ObserveResume(AppServerResumeEvidence{Binding: l.Binding(), Result: AppServerKnown, Resumed: true, Quiescent: true, ThreadID: original.Binding().ThreadID})
	if err != nil || l.State() != AppServerReady || l.AcceptCurrentEvent(l.Binding()) != nil || l.AcceptCurrentEvent(original.Binding()) == nil {
		t.Fatalf("same-thread resumed epoch: %s %v", l.State(), err)
	}
	if l.Binding().ThreadID != original.Binding().ThreadID || l.Binding().Account != original.Binding().Account || l.Binding().Model != original.Binding().Model {
		t.Fatal("renewal changed retained selection")
	}
}

func TestAppServerUncertainRefreshCannotRestartOrReplay(t *testing.T) {
	cases := map[string]func(*AppServerRenewalEvidence){
		"lost-reply":            func(e *AppServerRenewalEvidence) { e.Result = AppServerUnknown },
		"store-commit-unknown":  func(e *AppServerRenewalEvidence) { e.AtomicCommitted = false },
		"account-switch":        func(e *AppServerRenewalEvidence) { e.Account.Epoch++ },
		"wrong-original":        func(e *AppServerRenewalEvidence) { e.Binding.ProcessID = "other-original" },
		"generation-gap":        func(e *AppServerRenewalEvidence) { e.ToGeneration++ },
		"late-generation":       func(e *AppServerRenewalEvidence) { e.FromGeneration--; e.ToGeneration-- },
		"contradictory-refusal": func(e *AppServerRenewalEvidence) { e.Result = AppServerRefused },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			original := appServerReady(t)
			e := appServerRenewal(original)
			mutate(&e)
			l, err := original.BeginRenewal(e)
			if err != AppServerLifecycleUnknown || l.State() != AppServerFencedUnknown {
				t.Fatal("uncertain credential rotation accepted")
			}
			if l, err = l.BeginRenewal(appServerRenewal(original)); err == nil || l.State() != AppServerFencedUnknown {
				t.Fatal("refresh replay unsealed unknown")
			}
			if l, err = l.ObserveStop(appServerStop(original)); err == nil || l.State() != AppServerFencedUnknown {
				t.Fatal("late stop unsealed unknown")
			}
			if l, err = l.ObserveStart(appServerStart(original)); err == nil || l.State() != AppServerFencedUnknown {
				t.Fatal("new provider process unsealed unknown")
			}
		})
	}
}

func TestAppServerUnknownOrCrossedStopCannotStart(t *testing.T) {
	cases := map[string]func(*AppServerStopEvidence){
		"unknown":               func(e *AppServerStopEvidence) { e.Result = AppServerUnknown },
		"signal-refused":        func(e *AppServerStopEvidence) { e.Result = AppServerRefused },
		"missing-clean-exit":    func(e *AppServerStopEvidence) { e.CleanExit = false },
		"missing-original-join": func(e *AppServerStopEvidence) { e.OriginalJoined = false },
		"nonzero-exit":          func(e *AppServerStopEvidence) { e.ExitCode = 1 },
		"other-process":         func(e *AppServerStopEvidence) { e.Binding.ProcessID = "wrong-process" },
		"old-token":             func(e *AppServerStopEvidence) { e.Binding.TokenGeneration-- },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			l := appServerReady(t)
			l, _ = l.BeginRenewal(appServerRenewal(l))
			e := appServerStop(l)
			mutate(&e)
			l, err := l.ObserveStop(e)
			if err != AppServerLifecycleUnknown || l.State() != AppServerFencedUnknown {
				t.Fatal("unproved original stop accepted")
			}
			if late, err := l.ObserveStop(appServerStop(l)); err == nil || late.State() != AppServerFencedUnknown {
				t.Fatal("late exit erased original unknown")
			}
			if next, err := l.ObserveStart(appServerStart(l)); err == nil || next.State() != AppServerFencedUnknown {
				t.Fatal("unproved stop authorized new process")
			}
		})
	}
}

func TestAppServerUnknownStartOrMissingResumeCannotAuthorizeEvents(t *testing.T) {
	readyForStart := func() AppServerLifecycle {
		l := appServerReady(t)
		l, _ = l.BeginRenewal(appServerRenewal(l))
		l, _ = l.ObserveStop(appServerStop(l))
		return l
	}
	for name, mutate := range map[string]func(*AppServerStartEvidence){
		"unknown-start":         func(e *AppServerStartEvidence) { e.Result = AppServerUnknown },
		"contradictory-refusal": func(e *AppServerStartEvidence) { e.Result = AppServerRefused },
		"missing-initialize":    func(e *AppServerStartEvidence) { e.Initialized = false },
		"wrong-app-initialize":  func(e *AppServerStartEvidence) { e.InitializeClientName = "other-app" },
		"same-process":          func(e *AppServerStartEvidence) { e.Binding.ProcessID = "original-process-handle" },
		"old-process-epoch":     func(e *AppServerStartEvidence) { e.Binding.ProcessEpoch-- },
		"old-token-epoch":       func(e *AppServerStartEvidence) { e.Binding.TokenGeneration-- },
		"different-thread":      func(e *AppServerStartEvidence) { e.Binding.ThreadID = "replacement-thread" },
		"different-account":     func(e *AppServerStartEvidence) { e.Binding.Account.Subject = "other-account" },
		"different-model":       func(e *AppServerStartEvidence) { e.Binding.Model.Slug = "other-model" },
	} {
		t.Run(name, func(t *testing.T) {
			l := readyForStart()
			e := appServerStart(l)
			mutate(&e)
			l, err := l.ObserveStart(e)
			if err != AppServerLifecycleUnknown || l.State() != AppServerFencedUnknown {
				t.Fatal("uncertain/crossed new process accepted")
			}
			if next, err := l.ObserveStart(appServerStart(l)); err == nil || next.State() != AppServerFencedUnknown {
				t.Fatal("second start erased unknown")
			}
		})
	}
	for name, mutate := range map[string]func(*AppServerResumeEvidence){
		"unknown-resume":    func(e *AppServerResumeEvidence) { e.Result = AppServerUnknown },
		"missing-resume":    func(e *AppServerResumeEvidence) { e.Resumed = false },
		"pending-operation": func(e *AppServerResumeEvidence) { e.Quiescent = false },
		"different-thread":  func(e *AppServerResumeEvidence) { e.ThreadID = "replacement-thread" },
		"late-old-epoch":    func(e *AppServerResumeEvidence) { e.Binding.TokenGeneration-- },
	} {
		t.Run(name, func(t *testing.T) {
			l := readyForStart()
			l, _ = l.ObserveStart(appServerStart(l))
			e := AppServerResumeEvidence{Binding: l.Binding(), Result: AppServerKnown, Resumed: true, Quiescent: true, ThreadID: l.Binding().ThreadID}
			mutate(&e)
			l, err := l.ObserveResume(e)
			if err != AppServerLifecycleUnknown || l.State() != AppServerFencedUnknown || l.AcceptCurrentEvent(l.Binding()) == nil {
				t.Fatal("unproved same-thread resume accepted")
			}
		})
	}
}

func TestAppServerRefusedAndBoundedLifetimeCannotReplay(t *testing.T) {
	l := appServerReady(t)
	e := appServerRenewal(l)
	e.Result = AppServerRefused
	e.AtomicCommitted = false
	e.ToGeneration = 0
	l, err := l.BeginRenewal(e)
	if err != AppServerLifecycleRefused || l.State() != AppServerFencedRefused {
		t.Fatal("known refresh refusal lost")
	}
	if next, err := l.BeginRenewal(e); err == nil || next.State() != AppServerFencedRefused {
		t.Fatal("refused refresh replayed")
	}
	l = appServerReady(t)
	l, _ = l.BeginRenewal(appServerRenewal(l))
	l, _ = l.ObserveStop(appServerStop(l))
	start := appServerStart(l)
	start.Result = AppServerRefused
	start.Initialized = false
	l, err = l.ObserveStart(start)
	if err != AppServerLifecycleRefused || l.State() != AppServerFencedRefused {
		t.Fatal("known start refusal lost")
	}
	if next, err := l.ObserveStart(start); err == nil || next.State() != AppServerFencedRefused {
		t.Fatal("refused start replayed")
	}
	l = appServerReady(t)
	l.renewals = AppServerMaxRenewals
	if next, err := l.BeginRenewal(appServerRenewal(l)); err != AppServerLifecycleRefused || next.State() != AppServerFencedRefused {
		t.Fatal("renewal bound not enforced")
	}
	l = appServerReady(t)
	l.current.TokenGeneration = ^uint64(0)
	if next, err := l.BeginRenewal(appServerRenewal(l)); err != AppServerLifecycleUnknown || next.State() != AppServerFencedUnknown {
		t.Fatal("token generation wrapped")
	}
}
