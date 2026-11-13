package inference

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	opaque "github.com/legrch/farol/pkg/kernel/domain/id"
)

func digestValue(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func ValidAccountIdentity(a AccountIdentity) bool {
	if a.Issuer != "https://auth.openai.com" || !opaque.Valid(a.Subject) || !opaque.Valid(a.ClientID) || a.ClientID == "dynamic_agent_client" || !opaque.Valid(a.HostID) || a.Epoch == 0 {
		return false
	}
	for _, prefix := range []string{"urn:uuid:", "urn:ietf:params:oauth:jwk-thumbprint:", "did:key:"} {
		if strings.HasPrefix(a.HostID, prefix) && len(a.HostID) > len(prefix) {
			return true
		}
	}
	return false
}

func ValidSelection(s Selection) bool {
	if s.Backend != PlanBackend || !ValidAccountIdentity(s.Account) || !opaque.Valid(s.ConsentID) || s.ConsentRevision == 0 || !opaque.Valid(s.Model.Slug) || !opaque.Valid(s.Model.CapabilityEvidence) || s.Model.CatalogueEpoch == 0 {
		return false
	}
	switch s.Model.Effort {
	case "", "none", "minimal", "low", "medium", "high", "xhigh":
		return true
	}
	return false
}

// ValidateRequest refuses unresolved prior function rounds, rather than silently
// deleting them from a no-tools request. Input order is retained byte-for-byte.
func ValidateRequest(r Request) error {
	if !opaque.Valid(r.Model.Slug) || !opaque.Valid(r.Model.CapabilityEvidence) || r.Model.CatalogueEpoch == 0 || len(r.Input) == 0 || len(r.Input) > MaxInputItems {
		return Invalid
	}
	switch r.Model.Effort {
	case "", "none", "minimal", "low", "medium", "high", "xhigh":
	default:
		return Invalid
	}
	calls := make(map[string]bool)
	for _, i := range r.Input {
		for _, s := range []string{i.Kind, i.Role, i.Content, i.CallID, i.Name, i.Arguments} {
			if !utf8.ValidString(s) {
				return Invalid
			}
		}
		switch i.Kind {
		case "message":
			if (i.Role != "user" && i.Role != "assistant" && i.Role != "developer") || i.CallID != "" || i.Name != "" || i.Arguments != "" {
				return Invalid
			}
		case "function_call":
			if i.Role != "" || i.Content != "" || !opaque.Valid(i.CallID) || !opaque.Valid(i.Name) || !json.Valid([]byte(i.Arguments)) {
				return Invalid
			}
			if _, exists := calls[i.CallID]; exists {
				return Invalid
			}
			calls[i.CallID] = false
		case "function_call_output":
			resolved, exists := calls[i.CallID]
			if i.Role != "" || i.Name != "" || i.Arguments != "" || !exists || resolved {
				return Invalid
			}
			calls[i.CallID] = true
		default:
			return Invalid
		}
	}
	for _, resolved := range calls {
		if !resolved {
			return Invalid
		}
	}
	raw, err := json.Marshal(r.Input)
	if err != nil || len(raw) > MaxInputBytes {
		return Invalid
	}
	return nil
}

// InputHash describes the complete canonical ordered application input, not
// provider storage and not a guaranteed token count.
func InputHash(d Digester, items []InputItem) (string, error) {
	if d == nil {
		return "", Invalid
	}
	raw, err := json.Marshal(items)
	if err != nil || len(raw) > MaxInputBytes {
		return "", Invalid
	}
	hash, err := d.Digest(raw)
	if err != nil || !digestValue(hash) {
		return "", Invalid
	}
	return hash, nil
}
