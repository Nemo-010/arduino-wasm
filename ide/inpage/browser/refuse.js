// Stands in for a Node-only module that nothing in the page's path should reach.
//
// Reaching it is a defect, so every property access throws with the module's own
// name in the message rather than returning `undefined` and failing later
// somewhere unrelated.
module.exports = new Proxy(
  {},
  {
    get(_target, name) {
      throw new Error(
        "A Node-only Theia module was required in the page (property " +
          String(name) +
          "); the browser bundle must not need it",
      );
    },
  },
);
