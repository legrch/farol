package process

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Labelled pure contract doubles only. No native filesystem/child, persistence,
// provider, constructor qualification or assembled product evidence.
type connectorContractReadDouble struct {
	*observationLease
	scope processsvc.ConnectorReadScope
}

func (d *connectorContractReadDouble) ConnectorScope() processsvc.ConnectorReadScope { return d.scope }

func connectorContractDouble(t *testing.T) (*Contract, *connectorContractReadDouble, *observationPrepared, *preparationReservation) {
	t.Helper()
	// Reuse synthetic policy values, with fresh doubles for this operation.
	_, clock, values, preparedValues, _ := retainedContract(t)
	lease := &preparationLease{binding: values.binding, deadline: clock.now.Add(15 * time.Second), p: values.p.Clone(), a: values.a.Clone()}
	lease.p.Grant.Capabilities = []authority.Capability{authority.Shell}
	lease.p.Grant.Commands = authority.WorkspaceCommands
	lease.p.Grant.ExpiresAt = clock.now.Add(time.Hour)
	lease.a.Capabilities = []authority.Capability{authority.Shell}
	lease.a.Commands = authority.WorkspaceCommands
	lease.a.Workspaces[0].ShellVerified = true
	p := &observationPrepared{seal: preparedValues.seal, child: &observationChild{}}
	j := &preparationReservation{}
	host := port.ConnectorHost{ProfileID: "profile", BackendGeneration: "backend", BuildID: "build", RuntimeID: "runtime", LaunchDigest: strings.Repeat("b", 64), ConnectorGeneration: 1}
	scope := processsvc.ConnectorReservationScope{Host: host, OwnerID: "owner", ComputerID: "computer", CallID: "original-call", ComputerGeneration: 1, Generation: 3}
	s, err := processsvc.NewForConnector("op", scope, lease, p, j, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	c, err := New(s)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Start(context.Background(), StartRequest{"op"}); err != nil {
		t.Fatal(err)
	}
	clock.now = lease.deadline.Add(time.Millisecond)
	values.binding.SessionID = "later-session"
	values.binding.TaskID = "later-work"
	values.binding.TaskEpoch++
	values.binding.ParticipantID = "later-participant"
	values.binding.TurnID = "later-turn"
	values.p.ParticipantID = values.binding.ParticipantID
	values.p.Grant.Identity = values.binding.Identity
	values.p.Grant.AuthorityID = "later-admission"
	values.p.Grant.ExpiresAt = clock.now.Add(15 * time.Second)
	values.deadline = values.p.Grant.ExpiresAt
	host.ConnectorGeneration++
	host.RuntimeID = "later-runtime"
	return c, &connectorContractReadDouble{values, processsvc.ConnectorReadScope{Host: host, OwnerID: "owner", ComputerID: "computer", ComputerGeneration: 1}}, p, j
}

func TestConnectorObserveContractMapsOnlyHandleAndOffsets(t *testing.T) {
	c, current, p, j := connectorContractDouble(t)
	o, err := c.ConnectorObserver(current, observationWorkspace{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := o.Read(context.Background(), ReadRequest{Handle: "child", StdoutOffset: 2, StderrOffset: 4})
	if err != nil || out.State != Running || out.Handle != "child" || out.StdoutOffset != 2 || out.StdoutNext != 5 || out.StderrOffset != 4 || out.StderrNext != 7 || out.StdoutBase64 != "b3V0" || out.StderrBase64 != "ZXJy" || p.child.reads != 1 || p.spawns != 1 || j.calls != 1 || p.child.cancels != 0 {
		t.Fatal(out, err)
	}
	shape := reflect.TypeOf(o)
	if shape.NumMethod() != 1 || shape.Method(0).Name != "Read" {
		t.Fatal("connector contract exposes effects")
	}
	request := reflect.TypeOf(ReadRequest{})
	if request.NumField() != 3 || request.Field(0).Name != "Handle" || request.Field(1).Name != "StdoutOffset" || request.Field(2).Name != "StderrOffset" {
		t.Fatal("read body gained authority")
	}
	if out, err := c.Observer(current, observationWorkspace{}); out != nil || err == nil {
		t.Fatal("ordinary observer allowed connector rebind")
	}
}

func TestConnectorObserveContractRefusesLateWithdrawalAndPreservesUnknown(t *testing.T) {
	c, current, p, j := connectorContractDouble(t)
	o, err := c.ConnectorObserver(current, observationWorkspace{})
	if err != nil {
		t.Fatal(err)
	}
	p.child.afterRead = func() { current.withdrawn = true }
	out, err := o.Read(context.Background(), ReadRequest{Handle: "child"})
	var f *Failure
	if out != nil || !errors.As(err, &f) || f.Outcome != "refused" || f.Retry != "never" {
		t.Fatal(out, err)
	}
	// Fixture recovery only, to check an independent unknown-result case.
	current.withdrawn = false
	p.child.afterRead = nil
	p.child.err = &processsvc.NativeFailure{Unknown: true}
	if out, err = o.Read(context.Background(), ReadRequest{Handle: "child"}); out != nil || !errors.As(err, &f) || f.Outcome != "outcome_unknown" || f.Retry != "never" {
		t.Fatal(out, err)
	}
	p.child.err = nil
	if out, err = o.Read(context.Background(), ReadRequest{Handle: "child"}); err != nil || out.State != Unknown || p.spawns != 1 || j.calls != 1 || p.child.cancels != 0 {
		t.Fatal(out, err)
	}
}

func TestConnectorObserveContractRejectsMissingProvenanceAndForeignProfile(t *testing.T) {
	c, current, p, _ := connectorContractDouble(t)
	current.scope.Host.ProfileID = "foreign"
	if out, err := c.ConnectorObserver(current, observationWorkspace{}); out != nil || err == nil || p.child.reads != 0 {
		t.Fatal(out, err)
	}
	ordinary, _, read, _, _ := retainedContract(t)
	current.observationLease = read
	current.scope.Host.ProfileID = "profile"
	if out, err := ordinary.ConnectorObserver(current, observationWorkspace{}); out != nil || err == nil {
		t.Fatal("retrofitted original identity", out, err)
	}
	var absent *Contract
	if out, err := absent.ConnectorObserver(current, observationWorkspace{}); out != nil || err == nil {
		t.Fatal(out, err)
	}
}
