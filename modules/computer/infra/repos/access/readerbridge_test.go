package access

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Independent synthetic schema-1 bytes, not encodeState-generated inputs.
// These tests exercise only the codec/domain; no store or native host is opened.
const bridgeApproval = `{"ownerId":"owner","computerId":"computer","generation":"8","workspaces":[],"excludedPaths":[],"capabilities":null,"network":"none","commands":"none","expiresAt":1800000060000}`
const bridgePolicy = `{"workspaces":[],"excludedPaths":[],"capabilities":null,"network":"none","commands":"none","expiresAt":1800000060000}`
const bridgeOldApproval = `{"ownerId":"owner","computerId":"computer","generation":"7","workspaces":[{"workspaceId":"work","root":"/work","access":"read","rootIdentity":{"device":"1","inode":"2"},"gitHistoryApproved":false,"shellVerified":false}],"excludedPaths":[],"capabilities":["workspace.read"],"network":"none","commands":"none","expiresAt":1800000060000}`
const bridgeOldPolicy = `{"workspaces":[{"workspaceId":"work","root":"/work","mode":"subtree","paths":[],"access":"read","restrictionSource":""}],"excludedPaths":[],"capabilities":["workspace.read"],"network":"none","commands":"none","expiresAt":1800000060000}`

func bridgeParticipant(id, parent, generation, policy string, revoked bool) string {
	flag := "false"
	if revoked {
		flag = "true"
	}
	return `{"participantId":"` + id + `","parentParticipantId":"` + parent + `","role":"main","mutationOwnership":"none","authorityId":"grant","ownerId":"owner","sessionId":"session","taskId":"task","taskEpoch":"9007199254740993","computerId":"computer","computerGeneration":"` + generation + `","policy":` + policy + `,"revoked":` + flag + `}`
}
func bridgeDocument(approval, generation, participants string) []byte {
	return []byte(`{"schema":1,"profileId":"profile","ownerId":"owner","computerId":"computer","revision":"18446744073709551615","generation":"` + generation + `","seenApproval":true,"approval":` + approval + `,"participants":{` + participants + `}}` + "\n")
}
func bridgeFuture() []byte {
	return bridgeDocument(bridgeApproval, "8", `"child":`+bridgeParticipant("child", "main", "8", bridgePolicy, false)+`,"main":`+bridgeParticipant("main", "", "8", bridgePolicy, false)+`,"old":`+bridgeParticipant("old", "", "7", bridgeOldPolicy, true))
}
func TestReaderBridgeCurrentAndFutureExactRoundTrip(t *testing.T) {
	old := `"old":` + bridgeParticipant("old", "", "7", bridgeOldPolicy, true)
	for name, raw := range map[string][]byte{
		"future root-scoped files":             bytes.ReplaceAll(bytes.Replace(bridgeFuture(), []byte(`"approval":{"ownerId"`), []byte(`"approval":{"filePolicy":"approved-roots-v1","ownerId"`), 1), []byte(`"policy":{"workspaces":[]`), []byte(`"policy":{"filePolicy":"approved-roots-v1","workspaces":[]`)),
		"expired future":                       bytes.ReplaceAll(bridgeFuture(), []byte(`1800000060000`), []byte(`1700000060000`)),
		"future with later workspace approval": bridgeDocument(strings.Replace(bridgeOldApproval, `"generation":"7"`, `"generation":"9"`, 1), "9", `"main":`+bridgeParticipant("main", "", "8", bridgePolicy, false)+`,`+old),
		"current":                              bridgeDocument(bridgeOldApproval, "7", old),
		"future":                               bridgeFuture(),
		"future explicit empty capabilities":   bytes.ReplaceAll(bridgeFuture(), []byte(`"capabilities":null`), []byte(`"capabilities":[]`)),
		"revoked approval":                     bridgeDocument("null", "8", `"main":`+bridgeParticipant("main", "", "8", bridgePolicy, true)+`,`+old),
	} {
		t.Run(name, func(t *testing.T) {
			b := Binding{"profile", "owner", "computer"}
			s, err := decodeState(b, raw)
			if err != nil {
				t.Fatal(err)
			}
			if s.Revision != ^uint64(0) || s.Participants["old"].Value.Grant.TaskEpoch != 9007199254740993 || !s.Participants["old"].Revoked {
				t.Fatal("lost counters or revocation")
			}
			again, err := encodeState(b, s)
			if err != nil || !bytes.Equal(raw, again) {
				t.Fatalf("bytes changed: %v\n%s", err, again)
			}
			if s.Approval == nil {
				return
			}
			for _, retained := range s.Participants {
				for _, kind := range []authority.Capability{authority.List, authority.Read, authority.Search, authority.Verify, authority.Write, authority.Shell, authority.NetworkUse} {
					p := retained.Value
					err := authority.AuthorizeComputer(p, *s.Approval, authority.Action{Identity: p.Grant.Identity, Operation: authority.Operation{Kind: kind, WorkspaceID: "work", Path: "/work/file", Write: kind == authority.Write}}, time.UnixMilli(1800000000000))
					// Current fixture's only participant is retained and revoked.
					// The future owner generation also defeats its old grant.
					if err == nil && name != "current" {
						t.Fatalf("future restore permitted %s", kind)
					}
				}
			}
		})
	}
}
func TestReaderBridgeRejectsMalformedNoAccessSnapshots(t *testing.T) {
	raw := string(bridgeFuture())
	for name, changed := range map[string]string{
		"capability":             strings.Replace(raw, `"capabilities":null`, `"capabilities":["workspace.read"]`, 1),
		"participant capability": strings.ReplaceAll(raw, `"capabilities":null`, `"capabilities":["workspace.read"]`),
		"network":                strings.Replace(raw, `"network":"none"`, `"network":"approved"`, 1),
		"commands":               strings.Replace(raw, `"commands":"none"`, `"commands":"workspace"`, 1),
		"exclusion":              strings.Replace(raw, `"excludedPaths":[]`, `"excludedPaths":[{"workspaceId":"work","path":"/work","restrictionSource":""}]`, 1),
		"generation zero":        strings.ReplaceAll(raw, `"generation":"8"`, `"generation":"0"`),
		"identity":               strings.Replace(raw, `"ownerId":"owner"`, `"ownerId":"other"`, 1),
		"participant ownership":  strings.Replace(raw, `"mutationOwnership":"none"`, `"mutationOwnership":"task"`, 1),
		"revoked parent":         strings.ReplaceAll(raw, `"main":`+bridgeParticipant("main", "", "8", bridgePolicy, false), `"main":`+bridgeParticipant("main", "", "8", bridgePolicy, true)),
		"missing":                strings.Replace(raw, `"workspaces":[],`, "", 1),
		"null workspaces":        strings.Replace(raw, `"workspaces":[]`, `"workspaces":null`, 1),
		"unknown":                strings.Replace(raw, `"schema":1`, `"schema":1,"unknown":true`, 1),
		"trailing":               raw + "{}",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeState(Binding{"profile", "owner", "computer"}, []byte(changed)); err == nil {
				t.Fatal("malformed future state accepted")
			}
		})
	}
}
