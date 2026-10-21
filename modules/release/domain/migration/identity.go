// Package migration defines the one-time current-alpha profile relocation policy.
// It has no filesystem, process, browser, journal, or transport dependencies.
package migration

type Profile string

const (
	Production  Profile = "production"
	Development Profile = "dev"
)

// Identity values are explicit storage contracts, never derived from a display name.
type Identity struct {
	Name      string
	Bundle    string
	Directory string
	Partition string
}

func FinalIdentity(profile Profile) (Identity, error) {
	switch profile {
	case Production:
		return Identity{"Farol", "io.github.legrch.farol", "io.github.legrch.farol", "persist:farol-app-chatgpt"}, nil
	case Development:
		return Identity{"Farol Dev", "io.github.legrch.farol.dev", "Farol Dev", "persist:farol-dev"}, nil
	default:
		return Identity{}, InvalidProfile
	}
}

// These values are migration readers only. No new runtime consumes them.
const AlphaDirectory = "Farol Next Preview"
const AlphaBundle = "local.farol.next.preview"
