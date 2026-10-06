package access

import (
	"bytes"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// The real protected-state codec is exercised entirely in memory. No disk,
// native access repository, process, network or provider is opened by these tests.
func filePolicyState(t *testing.T, mode authority.FilePolicy) (Binding, state) {
	t.Helper()
	b := Binding{ProfileID: "profile", OwnerID: "owner", ComputerID: "computer"}
	now := time.UnixMilli(1800000000000)
	a := authority.Approval{OwnerID: b.OwnerID, ComputerID: b.ComputerID, Generation: 7, FilePolicy: mode, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, ExcludedPaths: []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}, Capabilities: []authority.Capability{authority.Read, authority.Write}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	g, err := authority.Derive(a, authority.Admission{Identity: authority.Identity{OwnerID: b.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1}, AuthorityID: "grant", ComputerID: b.ComputerID, ComputerGeneration: a.Generation, Policy: authority.Policy{FilePolicy: mode, Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.WriteAccess}}, Capabilities: a.Capabilities, Network: a.Network, Commands: a.Commands, ExpiresAt: now.Add(time.Minute)}}, now)
	if err != nil {
		t.Fatal(err)
	}
	p, err := authority.Create(*g, authority.ParticipantAdmission{ParticipantID: "main", Role: authority.Main, MutationOwnership: authority.TaskOwnership})
	if err != nil {
		t.Fatal(err)
	}
	child, err := authority.Delegate(*p, authority.Delegation{ParticipantAdmission: authority.ParticipantAdmission{ParticipantID: "child", Role: authority.Critic, MutationOwnership: authority.NoOwnership}})
	if err != nil {
		t.Fatal(err)
	}
	return b, state{Revision: 2, Generation: a.Generation, SeenApproval: true, Approval: &a, Participants: map[string]retainedParticipant{"main": {Value: *p}, "child": {Value: *child}}}
}

func TestFilePolicyPurePersistedRoundTrip(t *testing.T) {
	for _, mode := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		b, s := filePolicyState(t, mode)
		raw, err := encodeState(b, s)
		if err != nil {
			t.Fatal(err)
		}
		if got := bytes.Contains(raw, []byte(`"filePolicy"`)); got != (mode == authority.RootScopedFiles) {
			t.Fatal("unexpected stored mode presence")
		}
		restored, err := decodeState(b, raw)
		if err != nil {
			t.Fatal(err)
		}
		if restored.Approval.FilePolicy != mode || !authority.SameApprovalPolicy(*s.Approval, *restored.Approval) {
			t.Fatal("owner mode lost")
		}
		for id, p := range s.Participants {
			r := restored.Participants[id].Value
			if r.Grant.FilePolicy != mode || !authority.SameParticipantCeiling(p.Value, r) {
				t.Fatal("participant mode or restrictions lost")
			}
		}
		again, err := encodeState(b, restored)
		if err != nil || !bytes.Equal(raw, again) {
			t.Fatal("roundtrip changed canonical state")
		}
	}
}

func TestFilePolicyPureLegacyMissingAndEmptyCompatible(t *testing.T) {
	b, s := filePolicyState(t, authority.LegacyProtectedFiles)
	for _, ownerEmpty := range []bool{false, true} {
		for _, taskEmpty := range []bool{false, true} {
			d := stateDocument(b, s)
			empty := authority.LegacyProtectedFiles
			if ownerEmpty {
				d.Approval.FilePolicy = &empty
			}
			if taskEmpty {
				for id, v := range d.Participants {
					v.Policy.FilePolicy = &empty
					d.Participants[id] = v
				}
			}
			raw, err := encodeDocument(d)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := decodeState(b, raw)
			if err != nil || restored.Approval.FilePolicy != authority.LegacyProtectedFiles || restored.Participants["main"].Value.Grant.FilePolicy != authority.LegacyProtectedFiles {
				t.Fatalf("legacy compatibility: %v", err)
			}
		}
	}
}

func TestFilePolicyPureUnknownAndMalformedStateRefuses(t *testing.T) {
	b, s := filePolicyState(t, authority.RootScopedFiles)
	for _, where := range []string{"approval", "main", "child"} {
		d := stateDocument(b, s)
		unknown := authority.FilePolicy("unknown")
		if where == "approval" {
			d.Approval.FilePolicy = &unknown
		} else {
			v := d.Participants[where]
			v.Policy.FilePolicy = &unknown
			d.Participants[where] = v
		}
		raw, err := encodeDocument(d)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeState(b, raw); err == nil {
			t.Fatalf("accepted unknown %s mode", where)
		}
	}
	raw, _ := encodeState(b, s)
	for _, malformed := range [][]byte{
		bytes.Replace(raw, []byte(`"filePolicy":"approved-roots-v1"`), []byte(`"filePolicy":null`), 1),
		bytes.Replace(raw, []byte(`"filePolicy":"approved-roots-v1"`), []byte(`"filePolicy":7`), 1),
		bytes.Replace(raw, []byte(`"filePolicy":"approved-roots-v1"`), []byte(`"filePolicy":"approved-roots-v1","filePolicy":"approved-roots-v1"`), 1),
		bytes.Replace(raw, []byte(`"filePolicy"`), []byte(`"FilePolicy"`), 1),
		bytes.Replace(raw, []byte(`"network":"none",`), nil, 1),
		append(bytes.Clone(raw), []byte("{}")...),
	} {
		if _, err := decodeState(b, malformed); err == nil {
			t.Fatal("malformed stored policy became trusted")
		}
	}
	s.Approval.FilePolicy = "unknown"
	if validApproval(*s.Approval, b) {
		t.Fatal("unknown owner ingress")
	}
	p := s.Participants["main"].Value.Grant.Policy
	p.FilePolicy = "unknown"
	if validPolicy(p) {
		t.Fatal("unknown participant ingress")
	}
}

func TestFilePolicyPureRestoreCannotChangeDelegatedMode(t *testing.T) {
	b, s := filePolicyState(t, authority.RootScopedFiles)
	child := s.Participants["child"]
	child.Value.Grant.FilePolicy = authority.LegacyProtectedFiles
	s.Participants["child"] = child
	raw, err := encodeState(b, s)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeState(b, raw); err == nil {
		t.Fatal("restored incomparable child mode")
	}
}

func TestFilePolicyPurePersistedOwnerTransitionDoesNotUpgradeGrant(t *testing.T) {
	b, s := filePolicyState(t, authority.LegacyProtectedFiles)
	s.Approval.FilePolicy = authority.RootScopedFiles
	s.Approval.Generation++
	s.Generation = s.Approval.Generation
	raw, err := encodeState(b, s)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := decodeState(b, raw)
	if err != nil {
		t.Fatal(err)
	}
	p := restored.Participants["main"].Value
	if p.Grant.FilePolicy != authority.LegacyProtectedFiles {
		t.Fatal("retained legacy grant upgraded")
	}
	op := authority.Action{Identity: p.Grant.Identity, Operation: authority.Operation{Kind: authority.Write, WorkspaceID: "work", Path: "/work/readme", Write: true}}
	if err := authority.AuthorizeComputer(p, *restored.Approval, op, time.UnixMilli(1800000000000)); err == nil {
		t.Fatal("old effect survived policy/generation transition")
	}
}
