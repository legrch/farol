package update

import (
	"errors"
	"sync"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

// Service owns one updater lifetime. Ports own effects; snapshots do not grant
// filesystem, provider, browser, or install authority. No background timer runs.
type Service struct {
	mu        sync.Mutex
	state     release.State
	runtime   port.Runtime
	clock     port.Clock
	drained   chan struct{}
	cancelled chan struct{}
}

func New(runtime port.Runtime, clock port.Clock) *Service {
	drained := make(chan struct{})
	close(drained)
	return &Service{runtime: runtime, clock: clock, drained: drained, cancelled: make(chan struct{})}
}

type StatusRequest struct{}
type StatusResponse struct{ View View }
type View struct {
	Phase            string
	CheckedAt        *int64
	Version          string
	Deferred         bool
	BlockedBy        string
	Code             string
	RecoveryRequired bool
	RollbackVersion  string
}

func (s *Service) Status(StatusRequest) (*StatusResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &StatusResponse{View: view(s.state.Snapshot())}, nil
}

func (s *Service) begin(start func() bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !start() {
		return false
	}
	s.drained = make(chan struct{})
	return true
}

func (s *Service) finish(change func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	change()
	close(s.drained)
}

func classified(err error, code string, uncertain bool) release.Failure {
	var known *port.Failure
	if errors.As(err, &known) && known != nil && validCode(known.Code) {
		required := uncertain
		if known.RecoveryRequired != nil {
			required = *known.RecoveryRequired
		}
		return release.Failure{Code: known.Code, RecoveryRequired: required}
	}
	return release.Failure{Code: code, RecoveryRequired: uncertain}
}

func archive(a port.Archive) release.Archive {
	return release.Archive{Handle: a.Handle, Version: a.Version, BuildID: a.BuildID, SHA256: a.SHA256}
}
func archivePort(a release.Archive) port.Archive {
	return port.Archive{Handle: a.Handle, Version: a.Version, BuildID: a.BuildID, SHA256: a.SHA256}
}

func validArchive(a *port.Archive) bool {
	if a == nil || a.Handle == "" || len(a.Handle) > 4096 || a.Version == "" || len(a.Version) > 128 {
		return false
	}
	for _, d := range []string{a.BuildID, a.SHA256} {
		if len(d) != 64 {
			return false
		}
		for _, c := range d {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return false
			}
		}
	}
	return true
}

func view(v release.Snapshot) View {
	phases := [...]string{"idle", "checking", "downloading", "ready", "applying", "recovery", "failed"}
	return View{Phase: phases[v.Phase], CheckedAt: v.CheckedAt, Version: v.Version, Deferred: v.Deferred, BlockedBy: v.BlockedBy, Code: v.Code, RecoveryRequired: v.RecoveryRequired, RollbackVersion: v.RollbackVersion}
}

func validCode(code string) bool {
	if len(code) == 0 || len(code) > 101 || code[0] < 'A' || code[0] > 'Z' {
		return false
	}
	for _, c := range code {
		if !(c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
