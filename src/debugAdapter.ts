import * as vscode from 'vscode';
import * as debugadapter from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import * as extensionDependencies from './extensionDependencies';
import * as android from './android';
import { Device } from './commonTypes';
import { getLogcatCommand } from './logcatCommand';
import { ScrcpyConfiguration, ScrcpyProcessController, validateScrcpyConfiguration } from './scrcpy';

export class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory  {
    private context: vscode.ExtensionContext;
    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new DebugAdapter(this.context, session));
    }
}

class DebugAdapter extends debugadapter.LoggingDebugSession {
    private session: vscode.DebugSession;
    private childSessions: {[key: string]: vscode.DebugSession} = {};
    private jdwpCleanup: (() => Promise<void>) | undefined;
    private static terminal: Map<string, vscode.Terminal> | undefined; 
    private scrcpy: ScrcpyProcessController;
    private scrcpyConfiguration: ScrcpyConfiguration | undefined;
    private scrcpyFallbackToMain = false;
    private newDisplayStarted = false;
    private sessionName: string | undefined;
    private terminalWatcher: vscode.Disposable | undefined;

    constructor(context: vscode.ExtensionContext, session: vscode.DebugSession) {
        super();

        if (!DebugAdapter.terminal) {
            DebugAdapter.terminal = new Map<string, vscode.Terminal>();
        } else {
            DebugAdapter.terminal.forEach((term, device) => {
                if (term.exitStatus === undefined) {
                    term.dispose();
                    DebugAdapter.terminal!.delete(device);
                }
            });
        }
        this.terminalWatcher = vscode.window.onDidCloseTerminal(this.didCloseTerminal.bind(this));
        this.scrcpy = new ScrcpyProcessController((message) => this.consoleLog(message));

        this.session = session;
        context.subscriptions.push(vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession));
        context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(this.onDidTerminateDebugSession));
    }

    private onDidStartDebugSession = (debugSession: vscode.DebugSession) => {
        if (debugSession.parentSession?.id === this.session.id) {
            this.childSessions[debugSession.id] = debugSession;
        }
    };

    private onDidTerminateDebugSession = (debugSession: vscode.DebugSession) => {
        if (debugSession.id in this.childSessions) {
            delete this.childSessions[debugSession.id];
        }

        // Terminate debug session if no child sessions are active
        if (!Object.keys(this.childSessions).length) {
            this.sendEvent(new debugadapter.TerminatedEvent());
        }
    };

    private consoleLog(message: string) {
        this.sendEvent(new debugadapter.OutputEvent(`${message}\n`, "console"));
    }

    private prepareNativeDebugConfiguration(config: vscode.DebugConfiguration, pid: string) {
        let lldbConfig: vscode.DebugConfiguration = {
            "type": "lldb",
            "name": "Native",
            "request": "attach",
            "pid": pid,
            "androidTarget": config.target.udid,
            "androidAbi": config.native.abi,
            "androidPackageName": config.packageName,
        };

        let excludeProperties = ["abi", "abiSupported", "abiMap"];

        if (config.native) {
            for (let key in config.native) {
                if (!excludeProperties.includes(key)) {
                    lldbConfig[key] = config.native[key];
                }
            }
        }

        return lldbConfig;
    }

    private prepareJavaDebugConfiguration(config: vscode.DebugConfiguration, pid: string) {
        let javaConfig: vscode.DebugConfiguration = {
            "type": "java",
            "name": "Java",
            "request": "attach",
            "processId": pid,
            "androidTarget": config.target.udid,
        };

        let excludeProperties: string[] = [];

        if (config.java) {
            for (let key in config.java) {
                if (!excludeProperties.includes(key)) {
                    javaConfig[key] = config.java[key];
                }
            }
        }

        return javaConfig;
    }

    private createTerminal(options: vscode.TerminalOptions) {
        if (process.platform === "win32") {
            options = {
                ...options,
                shellPath: "powershell.exe",
                shellArgs: ["-NoLogo"],
            };
        }

        return vscode.window.createTerminal(options);
    }

    private async attachToProcess(pid: string, response: DebugProtocol.Response) {
        let config = this.session.configuration;

        let lldbEnabled = config.mode === "dual" || config.mode === "native";
        let javaEnabled = config.mode === "dual" || config.mode === "java";

        extensionDependencies.ensureExtensions(lldbEnabled, javaEnabled);

        let lldbSuccess = !lldbEnabled;
        if (lldbEnabled) {
            this.consoleLog("Starting Native debugger");
            let lldbConfig = this.prepareNativeDebugConfiguration(config, pid);

            lldbSuccess = await vscode.debug.startDebugging(this.session.workspaceFolder, lldbConfig, {
                parentSession: this.session
            });
        }

        let javaSuccess = !javaEnabled;
        if (javaEnabled && lldbSuccess) {
            this.consoleLog("Starting Java debugger");
            let javaConfig = this.prepareJavaDebugConfiguration(config, pid);

            javaSuccess = await vscode.debug.startDebugging(this.session.workspaceFolder, javaConfig, {
                parentSession: this.session
            });
        }

        response.success = lldbSuccess && javaSuccess;

        if (!response.success) {
            response.message = !lldbSuccess ? "Could not start native debugger" : !javaSuccess ? "Could not start java debugger" : "Could not start android debugger";
        }

        if (response.success) {
            this.consoleLog(`Attached to process ${pid}`);
        }
        else {
            this.consoleLog(`Error: ${response.message}`);
        }
    }

    private configureScrcpy(request: "attach" | "launch") {
        this.scrcpyConfiguration = validateScrcpyConfiguration(this.session.configuration.scrcpy, request);
        this.scrcpyFallbackToMain = false;
        this.newDisplayStarted = false;
    }

    private async prepareScrcpyForAttach(udid: string) {
        if (this.scrcpyConfiguration?.displayId === undefined) {
            return;
        }

        this.consoleLog(`Starting scrcpy for display ${this.scrcpyConfiguration.displayId}`);
        await this.scrcpy.start(udid, this.scrcpyConfiguration);
    }

    private async prepareScrcpyForLaunch(udid: string): Promise<number | undefined> {
        if (this.scrcpyConfiguration?.displayId !== undefined) {
            this.consoleLog(`Starting scrcpy for display ${this.scrcpyConfiguration.displayId}`);
            await this.scrcpy.start(udid, this.scrcpyConfiguration);
            return this.scrcpyConfiguration.displayId;
        }

        if (!this.scrcpyConfiguration?.newDisplay) {
            return undefined;
        }

        let display = this.scrcpyConfiguration.newDisplay;
        this.consoleLog(`Creating scrcpy virtual display ${display.width}x${display.height}/${display.dpi}`);
        try {
            let result = await this.scrcpy.start(udid, this.scrcpyConfiguration);
            if (result.displayId === undefined) {
                throw new Error("scrcpy did not report the new display ID.");
            }
            this.newDisplayStarted = true;
            this.consoleLog(`Created scrcpy virtual display ${result.displayId}`);
            return result.displayId;
        } catch (error: any) {
            this.scrcpyFallbackToMain = true;
            this.consoleLog(`Warning: Could not create the configured scrcpy virtual display: ${error.message}`);
            this.consoleLog("Falling back to Android display 0");
            return undefined;
        }
    }

    private async ensureScrcpyStarted(udid: string) {
        if (this.scrcpy.isRunning()) {
            return;
        }
        if (this.newDisplayStarted) {
            throw new Error("The scrcpy virtual display exited before debugger startup completed.");
        }

        let configuration = this.scrcpyFallbackToMain ? undefined : this.scrcpyConfiguration;
        if (configuration?.displayId !== undefined) {
            this.consoleLog(`Restarting scrcpy for display ${configuration.displayId}`);
        }
        await this.scrcpy.start(udid, configuration);
    }

    private async resumeProcess(pid: string) {
        let config = this.session.configuration;

        this.sessionName = this.session.name + "@" + config.target.udid;
        let term = DebugAdapter.terminal!.get(this.sessionName);
        if (term) {
            if (term.exitStatus !== undefined) {
                term.sendText('\u0003');
            }
            term.hide();
            term.dispose();
        }
        const termOpts: vscode.TerminalOptions = {
            name: this.sessionName,
            hideFromUser: false,
            iconPath: new vscode.ThemeIcon("debug"),
            isTransient: false,
        };
        term = this.createTerminal(termOpts);
        term.sendText(getLogcatCommand({
            udid: config.target.udid,
            pid,
            packageName: config.packageName,
            logcat: config.logcat,
        }));
        term.show();
        DebugAdapter.terminal!.set(this.sessionName, term);

        await this.ensureScrcpyStarted(config.target.udid);

        if (config.resumeProcess) {
            try {
                this.consoleLog(`Resuming process by attaching Java debugger`);
                this.jdwpCleanup = await android.resumeJavaDebugger(config.target, pid);
            }
            catch (e: any) {
                this.consoleLog(`Error resuming process: ${e.message}`);
            }
        }
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        let config = this.session.configuration;
        let pid = String(config.pid);

        try {
            this.configureScrcpy("attach");
            await this.prepareScrcpyForAttach(config.target.udid);

            // Attach to process
            await this.attachToProcess(pid, response);

            // Resume process if applicable
            if (response.success) {
                await this.resumeProcess(pid);
            } else {
                await this.scrcpy.stop();
            }
        } catch (e: any) {
            await this.scrcpy.stop();
            response.success = false;
            response.message = `Error attaching: ${e.message}`;
        }

        this.sendResponse(response);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        let config = this.session.configuration;

        let target: Device = config.target;

        try {
            this.configureScrcpy("launch");

            // Install the app if required
            if (config.apkPath) {
                this.consoleLog(`Installing ${config.apkPath}`);
                await android.installApp(target, config.apkPath);
            }

            // Try launching the app
            if (!config.packageName) {
                throw new Error("A valid package name is required.");
            }
            this.consoleLog(`Launching the app activity ${config.packageName}/${config.launchActivity}`);

            let waitForDebugger: boolean;
            if (typeof config.waitForDebugger === "boolean") {
                waitForDebugger = config.waitForDebugger;
            } else {
                // Default: enable `-D` so the debugger can attach before user code runs.
                // Skip it for wrap.sh / HWASan builds where JDWP often never registers
                // and `-D` would deadlock the launch.
                let usesWrapSh = await android.hasWrapSh(target, config.packageName);
                waitForDebugger = !usesWrapSh;
                if (usesWrapSh) {
                    this.consoleLog(`Detected wrap.sh in '${config.packageName}', launching without -D (wait-for-debugger)`);
                }
            }

            let displayId = await this.prepareScrcpyForLaunch(target.udid);
            await android.launchApp(target, config.packageName, config.launchActivity, {
                waitForDebugger,
                displayId,
            });

            let pid: string | undefined;
            if (config.pid) {
                pid = String(config.pid);
                this.consoleLog(`Using explicit pid ${pid}`);
            }
            else {
                this.consoleLog(`Getting pid for the launched app`);

                // Primary: poll `pidof <packageName>`. Authoritative on Android 6+
                // and independent of JDWP registration (survives wrap.sh / HWASan).
                pid = await android.waitForPidForPackage(target, config.packageName, { timeoutMs: 15000, pollMs: 500 });

                // Secondary: legacy filtered process list for pre-Android-6 devices
                // where `pidof <package>` is unavailable.
                if (!pid) {
                    let processList = await android.getProcessList(target, true);
                    let match = processList.find((p) =>
                        p.packages.includes(config.packageName)
                        || p.name === config.packageName
                        || config.packageName.endsWith(p.name)
                    );
                    pid = match?.pid;
                }

                if (!pid) {
                    throw new Error(
                        `App '${config.packageName}' does not appear to be running.\n` +
                        `  - verify AndroidManifest declares '${config.launchActivity}' as a launchable activity\n` +
                        `  - verify 'adb shell pm path ${config.packageName}' succeeds on the target device`
                    );
                }

                this.consoleLog(`Attaching to process ${pid}`);

                // Diagnostic: warn early if Java is requested but the pid isn't
                // advertised by `adb jdwp`. Common on wrap.sh / HWASan builds on
                // OEM-hardened Android where JDWP never registers.
                if (config.mode === "dual" || config.mode === "java") {
                    try {
                        let jdwpPids = await android.getJdwpPids(target);
                        if (!jdwpPids.includes(pid)) {
                            this.consoleLog(
                                `Warning: pid ${pid} is not visible in 'adb jdwp'. ` +
                                `Java debugger may fail to attach. ` +
                                `This is common with wrap.sh / HWASan builds on some OEM Android builds — ` +
                                `consider "mode": "native" to attach only LLDB.`
                            );
                        }
                    } catch { /* best-effort diagnostic */ }
                }
            }

            // Attach to the process
            await this.attachToProcess(pid, response);

            // Resume process if applicable
            if (response.success) {
                await this.resumeProcess(pid);
            } else {
                await this.scrcpy.stop();
            }
        }
        catch (e: any) {
            await this.scrcpy.stop();
            response.success = false;
            response.message = `Error launching: ${e.message}`;
        }

        this.sendResponse(response);
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        await Promise.all(Object.values(this.childSessions).map(async (s) => await vscode.debug.stopDebugging(s)));

        await this.scrcpy.stop();

        if (this.jdwpCleanup) {
            await this.jdwpCleanup();
            this.jdwpCleanup = undefined;
        }

        this.consoleLog("Debugger detached");
        this.sendResponse(response);
    }

    private async didCloseTerminal(terminal: vscode.Terminal) {
        if (terminal.name === this.sessionName) {
            DebugAdapter.terminal!.delete(this.sessionName);
            let session = this.session;
            if (session) {
                while (session.parentSession !== undefined) {
                    session = session.parentSession;
                }
                vscode.debug.stopDebugging(session);
            }
            this.terminalWatcher?.dispose();
        }
    }
}
