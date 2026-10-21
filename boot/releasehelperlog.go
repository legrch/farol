package boot

import (
	"encoding/json"
	"errors"
	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Diagnostics are best effort and never change the installation outcome. The
// only destination is a fixed leaf under the already borrowed operation folder.
// Never log native errors, request data, paths or profile contents here.
func writeReleaseHelperLog(operation *os.File, phase, code string) {
	if operation == nil {
		return
	}
	raw, err := operation.SyscallConn()
	if err != nil {
		return
	}
	fd := -1
	var opened error
	err = raw.Control(func(parent uintptr) {
		fd, opened = unix.Openat(int(parent), "helper.log.jsonl", unix.O_WRONLY|unix.O_APPEND|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0600)
	})
	if err != nil || opened != nil {
		return
	}
	f := os.NewFile(uintptr(fd), "helper-log")
	defer f.Close()
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 1 || stat.Mode&0077 != 0 {
		return
	}
	line, err := json.Marshal(struct {
		Phase     string `json:"phase"`
		Code      string `json:"code"`
		Timestamp string `json:"timestamp"`
		PID       int    `json:"pid"`
	}{phase, code, time.Now().UTC().Format(time.RFC3339Nano), os.Getpid()})
	if err == nil {
		_, _ = f.Write(append(line, '\n'))
		_ = f.Sync()
	}
}

func helperLogCode(err error) string {
	var execution *executionapp.Failure
	if errors.As(err, &execution) && execution != nil {
		return execution.Code
	}
	var native *releaseport.HelperRecoveryFailure
	if errors.As(err, &native) && native != nil {
		return native.Code
	}
	return "helper_failed"
}
