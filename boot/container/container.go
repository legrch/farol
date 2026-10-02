package container

import "github.com/legrch/farol/transport/desktop"

// New composes concrete transport adapters; application code never looks up services.
func New(buildID, profileID, generation string, methods map[string]desktop.Method) (*desktop.Server, error) {
	return desktop.New(desktop.Config{BuildID: buildID, ProfileID: profileID, Generation: generation, Methods: methods})
}
