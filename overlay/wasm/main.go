// Command wasm exposes the arduino-cli gRPC service to JavaScript.
//
// It is a thin bridge, not a reimplementation: every request and response is
// the real protobuf message from the arduino-cli API, encoded as protojson.
// Unary RPCs are dispatched by reflection over the real service
// implementation, so a new unary RPC added upstream works without a change
// here. Streaming RPCs use the callback adapters that arduino-cli already
// exports from its commands package.
//
// The JavaScript side calls:
//
//	arduinoCLI.call(method, requestJSON, callback)
//
// and receives, in order, zero or more event objects and exactly one terminal
// object:
//
//	{"type":"init",    "data": <InitResponse>}
//	{"type":"progress","data": <DownloadProgress>}
//	{"type":"task",    "data": <TaskProgress>}
//	{"type":"result",  "data": <...Response_Result>}
//	{"type":"done"}
//	{"type":"error",   "message": "..."}
//
// The call returns immediately. Work runs on a goroutine, because blocking the
// JavaScript stack would stop the event loop that fetch() and the filesystem
// shim need in order to make progress.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"runtime/debug"
	"syscall/js"

	"github.com/arduino/arduino-cli/commands"
	rpc "github.com/arduino/arduino-cli/rpc/cc/arduino/cli/commands/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var (
	ctx = context.Background()
	srv = commands.NewArduinoCoreServer()

	marshal = protojson.MarshalOptions{}
)

type emitter func(eventType string, msg proto.Message)

func main() {
	api := js.Global().Get("Object").New()
	api.Set("call", js.FuncOf(jsCall))
	js.Global().Set("arduinoCLI", api)

	// Signals to the page that the module is instantiated and the API exists.
	js.Global().Call("arduinoCLIReady")

	select {}
}

func jsCall(this js.Value, args []js.Value) any {
	if len(args) != 3 || args[0].Type() != js.TypeString || args[2].Type() != js.TypeFunction {
		return errorEvent(args, fmt.Errorf("usage: call(method, requestJSON, callback)"))
	}
	name := args[0].String()
	requestJSON := args[1].String()
	callback := args[2]

	go run(name, requestJSON, callback)

	return nil
}

func run(name, requestJSON string, callback js.Value) {
	defer func() {
		if r := recover(); r != nil {
			send(callback, map[string]any{
				"type":    "error",
				"message": fmt.Sprintf("panic in %s: %v\n%s", name, r, debug.Stack()),
			})
		}
	}()

	var err error
	if handler, ok := streamHandlers[name]; ok {
		err = handler(requestJSON, func(eventType string, msg proto.Message) {
			emitProto(callback, eventType, msg)
		})
	} else {
		err = invokeUnary(name, requestJSON, callback)
	}
	if err != nil {
		send(callback, map[string]any{"type": "error", "message": errorText(err)})
		return
	}
	send(callback, map[string]any{"type": "done"})
}

func invokeUnary(name, requestJSON string, callback js.Value) error {
	method := reflect.ValueOf(srv).MethodByName(name)
	if !method.IsValid() {
		return fmt.Errorf("unknown RPC %q", name)
	}
	typ := method.Type()
	if typ.NumIn() != 2 || typ.NumOut() != 2 {
		return fmt.Errorf("%q is not a unary RPC", name)
	}

	request := reflect.New(typ.In(1).Elem())
	msg, ok := request.Interface().(proto.Message)
	if !ok {
		return fmt.Errorf("%q has an unsupported request type", name)
	}
	if err := protojson.Unmarshal([]byte(requestJSON), msg); err != nil {
		return fmt.Errorf("%q: invalid request: %w", name, err)
	}

	out := method.Call([]reflect.Value{reflect.ValueOf(ctx), request})
	if errValue := out[1]; !errValue.IsNil() {
		return errValue.Interface().(error)
	}
	response, ok := out[0].Interface().(proto.Message)
	if !ok {
		return fmt.Errorf("%q has an unsupported response type", name)
	}
	emitProto(callback, "result", response)
	return nil
}

func emitProto(callback js.Value, eventType string, msg proto.Message) {
	data, err := marshal.Marshal(msg)
	if err != nil {
		send(callback, map[string]any{"type": "error", "message": err.Error()})
		return
	}
	event := map[string]any{"type": eventType, "data": json.RawMessage(data)}
	send(callback, event)
}

func send(callback js.Value, event map[string]any) {
	encoded, err := json.Marshal(event)
	if err != nil {
		callback.Invoke(`{"type":"error","message":"failed to encode event"}`)
		return
	}
	callback.Invoke(string(encoded))
}

func errorText(err error) string {
	if st, ok := status.FromError(err); ok && st.Message() != "" {
		return st.Message()
	}
	return err.Error()
}

func errorEvent(args []js.Value, err error) any {
	if len(args) >= 3 && args[2].Type() == js.TypeFunction {
		args[2].Invoke(fmt.Sprintf(`{"type":"error","message":%q}`, err.Error()))
	}
	return nil
}

type streamHandler func(requestJSON string, emit emitter) error

func unmarshal(requestJSON string, msg proto.Message) error {
	if err := protojson.Unmarshal([]byte(requestJSON), msg); err != nil {
		return fmt.Errorf("invalid request: %w", err)
	}
	return nil
}

func downloadEmitter(emit emitter) rpc.DownloadProgressCB {
	return func(p *rpc.DownloadProgress) { emit("progress", p) }
}

func taskEmitter(emit emitter) rpc.TaskProgressCB {
	return func(p *rpc.TaskProgress) { emit("task", p) }
}

// streamHandlers are the RPCs that send more than one response. Each one calls
// the real service method with the real request type; only the transport is
// replaced.
// compileStream carries CompileResponse values from the real Compile method to
// the JavaScript callback. Compile is the one RPC arduino-cli exposes as a
// server stream without shipping a callback adapter, so the adapter lives here.
// Everything else about the call is upstream's.
type compileStream struct {
	send func(*rpc.CompileResponse) error
}

func (s *compileStream) Send(m *rpc.CompileResponse) error { return s.send(m) }
func (s *compileStream) SetHeader(metadata.MD) error       { return nil }
func (s *compileStream) SendHeader(metadata.MD) error      { return nil }
func (s *compileStream) SetTrailer(metadata.MD)            {}
func (s *compileStream) Context() context.Context          { return ctx }
func (s *compileStream) SendMsg(any) error                 { return nil }
func (s *compileStream) RecvMsg(any) error                 { return io.EOF }

var _ grpc.ServerStreamingServer[rpc.CompileResponse] = (*compileStream)(nil)

var streamHandlers = map[string]streamHandler{
	"Compile": func(reqJSON string, emit emitter) error {
		var req rpc.CompileRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := &compileStream{send: func(m *rpc.CompileResponse) error {
			emit("result", m)
			return nil
		}}
		return srv.Compile(&req, stream)
	},
	"Init": func(reqJSON string, emit emitter) error {
		var req rpc.InitRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.InitStreamResponseToCallbackFunction(ctx, func(r *rpc.InitResponse) error {
			emit("init", r)
			return nil
		})
		return srv.Init(&req, stream)
	},
	"UpdateIndex": func(reqJSON string, emit emitter) error {
		var req rpc.UpdateIndexRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream, result := commands.UpdateIndexStreamResponseToCallbackFunction(ctx, downloadEmitter(emit))
		if err := srv.UpdateIndex(&req, stream); err != nil {
			return err
		}
		if r := result(); r != nil {
			emit("result", r)
		}
		return nil
	},
	"UpdateLibrariesIndex": func(reqJSON string, emit emitter) error {
		var req rpc.UpdateLibrariesIndexRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream, result := commands.UpdateLibrariesIndexStreamResponseToCallbackFunction(ctx, downloadEmitter(emit))
		if err := srv.UpdateLibrariesIndex(&req, stream); err != nil {
			return err
		}
		if r := result(); r != nil {
			emit("result", r)
		}
		return nil
	},
	"PlatformInstall": func(reqJSON string, emit emitter) error {
		var req rpc.PlatformInstallRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.PlatformInstallStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.PlatformInstall(&req, stream)
	},
	"PlatformDownload": func(reqJSON string, emit emitter) error {
		var req rpc.PlatformDownloadRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.PlatformDownloadStreamResponseToCallbackFunction(ctx, downloadEmitter(emit))
		return srv.PlatformDownload(&req, stream)
	},
	"PlatformUninstall": func(reqJSON string, emit emitter) error {
		var req rpc.PlatformUninstallRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.PlatformUninstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.PlatformUninstall(&req, stream)
	},
	"PlatformUpgrade": func(reqJSON string, emit emitter) error {
		var req rpc.PlatformUpgradeRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream, result := commands.PlatformUpgradeStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		if err := srv.PlatformUpgrade(&req, stream); err != nil {
			return err
		}
		if r := result(); r != nil {
			emit("result", r)
		}
		return nil
	},
	"LibraryInstall": func(reqJSON string, emit emitter) error {
		var req rpc.LibraryInstallRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.LibraryInstallStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.LibraryInstall(&req, stream)
	},
	"LibraryDownload": func(reqJSON string, emit emitter) error {
		var req rpc.LibraryDownloadRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.LibraryDownloadStreamResponseToCallbackFunction(ctx, downloadEmitter(emit))
		return srv.LibraryDownload(&req, stream)
	},
	"LibraryUninstall": func(reqJSON string, emit emitter) error {
		var req rpc.LibraryUninstallRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.LibraryUninstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.LibraryUninstall(&req, stream)
	},
	"LibraryUpgrade": func(reqJSON string, emit emitter) error {
		var req rpc.LibraryUpgradeRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.LibraryUpgradeStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.LibraryUpgrade(&req, stream)
	},
	"LibraryUpgradeAll": func(reqJSON string, emit emitter) error {
		var req rpc.LibraryUpgradeAllRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.LibraryUpgradeAllStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.LibraryUpgradeAll(&req, stream)
	},
	"ZipLibraryInstall": func(reqJSON string, emit emitter) error {
		var req rpc.ZipLibraryInstallRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.ZipLibraryInstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.ZipLibraryInstall(&req, stream)
	},
	"GitLibraryInstall": func(reqJSON string, emit emitter) error {
		var req rpc.GitLibraryInstallRequest
		if err := unmarshal(reqJSON, &req); err != nil {
			return err
		}
		stream := commands.GitLibraryInstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.GitLibraryInstall(&req, stream)
	},
}

var _ = commands.NewArduinoCoreServer
