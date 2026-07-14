import * as assert from 'assert';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';
import { getLaunchAppCommand } from '../../android';
import { getLogcatCommand, LogcatCommandOptions } from '../../logcatCommand';
import { getScrcpyArgs, ScrcpyOutputParser, ScrcpyProcessController, validateScrcpyConfiguration } from '../../scrcpy';

const baseLogcatOptions: LogcatCommandOptions = {
	udid: 'emulator-5554',
	pid: '1234',
	packageName: 'com.example.app',
	platform: 'linux',
};

function createFakeChildProcess(): ChildProcessWithoutNullStreams {
	let child = new EventEmitter() as ChildProcessWithoutNullStreams;
	let mutableChild = child as any;
	mutableChild.stdout = new PassThrough();
	mutableChild.stderr = new PassThrough();
	mutableChild.stdin = new PassThrough();
	mutableChild.exitCode = null;
	mutableChild.killed = false;
	mutableChild.kill = (signal?: NodeJS.Signals | number) => {
		mutableChild.killed = true;
		mutableChild.exitCode = 0;
		setImmediate(() => child.emit('close', 0, signal ?? null));
		return true;
	};
	return child;
}

function exitFakeChildProcess(child: ChildProcessWithoutNullStreams, code: number) {
	(child as any).exitCode = code;
	child.emit('close', code, null);
}

async function nextEventLoopTurn() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('POSIX logcat command restarts by default without resizing buffer', () => {
		const command = getLogcatCommand(baseLogcatOptions);

		assert.ok(!command.includes(' -G '));
		assert.ok(command.includes("adb -s 'emulator-5554' logcat -v raw -v color --pid='1234'"));
		assert.ok(command.includes('android_debug_process_live'));
		assert.ok(command.includes("expected='com.example.app'"));
		assert.ok(command.includes('while :; do'));
		assert.ok(command.includes('| uniq'));
		assert.ok(command.indexOf('| uniq') > command.indexOf('done'));
	});

	test('POSIX logcat command can resize main buffer before starting logcat', () => {
		const command = getLogcatCommand({
			...baseLogcatOptions,
			logcat: {
				bufferSize: '16M',
			},
		});

		assert.ok(command.includes("logcat -b main -G '16M'"));
		assert.ok(command.includes('Warning: failed to set main logcat buffer size; continuing.'));
		assert.ok(command.indexOf("logcat -b main -G '16M'") < command.indexOf('logcat -v raw -v color'));
	});

	test('POSIX logcat command can disable restart loop', () => {
		const command = getLogcatCommand({
			...baseLogcatOptions,
			logcat: {
				restartOnFailure: false,
			},
		});

		assert.ok(!command.includes('android_debug_process_live'));
		assert.ok(!command.includes('while :; do'));
		assert.ok(command.includes("adb -s 'emulator-5554' logcat -v raw -v color --pid='1234'"));
		assert.ok(command.includes('| uniq'));
	});

	test('PowerShell logcat command restarts by default without resizing buffer', () => {
		const command = getLogcatCommand({
			...baseLogcatOptions,
			platform: 'win32',
		});

		assert.ok(!command.includes(' -G '));
		assert.ok(command.includes("& adb -s 'emulator-5554' logcat -v raw -v color '--pid=1234'"));
		assert.ok(command.includes('Test-AndroidDebugProcessLive'));
		assert.ok(command.includes("$expected = 'com.example.app'"));
		assert.ok(command.includes("$cmdline.StartsWith($expected + ':')"));
		assert.ok(command.includes('Start-Sleep -Seconds 1'));
		assert.ok(command.includes('| Get-Unique'));
		assert.ok(command.indexOf('| Get-Unique') > command.indexOf('while ($true)'));
	});

	test('PowerShell logcat command can resize main buffer and disable restart loop', () => {
		const command = getLogcatCommand({
			...baseLogcatOptions,
			platform: 'win32',
			logcat: {
				bufferSize: '16M',
				restartOnFailure: false,
			},
		});

		assert.ok(command.includes("logcat -b main -G '16M'"));
		assert.ok(command.includes('Failed to set main logcat buffer size; continuing.'));
		assert.ok(!command.includes('Test-AndroidDebugProcessLive'));
		assert.ok(!command.includes('while ($true)'));
		assert.ok(command.includes('| Get-Unique'));
	});

	test('scrcpy arguments preserve defaults and select an existing display', () => {
		assert.deepStrictEqual(getScrcpyArgs('emulator-5554'), [
			'-s', 'emulator-5554',
			'--keyboard=uhid',
			'--gamepad=uhid',
			'--capture-orientation=0',
		]);
		assert.ok(getScrcpyArgs('device with spaces', { displayId: 7 }).includes('--display-id=7'));
		assert.strictEqual(getScrcpyArgs('device with spaces', { displayId: 7 })[1], 'device with spaces');
	});

	test('scrcpy arguments create a virtual display with exact dimensions and density', () => {
		let args = getScrcpyArgs('emulator-5554', {
			newDisplay: {
				width: 1920,
				height: 1080,
				dpi: 420,
			},
		});

		assert.ok(args.includes('--new-display=1920x1080/420'));
		assert.ok(!args.some((arg) => arg.startsWith('--display-id=')));
	});

	test('scrcpy output parser handles fragmented display and readiness messages', () => {
		let parser = new ScrcpyOutputParser();
		parser.push('[server] INFO: New dis');
		assert.strictEqual(parser.getNewDisplayId(), undefined);
		parser.push('play: 1920x1080/420 (id=12)\nINFO: Tex');
		assert.strictEqual(parser.getNewDisplayId(), 12);
		assert.strictEqual(parser.isVideoReady(), false);
		parser.push('ture: 1920x1080\n');
		assert.strictEqual(parser.isVideoReady(), true);
	});

	test('scrcpy process controller waits for and returns a fragmented new display ID', async () => {
		let child = createFakeChildProcess();
		let controller = new ScrcpyProcessController(() => undefined, () => child);
		let started = controller.start('emulator-5554', {
			newDisplay: { width: 1920, height: 1080, dpi: 420 },
		}, 100);
		await nextEventLoopTurn();
		(child.stderr as PassThrough).write('[server] INFO: New dis');
		(child.stderr as PassThrough).write('play: 1920x1080/420 (id=21)\n');

		assert.deepStrictEqual(await started, { displayId: 21 });
		assert.strictEqual(controller.isRunning(), true);
		await controller.stop();
	});

	test('scrcpy process controller rejects early exit and startup timeout', async () => {
		let exitingChild = createFakeChildProcess();
		let exitingController = new ScrcpyProcessController(() => undefined, () => exitingChild);
		let exitingStart = exitingController.start('emulator-5554', { displayId: 9 }, 100);
		await nextEventLoopTurn();
		exitFakeChildProcess(exitingChild, 1);
		await assert.rejects(exitingStart, /exited with code 1/);

		let stalledChild = createFakeChildProcess();
		let stalledController = new ScrcpyProcessController(() => undefined, () => stalledChild);
		await assert.rejects(
			stalledController.start('emulator-5554', {
				newDisplay: { width: 1920, height: 1080, dpi: 420 },
			}, 5),
			/did not become ready within 5ms/,
		);
	});

	test('scrcpy configuration validates request-specific display selectors', () => {
		assert.deepStrictEqual(validateScrcpyConfiguration({ displayId: 0 }, 'attach'), { displayId: 0 });
		assert.deepStrictEqual(validateScrcpyConfiguration({
			newDisplay: { width: 1280, height: 720, dpi: 320 },
		}, 'launch'), {
			newDisplay: { width: 1280, height: 720, dpi: 320 },
		});
		assert.throws(() => validateScrcpyConfiguration({
			newDisplay: { width: 1280, height: 720, dpi: 320 },
		}, 'attach'), /only supported for launch/);
		assert.throws(() => validateScrcpyConfiguration({
			displayId: 1,
			newDisplay: { width: 1280, height: 720, dpi: 320 },
		}, 'launch'), /exactly one/);
		assert.throws(() => validateScrcpyConfiguration({
			newDisplay: { width: 1280, height: 720, dpi: 0 },
		}, 'launch'), /dpi must be a positive integer/);
	});

	test('Android app launch command targets the selected display', () => {
		assert.strictEqual(
			getLaunchAppCommand('com.example.app', '.MainActivity', { waitForDebugger: true, displayId: 12 }),
			'am start -D -W --display 12 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app/.MainActivity',
		);
		assert.strictEqual(
			getLaunchAppCommand('com.example.app', '.MainActivity'),
			'am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app/.MainActivity',
		);
	});
});
