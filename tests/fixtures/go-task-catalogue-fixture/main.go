// CPU-only parity fixture for the published Task model catalogue contract.
// It accepts one JSON request per line and performs no provider or native work.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"

	app "github.com/legrch/farol/modules/task/app/services/modelpolicy"
	contract "github.com/legrch/farol/modules/task/contracts/modelpolicy"
	native "github.com/legrch/farol/modules/task/infra/modelpolicy"
)

type request struct {
	Config    string `json:"config"`
	Harness   string `json:"harness"`
	Catalogue string `json:"catalogue"`
}

type response struct {
	View  *contract.CatalogueResponse `json:"view,omitempty"`
	Error string                      `json:"error,omitempty"`
}

func main() {
	decoder := native.JSONDecoder{}
	api := contract.NewCatalogue(app.New(decoder, native.SHA256Digester{}, []string{"codex"}), decoder)
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 4096), 2<<20)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for in.Scan() {
		var req request
		var res response
		if err := json.Unmarshal(in.Bytes(), &req); err != nil {
			res.Error = "FIXTURE_REQUEST_INVALID"
		} else {
			view, err := api.Describe(context.Background(), contract.CatalogueRequest{
				Config: []byte(req.Config), Harness: req.Harness, Catalogue: []byte(req.Catalogue),
			})
			if err != nil {
				if failure, ok := err.(*contract.Failure); ok {
					res.Error = failure.Code
				} else {
					res.Error = "FIXTURE_CONTRACT_ERROR"
				}
			} else {
				res.View = view
			}
		}
		encoded, err := json.Marshal(res)
		if err != nil {
			return
		}
		if _, err = out.Write(append(encoded, '\n')); err != nil {
			return
		}
		if err = out.Flush(); err != nil {
			return
		}
	}
}
