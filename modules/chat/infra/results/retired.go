package results

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
)

// RetiredArchive observes only fixed retired Chat children of the independently
// qualified Go profile. The active Chat result owner is never opened. It uses
// the same archive reader and original on-disk claims; no second history store,
// journal repair, ACK, or authority to resume an old operation is introduced.
type RetiredArchive struct{ profile Root }

// NewRetiredArchive performs no IO; archive availability cannot gate startup.
// Root identifies the Go profile directory, rather than its active Chat child.
func NewRetiredArchive(profile Root) *RetiredArchive { return &RetiredArchive{profile: profile} }

func retiredKey(name, key string) string {
	digest := sha256.Sum256([]byte("farol.retired-reply/1\x00" + name + "\x00" + key))
	return hex.EncodeToString(digest[:])
}

func retiredName(name string) bool {
	const prefix = "chat-retired-"
	if len(name) != len(prefix)+36 || name[:len(prefix)] != prefix {
		return false
	}
	for i, c := range name[len(prefix):] {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (a *RetiredArchive) valid(ctx context.Context, profile, owner string) bool {
	return a != nil && !nilContext(ctx) && ctx.Err() == nil && profile == a.profile.ProfileID && validID(profile) && validID(owner)
}
