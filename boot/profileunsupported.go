//go:build !darwin

package boot

// Other platforms never substitute a lexical path or a weaker producer.
func qualifyNativeProfile(ProfileBinding) (*QualifiedProfile, error) {
	return nil, profileFailure(ProfileUnsupported)
}
