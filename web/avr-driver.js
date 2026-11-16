// AVR toolchain driver: answers the arduino-cli exec seam with a real build.
//
// arduino-cli never names the tools it runs; it expands recipes from the
// installed platform's platform.txt. The AVR recipes call avr-g++, avr-gcc-ar,
// avr-objcopy, avr-size and ctags, which are x86-64 binaries. This module
// receives those command lines verbatim and produces the same results from four
// wasm tools: cc1plus, as, ld and objcopy.
//
// What is faithful and what is not:
//
//   * avr-g++ is a driver. Its two jobs are kept: pick the architecture and run
//     the front end, then assemble. cc1plus writes the .s, as makes the .o.
//   * avr-gcc-ar is not implemented. Each member is recorded and the archive is
//     expanded again at link time, so core.a is a list rather than a container.
//     A linker script or a Makefile that expects to *inspect* the archive will
//     not find one.
//   * -flto and -fuse-linker-plugin are removed. There is no lto1 and no plugin
//     interface in these wasm builds, and every object here is compiled from
//     source in the same run, so nothing needs to defer code generation.
//   * The device name is not passed to the compiler. This cc1plus was built
//     without GCC's device table and accepts only architecture names (avr2,
//     avr5, ...), so scripts/gen-avr-mcus.py turns the device into its
//     architecture and its <avr/io.h> macro.
//   * .c files are compiled as C++. Only cc1plus ships in the release; there is
//     no cc1. -fpermissive and a C++ -std= stand in for the C front end.
//   * ctags answers with no output. arduino-cli tolerates that; the cost is that
//     a sketch calling a function before defining it gets no forward prototype.
//
// The contract with the page is a command line in and files out. Every file the
// tool would have written on a real machine is returned to the caller, which
// writes it into the same filesystem arduino-cli reads.

import { AVR_DEVICES } from "./avr-mcus.js";
import { readTarGz } from "./tar.js";
import {
  basename,
  createToolInstance,
  elfSections,
  flagValue,
  flagValues,
  hasFlag,
  joinedValue,
  mkdirp,
  operands,
  parseArgs,
  readFileIfAny,
  writeFile,
} from "./tool-common.js";

const SYSROOT = "/wasm-avr/sysroot";
const GCC_VERSION = "7.3.0";
const INCLUDE_DIRS = [
  SYSROOT + "/avr/include",
  SYSROOT + "/lib/gcc/avr/" + GCC_VERSION + "/include",
  SYSROOT + "/lib/gcc/avr/" + GCC_VERSION + "/include-fixed",
];

// Flags whose value is the following argv element. Everything else that starts
// with "-" is a single token, joined values (-DFOO, -mmcu=x) included.
const VALUE_FLAGS = new Set([
  "-o", "-I", "-isystem", "-iquote", "-idirafter", "-include", "-imacros",
  "-D", "-U", "-MF", "-MT", "-MQ", "-x", "-L", "-l", "-T", "-B",
  "-isysroot", "-iprefix", "-iwithprefix", "--param", "-e", "-u", "-Map",
  "-m", "-z", "-G", "-Xlinker", "-Xassembler", "-Xpreprocessor",
  // objcopy: "-O ihex", "-j .eeprom", "-R .eeprom" all take a separate value.
  // -A is deliberately absent: avr-size spells "all sections" as a bare -A.
  "-O", "-j", "-R",
  // objcopy's other value-taking options. The eeprom recipe uses
  // "--change-section-lma .eeprom=0"; treating that value as a file operand is
  // how the .eep step silently produced nothing.
  "--change-section-lma", "--change-section-vma", "--change-section-address",
  "--adjust-section-vma", "--adjust-section-lma", "--set-start", "--gap-fill",
  "--pad-to", "--redefine-sym", "--redefine-syms", "--add-section",
  "--rename-section", "--set-section-flags", "--interleave", "-b", "-F",
]);

// Flags ld understands. Anything else on the link line is a compiler or
// front-end flag (-w, -Os, -g, -std=, -f*, -W*, -D*, -I*, -MMD) and is dropped.
const LINK_FLAGS = new Set([
  "-nostdlib", "-nostartfiles", "-nodefaultlibs", "-static", "-shared", "-r",
  "-s", "-N", "--gc-sections", "--relax", "--no-relax", "--noinhibit-exec",
]);

// The device as platform.txt spells it: -mmcu=atmega328p. `-mmcu avr5` is
// accepted too, because a user may have put an architecture there by hand.
function readMcu(tokens) {
  const joined = joinedValue(tokens, "-mmcu=");
  if (joined) return joined;
  const separate = flagValue(tokens, "-mmcu");
  if (separate) return separate;
  const bare = flagValue(tokens, "-m");
  return bare || null;
}

function architectureFor(mcu) {
  if (!mcu) return null;
  if (AVR_DEVICES[mcu]) return AVR_DEVICES[mcu][0];
  // An architecture name passed directly (avr5, avr25, ...) is already usable.
  if (mcu.startsWith("avr")) return mcu;
  return null;
}

// cc1plus is a C++ front end and rejects C dialect flags. The AVR C recipe
// passes -std=gnu11, which would stop every .c file in the core.
function rewriteStandard(flag) {
  if (!flag.startsWith("-std=")) return flag;
  const dialect = flag.slice(5);
  if (/^(c\+\+|gnu\+\+|cxx)/.test(dialect)) return flag;
  return "-std=gnu++11";
}

function isDroppedForFrontend(flag) {
  if (flag === "-c" || flag === "-E" || flag === "-S") return true;
  if (flag === "-o" || flag === "-x") return true;
  // Dependency-file flags are driver spellings; dependencyArgs() re-emits them
  // in the form the front end accepts.
  if (flag === "-MF" || flag === "-MD" || flag === "-MMD") return true;
  if (flag === "-flto" || flag === "-fno-fat-lto-objects") return true;
  if (flag === "-fuse-linker-plugin" || flag === "-fno-lto") return true;
  if (flag === "-fwhole-program" || flag === "-fno-whole-program") return true;
  if (flag === "-nostdlib" || flag === "-nostartfiles" || flag === "-nodefaultlibs") return true;
  if (flag.startsWith("-mmcu=") || flag === "-mmcu" || flag === "-m") return true;
  if (flag.startsWith("-Wl,") || flag.startsWith("-Xlinker")) return true;
  if (flag.startsWith("-L") || flag.startsWith("-l") || flag.startsWith("-T")) return true;
  if (flag.startsWith("-B")) return true;
  return false;
}

// cc1plus is the front end, not the driver, and the two disagree about how a
// dependency file is spelled. The front end's -MMD takes the file name as a
// separate argument and it has no -MF at all, so "-MMD -MF x.d" makes it read
// x.d as a second input file (measured: "error: too many filenames given" then
// "fatal error: x.d: No such file or directory"). Translate the driver's
// spelling into "-MMD <path>", taking the path from -MF, or from the output
// name the way the driver does when -MF is absent.
function dependencyArgs(tokens, output) {
  const wanted = hasFlag(tokens, "-MMD") ? "-MMD" : hasFlag(tokens, "-MD") ? "-MD" : null;
  if (!wanted) return [];
  let depfile = flagValue(tokens, "-MF") || joinedValue(tokens, "-MF");
  if (!depfile && output) depfile = output.replace(/\.[^./]*$/, "") + ".d";
  if (!depfile) {
    note("avr driver: " + wanted + " without -MF and without -o, so no dependency file is written");
    return [];
  }
  return [wanted, depfile];
}

// The front end's argument list: everything from the recipe that describes the
// translation unit, plus the architecture, the device macro and the sysroot.
function frontendArgs(tokens, mcu, output) {
  const args = [];
  const arch = architectureFor(mcu);
  const device = mcu && AVR_DEVICES[mcu] ? AVR_DEVICES[mcu][1] : null;

  for (const token of tokens) {
    if (token.operand !== undefined) continue;
    const flag = token.flag;
    if (isDroppedForFrontend(flag)) continue;
    if (token.value !== undefined) {
      args.push(rewriteStandard(flag), token.value);
    } else {
      args.push(rewriteStandard(flag));
    }
  }

  if (arch) args.push("-mmcu=" + arch);
  if (device) args.push("-D" + device);
  args.push("-fpermissive");
  // The sysroot ships no libstdc++, so the vtable of the typeinfo classes
  // (__cxxabiv1::__si_class_type_info and friends) does not exist here. A real
  // Arduino build links anyway because -flto lets GCC drop unreferenced RTTI,
  // and this driver strips -flto: wasm ld has no LTO plugin. RTTI off is the
  // substitute, and it is what the precedent's own precompiled core.a was
  // built with (it carries _ZTV symbols but no _ZTI ones). Measured without it:
  // "undefined reference to `vtable for __cxxabiv1::__si_class_type_info'"
  // from HardwareSerial.cpp.o.
  if (!hasFlag(tokens, "-frtti")) args.push("-fno-rtti");
  for (const dir of INCLUDE_DIRS) args.push("-I" + dir);
  args.push(...dependencyArgs(tokens, output));
  return args;
}

// C does not mangle names. An alias declaration names the aliased symbol, and
// the alias target keeps its own identifier as the assembler name. The C++
// front end mangles both, so a C file that aliases a static function cannot be
// compiled as C++ verbatim. Measured on ArduinoCore-avr 1.8.6
// cores/arduino/hooks.c, which is nothing but
//   static void __empty() { }
//   void yield(void) __attribute__ ((weak, alias("__empty")));
// as C++: "error: 'void yield()' aliased to undefined symbol '__empty'", and a
// link that wants plain `yield` (wiring.c:111, from delay(), declared inside
// Arduino.h's extern "C" block) finds _Z5yieldv instead. The two edits below
// restore exactly what a C compiler emits, and nothing else.
function restoreCLinkage(text) {
  const notes = [];
  const targets = [];
  const aliasUse = /alias\s*\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g;
  for (let match; (match = aliasUse.exec(text)); ) targets.push(match[1]);

  let result = text;
  for (const target of new Set(targets)) {
    // The target must answer to its plain name, so it needs an explicit
    // assembler label; without one a static function is mangled (_ZL6__emptyv)
    // and the string in the attribute cannot resolve. A label is only allowed
    // on a declaration, not on a definition ("an asm-specification is not
    // allowed on a function-definition"), so the declaration is emitted in
    // front of the definition with the same signature.
    const definition = new RegExp("(static\\s+[A-Za-z_][^;{}()]*?\\b" + target + "\\s*\\([^)]*\\))(\\s*\\{)");
    let found = false;
    result = result.replace(definition, (whole, signature, brace) => {
      found = true;
      return signature + ' __asm__("' + target + '");\n' + signature + brace;
    });
    notes.push(found
      ? "C alias target " + target + " keeps its plain assembler name"
      : "no static definition of C alias target " + target + " was found; the front end will report it");
  }

  // The alias declaration itself names the symbol, so it takes C linkage.
  const declaration = /(^|\n)([ \t]*)([A-Za-z_][^;{}\n]*?)\s*__attribute__\s*\(\(\s*weak\s*,\s*alias\s*\(/g;
  result = result.replace(declaration, (whole, lineStart, indent, prefix) => {
    notes.push("C alias declaration given extern \"C\" linkage");
    return lineStart + indent + 'extern "C" ' + prefix + ' __attribute__ ((weak, alias(';
  });

  return { text: result, notes };
}

export async function createAvrDriver(options) {
  const { readAsset, importModule, readFile, listDir, isDirectory, log } = options;
  const note = log || (() => undefined);

  const archive = await readTarGz(await readAsset("sysroot.tar.gz"));
  const sysrootFiles = archive
    .filter((entry) => entry.type === "file" && entry.name.startsWith("sysroot/"))
    .map((entry) => ({ path: SYSROOT + "/" + entry.name.slice("sysroot/".length), data: entry.data }));
  // Assert the three things the recipes need by name. A file count would pass
  // on a sysroot that had lost, say, every linker script.
  for (const required of ["/avr/include/avr/io.h", "/avr/lib/avr5/libc.a", "/avr/lib/ldscripts/avr5.x"]) {
    if (!sysrootFiles.some((file) => file.path === SYSROOT + required)) {
      throw new Error("sysroot.tar.gz is missing " + required);
    }
  }
  note("avr driver: " + sysrootFiles.length + " sysroot files");
  note("avr driver: RTTI is disabled because the sysroot has no libstdc++; typeid and dynamic_cast will not compile");

  // core.a is recorded, not written. Keyed by archive path, ordered by arrival.
  const archives = new Map();
  const factories = new Map();

  async function factory(name) {
    if (!factories.has(name)) {
      const module = await importModule(name);
      factories.set(name, module.default || module.createTool);
    }
    return factories.get(name);
  }

  // Stage the sysroot and the named inputs into the tool's own filesystem.
  async function stage(FS, { files, directories }) {
    for (const file of sysrootFiles) writeFile(FS, file.path, file.data);

    const seen = new Set();
    const addFile = async (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      const data = await readFile(path);
      if (!data) return;
      writeFile(FS, path, data);
    };

    const addTree = async (dir) => {
      if (seen.has("dir:" + dir)) return;
      seen.add("dir:" + dir);
      const names = await listDir(dir);
      if (!names) return;
      mkdirp(FS, dir);
      for (const name of names) {
        const child = dir.replace(/\/$/, "") + "/" + name;
        if (await isDirectory(child)) await addTree(child);
        else await addFile(child);
      }
    };

    for (const file of files) await addFile(file);
    for (const dir of directories) await addTree(dir);
  }

  async function runTool(name, argv, { files, directories, outputs, extra }) {
    const create = await factory(name);
    const wasmBinary = await readAsset(name + ".wasm");
    let stdout = "";
    let stderr = "";
    const instance = await createToolInstance(create, {
      wasmBinary,
      noInitialRun: true,
      noExitRuntime: true,
      print: (line) => { stdout += line + "\n"; },
      printErr: (line) => { stderr += line + "\n"; },
    });

    // The tool cannot write into a directory that does not exist in its own
    // filesystem, so every output's parent is created before the call.
    for (const path of outputs || []) {
      const parent = path && path.slice(0, path.lastIndexOf("/"));
      if (parent) mkdirp(instance.FS, parent);
    }

    await stage(instance.FS, { files, directories });
    for (const file of extra || []) writeFile(instance.FS, file.path, file.data);

    let code = 0;
    try {
      // Emscripten's handleException catches ExitStatus and returns its status,
      // so a tool that fails reports through this return value and throws
      // nothing. Measured: cc1plus on a missing input returns 1, throws null.
      const status = instance.callMain(argv);
      if (typeof status === "number") code = status;
    } catch (error) {
      // A tool can still throw: an abort inside the runtime is not an exit.
      if (error && typeof error.status === "number") code = error.status;
      else throw error;
    }
    // In Node, Emscripten's quit_ sets process.exitCode as well as returning
    // the status, which would make a passing test exit non-zero because one
    // tool inside it failed. The status is returned instead; clear the leak.
    if (typeof process !== "undefined" && typeof process.exitCode === "number" && process.exitCode !== 0) process.exitCode = 0;

    const written = [];
    for (const path of outputs) {
      if (!path || path === "/dev/null") continue;
      const data = readFileIfAny(instance.FS, path);
      if (data) written.push({ path, data });
      // An exit code of zero with no file is the failure mode this driver must
      // never hide: the caller would go on to use a file that does not exist.
      else note("avr driver: " + name + " exited " + code + " without writing " + path + "\n  argv: " + argv.join(" ") + "\n  stderr: " + stderr.slice(0, 2000));
    }
    return { code, stdout, stderr, files: written };
  }

  // Inputs named directly on the command line, plus the directories that -I and
  // friends point at, are copied in. Anything the tool reads has to be named one
  // of those two ways, which is true of every recipe in platform.txt.
  function inputsFrom(tokens) {
    const files = [];
    const directories = [];
    for (const token of tokens) {
      if (token.operand !== undefined) files.push(token.operand);
      if (token.flag === "-I" || token.flag === "-isystem" || token.flag === "-iquote" || token.flag === "-idirafter") {
        directories.push(token.value);
      }
      if (token.flag && (token.flag.startsWith("-I") || token.flag.startsWith("-isystem"))) {
        const value = token.flag.replace(/^-isystem/, "").replace(/^-I/, "");
        if (value) directories.push(value);
      }
      if (token.flag === "-include" || token.flag === "-imacros") files.push(token.value);
    }
    return { files, directories };
  }

  async function preprocess(tokens, { assembler }) {
    const target = flagValue(tokens, "-o");
    const source = operands(tokens).pop();
    const { files, directories } = inputsFrom(tokens);
    const argv = frontendArgs(tokens, readMcu(tokens), target);
    argv.push("-E");
    // -x assembler-with-cpp is a driver option; cc1plus rejects it ("valid for
    // the driver but not for C++"). Preprocessing only copies tokens, so the
    // C++ front end reads a .S file correctly without it.
    if (assembler) note("avr driver: preprocessing " + source + " as token text");
    if (target) argv.push("-o", target);
    argv.push(source);

    const dependencies = dependencyArgs(tokens, target);
    const outputs = [target, dependencies[1]].filter(Boolean);
    const result = await runTool("cc1plus", argv, { files, directories, outputs });
    return result;
  }

  async function compile(tokens, { assembler }) {
    const object = flagValue(tokens, "-o");
    const source = operands(tokens).pop();
    const assembly = object + ".s";
    const arch = architectureFor(readMcu(tokens));
    const { files, directories } = inputsFrom(tokens);

    // A .c file is compiled as C++ here because only the C++ front end is
    // shipped. Where C and C++ disagree about a symbol's name, C wins: the
    // rewritten text below replaces the file the tools read.
    let overridden = [];
    if (!assembler && /\.c$/.test(source)) {
      const bytes = await readFile(source);
      const text = bytes ? new TextDecoder().decode(bytes) : "";
      if (text.includes("alias")) {
        const restored = restoreCLinkage(text);
        for (const line of restored.notes) note("avr driver: " + line);
        overridden = [{ path: source, data: new TextEncoder().encode(restored.text) }];
      }
    }
    // The dependency file is named after the object the recipe asked for, not
    // after the intermediate .s this driver happens to produce.
    const depfile = dependencyArgs(tokens, object)[1] || null;

    // Flags common to both paths. The output and the source are appended per
    // branch, because a .S file is preprocessed rather than compiled.
    const base = frontendArgs(tokens, readMcu(tokens), object);

    // A .S file is not C++: cc1plus preprocesses it as token text, and `as`
    // assembles the result. -mmcu alone is not enough: real gcc's
    // "-x assembler-with-cpp" also defines __ASSEMBLER__, which is what keeps
    // avr-libc's typedefs out of the assembler stream (measured: without it,
    // stdint.h reaches `as` as "unknown opcode `typedef`").
    if (assembler) {
      const preprocessed = object + ".s";
      const pre = await runTool("cc1plus", [...base, "-D__ASSEMBLER__", "-E", "-o", preprocessed, source], {
        files,
        directories,
        outputs: [preprocessed, depfile].filter(Boolean),
      });
      if (pre.code !== 0) return pre;
      const text = pre.files.find((file) => file.path === preprocessed);
      if (!text) {
        return { code: 1, stdout: pre.stdout, stderr: pre.stderr + "avr driver: preprocessor produced nothing for " + source + "\n", files: [] };
      }
      const assembled = await runTool("as", ["-mmcu=" + arch, "-o", object, preprocessed], {
        files: [],
        directories: [],
        outputs: [object],
        extra: [{ path: preprocessed, data: text.data }],
      });
      return {
        code: assembled.code,
        stdout: pre.stdout + assembled.stdout,
        stderr: pre.stderr + assembled.stderr,
        files: assembled.files.concat(pre.files.filter((file) => file.path === depfile)),
      };
    }

    const argv = [...base, "-o", assembly, source];
    const front = await runTool("cc1plus", argv, {
      files,
      directories,
      outputs: [assembly, depfile].filter(Boolean),
      extra: overridden,
    });
    if (front.code !== 0) return front;
    const assemblyBytes = front.files.find((file) => file.path === assembly);
    if (!assemblyBytes) {
      return { code: 1, stdout: front.stdout, stderr: front.stderr + "cc1plus produced no assembly for " + source + "\n", files: [] };
    }

    // The assembler also needs the architecture. Without it `as` assumes avr2
    // and rejects muls, jmp and postincrement for anything newer.
    const assemble = await runTool("as", ["-mmcu=" + arch, "-o", object, assembly], {
      files: [],
      directories: [],
      outputs: [object],
      extra: [{ path: assembly, data: assemblyBytes.data }],
    });
    return {
      code: assemble.code,
      stdout: front.stdout + assemble.stdout,
      stderr: front.stderr + assemble.stderr,
      // The intermediate .s is not a deliverable, but the dependency file is.
      files: assemble.files.concat(front.files.filter((file) => file.path === depfile)),
    };
  }

  async function link(tokens) {
    const mcu = readMcu(tokens);
    const arch = architectureFor(mcu);
    const device = mcu && AVR_DEVICES[mcu] ? mcu : null;
    const output = flagValue(tokens, "-o");
    if (!arch) {
      return { code: 1, stdout: "", stderr: "cannot link: no -mmcu= was given\n", files: [] };
    }

    const objects = [];
    const libraries = [];
    const searchPaths = [];
    const linkerFlags = [];
    const libraries_ = [];

    for (const token of tokens) {
      if (token.operand !== undefined) {
        const members = archives.get(token.operand);
        if (members) objects.push(...members);
        else objects.push(token.operand);
        continue;
      }
      const flag = token.flag;
      if (flag === "-o") continue;
      if (flag === "-L") { searchPaths.push(token.value); continue; }
      if (flag.startsWith("-L")) { searchPaths.push(flag.slice(2)); continue; }
      if (flag === "-l") { libraries_.push("-l" + token.value); continue; }
      if (flag.startsWith("-l")) { libraries_.push(flag); continue; }
      if (flag.startsWith("-Wl,")) {
        for (const piece of flag.slice(4).split(",")) {
          if (piece) linkerFlags.push(piece);
        }
        continue;
      }
      if (LINK_FLAGS.has(flag)) { linkerFlags.push(flag); continue; }
      if (flag === "-e" || flag === "-u" || flag === "-Map" || flag === "-z") {
        linkerFlags.push(flag, token.value);
        continue;
      }
      // Everything else is a compiler or front-end flag. Silently dropping a
      // flag ld might have wanted would be a lie, so say so in the log.
      if (!isDroppedForFrontend(flag)) note("avr driver: link ignores " + flag);
    }

    const script = SYSROOT + "/avr/lib/ldscripts/" + arch + ".x";
    note("avr driver: link " + arch + (device ? " device=" + device : ""));
    const startup = device ? SYSROOT + "/avr/lib/" + arch + "/crt" + device + ".o" : null;

    const argv = ["-m", arch, "-T", script];
    for (const flag of linkerFlags) argv.push(flag);
    if (startup) argv.push(startup);
    argv.push("-o", output);
    for (const object of objects) argv.push(object);
    for (const path of [...new Set(searchPaths)]) argv.push("-L" + path);
    argv.push("-L" + SYSROOT + "/avr/lib/" + arch);
    argv.push("-L" + SYSROOT + "/lib/gcc/avr/" + GCC_VERSION + "/" + arch);
    argv.push("--start-group");
    // Deduplicate inside the group: the link recipe already passes -lm, and a
    // repeated library name is a real difference to a static linker.
    for (const library of [...new Set([...libraries_, "-lm", "-lc", "-lgcc"])]) argv.push(library);
    argv.push("--end-group");

    const files = [...objects, ...(startup ? [startup] : [])];
    note("avr driver: ld " + argv.join(" "));
    return runTool("ld", argv, { files, directories: [], outputs: [output] });
  }

  async function objcopy(tokens) {
    // objcopy's positional contract is "infile [outfile]" as the last one or two
    // non-option arguments, so a value flag the tokeniser does not know cannot
    // silently become the input file the way it did with --change-section-lma.
    const all = operands(tokens);
    if (all.length > 2) {
      note("avr driver: objcopy was given " + all.length + " file operands, using the last two: " + all.join(" "));
    }
    const output = all[all.length - 1];
    const input = all.length > 1 ? all[all.length - 2] : output;
    const argv = [];
    for (const token of tokens) {
      if (token.operand !== undefined) argv.push(token.operand);
      else if (token.value !== undefined) argv.push(token.flag, token.value);
      else argv.push(token.flag);
    }
    return runTool("objcopy", argv, { files: [input], directories: [], outputs: [output] });
  }

  function size(tokens) {
    const input = operands(tokens).pop();
    return (async () => {
      const data = await readFile(input);
      if (!data) return { code: 1, stdout: "", stderr: "avr-size: " + input + ": no such file\n", files: [] };
      const sections = elfSections(data);
      if (!sections) return { code: 1, stdout: "", stderr: "avr-size: " + input + ": not an ELF32 file\n", files: [] };
      // The shape is avr-size -A, which the CLI parses with
      // ^(?:\.text|\.data|\.bootloader)\s+([0-9]+). The leading dot is part of
      // the section name from the linker's point of view, not from ELF's.
      let text = input + "  :\n";
      text += "section           size      addr\n";
      let total = 0;
      for (const section of sections) {
        const name = section.name.startsWith(".") ? section.name : "." + section.name;
        text += name.padEnd(16) + String(section.size).padStart(8) + String(section.address).padStart(10) + "\n";
        total += section.size;
      }
      text += "Total" + String(total).padStart(19) + "\n";
      return { code: 0, stdout: text, stderr: "", files: [] };
    })();
  }

  function ar(tokens) {
    const all = operands(tokens);
    // ar takes its operation word without a dash ("rcs"), so it parses as an
    // operand. An operation word never contains a path separator or a dot.
    const start = all.length > 1 && !all[0].includes("/") && !all[0].includes(".") ? 1 : 0;
    const archivePath = all[start];
    const members = all.slice(start + 1);
    const existing = archives.get(archivePath) || [];
    for (const member of members) {
      if (!existing.includes(member)) existing.push(member);
    }
    archives.set(archivePath, existing);
    note("avr driver: recorded " + archivePath + " -> " + existing.length + " members");
    return Promise.resolve({ code: 0, stdout: "", stderr: "", files: [] });
  }

  async function run(request) {
    const argv = request.args || [];
    const tool = basename(argv[0]);
    const tokens = parseArgs(argv, VALUE_FLAGS);

    switch (tool) {
      case "avr-g++":
      case "avr-gcc": {
        const assembler = flagValue(tokens, "-x") === "assembler-with-cpp";
        if (hasFlag(tokens, "-E")) return preprocess(tokens, { assembler });
        if (hasFlag(tokens, "-c")) return compile(tokens, { assembler });
        return link(tokens);
      }
      case "avr-gcc-ar":
      case "avr-ar":
      case "ar":
        return ar(tokens);
      case "avr-objcopy":
      case "objcopy":
        return objcopy(tokens);
      case "avr-size":
      case "size":
        return size(tokens);
      case "ctags":
        // Empty output is a valid answer: arduino-cli parses zero prototypes and
        // keeps the sketch's own order.
        return { code: 0, stdout: "", stderr: "", files: [] };
      case "avrdude":
      case "avrdude-conf":
        return {
          code: 1,
          stdout: "",
          stderr: "avrdude cannot run in the page: uploading needs WebSerial, which is not wired up yet\n",
          files: [],
        };
      default:
        return {
          code: 1,
          stdout: "",
          stderr: "the in-page toolchain does not implement " + tool + " (from: " + argv.join(" ") + ")\n",
          files: [],
        };
    }
  }

  return {
    run: async (request) => {
      try {
        return await run(request);
      } catch (error) {
        return {
          code: 1,
          stdout: "",
          stderr: "avr-driver: " + (error && error.stack ? error.stack : String(error)) + "\n",
          files: [],
        };
      }
    },
    // Exposed for the tests: the driver's own view of a command line.
    describe: (argv) => ({
      tokens: parseArgs(argv, VALUE_FLAGS),
      arch: architectureFor(readMcu(parseArgs(argv, VALUE_FLAGS))),
    }),
    archives,
  };
}
