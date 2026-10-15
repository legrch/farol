// CPU-only fixture of actual Task contracts and native value adapters. It opens
// no host/profile/provider and supplies no execution, account or admission port.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/legrch/farol/modules/task/app/port"
	sourceapp "github.com/legrch/farol/modules/task/app/services/currentsource"
	policyapp "github.com/legrch/farol/modules/task/app/services/modelpolicy"
	sourcecontract "github.com/legrch/farol/modules/task/contracts/currentsource"
	policycontract "github.com/legrch/farol/modules/task/contracts/modelpolicy"
	"github.com/legrch/farol/modules/task/infra/currentsettings"
	"github.com/legrch/farol/modules/task/infra/modelpolicy"
)

// This consumer-owned fixture adapter maps published policy DTOs, with explicit
// Codex selection. Neither selection nor source eligibility is mocked here.
type modelResolver struct{ policy *policycontract.Contract }

func (r modelResolver) ResolveTaskSourceModel(ctx context.Context, raw []byte) (port.TaskSourceModelResolution, error) {
	out, err := r.policy.Resolve(ctx, policycontract.Request{Config: raw, Selection: []byte(`{"harness":"codex"}`)})
	if err != nil {
		return port.TaskSourceModelResolution{}, err
	}
	mapped := port.TaskSourceModelResolution{Status: out.Status}
	if out.Selection != nil {
		s := out.Selection
		mapped.Selection = &port.TaskSourceModelSelection{Harness: s.Harness, ModelAlias: s.ModelAlias, Model: s.Model, Effort: s.Effort, ConfigSHA256: out.ConfigSHA256}
	}
	return mapped, nil
}
func compose() *sourcecontract.Contract {
	policy := policycontract.New(policyapp.New(modelpolicy.JSONDecoder{}, modelpolicy.SHA256Digester{}, []string{"codex"}))
	return sourcecontract.New(sourceapp.New(currentsettings.JSONDecoder{}, modelResolver{policy}))
}

type request struct {
	Settings  string `json:"settings"`
	NowMillis *int64 `json:"nowMillis"`
}
type failure struct {
	Error string `json:"error"`
}

func serve(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	// The escaped line envelope can exceed the contract's 1MiB snapshot bound.
	scanner.Buffer(make([]byte, 4096), 2<<20)
	encoder := json.NewEncoder(output)
	contract := compose()
	for scanner.Scan() {
		var in request
		if err := json.Unmarshal(scanner.Bytes(), &in); err != nil || in.NowMillis == nil {
			if err := encoder.Encode(failure{sourceapp.Invalid}); err != nil {
				return err
			}
			continue
		}
		out, err := contract.Resolve(context.Background(), sourcecontract.Request{Settings: []byte(in.Settings), NowMillis: *in.NowMillis})
		if err != nil {
			if err := encoder.Encode(failure{err.Error()}); err != nil {
				return err
			}
		} else if err := encoder.Encode(out); err != nil {
			return err
		}
	}
	return scanner.Err()
}
func main() {
	if err := serve(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
