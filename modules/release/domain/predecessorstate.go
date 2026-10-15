package release

import "strings"

// PredecessorStateUnqualified is the existing helper's narrow refusal predicate
// for measured app versions. False makes no general state compatibility claim.
func PredecessorStateUnqualified(sourceVersion, targetVersion string) bool {
	stateReader := func(v string) bool {
		return len(v) == len("0.2.0-owner.beta.1") && strings.HasPrefix(v, "0.2.0-owner.beta.") && v[len(v)-1] >= '1' && v[len(v)-1] <= '9'
	}
	processReader := func(v string) bool {
		return stateReader(v) || v == "0.2.0-owner.beta.10" || v == "0.2.0-owner.beta.11"
	}
	return strings.HasPrefix(sourceVersion, "0.1.") && !strings.HasPrefix(targetVersion, "0.1.") ||
		sourceVersion == "0.2.0-owner.beta.3" ||
		stateReader(sourceVersion) && !stateReader(targetVersion) ||
		processReader(sourceVersion) && !processReader(targetVersion)
}
