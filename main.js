const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { startEmbeddedServer } = require('./server.js');

const PORT = process.env.PORT || 3000;
let mainWindow = null;
let tray = null;

// ── Create main desktop window ─────────────────────────────────────────────
function createWindow() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const appIcon = nativeImage.createFromPath(iconPath);

    mainWindow = new BrowserWindow({
        width: 1380,
        height: 860,
        minWidth: 1024,
        minHeight: 640,
        icon: appIcon,
        title: 'PC Optimizer & Drive C Manager',
        backgroundColor: '#0b0f19',
        show: true, // Show immediately — instant startup!
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
        },
        autoHideMenuBar: true,
    });

    Menu.setApplicationMenu(null);
    mainWindow.loadURL(`http://localhost:${PORT}`);

    // Focus window once created
    mainWindow.once('ready-to-show', () => {
        mainWindow.focus();
    });

    // Open external links in default OS browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // Minimize to system tray on window close button
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // Retry page load if server was still initializing
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
        console.error(`Page load error: ${code} ${desc}`);
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.loadURL(`http://localhost:${PORT}`);
            }
        }, 300);
    });
}

// ── Create System Tray ────────────────────────────────────────────────────
function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

    tray = new Tray(trayIcon);
    tray.setToolTip('PC Optimizer & Drive C Manager');

    const contextMenu = Menu.buildFromTemplate([
        {
            label: '🖥️  Open PC Optimizer',
            click: () => { mainWindow.show(); mainWindow.focus(); }
        },
        { type: 'separator' },
        {
            label: '🔄  Refresh',
            click: () => { if (mainWindow) mainWindow.reload(); }
        },
        { type: 'separator' },
        {
            label: '❌  Exit',
            click: () => { app.isQuitting = true; app.quit(); }
        }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ── Instant App Lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
    // Start embedded Express server directly in-process (<10ms launch)
    await startEmbeddedServer(PORT);

    createWindow();
    createTray();
});

app.on('window-all-closed', () => {
    if (process.platform === 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => {
    app.isQuitting = true;
});
