// Package limit holds the one bounded read: a reader is consumed to at most a
// stated size and anything longer is refused rather than truncated.
package limit

import (
	"errors"
	"io"
	"math"
)

// ErrTooLarge reports that the reader held more than the permitted bytes.
var ErrTooLarge = errors.New("limit: input exceeds the maximum size")

// Read returns every byte of r, which must not exceed maximum bytes. It reads
// at most maximum+1 bytes, so an endless reader costs one byte more than the
// bound. A reader longer than maximum yields (nil, ErrTooLarge); a reader
// error is returned as is with whatever was read. A negative maximum is
// treated as zero.
func Read(r io.Reader, maximum int64) ([]byte, error) {
	if maximum < 0 {
		maximum = 0
	}
	window := maximum + 1
	if maximum == math.MaxInt64 {
		window = math.MaxInt64
	}
	data, err := io.ReadAll(io.LimitReader(r, window))
	if err != nil {
		return data, err
	}
	if int64(len(data)) > maximum {
		return nil, ErrTooLarge
	}
	return data, nil
}
