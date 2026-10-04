// Package process owns a real Go child and bounded retained output. It never
// looks up an old numeric PID/PGID, restores a child from disk, or reports root
// Wait as group/cohort completion. The separate fresh anchor role may signal its
// OWN current live group once; that request is not settlement evidence. Native
// qualification and product activation remain separate gates.
package process

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Command is a trusted composition input, NOT a request DTO. Its caller owns
// selected executable/confinement policy and physical root approval. Environment
// is explicit and never inherited. Output/journal values never include Command.
type Command struct {
	WorkspaceID, Root, Cwd, Executable, ExecutableSHA256 string
	RootIdentity                                         authority.RootIdentity
	Args, Environment                                    []string
	Input                                                []byte
	Write                                                bool
	Binding                                              *InvocationBinding  `json:",omitempty"`
	Confinement                                          *ConfinementBinding `json:",omitempty"`
}

// Qualification is the native policy producer selected by trusted boot. It must
// attest effective confinement of THIS immutable command (including credentials,
// network, filesystem and Git policy); a boolean/cache/request claim is not an
// implementation. Qualify is read-only current mechanism/plan evidence inspection;
// it must not dispatch this command, run a probe or reissue an uncertain operation.
// There is no default evidence producer. Native Start additionally requires the
// sealed Seatbelt producer and applies that policy at the one start attempt.
type Qualification interface {
	Qualify(context.Context, Command) error
}

type timer interface{ Stop() bool }
type schedule func(time.Duration, func()) timer
type exit struct {
	Code            *int
	Signal          int
	Waited, Drained bool
	cohort          bool
}
type owned interface {
	Wait() (exit, error)
	Kill() error
}
type boundary interface {
	Start(context.Context, Command, func(context.Context) error, io.Writer, io.Writer) (owned, error)
}

type Prepared struct {
	mutex     sync.Mutex
	command   Command
	seal      processsvc.Seal
	boundary  boundary
	clock     port.Clock
	schedule  schedule
	attempted bool
	execution context.Context
	retained  *Child
}

var _ processsvc.Prepared = (*Prepared)(nil)

// New constructs no OS process. The real os/exec boundary is used only by Spawn;
// its required native qualification remains fail closed when unavailable.
func New(command Command, qualification Qualification, clock port.Clock) (*Prepared, error) {
	if qualification == nil {
		return nil, &processsvc.NativeFailure{}
	}
	if selected, ok := qualification.(*Seatbelt); ok {
		if selected == nil {
			return nil, &processsvc.NativeFailure{}
		}
		var err error
		command, err = selected.bind(command)
		if err != nil {
			return nil, err
		}
	}
	return newPrepared(command, nativeBoundary{qualification}, clock, func(d time.Duration, f func()) timer { return time.AfterFunc(d, f) })
}
func copyCommand(c Command) Command {
	c.Args = append([]string(nil), c.Args...)
	c.Environment = append([]string{}, c.Environment...)
	c.Input = append([]byte(nil), c.Input...)
	if c.Binding != nil {
		binding := *c.Binding
		c.Binding = &binding
	}
	if c.Confinement != nil {
		binding := *c.Confinement
		c.Confinement = &binding
	}
	return c
}
func newPrepared(command Command, native boundary, clock port.Clock, scheduler schedule) (*Prepared, error) {
	if native == nil || clock == nil || scheduler == nil || !validCommand(command) {
		return nil, &processsvc.NativeFailure{}
	}
	command = copyCommand(command)
	encoded, err := json.Marshal(command)
	if err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	digest := sha256.Sum256(encoded)
	seal := processsvc.Seal{Digest: hex.EncodeToString(digest[:]), WorkspaceID: command.WorkspaceID, Root: command.Root, Cwd: command.Cwd, RootIdentity: command.RootIdentity, Write: command.Write}
	return &Prepared{command: command, seal: seal, boundary: native, clock: clock, schedule: scheduler}, nil
}
func validCommand(c Command) bool {
	plain := func(v string) bool {
		return filepath.IsAbs(v) && filepath.Clean(v) == v && len(v) <= 4096 && !strings.ContainsRune(v, 0)
	}
	if c.WorkspaceID == "" || !plain(c.Root) || !plain(c.Cwd) || !plain(c.Executable) || !(c.Cwd == c.Root || strings.HasPrefix(c.Cwd, strings.TrimSuffix(c.Root, "/")+"/")) || c.RootIdentity.Device == "" || c.RootIdentity.Inode == "" || len(c.Args) > 256 || len(c.Environment) > 64 || len(c.Input) > 1024*1024 {
		return false
	}
	if c.Binding != nil && (!bindingID(c.Binding.RuntimeID) || !bindingID(c.Binding.SessionID) || !bindingID(c.Binding.ModelID) || !bindingID(c.Binding.AdmissionID)) {
		return false
	}
	raw, err := hex.DecodeString(c.ExecutableSHA256)
	if err != nil || len(raw) != sha256.Size || strings.ToLower(c.ExecutableSHA256) != c.ExecutableSHA256 {
		return false
	}
	bytes := 0
	for _, arg := range c.Args {
		if strings.ContainsRune(arg, 0) {
			return false
		}
		bytes += len(arg)
	}
	names := map[string]bool{}
	for _, entry := range c.Environment {
		name, _, found := strings.Cut(entry, "=")
		if !found || name == "" || names[name] || strings.ContainsRune(entry, 0) {
			return false
		}
		for i, ch := range name {
			if !(ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch == '_' || i > 0 && ch >= '0' && ch <= '9') {
				return false
			}
		}
		names[name] = true
		bytes += len(entry)
	}
	return bytes <= 64*1024
}
func (p *Prepared) Seal() processsvc.Seal { return p.seal }
func (p *Prepared) Spawn(ctx context.Context, request processsvc.SpawnRequest) (processsvc.Child, error) {
	p.mutex.Lock()
	if p.attempted {
		p.mutex.Unlock()
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	p.attempted = true
	p.mutex.Unlock()
	if ctx == nil || ctx.Err() != nil || request.Check == nil || !p.clock.Now().Before(request.Deadline) {
		return nil, &processsvc.NativeFailure{}
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	child := &Child{handle: "process-" + hex.EncodeToString(raw[:]), root: processsvc.RootRunning, group: processsvc.CleanupPending, descendants: processsvc.CleanupPending, done: make(chan struct{})}
	execution := ctx
	if p.execution != nil {
		execution = p.execution
	}
	var root owned
	var err error
	if leased, ok := p.boundary.(leaseBoundary); ok {
		root, err = leased.StartLease(ctx, copyCommand(p.command), request, output{child, false}, output{child, true})
	} else {
		root, err = p.boundary.Start(ctx, copyCommand(p.command), request.Check, output{child, false}, output{child, true})
	}
	if root != nil {
		p.mutex.Lock()
		p.retained = child
		p.mutex.Unlock()
	}
	if root == nil {
		var native *processsvc.NativeFailure
		if errors.As(err, &native) {
			return nil, native
		}
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	startErr := err
	child.mutex.Lock()
	child.process = root
	limit := child.outputLimit
	child.mutex.Unlock()
	go child.wait()
	deadline := p.schedule(request.Deadline.Sub(p.clock.Now()), func() { child.stop(true) })
	child.mutex.Lock()
	child.deadline = deadline
	finished := child.finished
	child.mutex.Unlock()
	if finished && deadline != nil {
		deadline.Stop()
	}
	// Cancellation of the selected execution owner is a stop REQUEST only.
	// The legacy direct boundary still uses its caller as that owner.
	go func() {
		select {
		case <-execution.Done():
			child.stop(false)
		case <-child.done:
		}
	}()
	child.watchCurrent(execution, request.Check, p.schedule)
	if limit {
		child.stop(false)
	}
	if startErr != nil {
		// The exact possible-start resource remains retained and owns wait/stop.
		// It cannot become a successful Start or another spawn on observation.
		child.stop(false)
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	return child, nil
}

// A refusal/unknown owner observation stops this watch permanently. Cleanup is
// one signal request on the already owned child, never another dispatch/renewal.
func (c *Child) watchCurrent(ctx context.Context, check func(context.Context) error, scheduler schedule) {
	c.mutex.Lock()
	done := c.finished || c.signalAttempted
	c.mutex.Unlock()
	if done {
		return
	}
	watch := scheduler(100*time.Millisecond, func() {
		c.mutex.Lock()
		done := c.finished || c.signalAttempted
		c.mutex.Unlock()
		if done {
			return
		}
		if check(ctx) != nil {
			c.mutex.Lock()
			c.authorityLost = true
			c.mutex.Unlock()
			c.stop(false)
			return
		}
		c.watchCurrent(ctx, check, scheduler)
	})
	c.mutex.Lock()
	c.watch = watch
	done = c.finished || c.signalAttempted
	c.mutex.Unlock()
	if done && watch != nil {
		watch.Stop()
	}
}
