package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Execute the command entrypoint in an isolated test process, including exit1.
func TestCLIProcess(t *testing.T) {
	if os.Getenv("FAROL_ARCHIVE_CLI_TEST") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			main()
			os.Exit(0)
		}
	}
	os.Exit(2)
}

func TestCLIContract(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	for name, payload := range map[string]string{"artifact.json": "{}", "Farol.app/Contents/Info.plist": "plist"} {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, bootstrap := range []bool{false, true} {
		t.Run(strconv.FormatBool(bootstrap), func(t *testing.T) {
			parent := t.TempDir()
			archive := filepath.Join(parent, "archive.zip")
			stage := filepath.Join(parent, "stage")
			if err := os.WriteFile(archive, data.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(stage, 0700); err != nil {
				t.Fatal(err)
			}
			if bootstrap {
				if err := os.WriteFile(filepath.Join(stage, ".update_archive.py"), []byte("trusted executable fixture"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			sum := sha256.Sum256(data.Bytes())
			args := []string{archive, stage, strconv.Itoa(data.Len()), hex.EncodeToString(sum[:])}
			invoke := func(args []string) ([]byte, []byte, error) {
				command := exec.Command(executable, append([]string{"-test.run=^TestCLIProcess$", "--"}, args...)...)
				command.Env = []string{"FAROL_ARCHIVE_CLI_TEST=1", "GOCOVERDIR=" + t.TempDir()}
				var stdout, stderr bytes.Buffer
				command.Stdout = &stdout
				command.Stderr = &stderr
				err := command.Run()
				return stdout.Bytes(), stderr.Bytes(), err
			}
			stdout, stderr, err := invoke(args)
			if err != nil || len(stderr) != 0 {
				t.Fatalf("CLI success: %s %s %v", stdout, stderr, err)
			}
			result := map[string]string{}
			if err := json.Unmarshal(stdout, &result); err != nil {
				t.Fatal(err)
			}
			canonical, err := filepath.EvalSymlinks(stage)
			if err != nil {
				t.Fatal(err)
			}
			if len(result) != 2 || result["appPath"] != filepath.Join(canonical, "Farol.app") || result["artifactPath"] != filepath.Join(canonical, "artifact.json") {
				t.Fatal(result)
			}
			if bootstrap {
				content, err := os.ReadFile(filepath.Join(stage, ".update_archive.py"))
				if err != nil || string(content) != "trusted executable fixture" {
					t.Fatal("bootstrap changed", err)
				}
			}
			stdout, stderr, err = invoke(nil)
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 1 || len(stdout) != 0 || string(stderr) != "ARCHIVE_REFUSED:ARCHIVE_ARGUMENTS_INVALID\n" {
				t.Fatalf("CLI failure: %q %q %v", stdout, stderr, err)
			}
			args[3] = strings.Repeat("a", 63) + "G"
			stdout, stderr, err = invoke(args)
			exit, ok = err.(*exec.ExitError)
			if !ok || exit.ExitCode() != 1 || len(stdout) != 0 || string(stderr) != "ARCHIVE_REFUSED:ARCHIVE_DIGEST_INVALID\n" {
				t.Fatalf("CLI classified failure: %q %q %v", stdout, stderr, err)
			}
		})
	}
}
