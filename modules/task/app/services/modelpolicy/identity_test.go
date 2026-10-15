package modelpolicy

import (
	"errors"
	"strings"
	"testing"
)

func TestIdentityPreservesCanonicalResolveBytes(t *testing.T) {
	d := &decoder{p: fixture()}
	hash := goodDigest()
	s := New(d, hash, []string{"codex"})
	resolved := s.Resolve(nil, nil)
	before := string(hash.input)
	identity := s.Identity(nil)
	if identity.Status != Ready || identity.ConfigSHA256 != resolved.ConfigSHA256 || string(hash.input) != before {
		t.Fatalf("canonical identity changed: %+v", identity)
	}
	want := `["farol-task-policy/1","codex",[["codex","small",[["constructor","fixture/own",null],["plain","fixture/plain",null],["small","fixture/small","medium"]]],["future","small",[["small","fixture/future",null]]]]]`
	if before != want {
		t.Fatalf("canonical bytes: %s", before)
	}
	if d.requestCalls != 1 {
		t.Fatal("Identity selected a harness")
	}
	// Identity includes every valid policy regardless of executable support.
	for _, supported := range [][]string{nil, {"codex"}} {
		d := &decoder{p: fixture()}
		delete(d.p.Harnesses, "codex")
		d.p.DefaultHarness = "future"
		digest := goodDigest()
		got := New(d, digest, supported).Identity(nil)
		if got.Status != Ready || !strings.Contains(string(digest.input), "fixture/future") || d.requestCalls != 0 {
			t.Fatalf("no-codex identity: %+v", got)
		}
	}
}
func TestIdentityClassesAndUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name   string
		d      *decoder
		digest *digester
		want   Status
	}{
		{"missing", &decoder{}, goodDigest(), ConfigMissing},
		{"decode invalid", &decoder{policyErr: errors.New("bad")}, goodDigest(), ConfigInvalid},
		{"semantic invalid", &decoder{p: fixture()}, goodDigest(), ConfigInvalid},
		{"digest failure", &decoder{p: fixture()}, &digester{err: errors.New("private")}, Unavailable},
		{"digest shape", &decoder{p: fixture()}, &digester{value: "not-a-digest"}, Unavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "semantic invalid" {
				tc.d.p.DefaultHarness = "absent"
			}
			got := New(tc.d, tc.digest, nil).Identity(nil)
			if got.Status != tc.want || got.ConfigSHA256 != "" {
				t.Fatalf("%+v", got)
			}
		})
	}
	for _, s := range []*Service{nil, New(nil, nil, nil), New(&decoder{p: fixture()}, nil, nil)} {
		if got := s.Identity(nil); got.Status != Unavailable {
			t.Fatalf("%+v", got)
		}
	}
	if got := New(&decoder{p: fixture()}, goodDigest(), nil).Identity(make([]byte, MaxPolicyBytes+1)); got.Status != ConfigInvalid {
		t.Fatal(got)
	}
}
