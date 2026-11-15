// ARM toolchain driver: answers arduino-cli's exec seam for nRF52 builds.
//
// The Seeed nRF52 platform's recipes call arm-none-eabi-g++, arm-none-eabi-ar,
// arm-none-eabi-objcopy and arm-none-eabi-size, which in the installed
// toolchain are x86-64 ELF binaries and cannot run in a page. This module
// receives those command lines and produces the same artefacts from six wasm
// tools: cc1, cc1plus, as, ld, objcopy and ar.
//
// What is faithful and what is not:
//
//   * gcc and g++ are drivers. Their jobs are kept: choose the front end, run
//     it, then assemble. cc1 writes the .s, as makes the .o. C and C++ both have
//     a real front end here, so unlike the AVR driver nothing is compiled as the
//     wrong language.
//   * Link libraries come from the vendor sysroot's Cortex-M4F hard-float
//     multilib, which is the one these boards use. A recipe that needs another
//     multilib is told which one the driver has instead of failing inside ld.
//   * --specs=nano.specs and --specs=nosys.specs are translated into the
//     libraries they name, because wasm ld has no specs parser: libc_nano and
//     libnosys. A spec file that is not one of those two is reported.
//   * -mcpu, -mthumb, -mfpu and -mfloat-abi are not passed to ld: bfd reads the
//     attributes the objects already carry, and ld mistook "-mfloat-abi=hard"
//     for an emulation name when it was given them. Measured.
//   * The linker script comes from the core (-T{build.ldscript}), so vector
//     placement and the memory map are the core's, not this driver's.
//   * ar, objcopy and size are real tools, except that size is a stand-in which
//     prints the table the recipe's regexes match.
//
// The contract with the page is a command line in and files out: every file the
// tool would have written is returned to the caller, which writes it into the
// filesystem arduino-cli reads.

import { createArmTools } from "./arm-tools.js";
import { readTarGz } from "./tar.js";
import {
  basename,
  elfSections,
  flagValue,
  hasFlag,
  joinedValue,
  operands,
  parseArgs,
} from "./tool-common.js";
import { genpkg } from "./nrfutil.js";

const SYSROOT = "/sysroot";
const MULTILIB = "thumb/v7e-m+fp/hard";
const GCC_VERSION = "9.2.0";
// The C++ headers keep the vendor's version in their path, because that is how
// the vendor laid them out and the driver names them with -isystem.
const CXX_VERSION = "9.2.1";
const LIB_DIR = SYSROOT + "/arm-none-eabi/lib/" + MULTILIB;
const GCC_LIB_DIR = SYSROOT + "/lib/gcc/arm-none-eabi/" + GCC_VERSION + "/" + MULTILIB;
const CXX_INCLUDE = SYSROOT + "/arm-none-eabi/include/c++/" + CXX_VERSION;
const INCLUDE_DIRS = [
  // The C++ directories come first so <atomic> and the rest of the library
  // resolve; the target-specific one holds this multilib's bits/c++config.h.
  CXX_INCLUDE,
  CXX_INCLUDE + "/arm-none-eabi/" + MULTILIB,
  CXX_INCLUDE + "/backward",
  SYSROOT + "/arm-none-eabi/include",
  SYSROOT + "/lib/gcc/arm-none-eabi/" + GCC_VERSION + "/include",
  SYSROOT + "/lib/gcc/arm-none-eabi/" + GCC_VERSION + "/include-fixed",
];

// Flags whose value is the next argument. Everything else starting with "-" is
// self-contained, so this set decides whether an argument is a flag or a file.
const VALUE_FLAGS = new Set([
  "-o", "-I", "-D", "-U", "-L", "-l", "-T", "-MF", "-MT", "-MQ",
  "-include", "-imacros", "-isystem", "-iquote", "-idirafter", "-x", "-u",
  "-Xlinker", "-Xassembler", "-Xpreprocessor", "--param", "-iprefix",
  "-iwithprefix", "-iwithprefixbefore", "-B", "-dumpbase", "-dumpdir",
]);

// Flags that belong to the link step. Passing one to cc1 is an error, and the
// two dependency spellings are re-emitted in the form the front end accepts.
function linkOnly(flag) {
  if (flag.startsWith("-Wl,") || flag.startsWith("-Xlinker")) return true;
  if (flag.startsWith("-L") || flag.startsWith("-l") || flag.startsWith("-T")) return true;
  if (flag.startsWith("--specs=")) return true;
  if (flag === "-u" || flag === "-save-temps" || flag === "-save-temps=obj") return true;
  if (flag === "-shared" || flag === "-static" || flag === "-r" || flag === "-pie") return true;
  if (flag === "-nostdlib" || flag === "-nostartfiles" || flag === "-nodefaultlibs") return true;
  if (flag === "-flto" || flag === "-fno-lto" || flag === "-fuse-linker-plugin") return true;
  return false;
}

// What cc1 and cc1plus refuse: they are the front end, not the driver.
function droppedForFrontend(flag) {
  if (flag === "-c" || flag === "-E" || flag === "-S") return true;
  if (flag === "-o" || flag === "-x") return true;
  if (flag === "-MF" || flag === "-MT" || flag === "-MQ" || flag === "-MD" || flag === "-MMD") return true;
  return linkOnly(flag);
}

function isAssemblerSource(path) {
  return /\.(s|S)$/.test(path);
}

// Assembly with a C preprocessor is a driver mode, not a front-end mode: gcc
// runs cpp over the .S and hands the result to gas without ever parsing it as C.
// Only the flags cpp and the target need survive, because cc1 in C mode refuses
// C++ flags ("valid for C++ but not for C") and the -x spelling.
function assemblerCppArgs(tokens) {
  const args = [];
  const valued = new Set(["-D", "-U", "-I", "-isystem", "-include", "-imacros", "-iquote", "-idirafter"]);
  for (const token of tokens) {
    if (token.operand !== undefined) continue;
    if (token.value !== undefined) {
      if (valued.has(token.flag)) args.push(token.flag, token.value);
      continue;
    }
    const flag = token.flag;
    if (/^-[DUI]/.test(flag) || /^-i(system|nclude|macros|quote|dirafter)/.test(flag)) {
      args.push(flag);
      continue;
    }
    if (flag.startsWith("-mcpu=") || flag.startsWith("-mfpu=") || flag.startsWith("-mfloat-abi=")
      || flag.startsWith("-march=") || flag.startsWith("-mtune=") || flag === "-mthumb") {
      args.push(flag);
    }
  }
  // gcc defines this itself for .S, and the startup files test it.
  args.push("-D__ASSEMBLER__");
  return args;
}

function frontendFor(source) {
  // cc1 is the C and assembler front end; only C++ needs cc1plus.
  return /\.(c|s|S)$/.test(source) ? "cc1" : "cc1plus";
}

// cc1 spells its dependency output as "-MMD <path>": it has no -MF, and the
// driver's "-MMD -MF x.d" makes it read x.d as a second input file.
function dependencyArgs(tokens, output) {
  const wanted = hasFlag(tokens, "-MMD") ? "-MMD" : hasFlag(tokens, "-MD") ? "-MD" : null;
  if (!wanted) return [];
  let depfile = flagValue(tokens, "-MF") || joinedValue(tokens, "-MF");
  if (!depfile && output) depfile = output.replace(/\.[^./]*$/, "") + ".d";
  if (!depfile) return [];
  return [wanted, depfile];
}

function includeArgs() {
  const args = [];
  for (const dir of INCLUDE_DIRS) args.push("-isystem", dir);
  return args;
}

// Everything from the recipe that describes the translation unit, plus where the
// compiler's own headers are in this filesystem.
function frontendArgs(tokens, { output }) {
  const args = ["-quiet"];
  for (const token of tokens) {
    if (token.operand !== undefined) continue;
    if (droppedForFrontend(token.flag)) continue;
    if (token.value !== undefined) args.push(token.flag, token.value);
    else args.push(token.flag);
  }
  for (const dir of INCLUDE_DIRS) args.push("-isystem", dir);
  args.push(...dependencyArgs(tokens, output));
  return args;
}

// The target flags as gas spells them. ld must not see these.
function assemblerArgs(tokens) {
  const args = [];
  for (const token of tokens) {
    const flag = token.flag;
    if (!flag) continue;
    if (flag.startsWith("-mcpu=") || flag.startsWith("-mfpu=") || flag.startsWith("-mfloat-abi=")) args.push(flag);
    else if (flag === "-mthumb") args.push("-mthumb");
  }
  return args;
}

export async function createArmDriver(options) {
  const { readAsset, importModule, readWasm, readFile, listDir, isDirectory, log } = options;
  const note = log || (() => undefined);

  const entries = await readTarGz(await readAsset("sysroot.tar.gz"));
  const sysrootFiles = entries
    .filter((entry) => entry.type === "file" && entry.name.startsWith("sysroot/"))
    .map((entry) => ({ path: SYSROOT + "/" + entry.name.slice("sysroot/".length), data: entry.data }));
  // Name the paths a link needs. A file count passes on a sysroot that has lost
  // every crt object.
  for (const required of [
    "/arm-none-eabi/include/stdint.h",
    "/arm-none-eabi/lib/nano.specs",
    "/arm-none-eabi/lib/nosys.specs",
    "/arm-none-eabi/lib/" + MULTILIB + "/libc_nano.a",
    "/arm-none-eabi/lib/" + MULTILIB + "/libnosys.a",
    "/arm-none-eabi/lib/" + MULTILIB + "/libm.a",
    "/arm-none-eabi/lib/" + MULTILIB + "/crt0.o",
    "/lib/gcc/arm-none-eabi/" + GCC_VERSION + "/" + MULTILIB + "/libgcc.a",
    "/lib/gcc/arm-none-eabi/" + GCC_VERSION + "/" + MULTILIB + "/crtbegin.o",
  ]) {
    if (!sysrootFiles.some((file) => file.path === SYSROOT + required)) {
      throw new Error("sysroot.tar.gz is missing " + required);
    }
  }
  const headerFiles = sysrootFiles.filter((file) => /\/include(-fixed)?\//.test(file.path));
  const linkFiles = sysrootFiles.filter((file) => /\.(a|o|specs)$/.test(file.path));
  note("arm driver: " + sysrootFiles.length + " sysroot files, " + headerFiles.length + " headers, "
    + linkFiles.length + " link inputs");

  const tools = createArmTools({ importModule, readWasm, note });

  // Everything a tool reads has to be named on the command line or reached
  // through -I, and a name on the command line is a path in the CLI's
  // filesystem, so the driver copies those in from there.
  async function inputFiles(tokens, extra = [], skip = new Set(), trees = []) {
    const files = [];
    const seen = new Set();
    async function addFile(path) {
      if (!path || path === "/dev/null" || seen.has(path)) return;
      seen.add(path);
      const data = await readFile(path);
      if (data) files.push({ path, data });
      else note("arm driver: input " + path + " is not in the filesystem");
    }
    async function addTree(dir) {
      if (!dir || seen.has("dir:" + dir)) return;
      seen.add("dir:" + dir);
      const names = await listDir(dir);
      if (!names) return;
      for (const name of names) {
        const child = dir.replace(/\/$/, "") + "/" + name;
        if (await isDirectory(child)) await addTree(child);
        else await addFile(child);
      }
    }
    for (const token of tokens) {
      if (token.operand !== undefined && !skip.has(token.operand)) await addFile(token.operand);
      if (token.flag === "-I" || token.flag === "-isystem" || token.flag === "-iquote" || token.flag === "-idirafter") {
        await addTree(token.value);
      }
      if (token.flag === "-include" || token.flag === "-imacros") await addFile(token.value);
      if (token.flag && (token.flag.startsWith("-I") || token.flag.startsWith("-isystem"))) {
        const value = token.flag.replace(/^-isystem/, "").replace(/^-I/, "");
        if (value) await addTree(value);
      }
      if (token.flag && token.flag.startsWith("-T")) await addFile(token.flag.slice(2));
    }
    // A library named only as -l<name> is found by searching -L, so the whole
    // directory has to be there; nothing on the command line names the archive.
    for (const dir of trees) await addTree(dir);
    for (const file of extra) {
      if (!seen.has(file.path)) { seen.add(file.path); files.push(file); }
    }
    return files;
  }

  function outputsOf(paths) {
    return paths.filter((path) => path && path !== "/dev/null");
  }

  function stripDriverFlags(tokens, { keepOperands }) {
    const argv = [];
    for (const token of tokens) {
      if (token.operand !== undefined) {
        if (keepOperands) argv.push(token.operand);
        continue;
      }
      if (token.value !== undefined) argv.push(token.flag, token.value);
      else argv.push(token.flag);
    }
    return argv;
  }

  // A quoted include is searched next to the file that says it, and gcc never
  // needs that search to appear in -I: the SEGGER assembly includes its own
  // header by name and the recipe passes no directory for it.
  const siblingDirs = new Set();
  async function siblingHeaders(source) {
    const dir = source.replace(/\/[^/]*$/, "");
    if (!dir || siblingDirs.has(dir)) return [];
    siblingDirs.add(dir);
    const names = await listDir(dir);
    if (!names) return [];
    const files = [];
    for (const name of names) {
      if (!/\.(h|hh|hpp|hxx|inc|inl)$/i.test(name)) continue;
      const path = dir + "/" + name;
      const data = await readFile(path);
      if (data) files.push({ path, data });
    }
    return files;
  }

  async function preprocess(tokens) {
    const target = flagValue(tokens, "-o");
    const source = operands(tokens).pop();
    const files = [...await inputFiles(tokens, headerFiles), ...await siblingHeaders(source)];
    const argv = isAssemblerSource(source)
      ? ["-quiet", ...assemblerCppArgs(tokens), ...includeArgs()]
      : frontendArgs(tokens, { output: target });
    argv.push("-E");
    if (target) argv.push("-o", target);
    argv.push(source);
    return tools.run(frontendFor(source), argv, {
      files,
      outputs: outputsOf([target, dependencyArgs(tokens, target)[1]]),
    });
  }

  async function compile(tokens) {
    const object = flagValue(tokens, "-o");
    const source = operands(tokens).pop();
    if (!object) throw new Error("arm driver: compile without -o");
    const assembly = object + ".s";
    const assembler = isAssemblerSource(source);
    const frontend = frontendFor(source);

    // The dependency file is named after the object the recipe asked for, not
    // after the intermediate .s this driver happens to produce.
    const dependencies = dependencyArgs(tokens, object);
    const argv = frontendArgs(tokens, { output: object });
    argv.push("-o", assembly, source);

    const files = [...await inputFiles(tokens, headerFiles), ...await siblingHeaders(source)];
    if (assembler) {
      // Preprocess, then assemble. Feeding the .S straight to the front end in
      // C++ mode fails on the first immediate ("stray '#' in program", measured
      // on gcc_startup_nrf52840.S:240).
      const pre = await tools.run("cc1", ["-quiet", "-E", ...assemblerCppArgs(tokens), ...includeArgs(),
        ...dependencyArgs(tokens, object), "-o", assembly, source], {
        files,
        outputs: outputsOf([assembly, dependencyArgs(tokens, object)[1]]),
      });
      if (pre.code !== 0) return { ...pre, files: [] };
      const text = pre.files.find((file) => file.path === assembly);
      if (!text) {
        return {
          code: 1,
          stdout: pre.stdout,
          stderr: pre.stderr + "\narm driver: cc1 wrote no " + assembly,
          files: [],
        };
      }
      const assembledText = await tools.run("as", [...assemblerArgs(tokens), "-o", object, assembly], {
        files: [{ path: assembly, data: text.data }],
        outputs: [object],
      });
      return {
        code: assembledText.code,
        stdout: pre.stdout + assembledText.stdout,
        stderr: pre.stderr + assembledText.stderr,
        files: [...pre.files.filter((file) => file.path !== assembly), ...assembledText.files],
      };
    }

    const front = await tools.run(frontend, argv, {
      files,
      outputs: outputsOf([assembly, dependencies[1]]),
    });
    if (front.code !== 0) return { ...front, files: [] };

    const assemblyFile = front.files.find((file) => file.path === assembly);
    if (!assemblyFile) {
      return {
        code: 1,
        stdout: front.stdout,
        stderr: front.stderr + "\narm driver: " + frontend + " wrote no " + assembly,
        files: [],
      };
    }

    const assembled = await tools.run("as", [...assemblerArgs(tokens), "-o", object, assembly], {
      files: [{ path: assembly, data: assemblyFile.data }],
      outputs: [object],
    });
    return {
      code: assembled.code,
      stdout: front.stdout + assembled.stdout,
      stderr: front.stderr + assembled.stderr,
      files: [...front.files.filter((file) => file.path !== assembly), ...assembled.files],
    };
  }

  // A link through g++ becomes a link through ld with the crt objects and the
  // specs' libraries spelled out. -Wl,X passes X through unchanged, which is
  // most of what the recipe says.
  async function link(tokens) {
    const output = flagValue(tokens, "-o");
    const body = [];
    const mapArgs = [];
    const objects = [];
    const libraries = [];
    const specs = [];
    const searchDirs = [];
    const scripts = [];
    const unknown = [];
    let scriptNext = false;
    let mapNext = false;

    for (const token of tokens) {
      const flag = token.flag;
      if (mapNext) { mapArgs.push("-Map", token.operand ?? token.value ?? ""); mapNext = false; continue; }
      if (scriptNext) { scripts.push(token.operand ?? token.value ?? ""); scriptNext = false; continue; }
      if (token.operand !== undefined) { objects.push(token.operand); continue; }
      if (token.value !== undefined) {
        if (flag === "-o") continue;
        if (flag === "-L") { body.push("-L", token.value); searchDirs.push(token.value); continue; }
        if (flag === "-l") { libraries.push(token.value); continue; }
        if (flag === "-T") { scripts.push(token.value); continue; }
        if (flag === "-u") { body.push("-u", token.value); continue; }
        if (flag === "-Xlinker") { body.push(token.value); if (token.value === "-T") scriptNext = true; continue; }
        unknown.push(flag + " " + token.value);
        continue;
      }
      if (flag.startsWith("-Wl,")) {
        for (const part of flag.slice(4).split(",")) {
          if (!part) continue;
          if (mapNext) { mapArgs.push("-Map", part); mapNext = false; continue; }
          if (scriptNext) { scripts.push(part); scriptNext = false; continue; }
          if (part.startsWith("-Map=")) mapArgs.push("-Map", part.slice(5));
          else if (part === "-Map") mapNext = true;
          else if (part === "-T") scriptNext = true;
          else body.push(part);
        }
        continue;
      }
      if (flag.startsWith("-L")) { body.push("-L", flag.slice(2)); searchDirs.push(flag.slice(2)); continue; }
      if (flag.startsWith("-l")) { libraries.push(flag.slice(2)); continue; }
      if (flag.startsWith("-T")) { scripts.push(flag.slice(2)); continue; }
      if (flag.startsWith("--specs=")) { specs.push(flag.slice("--specs=".length)); continue; }
      if (flag.startsWith("-mcpu=") || flag.startsWith("-mfpu=") || flag.startsWith("-mfloat-abi=")
        || flag === "-mthumb") {
        // bfd reads the attributes the objects carry; ld rejects these as
        // emulation names.
        continue;
      }
      if (flag.startsWith("-O") || flag === "-g" || flag.startsWith("-std=")) continue;
      if (flag === "-save-temps" || flag === "-save-temps=obj") {
        note("arm driver: link ignores " + flag);
        continue;
      }
      if (flag === "-nostdlib" || flag === "-nostartfiles" || flag === "-nodefaultlibs") {
        note("arm driver: link ignores " + flag + " and always adds the nano/nosys start files");
        continue;
      }
      unknown.push(flag);
    }

    // The two spec files this platform asks for decide which libc and which
    // system-call stubs the image gets.
    let libc = "c";
    let nosys = false;
    for (const spec of specs) {
      if (spec === "nano.specs") libc = "c_nano";
      else if (spec === "nosys.specs") nosys = true;
      else if (/^(rdimon|linux).*specs$/.test(spec)) {
        return {
          code: 1,
          stdout: "",
          stderr: "arm driver: " + spec + " needs a semihosting library this sysroot does not carry",
          files: [],
        };
      } else {
        note("arm driver: link ignores --specs=" + spec + " (only nano.specs and nosys.specs are translated)");
      }
    }
    if (unknown.length) note("arm driver: link ignores " + [...new Set(unknown)].join(" "));

    // crt0.o is the C library's entry stub; crti.o, crtbegin.o, crtend.o and
    // crtn.o are GCC's own. gcc finds each in its own directory, so this does
    // too: crti.o is not in the libc directory of this sysroot (measured).
    const startFiles = [LIB_DIR + "/crt0.o", GCC_LIB_DIR + "/crti.o", GCC_LIB_DIR + "/crtbegin.o"];
    const endFiles = [GCC_LIB_DIR + "/crtend.o", GCC_LIB_DIR + "/crtn.o"];

    // The recipe names the linker script without a directory and expects -L to
    // find it, and the scripts in turn include each other by bare name. Resolve
    // both here and rewrite every INCLUDE to the path it resolved to: the name
    // a script finds has to be a path this filesystem has, and an absolute
    // INCLUDE is what the wasm ld opens correctly.
    const scriptArgs = [];
    const scriptFiles = [];
    const staged = new Set();
    async function resolveName(name, from) {
      const searched = name.startsWith("/")
        ? [name]
        : [
          ...searchDirs.map((dir) => dir.replace(/\/$/, "") + "/" + name),
          from.replace(/\/[^/]*$/, "") + "/" + name,
        ];
      for (const candidate of searched) {
        if (staged.has(candidate)) return candidate;
        if (await readFile(candidate)) return candidate;
      }
      return { searched, missing: true };
    }
    async function stageScript(path, depth = 0) {
      if (staged.has(path)) return;
      staged.add(path);
      const raw = await readFile(path);
      if (!raw) throw new Error("arm driver: linker script " + path + " is not in the filesystem");
      if (depth > 8) throw new Error("arm driver: linker script includes nest past 8 levels at " + path);
      const lines = [];
      for (const line of new TextDecoder().decode(raw).split("\n")) {
        const match = /^(\s*INCLUDE\s+)(?:"([^"]+)"|'([^']+)'|(\S+))(.*)$/i.exec(line);
        if (!match) { lines.push(line); continue; }
        const name = match[2] ?? match[3] ?? match[4];
        const target = await resolveName(name, path);
        if (target.missing) {
          throw new Error("arm driver: " + path + " includes " + name + ", which is not in "
            + target.searched.join(" or "));
        }
        await stageScript(target, depth + 1);
        lines.push(match[1] + '"' + target + '"' + match[5]);
      }
      scriptFiles.push({ path, data: new TextEncoder().encode(lines.join("\n")) });
    }
    try {
      for (const name of scripts) {
        if (!name) continue;
        const found = await resolveName(name, output || "/");
        if (found.missing) {
          return {
            code: 1,
            stdout: "",
            stderr: "arm driver: linker script " + name + " is not in " + found.searched.join(" or "),
            files: [],
          };
        }
        await stageScript(found);
        scriptArgs.push("-T", found);
      }
    } catch (error) {
      return { code: 1, stdout: "", stderr: error.message, files: [] };
    }
    const libs = libraries.map((name) => "-l" + name);
    // g++ adds the C++ runtime itself; the recipes never name it. nano.specs
    // rewrites both of these to the _nano archives, so this mirrors that.
    const nano = libc === "c_nano";
    libs.push(nano ? "-lstdc++_nano" : "-lstdc++", nano ? "-lsupc++_nano" : "-lsupc++");
    libs.push("-l" + libc);
    if (nosys) libs.push("-lnosys");
    libs.push("-lgcc", "-lm");

    // The recipe wraps its libraries in --start-group. The C library belongs in
    // that same group, because an archive member can need another; ld does not
    // accept a nested group, so it goes just before the recipe's --end-group.
    let placed = false;
    let sawGroup = false;
    const grouped = [...scriptArgs];
    for (const part of body) {
      if (part === "--start-group") sawGroup = true;
      if (part === "--end-group" && !placed) { grouped.push(...libs); placed = true; }
      grouped.push(part);
    }
    if (!placed) grouped.push(...libs);
    if (!sawGroup) note("arm driver: link found no --start-group in the recipe, so libraries are resolved in order");

    const finalArgs = [
      "-L", LIB_DIR,
      "-L", GCC_LIB_DIR,
      // bfd resolves an INCLUDE while it parses the script, so every directory
      // the script may reach into has to precede -T on the command line.
      ...searchDirs.flatMap((dir) => ["-L", dir]),
      ...mapArgs,
      ...startFiles,
      ...objects,
      ...grouped,
      ...endFiles,
    ];
    if (output) finalArgs.push("-o", output);

    const files = [...await inputFiles(tokens, linkFiles, new Set(), searchDirs), ...scriptFiles];
    return tools.run("ld", finalArgs, {
      files,
      outputs: outputsOf([output, ...mapArgs.filter((part) => part !== "-Map")]),
    });
  }

  async function runAr(tokens) {
    const argv = stripDriverFlags(tokens, { keepOperands: true });
    // ar rcs <archive> <object>...: the first operand is ar's own mode word, so
    // the archive is the first operand that names a file. Without naming it, the
    // archive stays inside the tool's filesystem and the link never sees it.
    const named = operands(tokens);
    const archive = named.find((path) => path.includes("/") || /\.a$/.test(path)) ?? named[0];
    const skip = named[0] === archive ? new Set() : new Set([named[0]]);
    const files = await inputFiles(tokens, [], skip);
    return tools.run("ar", argv, { files, outputs: outputsOf([archive]) });
  }

  async function objcopy(tokens) {
    const argv = stripDriverFlags(tokens, { keepOperands: true });
    const named = operands(tokens);
    const output = named[named.length - 1];
    const files = await inputFiles(tokens);
    return tools.run("objcopy", argv, { files, outputs: outputsOf([output]) });
  }

  // arm-none-eabi-size -A: one line per section, "name size address", which is
  // what the platform's regexes match. A real size reads the same ELF the same
  // way; this prints the table without needing a seventh wasm tool.
  async function size(tokens) {
    const file = operands(tokens).pop();
    // readFile is the VFS's, so this has to be awaited; without the await it is
    // a Promise and elfSections gets something no DataView accepts.
    const data = file ? await readFile(file) : null;
    if (!data) {
      return { code: 1, stdout: "", stderr: "arm driver: size cannot read " + file, files: [] };
    }
    const sections = elfSections(data);
    if (!sections) {
      return { code: 1, stdout: "", stderr: "arm driver: size found no ELF sections in " + file, files: [] };
    }
    const lines = ["section", "size", "addr"];
    let total = 0;
    for (const section of sections) {
      if (section.size === 0) continue;
      lines.push(section.name + " " + section.size + " 0x" + section.address.toString(16));
      total += section.size;
    }
    lines.push("Total " + total);
    return { code: 0, stdout: lines.join("\n") + "\n", stderr: "", files: [] };
  }

  async function run(request) {
    const argv = request.args || [];
    const tool = basename(argv[0] || "");
    const tokens = parseArgs(argv, VALUE_FLAGS);
    const preprocessed = hasFlag(tokens, "-E");
    const compiling = hasFlag(tokens, "-c");

    if (/arm-none-eabi-g\+\+$|arm-none-eabi-gcc$/.test(tool)) {
      if (preprocessed) return preprocess(tokens);
      if (compiling) return compile(tokens);
      return link(tokens);
    }
    if (/arm-none-eabi-ar$/.test(tool)) return runAr(tokens);
    if (/arm-none-eabi-objcopy$/.test(tool)) return objcopy(tokens);
    if (/arm-none-eabi-size$/.test(tool)) return size(tokens);
    if (/^adafruit-nrfutil/.test(tool)) return genpkg(argv.slice(1), { readFile });
    if (/^ctags/.test(tool)) {
      note("arm driver: ctags answers with no output, so a sketch that calls a function before declaring it gets no prototype");
      return { code: 0, stdout: "", stderr: "", files: [] };
    }
    return {
      code: 1,
      stdout: "",
      stderr: "arm driver: no implementation for " + tool,
      files: [],
    };
  }

  return { run, toolchain: { multilib: MULTILIB, gcc: GCC_VERSION } };
}
