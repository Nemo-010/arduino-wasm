package cores

import (
	"os"
	"runtime"
)

// The CLI selects a tool archive from the package index by matching the
// running platform against each flavour's host triple. Under js/wasm those are
// "js"/"wasm", which no package index lists, so installing any platform that
// depends on tools would fail before a single byte was downloaded.
//
// The browser cannot execute a native toolchain either way, but it can still
// fetch and store exactly the archive a desktop CLI would fetch. The host
// triple is therefore taken from the environment when the embedding page
// provides one, and otherwise falls back to a platform that exists in the
// indexes. The default only applies to js/wasm; native builds are unaffected.
func toolHostOS() string {
	if value := os.Getenv("ARDUINO_TOOL_HOST_OS"); value != "" {
		return value
	}
	if runtime.GOOS == "js" {
		return "linux"
	}
	return runtime.GOOS
}

func toolHostArch() string {
	if value := os.Getenv("ARDUINO_TOOL_HOST_ARCH"); value != "" {
		return value
	}
	if runtime.GOARCH == "wasm" {
		return "amd64"
	}
	return runtime.GOARCH
}
