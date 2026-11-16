// A drop-in for `fs/promises`.
//
// The promise API is the same object the facade already exposes as
// `fs.promises`, so this forwards rather than wrapping again: two promise
// surfaces would drift, and the one that is wrong is the one somebody trusts.
const fs = require("./fs.js");

module.exports = fs.promises;
