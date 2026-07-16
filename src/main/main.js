import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Closing with edits in flight would drop them silently — nothing is written
 * until Update. This has to live here rather than in the renderer: Electron
 * does not prompt for beforeunload, it just cancels the close without telling
 * anyone. So intercept, ask the page what's unsaved, and confirm natively.
 */
function guardClose (win) {
    let allowClose = false;
    // tests exit unattended, so the gate is off under FINANCES_E2E — unless
    // FINANCES_CLOSE_ANSWER names the button to auto-click, which is how the
    // gate itself gets tested without leaving a modal on screen
    const autoAnswer = process.env.FINANCES_E2E && process.env.FINANCES_CLOSE_ANSWER;

    win.on('close', (e) => {
        if (allowClose || (process.env.FINANCES_E2E && !autoAnswer)) return;
        e.preventDefault();
        win.webContents
            .executeJavaScript('window.__unsavedSummary ? window.__unsavedSummary() : null')
            .catch(() => null) // a broken page must never trap the user inside the app
            .then(async (unsaved) => {
                if (!unsaved) { allowClose = true; win.close(); return; }
                const { response } = autoAnswer
                    ? { response: autoAnswer === 'discard' ? 0 : 1 }
                    : await dialog.showMessageBox(win, {
                        type: 'warning',
                        buttons: ['Discard & quit', 'Keep editing'],
                        defaultId: 1,
                        cancelId: 1,
                        title: 'Unsaved changes',
                        message: `Discard unsaved changes to ${unsaved}?`,
                        detail: 'They have not been written to your database yet. Closing now loses them.',
                    });
                if (response === 0) { allowClose = true; win.close(); }
            });
    });
}

function createWindow () {
    const win = new BrowserWindow({
        width: 1500,
        height: 960,
        minWidth: 900,
        minHeight: 600,
        icon: path.join(__dirname, '../renderer/assets/icon.ico'),
        backgroundColor: '#fafafa',
        webPreferences: {
            preload: path.join(__dirname, '../preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.removeMenu();
    guardClose(win);
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    if (process.env.FINANCES_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
    if (process.env.FINANCES_LOG_CONSOLE) {
        win.webContents.on('console-message', (e, level, message, line, sourceId) => {
            console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
        });
    }
    if (process.env.FINANCES_SCREENSHOT) {
        win.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
                const image = await win.webContents.capturePage();
                fs.writeFileSync(process.env.FINANCES_SCREENSHOT, image.toPNG());
                console.log('[screenshot] written to ' + process.env.FINANCES_SCREENSHOT);
            }, 2000);
        });
    }
    if (process.env.FINANCES_E2E) {
        win.webContents.setBackgroundThrottling(false); // keep painting for capturePage
        win.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
                const script = fs.readFileSync(process.env.FINANCES_E2E, 'utf8');
                let dbg = null;
                if (process.env.FINANCES_PROFILE) {
                    dbg = win.webContents.debugger;
                    dbg.attach('1.3');
                    await dbg.sendCommand('Profiler.enable');
                    await dbg.sendCommand('Profiler.start');
                }
                try {
                    const result = await win.webContents.executeJavaScript(script);
                    console.log('[e2e] ' + JSON.stringify(result, null, 2));
                } catch (err) {
                    console.log('[e2e:error] ' + (err && err.message || err));
                }
                if (dbg) {
                    const { profile } = await dbg.sendCommand('Profiler.stop');
                    fs.writeFileSync(process.env.FINANCES_PROFILE, JSON.stringify(profile));
                    console.log('[profile] written to ' + process.env.FINANCES_PROFILE);
                }
                if (process.env.FINANCES_E2E_SCREENSHOT) {
                    const image = await win.webContents.capturePage();
                    fs.writeFileSync(process.env.FINANCES_E2E_SCREENSHOT, image.toPNG());
                    console.log('[screenshot] written to ' + process.env.FINANCES_E2E_SCREENSHOT);
                }
                app.quit();
            }, 2500);
        });
    }
    return win;
}

app.whenReady().then(async () => {
    await registerIpc();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
