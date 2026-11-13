package globals

import (
	"net/url"
	"os"
)

// DefaultIndexURL points at the official package index. On a desktop the CLI
// has no reason to change it, but a wasm build is embedded in a page that may
// serve from a mirror, run offline against a local fixture, or prefer a
// different vendor. The variables are exported and mutable, so this hook needs
// no upstream change.
//
// Package-level variables are initialised before init functions run, so the
// values assigned in globals.go are already in place here.
func init() {
	if value := os.Getenv("ARDUINO_DEFAULT_INDEX_URL"); value != "" {
		DefaultIndexURL = value
	}

	if value := os.Getenv("ARDUINO_LIBRARIES_INDEX_URL"); value != "" {
		parsed, err := url.Parse(value)
		if err != nil {
			return
		}
		LibrariesIndexURL = parsed
		LibrariesIndexResource.URL = parsed
		// The bundled keyring only signs the official index. A page that
		// points at a mirror or a local fixture has no signature to check,
		// and refusing the download would make the override useless.
		if parsed.Host != "downloads.arduino.cc" {
			LibrariesIndexResource.EnforceSignatureVerification = false
		}
	}
}
