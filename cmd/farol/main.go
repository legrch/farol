package main

import (
	"github.com/legrch/farol/boot"
	"os"
)

func main() { os.Exit(boot.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
