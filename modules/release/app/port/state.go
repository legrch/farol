package port

// StateGate protects one owning application's state transitions. Boot supplies
// a distinct implementation for each service lifetime. It is a serialization
// mechanism, never admission, provenance, a filesystem lock or a migration claim.
type StateGate interface {
	Lock()
	Unlock()
}
