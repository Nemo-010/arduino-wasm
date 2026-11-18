// Link-time shim for Emscripten-built upload tools.
//
// Compile a tool with:
//   emcc tool.c scripts/serial-shim.c -Wl,--wrap=read \
//     -s ASYNCIFY=1 -s EXPORTED_RUNTIME_METHODS='["FS","callMain","HEAPU8"]'
//
// POSIX read() on a device fd then suspends the C caller until the page's
// WebSerial device has bytes. Ordinary file reads go to the real read().
// No change to the tool's own source is needed.

#include <sys/types.h>
#include <emscripten.h>

extern ssize_t __real_read(int fd, void *buf, size_t count);

EM_ASYNC_JS(ssize_t, serial_read_async, (int fd, void *buf, size_t count), {
  return await globalThis.__arduinoSerialRead(fd, buf, count);
});

ssize_t __wrap_read(int fd, void *buf, size_t count) {
  // fds 0..2 are stdio; nodefs/Emscripten allocate device fds from 3.
  if (fd >= 3) return serial_read_async(fd, buf, count);
  return __real_read(fd, buf, count);
}
