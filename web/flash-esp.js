// Espressif flasher behind the generic upload-tool dispatcher.
//
// One plugin covers every chip esptool-js supports: ESP32, C2, C3, C5, C6,
// C61, H2, P4, S2, S3 and ESP8266. The chip is detected by talking to the
// device, not selected here. The library is vendored verbatim in vendor/;
// this module only adapts its public API to the flash registry's interface.

import { ESPLoader, Transport, parseIntelHex } from "./vendor/esptool-js-0.7.1.js";

const ESP_TOOLS = /^esptool(\.py|_py)?$/;

export function isEspTool(name) {
  return ESP_TOOLS.test(name.split("/").pop());
}

export function createEspFlash({ portProvider } = {}) {
  async function getPort() {
    if (portProvider) {
      const port = await portProvider();
      if (port) return port;
    }
    const serial = globalThis.navigator?.serial;
    if (!serial) throw new Error("WebSerial is not available in this browser");
    const ports = await serial.getPorts();
    return ports[0] || serial.requestPort();
  }

  return async function flashEsp({ hex, path, args, log = () => {} }) {
    const port = await getPort();
    if (!port) throw new Error("no WebSerial port was selected for upload");
    const transport = new Transport(port, true);
    const lines = [];
    const terminal = {
      clean() {},
      writeLine(text) { lines.push(String(text)); log(String(text)); },
      write(text) { lines.push(String(text)); log(String(text)); },
    };
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal,
      debugLogging: false,
    });
    const chip = await loader.main();
    let fileArray;
    if (/\.hex$/i.test(path || "")) {
      fileArray = parseIntelHex(new TextDecoder().decode(hex));
    } else {
      fileArray = [{ data: hex, address: 0 }];
    }
    await loader.writeFlash({
      fileArray,
      flashMode: "dio",
      flashFreq: "40m",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (index, written, total) => {
        log("flash " + chip + ": " + written + "/" + total);
      },
    });
    await loader.after("hard_reset");
    return {
      code: 0,
      stdout: "flashed " + fileArray.length + " image(s) to " + chip + "\n",
      stderr: lines.slice(-20).join("\n") + "\n",
      files: [],
    };
  };
}
