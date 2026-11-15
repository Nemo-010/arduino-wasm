//go:build js

package main

import (
	"fmt"
	"io"
	"os/exec"
	"syscall/js"

	pathsh "github.com/arduino/go-paths-helper"
)

// Every external command arduino-cli runs — the compiler, ctags, ar, objcopy,
// avrdude — goes through paths.Process, which wraps os/exec. A browser has no
// os/exec, so the page installs a runner and this hook hands each command to it.
//
// The page receives the whole command line, decides what to do with it, and
// answers with an exit code and both streams. Nothing here knows which tool it
// is: the recipes stay the ones from platform.txt, and the translation from a
// recipe to wasm tools happens on the JavaScript side.
func init() {
	pathsh.RunExternal = runExternal
}

func toJSArray(values []string) js.Value {
	array := js.Global().Get("Array").New(len(values))
	for index, value := range values {
		array.SetIndex(index, value)
	}
	return array
}

// runExternal runs one command in the page and blocks until it answers.
//
// The block is safe: the wasm runtime parks the goroutine and returns to the
// JavaScript event loop, so the runner's promise can settle. When no runner is
// installed the command falls through to os/exec, which fails on js with a
// message naming the missing capability — better than pretending it ran.
func runExternal(cmd *exec.Cmd) (bool, error) {
	runner := js.Global().Get("arduinoExec")
	if runner.Type() != js.TypeFunction {
		return false, nil
	}

	type outcome struct {
		code           int
		stdout, stderr string
		failure        string
	}

	done := make(chan outcome, 1)
	var callback js.Func
	callback = js.FuncOf(func(this js.Value, args []js.Value) any {
		defer callback.Release()
		if len(args) == 0 || args[0].Type() != js.TypeObject {
			done <- outcome{code: -1, failure: "exec runner answered nothing"}
			return nil
		}
		// A missing property reads back as undefined, whose String() is the
		// literal "<undefined>". Reading it unconditionally turns a clean exit
		// into a failure, so only a real string counts.
		failure := ""
		if value := args[0].Get("error"); value.Type() == js.TypeString {
			failure = value.String()
		}
		done <- outcome{
			code:    args[0].Get("code").Int(),
			stdout:  args[0].Get("stdout").String(),
			stderr:  args[0].Get("stderr").String(),
			failure: failure,
		}
		return nil
	})

	// syscall/js converts a short list of Go types and panics on anything else:
	// a map or a []string is not one of them, so the request is built by hand.
	request := js.Global().Get("Object").New()
	request.Set("args", toJSArray(cmd.Args))
	request.Set("dir", cmd.Dir)
	request.Set("env", toJSArray(cmd.Env))
	runner.Invoke(request, callback)

	result := <-done

	// The CLI redirects the streams into buffers or feedback writers. Write the
	// captured text where the process would have written it.
	if result.stdout != "" && cmd.Stdout != nil {
		io.WriteString(cmd.Stdout, result.stdout)
	}
	if result.stderr != "" && cmd.Stderr != nil {
		io.WriteString(cmd.Stderr, result.stderr)
	}
	if result.failure != "" {
		return true, fmt.Errorf("%s", result.failure)
	}
	if result.code != 0 {
		return true, fmt.Errorf("%s: exit status %d", cmd.Args[0], result.code)
	}
	return true, nil
}
