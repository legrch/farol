// Command update-archive admits and extracts one verified Farol release ZIP.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"farol.local/native/internal/releasearchive"
)

func main() {
	result, err := releasearchive.Run(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "ARCHIVE_REFUSED:"+releasearchive.Code(err))
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		fmt.Fprintln(os.Stderr, "ARCHIVE_REFUSED:ARCHIVE_IO_FAILED")
		os.Exit(1)
	}
}
