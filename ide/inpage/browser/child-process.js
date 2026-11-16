// A browser cannot start a process. The desktop backend uses `child_process`
// for two things: running clang-format, and running the CLI's own helper tasks.
// Both are places where a page must either do the work another way or say it
// cannot, and saying so by name is better than a stream that never emits.
function refuse(name) {
  throw new Error(
    "child_process." + name + " is not available in the page: nothing can spawn a process here",
  );
}

module.exports = {
  spawn: (..._args) => refuse("spawn"),
  spawnSync: (..._args) => refuse("spawnSync"),
  exec: (..._args) => refuse("exec"),
  execSync: (..._args) => refuse("execSync"),
  execFile: (..._args) => refuse("execFile"),
  execFileSync: (..._args) => refuse("execFileSync"),
  fork: (..._args) => refuse("fork"),
};
