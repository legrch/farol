package port

import observation "github.com/legrch/farol/modules/computer/domain/observation"

// MigrationGate serializes one coordinator; trusted composition owns the lock.
type MigrationGate interface {
	Lock()
	Unlock()
}

// ObservationDigester hashes the exact immutable native observation projection.
// Implementations cannot create or replace the observation's authority.
type ObservationDigester interface {
	Digest(observation.Observation) (string, error)
}
