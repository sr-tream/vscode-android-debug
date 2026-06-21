import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';
import { getLogcatCommand, LogcatCommandOptions } from '../../logcatCommand';

const baseLogcatOptions: LogcatCommandOptions = {
	udid: 'emulator-5554',
	pid: '1234',
	packageName: 'com.example.app',
	platform: 'linux',
};

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
});
