package release

// Phase describes updater presentation, not native helper completion.
type Phase uint8

const (
	Idle Phase = iota
	Checking
	Downloading
	Ready
	Applying
	Recovery
	Failed
)

type Snapshot struct {
	Phase            Phase
	CheckedAt        *int64
	Version          string
	Deferred         bool
	BlockedBy        string
	Code             string
	RecoveryRequired bool
	RollbackVersion  string
}

// Archive is an opaque reference to already verified bytes. It is not authority
// to install; the native boundary must reverify bytes and acquire admission.
type Archive struct {
	Handle  string
	Version string
	BuildID string
	SHA256  string
}

type Failure struct {
	Code             string
	RecoveryRequired bool
}

type Restored struct {
	Archive         *Archive
	RollbackVersion string
	RecoveryVersion string
}

type Action uint8

const (
	Apply Action = iota + 1
	Recover
	Rollback
)

type Handoff uint8

const (
	Accepted Handoff = iota + 1
	Blocked
	Unknown
)

const RecheckMilliseconds int64 = 6 * 60 * 60 * 1000

// State has one owner. Application serialization is separate from policy.
// All times and observations are supplied; this package performs no effects.
type State struct {
	view            Snapshot
	archive         *Archive
	initialized     bool
	busy            bool
	closed          bool
	lastCheck       *int64
	rollbackVersion string
	beforeHandoff   Snapshot
}

func (s *State) Snapshot() Snapshot {
	v := s.view
	if v.CheckedAt != nil {
		t := *v.CheckedAt
		v.CheckedAt = &t
	}
	return v
}

func (s *State) BeginInitialize() bool {
	if s.initialized || s.busy || s.closed {
		return false
	}
	s.busy = true
	return true
}

func (s *State) Reconciled(r Restored, failure *Failure) {
	s.initialized, s.busy = true, false
	if failure != nil {
		s.fail(*failure)
	} else if r.RecoveryVersion != "" {
		s.view = Snapshot{Phase: Recovery, Version: r.RecoveryVersion}
	} else if r.Archive != nil {
		a := *r.Archive
		s.archive = &a
		s.view = Snapshot{Phase: Ready, Version: a.Version, Deferred: true}
	} else if r.RollbackVersion != "" {
		s.rollbackVersion = r.RollbackVersion
		s.view = Snapshot{Phase: Idle, RollbackVersion: r.RollbackVersion}
	}
}

func (s *State) BeginCheck(manual bool, now int64) bool {
	if manual && !s.closed && !s.busy && s.view.Phase == Ready && recheckableAdmissionBlock(s.view.BlockedBy) {
		s.view.BlockedBy = ""
		return false
	}
	if !s.initialized || s.closed || s.busy || s.archive != nil || s.view.Phase == Applying || s.view.Phase == Recovery || (s.view.Phase == Failed && s.view.RecoveryRequired) {
		return false
	}
	if !manual && s.lastCheck != nil && (now < *s.lastCheck || now-*s.lastCheck < RecheckMilliseconds) {
		return false
	}
	s.lastCheck = &now
	s.busy = true
	s.view = Snapshot{Phase: Checking}
	return true
}

func (s *State) DiscoveryFailed(f Failure) {
	s.fail(f)
	if !f.RecoveryRequired {
		s.view.RollbackVersion = s.rollbackVersion
	}
	s.busy = false
}

func (s *State) NoUpdate() {
	s.view = Snapshot{Phase: Idle, CheckedAt: s.lastCheck, RollbackVersion: s.rollbackVersion}
	s.busy = false
}

func (s *State) BeginDownload() bool {
	if s.closed {
		s.busy = false
		return false
	}
	s.view = Snapshot{Phase: Downloading}
	return true
}

func (s *State) DownloadFailed(f Failure) { s.fail(f); s.busy = false }

// Retained is called only after a successful durable retention. After Close the
// caller still retains completed bytes, but never advertises a new ready action.
func (s *State) Retained(a Archive) {
	s.busy = false
	if s.closed {
		return
	}
	s.archive = &a
	s.view = Snapshot{Phase: Ready, Version: a.Version}
}

func (s *State) Later() {
	if !s.closed && s.view.Phase == Ready {
		s.view.Deferred = true
	}
}

func (s *State) BeginHandoff(action Action) (Archive, bool) {
	if s.closed || s.busy {
		return Archive{}, false
	}
	var version string
	switch action {
	case Apply:
		if s.view.Phase != Ready || s.view.BlockedBy != "" || s.archive == nil {
			return Archive{}, false
		}
		version = s.archive.Version
	case Recover:
		if s.view.Phase == Recovery {
			version = s.view.Version
		}
	case Rollback:
		if s.view.Phase == Idle || (s.view.Phase == Failed && !s.view.RecoveryRequired) {
			version = s.view.RollbackVersion
		}
	}
	if version == "" {
		return Archive{}, false
	}
	s.beforeHandoff = s.Snapshot()
	s.busy = true
	s.view = Snapshot{Phase: Applying, Version: version}
	if action == Apply {
		return *s.archive, true
	}
	return Archive{}, true
}

func (s *State) HandedOff(outcome Handoff, code string) {
	s.busy = false
	switch outcome {
	case Accepted:
		// Readiness permits normal Quit, not another apply or installed success.
	case Blocked:
		s.view = s.beforeHandoff
		if s.view.Phase == Ready {
			s.view.Deferred = true
		}
		if s.view.Phase == Failed {
			s.view.Code = code
		} else {
			s.view.BlockedBy = code
		}
	default:
		if code == "" {
			code = "UPDATE_HANDOFF_UNKNOWN"
		}
		s.fail(Failure{Code: code, RecoveryRequired: true})
	}
}

func (s *State) Close() bool {
	if s.closed {
		return false
	}
	s.closed = true
	return true
}

func (s *State) fail(f Failure) {
	s.view = Snapshot{Phase: Failed, Code: f.Code, RecoveryRequired: f.RecoveryRequired}
}

// Match the active updater's closed list. Observation cannot clear an unknown
// or unclassified admission result; a later Apply still reacquires admission.
func recheckableAdmissionBlock(code string) bool {
	switch code {
	case "UPDATE_CONNECTOR_ACTIVE", "UPDATE_TASK_ROUTE_NEEDS_DRAIN", "UPDATE_BROWSER_OPEN", "UPDATE_BROWSER_BUSY", "UPDATE_BROWSER_DRAFT", "UPDATE_WORK_PENDING":
		return true
	default:
		return false
	}
}
