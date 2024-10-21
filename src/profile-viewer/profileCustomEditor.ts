import * as vscode from 'vscode';
import { SimpleperfReportConverter } from '../profile-converter/converter';
// import { logger } from './logger'

export class SimpleperfReportCustomDocument implements vscode.CustomDocument {
    constructor(public uri: vscode.Uri, private fileData: Uint8Array) {}

    async saveAs(targetResource: vscode.Uri): Promise<void> {
        await vscode.workspace.fs.writeFile(targetResource, this.fileData);
    }

    get buffer(): Buffer {
        return Buffer.from(this.fileData.buffer);
    }

    dispose(): void {
        // Nothing to do
    }
}

export class SimpleperfReportCustomEditor implements vscode.CustomEditorProvider<SimpleperfReportCustomDocument> {
    public static readonly viewType = 'android-debug.profile';

    private readonly magicHeader = "SIMPLEPERF";

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            SimpleperfReportCustomEditor.viewType,
            new SimpleperfReportCustomEditor(context),
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
            }
        );
    }

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    onDidChangeCustomDocument: vscode.Event<vscode.CustomDocumentEditEvent<SimpleperfReportCustomDocument>> | vscode.Event<vscode.CustomDocumentContentChangeEvent<SimpleperfReportCustomDocument>> = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<SimpleperfReportCustomDocument>>().event;

    async saveCustomDocument(document: SimpleperfReportCustomDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // The document is never dirtied, nothing to do
        return;
    }

    async saveCustomDocumentAs(document: SimpleperfReportCustomDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        return document.saveAs(destination);
    }

    async revertCustomDocument(document: SimpleperfReportCustomDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // This should never be triggered as the document is never dirtied
        throw new Error('Method not implemented.');
    }

    async backupCustomDocument(document: SimpleperfReportCustomDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        // This should never be triggered as the document is never dirtied
        throw new Error('Method not implemented.');
    }

    async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<SimpleperfReportCustomDocument> {
        try {
            let fileData: Uint8Array;

            if (openContext.untitledDocumentData) {
                fileData = openContext.untitledDocumentData;
            } else {
                const fileUri = uri.scheme === "untitled" ? vscode.Uri.file(uri.fsPath): uri;
                fileData = await vscode.workspace.fs.readFile(fileUri);

                if (fileData.slice(0, this.magicHeader.length).toString() !== this.magicHeader) {
                    throw new Error("Not a valid simpleperf report");
                }
            }

            return new SimpleperfReportCustomDocument(uri, fileData);
        } catch (e) {
            throw e;
        }
    }

    async resolveCustomEditor(document: SimpleperfReportCustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        const processedProfilePromise = new SimpleperfReportConverter(document.buffer).process();

        const profilerBaseUrl = "https://deploy-preview-5170--perf-html.netlify.app";
        webviewPanel.webview.html = this.getWebviewContent(profilerBaseUrl);
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.name === "is-ready") {
                webviewPanel.webview.postMessage({ name: 'inject-profile', profile: await processedProfilePromise });
            }
        });
    }

    getWebviewContent(profilerBaseUrl: string): string {
        return `
<!DOCTYPE html>
<html>
    <head>
        <meta charset="UTF-8">
        <title>Simpleperf Report</title>
    </head>
    <body style="padding: 0">
        <script>
        (async function() {
            const profilerBaseUrl = "${profilerBaseUrl}";
            document.body.style.padding = '0';
            document.body.style.overflow = 'hidden';

            var iframe = document.createElement('iframe');
            iframe.src = profilerBaseUrl + "/from-post-message/";
            iframe.style.width = '100vw';
            iframe.style.height = '100vh';
            iframe.style.border = 'none';
            document.body.appendChild(iframe);

            let isProfilerReady = false;
            window.addEventListener('message', ({data}) => {
                switch (data.name) {
                    case "is-ready":
                        // Ready message coming from the profiler
                        isProfilerReady = true;
                        break;
                    case "inject-profile":
                        // Inject profile message coming from VS Code
                        iframe.contentWindow.postMessage(data, profilerBaseUrl);
                        break;
                    default:
                        console.error("Unknown message", data);
                        break;
                }
            });

            while (!isProfilerReady) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                iframe.contentWindow.postMessage({ name: 'is-ready' }, profilerBaseUrl);
            }

            const vscode = acquireVsCodeApi();
            vscode.postMessage({ name: 'is-ready' });
        })();
        </script>
    </body>
`;
    }
}