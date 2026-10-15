package modelpolicy

import "strings"

// PolicyIdentity describes the complete configured policy, including harnesses
// unsupported by this build. A valid identity grants no execution authority.
type PolicyIdentity struct {
	Status       Status
	ConfigSHA256 string
}

// Identity uses the same semantic validation and canonical bytes as Resolve,
// without selecting a harness or consulting the supported harness list.
func (s *Service) Identity(configJSON []byte) PolicyIdentity {
	if s == nil || s.decoder == nil {
		return PolicyIdentity{Status: Unavailable}
	}
	if len(configJSON) > MaxPolicyBytes {
		return PolicyIdentity{Status: ConfigInvalid}
	}
	p, err := s.decoder.DecodePolicy(append([]byte(nil), configJSON...))
	if err != nil {
		return PolicyIdentity{Status: ConfigInvalid}
	}
	if p == nil {
		return PolicyIdentity{Status: ConfigMissing}
	}
	if !validPolicy(*p) {
		return PolicyIdentity{Status: ConfigInvalid}
	}
	if s.digester == nil {
		return PolicyIdentity{Status: Unavailable}
	}
	canonical, err := canonicalPolicy(*p)
	if err != nil {
		return PolicyIdentity{Status: Unavailable}
	}
	digest, err := s.digester.Digest(canonical)
	if err != nil || !validDigest(digest) {
		return PolicyIdentity{Status: Unavailable}
	}
	return PolicyIdentity{Status: Ready, ConfigSHA256: strings.Clone(digest)}
}
