//go:build js

package packagemanager

// A discovery is a native executable that the CLI starts as a child process and
// talks to over a pipe. A browser can do neither: there is no process to spawn,
// and the tool archives the indexes offer are ELF binaries for the host.
//
// Refusing to load them is not a workaround, it is the correct answer under js.
// Loading them is also what breaks the IDE: a platform that is not
// discovery-aware is given two required builtin discoveries by the loader, their
// absence is reported by `Init` as
//
//	Error loading hardware platform: discovery builtin:serial-discovery not found
//
// and `CoreClientProvider` reads exactly that as "the indexes need updating",
// runs an index update, fails identically, and leaves its client Deferred never
// settled -- the IDE then waits forever for a client that will not arrive.
//
// Ports in the page come from WebSerial instead. Board and platform listing does
// not depend on discoveries; only port enumeration does.
func DiscoveriesCanBeSpawned() bool {
	return false
}
