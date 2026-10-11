package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

// Aggregate in-memory owners and endpoint, not native or live-provider evidence.
func emptyVerificationOpen(t *testing.T) (*computerConnector, *connectorJournalFixture, *settingsNativeFixture, *connectorEndpointFixture, *wire.ComputerConnectorOpened) {
	t.Helper()
	s, journal, native, endpoint, input := newConnectorFixture(t)
	a := journal.approval.Clone()
	a.Workspaces, a.Capabilities = nil, nil
	journal.approval = a
	journal.PutApproval(a)
	s.root.publication.approval = a.Clone()
	digest := sha256.Sum256([]byte("visible-challenge"))
	challenge := hex.EncodeToString(digest[:])
	input.ChallengeSha256 = &challenge
	opened, err := s.Open(context.Background(), "open-empty", input)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Shutdown() })
	return s, journal, native, endpoint, opened
}

func TestConnectorEmptyCatalogueProofAndStatusDoNotTouchFiles(t *testing.T) {
	s, _, native, endpoint, opened := emptyVerificationOpen(t)
	query := wire.ComputerConnectorVerificationQuery{Binding: opened.Endpoint.Binding}
	observe := endpoint.methods["computer.connector.verification"]
	out, err := verificationInvoke(t, observe, query)
	initial := verificationState(t, out, err)
	if initial.Receipt != nil || initial.CatalogueReceipt != nil || initial.ReceiptSha256 != nil {
		t.Fatal("unattempted connection invented proof")
	}
	request := wire.ComputerConnectorCatalogueVerify{Challenge: "visible-challenge", CallId: "original-catalogue"}
	method := endpoint.methods["computer.connector.catalogueverify"]
	out, err = verificationInvoke(t, method, request)
	first := verificationState(t, out, err)
	if first.Receipt != nil || first.CatalogueReceipt == nil || first.ReceiptSha256 == nil || native.calls != 0 {
		t.Fatalf("expected distinct content-free proof: %+v", first)
	}
	receipt := first.CatalogueReceipt
	if receipt.Binding != opened.Endpoint.Binding || receipt.Execution != opened.Execution || receipt.WorkspaceCount != 0 {
		t.Fatal("crossed catalogue proof")
	}
	raw, _ := json.Marshal(receipt)
	digest := sha256.Sum256(raw)
	if *first.ReceiptSha256 != hex.EncodeToString(digest[:]) {
		t.Fatal("wrong proof digest")
	}
	request.CallId = "observe-original"
	out, err = verificationInvoke(t, method, request)
	second := verificationState(t, out, err)
	if second.CatalogueReceipt == nil || *second.CatalogueReceipt != *receipt {
		t.Fatal("completed proof replaced original attempt")
	}
	out, err = verificationInvoke(t, observe, query)
	third := verificationState(t, out, err)
	if third.CatalogueReceipt == nil || *third.CatalogueReceipt != *receipt || native.calls != 0 {
		t.Fatal("observation touched native files or changed proof")
	}
	out, err = verificationInvoke(t, s.verificationMethod(s.current), wire.ComputerConnectorVerify{Challenge: "visible-challenge", WorkspaceId: "invented", CallId: "crossed"})
	if err == nil && out != nil && out.Status == "ok" {
		t.Fatal("catalogue became workspace verification")
	}
	if native.calls != 0 {
		t.Fatal("empty proof read files")
	}
}

func TestCatalogueVerificationCannotBypassNonemptyOrWithdrawnAuthority(t *testing.T) {
	s, _, native, _ := verificationOpen(t)
	out, err := verificationInvoke(t, s.catalogueVerificationMethod(s.current), wire.ComputerConnectorCatalogueVerify{Challenge: "visible-challenge", CallId: "not-empty"})
	if err == nil && out != nil && out.Status == "ok" {
		t.Fatal("nonempty scope used empty proof")
	}
	if native.calls != 0 {
		t.Fatal("invalid empty request touched files")
	}
	s, journal, native, endpoint, opened := emptyVerificationOpen(t)
	journal.RevokeParticipant(opened.Execution.ParticipantId)
	out, err = verificationInvoke(t, endpoint.methods["computer.connector.catalogueverify"], wire.ComputerConnectorCatalogueVerify{Challenge: "visible-challenge", CallId: "revoked"})
	if err == nil && out != nil && out.Status == "ok" {
		t.Fatal("revoked empty authority verified")
	}
	if native.calls != 0 {
		t.Fatal("revoked empty request touched files")
	}
}
