export interface LogcatOptions {
    bufferSize?: string;
    restartOnFailure?: boolean;
}

export interface LogcatCommandOptions {
    udid: string;
    pid: string;
    packageName?: string;
    logcat?: LogcatOptions;
    platform?: NodeJS.Platform;
}

function quotePosix(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string) {
    return `'${value.replace(/'/g, `''`)}'`;
}

function getProcCmdlineCommand(pid: string) {
    return `cat /proc/${quotePosix(pid)}/cmdline 2>/dev/null`;
}

function getPosixProcessLiveFunction(udid: string, pid: string, packageName: string | undefined) {
    const adbDeviceArgs = `-s ${quotePosix(udid)}`;
    const procCmdlineCommand = quotePosix(getProcCmdlineCommand(pid));

    return [
        `android_debug_process_live() {`,
        `    cmdline=$(adb ${adbDeviceArgs} shell ${procCmdlineCommand} | tr '\\000' '\\n' | head -n 1 | tr -d '\\r')`,
        `    expected=${quotePosix(packageName ?? "")}`,
        `    if [ -z "$expected" ]; then [ -n "$cmdline" ]; return $?; fi`,
        `    [ "$cmdline" = "$expected" ] || case "$cmdline" in "$expected":*) true ;; *) false ;; esac`,
        `}`,
    ].join("; ");
}

function getPowerShellProcessLiveFunction(udid: string, pid: string, packageName: string | undefined) {
    const procCmdlineCommand = quotePowerShell(getProcCmdlineCommand(pid));

    return [
        `function Test-AndroidDebugProcessLive {`,
        `    $cmdline = (& adb -s ${quotePowerShell(udid)} shell ${procCmdlineCommand} | Out-String)`,
        `    $cmdline = (($cmdline -replace [char]0, "\`n") -replace "\`r", "").Split("\`n")[0]`,
        `    $expected = ${quotePowerShell(packageName ?? "")}`,
        `    if (-not $expected) { return $cmdline.Length -gt 0 }`,
        `    return ($cmdline -eq $expected) -or $cmdline.StartsWith($expected + ':')`,
        `}`,
    ].join("; ");
}

function getPosixLogcatCommand(options: LogcatCommandOptions) {
    const adbDeviceArgs = `-s ${quotePosix(options.udid)}`;
    const pidArg = quotePosix(options.pid);
    const logcat = options.logcat ?? {};
    const restartOnFailure = logcat.restartOnFailure !== false;
    const commands: string[] = [];

    if (logcat.bufferSize) {
        const bufferSize = quotePosix(logcat.bufferSize);
        commands.push(
            `adb ${adbDeviceArgs} logcat -b main -G ${bufferSize} || echo 'Warning: failed to set main logcat buffer size; continuing.' >&2`
        );
    }

    if (restartOnFailure) {
        commands.push(getPosixProcessLiveFunction(options.udid, options.pid, options.packageName));
        commands.push(
            `while :; do adb ${adbDeviceArgs} logcat -v raw -v color --pid=${pidArg}; sleep 1; android_debug_process_live || break; done`
        );
    } else {
        commands.push(`adb ${adbDeviceArgs} logcat -v raw -v color --pid=${pidArg}`);
    }

    return ` trap '' INT; ( ${commands.join("; ")} ) | uniq; printf '\\nPress Enter to close session...\\n' && read -s -r && exit`;
}

function getPowerShellLogcatCommand(options: LogcatCommandOptions) {
    const pidArg = quotePowerShell(`--pid=${options.pid}`);
    const logcat = options.logcat ?? {};
    const restartOnFailure = logcat.restartOnFailure !== false;
    const commands: string[] = [];

    if (logcat.bufferSize) {
        const bufferSize = quotePowerShell(logcat.bufferSize);
        commands.push(
            `& adb -s ${quotePowerShell(options.udid)} logcat -b main -G ${bufferSize}; if ($LASTEXITCODE -ne 0) { Write-Warning 'Failed to set main logcat buffer size; continuing.' }`
        );
    }

    if (restartOnFailure) {
        commands.push(getPowerShellProcessLiveFunction(options.udid, options.pid, options.packageName));
        commands.push(
            `while ($true) { & adb -s ${quotePowerShell(options.udid)} logcat -v raw -v color ${pidArg}; Start-Sleep -Seconds 1; if (-not (Test-AndroidDebugProcessLive)) { break } }`
        );
    } else {
        commands.push(`& adb -s ${quotePowerShell(options.udid)} logcat -v raw -v color ${pidArg}`);
    }

    return `try { & { ${commands.join("; ")} } | Get-Unique } finally { $null = Read-Host 'Press Enter to close session...'; exit }`;
}

export function getLogcatCommand(options: LogcatCommandOptions) {
    if ((options.platform ?? process.platform) === "win32") {
        return getPowerShellLogcatCommand(options);
    }

    return getPosixLogcatCommand(options);
}
