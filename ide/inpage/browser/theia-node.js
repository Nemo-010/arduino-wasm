// `library-service-impl.js` imports `@theia/core/lib/node`, an index that pulls
// the whole Node backend surface -- express, websockets, the CLI server -- none
// of which a page has. The only symbol it uses from that index is `FileUri`, a
// pure URI helper that already lives in Theia's browser-safe common package.
//
// So this module is that one re-export, and the bundler resolves the index to it
// instead of to the server. If a future version of the extension starts using
// another symbol from that index, the call site fails by name rather than
// quietly getting `undefined`.
const { FileUri } = require("@theia/core/lib/common/file-uri");

module.exports = { FileUri };
