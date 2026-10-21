// Package releasearchive implements the bounded native release ZIP contract.
// It has no provider, installed-application, or credential dependencies.
package releasearchive

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
)

const (
	maxArchive  = 2_147_483_648
	maxExpanded = 1_073_741_824
	maxEntries  = 100_000
	maxCentral  = 16 * 1024 * 1024
	maxParts    = 128
	maxLink     = 4096
	chunk       = 1024 * 1024
)

const previewApp = "Farol Next Preview.app"
const brandedApp = "Farol.app"

type refusal string

func (r refusal) Error() string { return string(r) }
func refuse(code string) error  { return refusal(code) }

// Code never forwards filesystem paths, decompressor text, or arbitrary errors.
func Code(err error) string {
	var r refusal
	if errors.As(err, &r) {
		return string(r)
	}
	return "ARCHIVE_IO_FAILED"
}

type Result struct {
	AppPath      string `json:"appPath"`
	ArtifactPath string `json:"artifactPath"`
}

type identity struct {
	dev                                        int64
	ino                                        uint64
	mode                                       uint32
	nlink                                      uint64
	uid, gid                                   uint32
	size, mtimeSec, mtimeNS, ctimeSec, ctimeNS int64
}

func decimalSize(text string) (int64, error) {
	if text == "" {
		return 0, refuse("ARCHIVE_SIZE_INVALID")
	}
	var size int64
	for _, r := range text {
		digit := int64(-1)
		if r >= '0' && r <= '9' {
			digit = int64(r - '0')
		} else {
			// Match Python isdecimal/int for Unicode Nd digits, including mixed
			// decimal scripts. Each Nd range consists of ordered groups of ten.
			for _, span := range unicode.Nd.R16 {
				if uint32(r) >= uint32(span.Lo) && uint32(r) <= uint32(span.Hi) && (uint32(r)-uint32(span.Lo))%uint32(span.Stride) == 0 {
					digit = int64((uint32(r) - uint32(span.Lo)) / uint32(span.Stride) % 10)
					break
				}
			}
			if digit < 0 {
				for _, span := range unicode.Nd.R32 {
					if uint32(r) >= span.Lo && uint32(r) <= span.Hi && (uint32(r)-span.Lo)%span.Stride == 0 {
						digit = int64((uint32(r) - span.Lo) / span.Stride % 10)
						break
					}
				}
			}
		}
		if digit < 0 || size > (maxArchive-digit)/10 {
			return 0, refuse("ARCHIVE_SIZE_INVALID")
		}
		size = size*10 + digit
	}
	if size == 0 {
		return 0, refuse("ARCHIVE_SIZE_INVALID")
	}
	return size, nil
}

func unchangedArchive(path string, file *os.File, before identity) error {
	opened, err := file.Stat()
	if err != nil {
		return refuse("ARCHIVE_CHANGED")
	}
	named, err := os.Lstat(path)
	if err != nil || !opened.Mode().IsRegular() || before != identify(opened) || before != identify(named) {
		return refuse("ARCHIVE_CHANGED")
	}
	return nil
}

// Run accepts precisely archive path, private stage path, decimal byte size,
// and lowercase SHA-256. It leaves existing bootstrap files untouched.
func Run(args []string) (Result, error) {
	if len(args) != 4 {
		return Result{}, refuse("ARCHIVE_ARGUMENTS_INVALID")
	}
	archivePath, rootPath, sizeText, digestText := args[0], args[1], args[2], args[3]
	size, err := decimalSize(sizeText)
	if err != nil {
		return Result{}, err
	}
	if len(digestText) != 64 || strings.IndexFunc(digestText, func(r rune) bool {
		return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f')
	}) >= 0 {
		return Result{}, refuse("ARCHIVE_DIGEST_INVALID")
	}
	stage, err := openStage(rootPath)
	if err != nil {
		return Result{}, err
	}
	defer stage.close()
	named, err := os.Lstat(archivePath)
	if err != nil {
		return Result{}, err
	}
	if !named.Mode().IsRegular() {
		return Result{}, refuse("ARCHIVE_TYPE_INVALID")
	}
	before := identify(named)
	if before.nlink != 1 || before.size != size {
		return Result{}, refuse("ARCHIVE_SIZE_MISMATCH")
	}
	file, err := os.OpenFile(archivePath, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return Result{}, err
	}
	defer file.Close()
	if err := unchangedArchive(archivePath, file, before); err != nil {
		return Result{}, err
	}
	hash := sha256.New()
	total, err := io.CopyBuffer(hash, io.LimitReader(file, size+1), make([]byte, chunk))
	if err != nil {
		return Result{}, err
	}
	if total != size {
		return Result{}, refuse("ARCHIVE_SIZE_MISMATCH")
	}
	if err := unchangedArchive(archivePath, file, before); err != nil {
		return Result{}, err
	}
	if hex.EncodeToString(hash.Sum(nil)) != digestText {
		return Result{}, refuse("ARCHIVE_DIGEST_MISMATCH")
	}
	count, err := admitDirectory(file, size)
	if err != nil {
		return Result{}, err
	}
	if err := unchangedArchive(archivePath, file, before); err != nil {
		return Result{}, err
	}
	archive, err := zip.NewReader(file, size)
	// Own path validation below is independent of the host's GODEBUG policy.
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		return Result{}, refuse("ARCHIVE_DIRECTORY_INVALID")
	}
	if archive == nil || len(archive.File) != count {
		return Result{}, refuse("ARCHIVE_ENTRY_COUNT_INVALID")
	}
	plan, err := preflight(archive, stage)
	if err != nil {
		return Result{}, err
	}
	if err := unchangedArchive(archivePath, file, before); err != nil {
		return Result{}, err
	}
	if err := stage.unchanged(); err != nil {
		return Result{}, err
	}
	if err := stage.extract(plan); err != nil {
		stage.cleanup()
		return Result{}, err
	}
	if err := unchangedArchive(archivePath, file, before); err != nil {
		stage.cleanup()
		return Result{}, err
	}
	if err := stage.unchanged(); err != nil {
		stage.cleanup()
		return Result{}, err
	}
	return Result{filepath.Join(stage.path, plan.app), filepath.Join(stage.path, "artifact.json")}, nil
}
