/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CommandManager } from './util/commandManager';
import * as commands from './commands/index';
import { RSTContentProvider } from './preview/previewContentProvider';
import { RSTPreviewManager } from './preview/previewManager';
import { Logger } from './util/logger';
import { Python } from './util/python';
import { RSTEngine } from './preview/rstEngine';
import { ExtensionContentSecurityPolicyArbiter, PreviewSecuritySelector } from './util/security';

import * as listEditing from './editor/listEditing';
import { rstDocumentSymbolProvider } from './preview/rstDocumentSymbolProvider';
import RstLintingProvider from './linter/rstLinter';
import { underline } from './editor/underline';
import { Configuration } from './util/configuration';
import RstTransformerStatus from './preview/statusBar';
import * as RstLanguageServer from './language-server/extension';
import { setGlobalState, setWorkspaceState } from './util/stateUtils';
import { initConfig } from './util/config';

let extensionPath = '';

export function getExtensionPath(): string {
    return extensionPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<{ initializationFinished: Promise<void> }> {

    setGlobalState(context.globalState);
    setWorkspaceState(context.workspaceState);

    await initConfig(context);

    extensionPath = context.extensionPath;

    const logger = new Logger();
    logger.log('Please visit https://docs.restructuredtext.net to learn how to configure the extension.');

    const conflicting = Configuration.getConflictingExtensions();
    for (const element of conflicting) {
        const found = vscode.extensions.getExtension(element);
        if (found) {
            const message = `Found conflicting extension ${element}. Please uninstall it.`;
            logger.log(message);
            vscode.window.showErrorMessage(message);
        }
    }

    await logPlatform(logger);
    const disableLsp = Configuration.getLanguageServerDisabled();

    const python: Python = new Python(logger);

    // activate language services
    const rstLspPromise = RstLanguageServer.activate(context, logger, disableLsp, python);

    // Section creation support.
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('restructuredtext.features.underline.underline', underline),
        vscode.commands.registerTextEditorCommand('restructuredtext.features.underline.underlineReverse',
            (textEditor, edit) => underline(textEditor, edit, true)),
    );

    // Linter support
    if (!Configuration.getLinterDisabled()) {
        const linter = new RstLintingProvider(logger, python);
        linter.activate(context.subscriptions);
    }

    if (!Configuration.getDocUtilDisabled() || !Configuration.getSphinxDisabled()) {
        // Status bar to show the active rst->html transformer configuration
        const status = new RstTransformerStatus(python, logger);

        // Hook up the status bar to document change events
        context.subscriptions.push(
            vscode.commands.registerCommand('restructuredtext.resetStatus',
                status.reset, status),
        );

        vscode.window.onDidChangeActiveTextEditor(status.update, status, context.subscriptions);
        status.update();

        const cspArbiter = new ExtensionContentSecurityPolicyArbiter(context.globalState, context.workspaceState);

        const engine: RSTEngine = new RSTEngine(python, logger, status);

        const contentProvider = new RSTContentProvider(context, cspArbiter, engine, logger);
        const previewManager = new RSTPreviewManager(contentProvider, logger);
        context.subscriptions.push(previewManager);

        const previewSecuritySelector = new PreviewSecuritySelector(cspArbiter, previewManager);

        const commandManager = new CommandManager();
        context.subscriptions.push(commandManager);
        commandManager.register(new commands.ShowPreviewCommand(previewManager, python));
        commandManager.register(new commands.ShowPreviewToSideCommand(previewManager, python));
        commandManager.register(new commands.ShowLockedPreviewToSideCommand(previewManager, python));
        commandManager.register(new commands.ShowSourceCommand(previewManager));
        commandManager.register(new commands.RefreshPreviewCommand(previewManager));
        commandManager.register(new commands.MoveCursorToPositionCommand());
        commandManager.register(new commands.ShowPreviewSecuritySelectorCommand(previewSecuritySelector, previewManager));
        commandManager.register(new commands.OpenDocumentLinkCommand());
        commandManager.register(new commands.ToggleLockCommand(previewManager));

        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => {
            logger.updateConfiguration();
            previewManager.updateConfiguration();
        }));
    }

    // DocumentSymbolProvider Demo, for Outline View Test
    let disposableRstDSP = vscode.languages.registerDocumentSymbolProvider(
        { scheme: 'file', language: 'restructuredtext' }, new rstDocumentSymbolProvider()
    );
    context.subscriptions.push(disposableRstDSP);

    listEditing.activate(context);

    return {
        initializationFinished: Promise.all([rstLspPromise])
            .then((promiseResult) => {
                // This promise resolver simply swallows the result of Promise.all.
                // When we decide we want to expose this level of detail
                // to other extensions then we will design that return type and implement it here.
            }),
    };
}

async function logPlatform(logger: Logger): Promise<void> {
    const os = require('os');
    let platform = os.platform();
    logger.log(`OS is ${platform}`);
    if (platform === 'darwin' || platform === 'win32') {
        return;
    }

    const osInfo = require('linux-os-info');
    const result = await osInfo();
    const dist = result.id;
    logger.log(`dist: ${dist}`);
}
