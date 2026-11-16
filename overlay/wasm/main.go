// Command wasm exposes the arduino-cli gRPC service to JavaScript.
//
// It is a thin bridge, not a reimplementation: every request and response is
// the real protobuf message from the arduino-cli API. The same handlers serve
// two encodings: protojson, for the page that speaks JSON, and protobuf binary,
// for the IDE's own generated gRPC client.
// Unary RPCs are dispatched by reflection over the real service
// implementation, so a new unary RPC added upstream works without a change
// here. Streaming RPCs use the callback adapters that arduino-cli already
// exports from its commands package.
//
// The JavaScript side calls:
//
//	arduinoCLI.call(method, requestJSON, callback)
//	arduinoCLI.callBinary(method, requestBase64, callback)
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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"runtime/debug"
	"syscall/js"

	"github.com/arduino/arduino-cli/commands"
	rpc "github.com/arduino/arduino-cli/rpc/cc/arduino/cli/commands/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/dynamicpb"
)

var (
	ctx = context.Background()
	srv = commands.NewArduinoCoreServer()

	marshal = protojson.MarshalOptions{}
)

type emitter func(eventType string, msg proto.Message)

// decode fills a request message from whichever wire encoding the caller used.
type decode func(proto.Message) error

// transport pairs the decoder for a call's request with the emitter for its
// responses, so that one handler serves both encodings.
type transport struct {
	decode decode
	emit   emitter
}

func main() {
	api := js.Global().Get("Object").New()
	api.Set("call", js.FuncOf(jsCall))
	api.Set("callBinary", js.FuncOf(jsCallBinary))
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

	go run(name, jsonTransport(requestJSON, callback), callback)

	return nil
}

// jsCallBinary is the same call carried as protobuf binary, which is what the
// IDE's generated client serializes and deserializes.
func jsCallBinary(this js.Value, args []js.Value) any {
	if len(args) != 3 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeString || args[2].Type() != js.TypeFunction {
		return errorEvent(args, fmt.Errorf("usage: callBinary(method, requestBase64, callback)"))
	}
	name := args[0].String()
	request, err := base64.StdEncoding.DecodeString(args[1].String())
	if err != nil {
		return errorEvent(args, fmt.Errorf("%s: request is not base64: %w", name, err))
	}
	callback := args[2]
	response, _ := responseDescriptor(name)

	go run(name, binaryTransport(request, response, callback), callback)

	return nil
}

func jsonTransport(requestJSON string, callback js.Value) transport {
	return transport{
		decode: func(msg proto.Message) error {
			return protojson.Unmarshal([]byte(requestJSON), msg)
		},
		emit: func(eventType string, msg proto.Message) {
			emitProto(callback, eventType, msg)
		},
	}
}

func binaryTransport(request []byte, response protoreflect.MessageDescriptor, callback js.Value) transport {
	return transport{
		decode: func(msg proto.Message) error {
			return proto.Unmarshal(request, msg)
		},
		emit: func(eventType string, msg proto.Message) {
			emitBinary(callback, eventType, msg, response)
		},
	}
}

// responseDescriptor names the message a streaming RPC carries on the wire.
// Every arduino-cli RPC names it after itself, so the type is resolvable without
// a table; a unary RPC gets its response type by reflection instead.
func responseDescriptor(name string) (protoreflect.MessageDescriptor, bool) {
	full := protoreflect.FullName("cc.arduino.cli.commands.v1." + name + "Response")
	message, err := protoregistry.GlobalTypes.FindMessageByName(full)
	if err != nil {
		return nil, false
	}
	return message.Descriptor(), true
}

// wrapResponse puts a progress or task message into the response message the RPC
// actually streams. A gRPC client sees, for example, a PlatformInstallResponse
// whose task_progress is set, not a bare TaskProgress; without this the generated
// client deserializes the inner message as its outer type.
func wrapResponse(response protoreflect.MessageDescriptor, inner proto.Message) (proto.Message, error) {
	wrapped := dynamicpb.NewMessage(response)
	innerName := inner.ProtoReflect().Descriptor().FullName()
	fields := response.Fields()
	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		if field.Kind() != protoreflect.MessageKind && field.Kind() != protoreflect.GroupKind {
			continue
		}
		if field.Message().FullName() != innerName {
			continue
		}
		wrapped.Set(field, protoreflect.ValueOfMessage(inner.ProtoReflect()))
		return wrapped, nil
	}
	return nil, fmt.Errorf("no field of %s carries a %s", response.FullName(), innerName)
}

func run(name string, tr transport, callback js.Value) {
	defer func() {
		if r := recover(); r != nil {
			send(callback, map[string]any{
				"type":    "error",
				"code":    int(codes.Internal),
				"message": fmt.Sprintf("panic in %s: %v\n%s", name, r, debug.Stack()),
			})
		}
	}()

	var err error
	if handler, ok := streamHandlers[name]; ok {
		err = handler(tr.decode, tr.emit)
	} else {
		err = invokeUnary(name, tr)
	}
	if err == errStreamStaysOpen {
		// The call is over as far as this side is concerned, and the client will
		// treat the stream as open for as long as the page lives.
		return
	}
	if err != nil {
		send(callback, failureEvent(err))
		return
	}
	send(callback, map[string]any{"type": "done"})
}

func invokeUnary(name string, tr transport) error {
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
	if err := tr.decode(msg); err != nil {
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
	tr.emit("result", response)
	return nil
}

// emitBinary is emitProto's protobuf counterpart: the same message unencoded,
// for a client that deserializes it with the generated message class.
func emitBinary(callback js.Value, eventType string, msg proto.Message, response protoreflect.MessageDescriptor) {
	if response != nil && msg.ProtoReflect().Descriptor().FullName() != response.FullName() {
		wrapped, err := wrapResponse(response, msg)
		if err != nil {
			send(callback, failureEvent(err))
			return
		}
		msg = wrapped
	}
	data, err := proto.Marshal(msg)
	if err != nil {
		send(callback, failureEvent(err))
		return
	}
	send(callback, map[string]any{
		"type":   eventType,
		"binary": base64.StdEncoding.EncodeToString(data),
	})
}

func emitProto(callback js.Value, eventType string, msg proto.Message) {
	data, err := marshal.Marshal(msg)
	if err != nil {
		send(callback, failureEvent(err))
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

// failureEvent carries both halves of what a gRPC client is given: the message
// and the status code. The extension decides what to do from the code -- a
// NotFound from LoadSketch means "this is not a sketch", not "something went
// wrong" -- so a bare message is not enough to answer with.
func failureEvent(err error) map[string]any {
	code := codes.Unknown
	if st, ok := status.FromError(err); ok {
		code = st.Code()
	}
	return map[string]any{"type": "error", "code": int(code), "message": errorText(err)}
}

func errorEvent(args []js.Value, err error) any {
	if len(args) >= 3 && args[2].Type() == js.TypeFunction {
		encoded, marshalErr := json.Marshal(failureEvent(err))
		if marshalErr != nil {
			args[2].Invoke(`{"type":"error","code":13,"message":"failed to encode error"}`)
		} else {
			args[2].Invoke(string(encoded))
		}
	}
	return nil
}

type streamHandler func(decode decode, emit emitter) error

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
	"Compile": func(decode decode, emit emitter) error {
		var req rpc.CompileRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := &compileStream{send: func(m *rpc.CompileResponse) error {
			emit("result", m)
			return nil
		}}
		return srv.Compile(&req, stream)
	},
	"Init": func(decode decode, emit emitter) error {
		var req rpc.InitRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.InitStreamResponseToCallbackFunction(ctx, func(r *rpc.InitResponse) error {
			emit("init", r)
			return nil
		})
		return srv.Init(&req, stream)
	},
	"UpdateIndex": func(decode decode, emit emitter) error {
		var req rpc.UpdateIndexRequest
		if err := decode(&req); err != nil {
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
	"UpdateLibrariesIndex": func(decode decode, emit emitter) error {
		var req rpc.UpdateLibrariesIndexRequest
		if err := decode(&req); err != nil {
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
	"PlatformInstall": func(decode decode, emit emitter) error {
		var req rpc.PlatformInstallRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.PlatformInstallStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.PlatformInstall(&req, stream)
	},
	"PlatformDownload": func(decode decode, emit emitter) error {
		var req rpc.PlatformDownloadRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.PlatformDownloadStreamResponseToCallbackFunction(ctx, downloadEmitter(emit))
		return srv.PlatformDownload(&req, stream)
	},
	"PlatformUninstall": func(decode decode, emit emitter) error {
		var req rpc.PlatformUninstallRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.PlatformUninstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.PlatformUninstall(&req, stream)
	},
	"PlatformUpgrade": func(decode decode, emit emitter) error {
		var req rpc.PlatformUpgradeRequest
		if err := decode(&req); err != nil {
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
	"LibraryInstall": func(decode decode, emit emitter) error {
		var req rpc.LibraryInstallRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.LibraryInstallStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.LibraryInstall(&req, stream)
	},
	"LibraryDownload": func(decode decode, emit emitter) error {
		var req rpc.LibraryDownloadRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.LibraryDownloadStreamResponseToCallbackFunction(ctx, downloadEmitter(emit))
		return srv.LibraryDownload(&req, stream)
	},
	"LibraryUninstall": func(decode decode, emit emitter) error {
		var req rpc.LibraryUninstallRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.LibraryUninstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.LibraryUninstall(&req, stream)
	},
	"LibraryUpgrade": func(decode decode, emit emitter) error {
		var req rpc.LibraryUpgradeRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.LibraryUpgradeStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.LibraryUpgrade(&req, stream)
	},
	"LibraryUpgradeAll": func(decode decode, emit emitter) error {
		var req rpc.LibraryUpgradeAllRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.LibraryUpgradeAllStreamResponseToCallbackFunction(ctx, downloadEmitter(emit), taskEmitter(emit))
		return srv.LibraryUpgradeAll(&req, stream)
	},
	"ZipLibraryInstall": func(decode decode, emit emitter) error {
		var req rpc.ZipLibraryInstallRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.ZipLibraryInstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.ZipLibraryInstall(&req, stream)
	},
	"GitLibraryInstall": func(decode decode, emit emitter) error {
		var req rpc.GitLibraryInstallRequest
		if err := decode(&req); err != nil {
			return err
		}
		stream := commands.GitLibraryInstallStreamResponseToCallbackFunction(ctx, taskEmitter(emit))
		return srv.GitLibraryInstall(&req, stream)
	},
	// The desktop IDE's board list is a watch: the daemon pushes a new list
	// whenever a port appears or disappears. The page has no in-process
	// discovery at all -- the builtin discovery tools are host executables, so
	// the js build loads none of them (see packagemanager/discovery_js.go) --
	// and its ports come from WebSerial. The watch therefore answers the shape
	// the daemon answers when nothing changes: no events and no end.
	// `errStreamStaysOpen` stops `run` from sending `done`, which would tell the
	// IDE the watch had ended and make it open another one immediately.
	"BoardListWatch": func(decode decode, emit emitter) error {
		var req rpc.BoardListWatchRequest
		if err := decode(&req); err != nil {
			return err
		}
		return errStreamStaysOpen
	},
	// The remaining five streaming RPCs each need something the page does not
	// have behind this transport: a host toolchain run with a serial port on the
	// other end (upload, uploadUsingProgrammer, burnBootloader), or a serial
	// device owned by the page (monitor, debug). Answering them by name is
	// better than letting `invokeUnary` report "not a unary RPC", which says
	// nothing to whoever reads it.
	"Upload":                 refuseStream("Upload", "uploads run over WebSerial from the page, not through the wasm CLI"),
	"UploadUsingProgrammer":  refuseStream("UploadUsingProgrammer", "uploads run over WebSerial from the page, not through the wasm CLI"),
	"BurnBootloader":         refuseStream("BurnBootloader", "a bootloader burn drives a programmer over WebSerial, which the page does not wire yet"),
	"Monitor":                refuseStream("Monitor", "the serial monitor owns a port the page has not wired to WebSerial yet"),
	"Debug":                  refuseStream("Debug", "debugging needs a gdb session over a device the page does not have"),
}

// errStreamStaysOpen marks a handler that has answered its stream and will
// never end it, which is a legal gRPC server stream.
var errStreamStaysOpen = errors.New("stream stays open")

func refuseStream(name, why string) streamHandler {
	return func(decode decode, emit emitter) error {
		return fmt.Errorf("%s is not available in the page: %s", name, why)
	}
}

var _ = commands.NewArduinoCoreServer
