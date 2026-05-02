# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` then `git submodule update --init --recursive` — pulls deps and the `firefox-profiler` submodule (required before `build-profiler` or `vscode:prepublish`).
- `npm run build` — esbuild bundle with sourcemap into `out/extension.js`.
- `npm run watch` — same, rebuilds on change. This is the default build task used by the `Run Extension` launch config.
- `npm run typecheck` — `tsc -noEmit`. Fast correctness check; does NOT emit files.
- `npm run lint` — `eslint src --ext ts`.
- `npm run pretest` — `tsc -p ./ && npm run lint`. This EMITS files to `out/` (required by the test runner — `npm run build` uses esbuild which only writes the single bundle and is not enough for tests).
- `npm run test` — runs `out/test/runTest.js` via `@vscode/test-electron`, which downloads a disposable VS Code and executes the Mocha suite in `out/test/suite`. Run `npm run pretest` first if you've only been using esbuild.
- `npm run vscode:prepublish` — minified bundle plus `build-profiler` (descends into `firefox-profiler/` and runs `yarn install && yarn run build-prod`). The submodule MUST be initialised or publish fails.
- `npm run protoc` — regenerate `src/profile-converter/simpleperf/simpleperf_report.{js,d.ts}` from the `.proto`. Only needed after touching the proto.

### Running inside VS Code
- `F5` launches the `Run Extension` config (`.vscode/launch.json`), which starts an extension-development host attached to the esbuild `watch` task.
- `Extension Tests` launch config runs the test suite inside the dev host.

### Runtime dependencies (not npm)
- Android SDK + platform-tools on PATH or pointed to by `android-debug.sdkRoot` / `ANDROID_SDK_ROOT`.
- Android NDK for native debugging (supplies `lldb-server` and `simpleperf`). Points to it via `android-debug.ndkRoot` / `ANDROID_NDK_ROOT`.
- VS Code extensions required at debug time: `vadimcn.vscode-lldb` (native), `vscjava.vscode-java-debug` + `redhat.java` (Java). The extension prompts to install them when a session needs them — don't hard-code them into `package.json`'s `extensionDependencies`.

## Architecture

This is a VS Code debug extension (`type: android-debug`) that orchestrates CodeLLDB and Microsoft's Java debugger against an Android device, plus a standalone profiler (`type: android-profile`) that drives `simpleperf` and renders traces in a bundled Firefox Profiler fork.

### Debug session flow (the non-obvious part)

The `android-debug` adapter does NOT itself speak the DAP to lldb/java; it spawns **child debug sessions** of those types and terminates itself when all children terminate. This shape matters for almost every file:

1. `debugConfigProvider.ts::AndroidDebugConfigurationProvider.resolveDebugConfiguration` (phase 1) picks the target device, stashes cross-call state on module-level singletons in `targetPicker`/`targetCommand` (see "State-passing trick" below), and returns the config with a `target: Device` object injected.
2. VS Code then substitutes `${command:xxx}` variables. These callbacks (`pickAndroidProcess`, `getBestAbi`, `getBestMappedAbi`) live in `targetCommand.ts` and RELY on the singletons set in phase 1 — that's how they know which device/package to query without the user being prompted again.
3. `resolveDebugConfigurationWithSubstitutedVariables` (phase 2) fills in final fields (`mode` default, `resumeProcess` default per-request-kind, native `abi`) and RESETS the singletons. From this point on, only the fully-resolved config is trusted.
4. `debugAdapter.ts::DebugAdapter.launchRequest` (or `attachRequest`) runs `installApp` → `launchApp` → pid discovery → `attachToProcess` → `resumeProcess`. `attachToProcess` calls `vscode.debug.startDebugging` with `{parentSession: this.session}` once for lldb and once for java (depending on `mode`). Child sessions are tracked by `onDidStartDebugSession`; when the last child terminates, the parent sends `TerminatedEvent`.
5. The **child** lldb/java sessions are resolved by `LLDBDebugConfigurationProvider` / `JavaDebugConfigurationProvider` in the same file — they detect they are "Android-flavoured" via the presence of `androidTarget` on the config. They start `lldb-server` inside the app (via `run-as`) and set up a JDWP TCP forward respectively.

### State-passing trick
Because `${command:xxx}` substitution happens between phase 1 and phase 2 of config resolution, data has to cross that boundary without going through the config (VS Code only passes one config object through, not arbitrary context). The codebase uses module-level singletons in `targetPicker.ts` (`currentTarget`) and `targetCommand.ts` (`currentAbi`, `currentAbiSupportedList`, `currentAbiMap`, `currentPackageName`) guarded by `setX/resetX` pairs. Phase 1 sets them; the command callback reads them; phase 2 resets them. Keep this invariant when adding new variables — always reset in phase 2 even on the error paths.

### ADB / process model (`android.ts`)
- `getAdb()` memoises a single `appium-adb` `ADB` instance; `getDeviceAdb(device)` clones it and pins the device serial. Re-create is forced via `handlePathsUpdated` when sdkRoot changes.
- `getProcessList` uses `adb jdwp` exclusively — it is the authoritative "which Android processes can we debug" source. Known limitation: apps that launch via a `lib/<abi>/wrap.sh` (e.g. HWASan builds) don't register with JDWP on some OEM builds, so they are invisible to this discovery path even when `pidof` finds them. See `task.md` for ongoing work on multi-source discovery.
- `startLldbServer` pushes `lldb-server` to `/data/local/tmp` and then `run-as`-copies it into the app's private dir so it can exec with the app's uid. The server listens on a random abstract unix socket; the socket name is threaded back into the lldb config as `settings: platform connect unix-abstract-connect://[<udid>]<socket>`. A map of socket→kill-fn (`lldbProcessKillers`) is cleaned up on session end by `debugLifecycleManager.ts`.
- `resumeJavaDebugger` forwards a tcp port to `jdwp:<pid>` and uses the minimal JDWP client in `jdwp.ts` to send a `VirtualMachine.Resume` packet. This is what unblocks apps started with `am start -D`.
- `launchApp` passes `-D` (wait-for-debugger) based on `config.waitForDebugger`. When that field is unset, `launchRequest` auto-detects: `true` for normal apps (so the debugger can attach before user code runs), `false` if the installed APK ships `lib/<abi>/wrap.sh` (HWASan / sanitizer builds), since on some OEM Android builds wrap.sh suppresses JDWP and `-D` would deadlock. The `resumeProcess: true` default for `launch` requests exists to release the `-D` pause when `mode === "native"` (the java debugger would have resumed it otherwise) — when `-D` wasn't passed, the resume is a harmless no-op.

### Profiler (`profiler.ts` + `profile-converter/` + `profile-viewer/`)
Separate debug type `android-profile` that runs `simpleperf record` on the device, pulls the trace, converts it via the generated protobuf code, and renders it through a forked Firefox Profiler webview (`profile-viewer/profileCustomEditor.ts` registers a `CustomEditor` for `*.trace`). `vscode:prepublish` builds the Firefox Profiler bundle into the submodule; forgetting `git submodule update --init` means a broken publish.

## Repo conventions

- Keep the esbuild bundle single-file; don't add dynamic `require()` paths — the minifier inlines everything.
- When adding a launch config field, update **both** the runtime consumer (`debugAdapter.ts` / `debugConfigProvider.ts`) **and** the JSON Schema under `contributes.debuggers[].configurationAttributes` in `package.json`. Users rely on the IntelliSense in `launch.json`.
- When adding a new `${command:xxx}` variable, register it in `extension.ts` AND declare it under `contributes.debuggers[].variables` in `package.json`.
- Tests live in `src/test/suite/**` and are run by Mocha via `@vscode/test-electron`. They require the compiled `out/` tree (see `pretest` above).
