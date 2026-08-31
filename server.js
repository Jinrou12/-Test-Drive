const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helper: run PowerShell command ───────────────────────────────────────
function runPowerShell(cmd) {
    return new Promise((resolve) => {
        // Escape double-quotes for cmd.exe shell wrapping
        const escaped = cmd.replace(/"/g, '\\"');
        const psCommand = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${escaped}"`;
        exec(psCommand, { maxBuffer: 1024 * 1024 * 20, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                resolve({ success: false, error: error.message, stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
            } else {
                resolve({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
            }
        });
    });
}

// ── Helper: taskkill by PID ───────────────────────────────────────────────
function taskkillPid(pid) {
    return new Promise(resolve => exec(`taskkill /F /PID ${pid}`, { timeout: 5000 }, resolve));
}

// ── Helper: taskkill by name ─────────────────────────────────────────────
function taskkillName(name) {
    return new Promise(resolve => exec(`taskkill /F /IM "${name}.exe"`, { timeout: 5000 }, resolve));
}

// ── Helper: recursive folder metrics (non-blocking batches) ──────────────
function getFolderMetrics(dirPath, maxDepth = 4, currentDepth = 0) {
    let totalSize = 0;
    let fileCount = 0;

    if (currentDepth > maxDepth || !fs.existsSync(dirPath)) {
        return { totalSize, fileCount };
    }

    try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const item of items) {
            // Skip Windows system/hidden directories that always throw permission errors
            if (item.name.startsWith('$') || item.name === 'System Volume Information') continue;
            const fullPath = path.join(dirPath, item.name);
            try {
                if (item.isDirectory()) {
                    const sub = getFolderMetrics(fullPath, maxDepth, currentDepth + 1);
                    totalSize += sub.totalSize;
                    fileCount += sub.fileCount;
                } else if (item.isFile()) {
                    const stats = fs.statSync(fullPath);
                    totalSize += stats.size;
                    fileCount += 1;
                }
            } catch (_) { /* skip locked/permission-denied files */ }
        }
    } catch (_) { /* skip unreadable directories */ }

    return { totalSize, fileCount };
}

// ── 1. GET /api/drives ────────────────────────────────────────────────────
app.get('/api/drives', async (req, res) => {
    const psCmd = `Get-CimInstance Win32_LogicalDisk | Where-Object DriveType -eq 3 | Select-Object DeviceID, VolumeName, Size, FreeSpace | ConvertTo-Json`;
    const result = await runPowerShell(psCmd);

    if (!result.success) {
        return res.status(500).json({ error: 'Failed to fetch drives', details: result.error });
    }

    try {
        let drives = JSON.parse(result.stdout);
        if (!Array.isArray(drives)) drives = [drives];

        const formatted = drives.map(d => {
            // FIX: keep as numbers throughout — avoid string subtraction bug
            const sizeBytes = d.Size || 0;
            const freeBytes = d.FreeSpace || 0;
            const usedBytes = sizeBytes - freeBytes;

            const sizeGB  = parseFloat((sizeBytes  / (1024 ** 3)).toFixed(1));
            const freeGB  = parseFloat((freeBytes  / (1024 ** 3)).toFixed(1));
            const usedGB  = parseFloat((usedBytes  / (1024 ** 3)).toFixed(1));
            const usedPercent = sizeGB > 0 ? Math.min(100, Math.round((usedGB / sizeGB) * 100)) : 0;

            return { drive: d.DeviceID, name: d.VolumeName || 'Local Disk', sizeGB, freeGB, usedGB, usedPercent };
        });

        res.json({ drives: formatted });
    } catch (e) {
        res.status(500).json({ error: 'Error parsing drive data', raw: result.stdout });
    }
});

// ── 2. GET /api/user-folders ──────────────────────────────────────────────
// FIX: run all 6 folder scans in parallel via Promise.all to avoid blocking
app.get('/api/user-folders', async (req, res) => {
    const userHome = os.homedir();
    const folderNames = ['Downloads', 'Desktop', 'Videos', 'Pictures', 'Documents', 'Music'];

    const folders = await Promise.all(folderNames.map(fName => {
        return new Promise(resolve => {
            // Wrap in setImmediate so each scan yields to event loop between items
            setImmediate(() => {
                const fullPath = path.join(userHome, fName);
                const metrics = getFolderMetrics(fullPath);
                const sizeMB = parseFloat((metrics.totalSize / (1024 * 1024)).toFixed(1));
                const sizeGB = parseFloat((metrics.totalSize / (1024 ** 3)).toFixed(2));
                resolve({ folder: fName, path: fullPath, count: metrics.fileCount, sizeBytes: metrics.totalSize, sizeMB, sizeGB });
            });
        });
    }));

    res.json({ userHome, folders });
});

// ── 3. POST /api/move-folder ─────────────────────────────────────────────
app.post('/api/move-folder', (req, res) => {
    const { folderName, customPath, targetDrive } = req.body;

    if (!targetDrive) {
        return res.status(400).json({ error: 'Target drive is required (e.g. D: or F:)' });
    }

    let sourcePath = '';
    let destinationDir = '';

    if (folderName) {
        sourcePath = path.join(os.homedir(), folderName);
        destinationDir = path.join(`${targetDrive}\\`, 'Migrated_Files', folderName);
    } else if (customPath) {
        sourcePath = customPath;
        destinationDir = path.join(`${targetDrive}\\`, 'Migrated_Files', path.basename(customPath));
    } else {
        return res.status(400).json({ error: 'Provide folderName or customPath' });
    }

    if (!fs.existsSync(sourcePath)) {
        return res.status(404).json({ error: `Source path does not exist: ${sourcePath}` });
    }

    // /E = copy subdirectories incl empty, /MOVE = delete source after copy
    // /R:2 /W:1 = retry twice, wait 1s. /NJH /NJS = suppress headers/summary
    const cmd = `robocopy "${sourcePath}" "${destinationDir}" /E /MOVE /BYTES /R:2 /W:1 /NJH /NJS`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
        // Robocopy exit codes 0-7 = success/partial success
        const isSuccess = !err || (typeof err.code === 'number' && err.code <= 7);
        if (isSuccess) {
            res.json({ success: true, message: `Migrated to ${destinationDir}`, sourcePath, destinationDir });
        } else {
            res.status(500).json({ error: `Robocopy failed (exit ${err ? err.code : '?'})`, stdout, stderr });
        }
    });
});

// ── 4. GET /api/scan-temp ────────────────────────────────────────────────
app.get('/api/scan-temp', (req, res) => {
    const userTemp = os.tmpdir();
    const winTemp  = 'C:\\Windows\\Temp';

    const userMetrics = getFolderMetrics(userTemp, 3);
    const winMetrics  = getFolderMetrics(winTemp, 3);

    const totalBytes = userMetrics.totalSize + winMetrics.totalSize;
    const totalFiles = userMetrics.fileCount + winMetrics.fileCount;

    res.json({
        sizeBytes:  totalBytes,
        sizeMB:     parseFloat((totalBytes / (1024 * 1024)).toFixed(1)) || 0,
        sizeGB:     parseFloat((totalBytes / (1024 ** 3)).toFixed(2)) || 0,
        filesCount: totalFiles || 0
    });
});

// ── 5. POST /api/clean-temp ──────────────────────────────────────────────
app.post('/api/clean-temp', async (req, res) => {
    const userTemp = os.tmpdir().replace(/\\/g, '\\\\');
    const winTemp  = 'C:\\\\Windows\\\\Temp';

    const psCmd = `
        $paths = @("${userTemp}", "${winTemp}");
        $removed = 0;
        foreach ($p in $paths) {
            Get-ChildItem -Path $p -Recurse -ErrorAction SilentlyContinue |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue;
        }
        "ok"
    `;

    const result = await runPowerShell(psCmd);
    // FIX: report actual outcome instead of always returning success
    if (result.success) {
        res.json({ success: true, message: 'Temporary & Junk files cleaned successfully!' });
    } else {
        res.status(500).json({ success: false, error: 'Clean partially failed', details: result.error });
    }
});

// ── 6. GET /api/processes ────────────────────────────────────────────────
app.get('/api/processes', async (req, res) => {
    const psCmd = `Get-Process | Where-Object WorkingSet64 -gt 5242880 | Select-Object Id, ProcessName, WorkingSet64, Path | Sort-Object WorkingSet64 -Descending | Select-Object -First 80 | ConvertTo-Json -Depth 2`;

    const result = await runPowerShell(psCmd);
    if (!result.success) {
        return res.status(500).json({ error: 'Failed to fetch processes', details: result.error });
    }

    try {
        let procs = JSON.parse(result.stdout || '[]');
        if (!Array.isArray(procs)) procs = [procs];

        const formatted = procs.map(p => ({
            pid:   p.Id,
            name:  p.ProcessName,
            ramMB: parseFloat(((p.WorkingSet64 || 0) / (1024 * 1024)).toFixed(1)),
            path:  p.Path || ''
        }));

        res.json({ processes: formatted });
    } catch (e) {
        res.status(500).json({ error: 'Error parsing process list', raw: result.stdout });
    }
});

// ── 7. POST /api/end-process ─────────────────────────────────────────────
app.post('/api/end-process', async (req, res) => {
    const { pid, name } = req.body;
    if (!pid && !name) {
        return res.status(400).json({ error: 'pid or process name required' });
    }

    const pidInt = pid ? parseInt(pid, 10) : null;

    // Try PowerShell first (graceful), then taskkill (force) as fallback
    if (pidInt) {
        await runPowerShell(`Stop-Process -Id ${pidInt} -Force -ErrorAction SilentlyContinue`);
        await taskkillPid(pidInt);
    } else {
        await runPowerShell(`Stop-Process -Name "${name}" -Force -ErrorAction SilentlyContinue`);
        await taskkillName(name);
    }

    res.json({ success: true, message: `Terminated: ${name || pid}` });
});

// ── 7B. POST /api/end-multiple-processes ─────────────────────────────────
app.post('/api/end-multiple-processes', async (req, res) => {
    const { items } = req.body; // array of { pid, name, ramMB }
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Array of items { pid, name } required' });
    }

    let killedCount = 0;
    let freedMB = 0;

    for (const item of items) {
        if (!item.pid && !item.name) continue;
        const pidInt = item.pid ? parseInt(item.pid, 10) : null;

        if (pidInt) {
            await runPowerShell(`Stop-Process -Id ${pidInt} -Force -ErrorAction SilentlyContinue`);
            await taskkillPid(pidInt);
        } else if (item.name) {
            await runPowerShell(`Stop-Process -Name "${item.name}" -Force -ErrorAction SilentlyContinue`);
            await taskkillName(item.name);
        }

        killedCount++;
        freedMB += Math.round(item.ramMB || 0);
    }

    res.json({ success: true, killedCount, freedMB });
});


// ── Helper: boost (kill a list of process names) ─────────────────────────
async function boostProcessList(targetNames) {
    const psCmd = `Get-Process | Select-Object Id, ProcessName, WorkingSet64 | ConvertTo-Json -Depth 2`;
    const result = await runPowerShell(psCmd);

    if (!result.success || !result.stdout) {
        return { success: false, error: 'Failed to scan active processes' };
    }

    try {
        let procs = JSON.parse(result.stdout);
        if (!Array.isArray(procs)) procs = [procs];

        const targetLower = new Set(targetNames.map(t => t.toLowerCase()));
        let killedCount = 0;
        let freedMB = 0;
        const terminatedApps = [];
        // Track by name so we only report each app once even if multiple PIDs
        const seenNames = new Set();

        for (const p of procs) {
            if (!p.ProcessName) continue;
            if (!targetLower.has(p.ProcessName.toLowerCase())) continue;

            // Kill the PID regardless (may have multiple instances)
            await runPowerShell(`Stop-Process -Id ${p.Id} -Force -ErrorAction SilentlyContinue`);
            await taskkillPid(p.Id);

            killedCount++;
            freedMB += Math.round((p.WorkingSet64 || 0) / (1024 * 1024));

            // Only add app name to list once per unique name
            if (!seenNames.has(p.ProcessName.toLowerCase())) {
                seenNames.add(p.ProcessName.toLowerCase());
                terminatedApps.push(p.ProcessName);
            }
        }

        return { success: true, killedCount, freedMB, terminatedApps };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ── 8A. POST /api/boost-editor ───────────────────────────────────────────
app.post('/api/boost-editor', async (req, res) => {
    const targetProcesses = [
        'SearchApp', 'PhoneExperienceHost', 'YourPhone', 'GameBarPresenceWriter', 'XboxGameBar',
        'XboxAppServices', 'FeedbackHub', 'GoogleUpdate', 'EdgeUpdate', 'MicrosoftEdgeUpdate',
        'AdobeUpdateService', 'AdobeARM', 'AGSService', 'AGMService', 'iTunesHelper',
        'OneDrive', 'Spotify', 'Cortana', 'AutoClickerPC', 'Widgets', 'msedgewebview2',
        'Video.UI', 'ZuneMusic', 'ZuneVideo'
        // AutoClickerPC kept here: editors don't need it
    ];
    res.json(await boostProcessList(targetProcesses));
});

// ── 8B. POST /api/boost-coder ───────────────────────────────────────────
app.post('/api/boost-coder', async (req, res) => {
    const targetProcesses = [
        'SearchApp', 'PhoneExperienceHost', 'YourPhone', 'GameBarPresenceWriter', 'XboxGameBar',
        'XboxAppServices', 'FeedbackHub', 'AdobeUpdateService', 'AdobeARM', 'AGSService',
        'AGMService', 'AdobeIPCBroker', 'CoreSync', 'CCLBS', 'iTunesHelper',
        'GoogleUpdate', 'EdgeUpdate', 'MicrosoftEdgeUpdate', 'Cortana', 'OneDrive',
        'Spotify', 'Widgets', 'Video.UI', 'ZuneMusic', 'ZuneVideo'
        // NOTE: AutoClickerPC intentionally excluded — user needs it for coding
    ];
    res.json(await boostProcessList(targetProcesses));
});

// ── Start server function ────────────────────────────────────────────────
function startEmbeddedServer(port = PORT) {
    return new Promise((resolve) => {
        const server = app.listen(port, () => {
            console.log(`====================================================`);
            console.log(`🚀 PC Optimizer & Drive C Transfer Tool running!`);
            console.log(`🌐 Open in browser: http://localhost:${port}`);
            console.log(`====================================================`);
            resolve(server);
        }).on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`Port ${port} in use, using existing server instance.`);
                resolve(null);
            } else {
                console.error('Server error:', err);
                resolve(null);
            }
        });
    });
}

if (require.main === module) {
    startEmbeddedServer();
}

module.exports = { app, startEmbeddedServer };

