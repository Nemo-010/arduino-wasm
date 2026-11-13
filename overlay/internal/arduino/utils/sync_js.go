//go:build js

package utils

import "github.com/arduino/go-paths-helper"

// SyncTree asks the kernel to flush a directory tree. In a browser there is no
// kernel and no disk to flush; the filesystem shim persists writes on its own.
func SyncTree(*paths.Path) error {
	return nil
}
