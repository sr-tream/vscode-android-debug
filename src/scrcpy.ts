import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

export interface ScrcpyNewDisplayConfiguration {
    width: number;
    height: number;
    dpi: number;
}

export interface ScrcpyConfiguration {
    displayId?: number;
    newDisplay?: ScrcpyNewDisplayConfiguration;
}

export interface ScrcpyStartResult {
    displayId?: number;
}

export type ScrcpyProcessSpawner = (args: string[]) => ChildProcessWithoutNullStreams;

function spawnScrcpy(args: string[]) {
    return spawn("scrcpy", args, { windowsHide: true });
}

export class ScrcpyOutputParser {
    private output = "";

    push(chunk: string | Buffer) {
        this.output += chunk.toString();
        if (this.output.length > 16384) {
            this.output = this.output.slice(-16384);
        }
    }

    getNewDisplayId(): number | undefined {
        let match = this.output.match(/\bNew display:[^\r\n]*\(id=(\d+)\)/i);
        return match ? Number(match[1]) : undefined;
    }

    isVideoReady(): boolean {
        return /\b(?:Initial\s+)?Texture:\s*\d+x\d+/i.test(this.output);
    }

    getRecentOutput(): string {
        return this.output;
    }
}

function requireNonNegativeInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
    return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
}

export function validateScrcpyConfiguration(value: unknown, request: "attach" | "launch"): ScrcpyConfiguration | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("scrcpy must be an object.");
    }

    let raw = value as Record<string, unknown>;
    let unknownProperties = Object.keys(raw).filter((key) => key !== "displayId" && key !== "newDisplay");
    if (unknownProperties.length) {
        throw new Error(`Unknown scrcpy configuration property '${unknownProperties[0]}'.`);
    }

    let hasDisplayId = raw.displayId !== undefined;
    let hasNewDisplay = raw.newDisplay !== undefined;
    if (hasDisplayId === hasNewDisplay) {
        throw new Error("scrcpy must specify exactly one of displayId or newDisplay.");
    }

    if (hasDisplayId) {
        return { displayId: requireNonNegativeInteger(raw.displayId, "scrcpy.displayId") };
    }

    if (request === "attach") {
        throw new Error("scrcpy.newDisplay is only supported for launch requests.");
    }
    if (typeof raw.newDisplay !== "object" || raw.newDisplay === null || Array.isArray(raw.newDisplay)) {
        throw new Error("scrcpy.newDisplay must be an object.");
    }

    let rawNewDisplay = raw.newDisplay as Record<string, unknown>;
    let unknownNewDisplayProperties = Object.keys(rawNewDisplay).filter((key) => !["width", "height", "dpi"].includes(key));
    if (unknownNewDisplayProperties.length) {
        throw new Error(`Unknown scrcpy.newDisplay configuration property '${unknownNewDisplayProperties[0]}'.`);
    }

    return {
        newDisplay: {
            width: requirePositiveInteger(rawNewDisplay.width, "scrcpy.newDisplay.width"),
            height: requirePositiveInteger(rawNewDisplay.height, "scrcpy.newDisplay.height"),
            dpi: requirePositiveInteger(rawNewDisplay.dpi, "scrcpy.newDisplay.dpi"),
        },
    };
}

export function getScrcpyArgs(udid: string, config?: ScrcpyConfiguration): string[] {
    let args = [
        "-s", udid,
        "--keyboard=uhid",
        "--gamepad=uhid",
        "--capture-orientation=0",
    ];

    if (config?.displayId !== undefined) {
        args.push(`--display-id=${config.displayId}`);
    } else if (config?.newDisplay) {
        let display = config.newDisplay;
        args.push(`--new-display=${display.width}x${display.height}/${display.dpi}`);
    }

    return args;
}

interface StartupWaiter {
    check: () => void;
    reject: (error: Error) => void;
}

interface ManagedScrcpyProcess {
    child: ChildProcessWithoutNullStreams;
    parser: ScrcpyOutputParser;
    intentionalStop: boolean;
    failureReported: boolean;
    startupWaiter?: StartupWaiter;
}

export class ScrcpyProcessController {
    private current: ManagedScrcpyProcess | undefined;

    constructor(
        private readonly onMessage: (message: string) => void = () => undefined,
        private readonly spawnProcess: ScrcpyProcessSpawner = spawnScrcpy,
    ) {}

    isRunning(): boolean {
        return !!this.current && this.current.child.exitCode === null && !this.current.child.killed;
    }

    async start(udid: string, config?: ScrcpyConfiguration, timeoutMs = 15000): Promise<ScrcpyStartResult> {
        await this.stop();

        let child = this.spawnProcess(getScrcpyArgs(udid, config));
        let state: ManagedScrcpyProcess = {
            child,
            parser: new ScrcpyOutputParser(),
            intentionalStop: false,
            failureReported: false,
        };
        this.current = state;

        let handleOutput = (chunk: Buffer) => {
            state.parser.push(chunk);
            state.startupWaiter?.check();
        };
        child.stdout.on("data", handleOutput);
        child.stderr.on("data", handleOutput);
        child.on("error", (error) => {
            let wrapped = this.createFailure(state, error.message);
            if (state.startupWaiter) {
                state.startupWaiter.reject(wrapped);
            } else {
                this.reportUnexpectedFailure(state, wrapped.message);
            }
        });
        child.on("close", (code, signal) => {
            if (this.current === state) {
                this.current = undefined;
            }
            if (state.intentionalStop) {
                return;
            }

            let reason = signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`;
            let error = this.createFailure(state, reason);
            if (state.startupWaiter) {
                state.startupWaiter.reject(error);
            } else {
                this.reportUnexpectedFailure(state, error.message);
            }
        });

        let waitMode: "new-display" | "video" | undefined = config?.newDisplay ? "new-display" : config?.displayId !== undefined ? "video" : undefined;
        if (!waitMode) {
            return {};
        }

        try {
            let result = await this.waitForStartup(state, waitMode, timeoutMs);
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (!this.isRunning()) {
                throw this.createFailure(state, "exited during startup");
            }
            return result;
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop(): Promise<void> {
        let state = this.current;
        if (!state) {
            return;
        }
        this.current = undefined;
        state.intentionalStop = true;
        state.startupWaiter?.reject(new Error("scrcpy startup cancelled."));

        if (state.child.exitCode !== null) {
            return;
        }

        await new Promise<void>((resolve) => {
            let settled = false;
            let finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(forceTimer);
                clearTimeout(giveUpTimer);
                resolve();
            };
            let forceTimer = setTimeout(() => {
                if (state.child.exitCode === null) {
                    state.child.kill("SIGKILL");
                }
            }, 2000);
            let giveUpTimer = setTimeout(finish, 3000);

            state.child.once("close", finish);
            try {
                if (!state.child.kill()) {
                    finish();
                }
            } catch {
                finish();
            }
        });
    }

    private waitForStartup(state: ManagedScrcpyProcess, mode: "new-display" | "video", timeoutMs: number): Promise<ScrcpyStartResult> {
        return new Promise<ScrcpyStartResult>((resolve, reject) => {
            let settled = false;
            let timer = setTimeout(() => {
                finishReject(this.createFailure(state, `did not become ready within ${timeoutMs}ms`));
            }, timeoutMs);

            let clear = () => {
                clearTimeout(timer);
                if (state.startupWaiter === waiter) {
                    state.startupWaiter = undefined;
                }
            };
            let finishResolve = (result: ScrcpyStartResult) => {
                if (!settled) {
                    settled = true;
                    clear();
                    resolve(result);
                }
            };
            let finishReject = (error: Error) => {
                if (!settled) {
                    settled = true;
                    clear();
                    reject(error);
                }
            };
            let waiter: StartupWaiter = {
                check: () => {
                    if (mode === "new-display") {
                        let displayId = state.parser.getNewDisplayId();
                        if (displayId !== undefined) {
                            finishResolve({ displayId });
                        }
                    } else if (state.parser.isVideoReady()) {
                        finishResolve({});
                    }
                },
                reject: finishReject,
            };
            state.startupWaiter = waiter;
            waiter.check();
        });
    }

    private createFailure(state: ManagedScrcpyProcess, reason: string): Error {
        let lines = state.parser.getRecentOutput().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        let detail = lines.slice(-3).join(" | ");
        return new Error(`scrcpy ${reason}${detail ? `: ${detail}` : ""}`);
    }

    private reportUnexpectedFailure(state: ManagedScrcpyProcess, message: string) {
        if (!state.failureReported) {
            state.failureReported = true;
            this.onMessage(`Warning: ${message}`);
        }
    }
}
