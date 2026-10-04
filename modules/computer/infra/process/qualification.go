package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// NativeFixture is trusted root composition input for a NEW disposable native
// lane, never a request/approval DTO or general qualification certificate. Root
// must independently measure readable/writable baselines and live controlled
// listeners BEFORE launching the same-profile confined Farol witness role.
// Every path is synthetic; no real credential store or external endpoint is used.
type NativeFixture struct {
	Nonce                                                               string
	AllowedRead, AllowedSHA256                                          string
	OutsideRead, CredentialRead, AliasRead, HardlinkRead, ReadOnlyWrite string
	Loopback4, Loopback6                                                string
}
type nativeProbe interface {
	Allowed(context.Context, string, string) error
	DeniedRead(context.Context, string) error
	DeniedWrite(context.Context, string) error
	DeniedConnect(context.Context, string) error
	CurrentProcess() int
}

// NativeQualification is produced only by the one-shot native conformance run
// in its exact confined process. Its scope is the exact disposable command,
// profile and original lease deadline, not production/provider eligibility.
// Missing vectors, host refusal, readable alias/hardlink or wrong process refuse.
// It cannot be fabricated from public receipts or restored across a restart.
type NativeQualification struct {
	commandDigest, originalDigest string
	process                       int
	deadline                      time.Time
	clock                         port.Clock
	probe                         nativeProbe
	dispatch                      *qualificationDispatch
}

type qualificationDispatch struct {
	mutex     sync.Mutex
	attempted bool
}

// QualificationAttempt owns ONE conformance attempt. It is not a task/journal
// engine. A failed/unknown attempt never resumes, retries or switches executor.
type QualificationAttempt struct {
	mutex     sync.Mutex
	attempted bool
	probe     nativeProbe
	clock     port.Clock
}

func NewQualificationAttempt(clock port.Clock) (*QualificationAttempt, error) {
	if clock == nil {
		return nil, &processsvc.NativeFailure{}
	}
	return &QualificationAttempt{probe: systemProbe{}, clock: clock}, nil
}

// Run belongs inside the exact held Farol guest, AFTER Seatbelt was applied and
// BEFORE user-command release. It performs real synthetic file/connect attempts,
// so only the separately authorized fresh native lane may call it. Root owns
// existing transport/frame/build identity and baseline receipts. A PASS certifies
// only these vectors on this exact disposable invocation; it is not evidence for
// untested aliases, arbitrary roots/commands, browser/Node or networked providers.
func (a *QualificationAttempt) Run(ctx context.Context, original, wrapped Command, fixture NativeFixture, deadline time.Time) (*NativeQualification, error) {
	a.mutex.Lock()
	if a.attempted {
		a.mutex.Unlock()
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	a.attempted = true
	a.mutex.Unlock()
	if ctx == nil || ctx.Err() != nil || a.probe == nil || a.clock == nil || !validFixture(wrapped, fixture) || !sameWrappedGuest(original, wrapped) ||
		!a.clock.Now().Before(deadline) || deadline.After(a.clock.Now().Add(15*time.Second)) {
		return nil, &processsvc.NativeFailure{}
	}
	bounded, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	current := func() bool { return bounded.Err() == nil && a.clock.Now().Before(deadline) }
	if !current() || a.probe.Allowed(bounded, fixture.AllowedRead, fixture.AllowedSHA256) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	for _, path := range []string{fixture.OutsideRead, fixture.CredentialRead, fixture.AliasRead, fixture.HardlinkRead} {
		if !current() || a.probe.DeniedRead(bounded, path) != nil {
			return nil, &processsvc.NativeFailure{}
		}
	}
	if !current() || a.probe.DeniedWrite(bounded, fixture.ReadOnlyWrite) != nil {
		return nil, &processsvc.NativeFailure{}
	}
	for _, endpoint := range []string{fixture.Loopback4, fixture.Loopback6} {
		if !current() || a.probe.DeniedConnect(bounded, endpoint) != nil {
			return nil, &processsvc.NativeFailure{}
		}
	}
	pid := a.probe.CurrentProcess()
	if bounded.Err() != nil || !a.clock.Now().Before(deadline) || pid <= 0 {
		return nil, &processsvc.NativeFailure{}
	}
	digest, err := nativeCommandDigest(wrapped)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	origin, err := nativeCommandDigest(original)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	return &NativeQualification{originalDigest: origin, commandDigest: digest, process: pid, deadline: deadline, clock: a.clock, probe: a.probe, dispatch: &qualificationDispatch{}}, nil
}
func nativeCommandDigest(command Command) (string, error) {
	encoded, err := json.Marshal(command)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
func (q *NativeQualification) Qualify(ctx context.Context, command Command) error {
	if q == nil || ctx == nil || ctx.Err() != nil || q.clock == nil || q.probe == nil || !q.clock.Now().Before(q.deadline) || q.probe.CurrentProcess() != q.process {
		return &processsvc.NativeFailure{}
	}
	digest, err := nativeCommandDigest(command)
	if err != nil || digest != q.commandDigest {
		return &processsvc.NativeFailure{}
	}
	return nil
}

func fixtureRoot(path string) bool {
	return filepath.Dir(path) == "/private/tmp" && len(filepath.Base(path)) > len("farol-") && filepath.Base(path)[:len("farol-")] == "farol-"
}
func validFixture(command Command, f NativeFixture) bool {
	if command.Executable != seatbeltExecutable || !digestValue(command.ExecutableSHA256) || command.Confinement == nil || !digestValue(command.Confinement.ProfileSHA256) ||
		command.Confinement.MechanismSHA256 != command.ExecutableSHA256 || command.Binding == nil || !validCommand(command) || command.Write || !fixtureRoot(command.Root) ||
		len(f.Nonce) != 32 || !digestValue(f.AllowedSHA256) {
		return false
	}
	if _, err := hex.DecodeString(f.Nonce); err != nil {
		return false
	}
	seen := map[string]bool{}
	for _, path := range []string{f.AllowedRead, f.OutsideRead, f.CredentialRead, f.AliasRead, f.HardlinkRead, f.ReadOnlyWrite} {
		if !absolutePolicyPath(path) || seen[path] {
			return false
		}
		seen[path] = true
	}
	if !insidePolicy(command.Root, f.AllowedRead) || !insidePolicy(command.Root, f.CredentialRead) || !insidePolicy(command.Root, f.AliasRead) ||
		!insidePolicy(command.Root, f.HardlinkRead) || !insidePolicy(command.Root, f.ReadOnlyWrite) || insidePolicy(command.Root, f.OutsideRead) {
		return false
	}
	return controlledEndpoint(f.Loopback4, false) && controlledEndpoint(f.Loopback6, true)
}
func controlledEndpoint(address string, ipv6 bool) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil || (ipv6 && host != "::1") || (!ipv6 && host != "127.0.0.1") {
		return false
	}
	value, err := strconv.Atoi(port)
	return err == nil && value > 0 && value <= 65535 && strconv.Itoa(value) == port
}

var _ Qualification = (*NativeQualification)(nil)

func sameWrappedGuest(original, wrapped Command) bool {
	if !validCommand(original) || !validCommand(wrapped) || original.Binding == nil || wrapped.Binding == nil || original.Confinement == nil || wrapped.Confinement == nil ||
		*original.Binding != *wrapped.Binding || *original.Confinement != *wrapped.Confinement || original.Root != wrapped.Root || original.RootIdentity != wrapped.RootIdentity || original.Cwd != wrapped.Cwd ||
		original.WorkspaceID != wrapped.WorkspaceID || original.Write != wrapped.Write || wrapped.Executable != seatbeltExecutable || wrapped.ExecutableSHA256 != original.Confinement.MechanismSHA256 {
		return false
	}
	index := len(wrapped.Args) - len(original.Args) - 1
	return index > 0 && wrapped.Args[index-1] == "--" && wrapped.Args[index] == original.Executable && slices.Equal(wrapped.Args[index+1:], original.Args) &&
		slices.Equal(wrapped.Environment, original.Environment) && bytes.Equal(wrapped.Input, original.Input)
}
func (q *NativeQualification) matchesGuest(command Command) bool {
	digest, err := nativeCommandDigest(command)
	return q != nil && err == nil && digest == q.originalDigest
}

// claimExec owns only this proof's one held-role dispatch, not authority or a new
// execution lease. Copies share its attempt state. Refusal/unknown cannot reset it.
func (q *NativeQualification) claimExec(original, wrapped Command, deadline time.Time) error {
	if q == nil || q.dispatch == nil {
		return &processsvc.NativeFailure{}
	}
	q.dispatch.mutex.Lock()
	defer q.dispatch.mutex.Unlock()
	if q.dispatch.attempted {
		return &processsvc.NativeFailure{Unknown: true}
	}
	q.dispatch.attempted = true
	if !sameWrappedGuest(original, wrapped) || !q.matchesGuest(original) || !q.deadline.Equal(deadline) {
		return &processsvc.NativeFailure{}
	}
	return nil
}
