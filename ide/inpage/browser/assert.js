// `assert` as the packages that import it use it: to state an invariant about
// their own arguments. The implementation is deliberately small and throws a
// real AssertionError, because a dependency that trips it should fail loudly and
// in the same way it does under Node.
class AssertionError extends Error {
  constructor(message) {
    super(message || "Assertion failed");
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
  }
}

function ok(value, message) {
  if (!value) {
    throw new AssertionError(message);
  }
}

module.exports = ok;
module.exports.ok = ok;
module.exports.AssertionError = AssertionError;
module.exports.equal = (actual, expected, message) => {
  if (actual != expected) {
    throw new AssertionError(message || actual + " != " + expected);
  }
};
module.exports.strictEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new AssertionError(message || actual + " !== " + expected);
  }
};
module.exports.notEqual = (actual, expected, message) => {
  if (actual == expected) {
    throw new AssertionError(message || actual + " == " + expected);
  }
};
module.exports.notStrictEqual = (actual, expected, message) => {
  if (actual === expected) {
    throw new AssertionError(message || actual + " === " + expected);
  }
};
module.exports.deepEqual = module.exports.deepStrictEqual = (actual, expected, message) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AssertionError(message || "values are not deep equal");
  }
};
module.exports.fail = (message) => {
  throw new AssertionError(message || "Failed");
};
module.exports.throws = (fn, _expected, message) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new AssertionError(message || "Missing expected exception");
};
