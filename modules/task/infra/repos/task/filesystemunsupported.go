//go:build !darwin && !linux

package task

import "github.com/legrch/farol/modules/task/domain"

func openFilesystemStorage(FilesystemRoot) (filesystemStorage, error) {
	return nil, task.ErrUnavailable
}
