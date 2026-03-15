import * as vscode from 'vscode';
import * as debugadapter from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import * as extensionDependencies from './extensionDependencies';
import * as android from './android';
import { Device } from './commonTypes';

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
    private scrcpy: vscode.Terminal | undefined;
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

    private getLogcatCommand(udid: string, pid: string) {
        const shellHistoryPrefix = process.platform === "win32" ? "" : " ";

        if (process.platform === "win32") {
            return `try { adb -s ${udid} logcat -v raw -v color --pid=${pid} | Get-Unique } finally { $null = Read-Host 'Press Enter to close session...'; exit }`;
        }

        return `${shellHistoryPrefix}trap '' INT; adb -s ${udid} logcat -v raw -v color --pid=${pid} | uniq; echo -e '\nPress 'Enter' to close session...' && read -s -r && exit`;
    }

    private getScrcpyCommand(udid: string) {
        const shellHistoryPrefix = process.platform === "win32" ? "" : " ";

        return `${shellHistoryPrefix}scrcpy -s ${udid} --keyboard=uhid --gamepad=uhid --capture-orientation=0`;
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
        term.sendText(this.getLogcatCommand(config.target.udid, pid));
        term.show();
        DebugAdapter.terminal!.set(this.sessionName, term);

        if (!this.scrcpy) {
            const scrcpyTermOpts: vscode.TerminalOptions = {
                name: "ScrCpy-" + this.sessionName,
                hideFromUser: true,
                iconPath: new vscode.ThemeIcon("device-mobile")
            };
            this.scrcpy = this.createTerminal(scrcpyTermOpts);
        }
        else
            this.scrcpy.sendText('\u0003');
        this.scrcpy.sendText(this.getScrcpyCommand(config.target.udid));

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
        let pid = this.session.configuration.pid;

        // Attach to process
        await this.attachToProcess(pid, response);

        // Resume process if applicable
        await this.resumeProcess(pid);

        this.sendResponse(response);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        let config = this.session.configuration;

        let target: Device = config.target;

        try {
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
            await android.launchApp(target, config.packageName, config.launchActivity);

            this.consoleLog(`Getting pid for the launched app`);

            // Wait for some time before trying to get pid
            await new Promise((resolve, reject) => setTimeout(resolve, 1000));

            // Get last pid from jdwp
            let processList = await android.getProcessList(target, false);
            let process = processList.length ? processList[processList.length - 1] : undefined;

            if (!process?.pid) {
                throw new Error("Could not get pid for the app. Please ensure that the app is launched correctly.");
            }
            else {
                this.consoleLog(`Attaching to process ${process.pid} (${process.name})`);
            }

            // Attach to the process
            await this.attachToProcess(process.pid, response);

            // Resume process if applicable
            await this.resumeProcess(process.pid);
        }
        catch (e: any) {
            response.success = false;
            response.message = `Error launching: ${e.message}`;
        }

        this.sendResponse(response);
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        await Promise.all(Object.values(this.childSessions).map(async (s) => await vscode.debug.stopDebugging(s)));

        if (this.scrcpy) {
            this.scrcpy.sendText('\u0003');
            this.scrcpy.dispose();
            this.scrcpy = undefined;
        }

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
                while (session.parentSession !== undefined)
                    session = session.parentSession;
                vscode.debug.stopDebugging(session);
            }
            this.terminalWatcher?.dispose();
        }
    }
}
