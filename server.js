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
    const psCmd = `Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3,4 } | Select-Object DeviceID, VolumeName, FileSystem, DriveType, Size, FreeSpace | ConvertTo-Json`;
    const result = await runPowerShell(psCmd);

    if (!result.success) {
        return res.status(500).json({ error: 'Failed to fetch drives', details: result.error });
    }

    try {
        let drives = JSON.parse(result.stdout);
        if (!Array.isArray(drives)) drives = [drives];

        const formatted = drives.map(d => {
            const sizeBytes = d.Size || 0;
            const freeBytes = d.FreeSpace || 0;
            const usedBytes = sizeBytes - freeBytes;

            const sizeGB  = parseFloat((sizeBytes  / (1024 ** 3)).toFixed(1));
            const freeGB  = parseFloat((freeBytes  / (1024 ** 3)).toFixed(1));
            const usedGB  = parseFloat((usedBytes  / (1024 ** 3)).toFixed(1));
            const usedPercent = sizeGB > 0 ? Math.min(100, Math.round((usedGB / sizeGB) * 100)) : 0;

            const isExternal = d.DriveType === 2 || d.DriveType === 4;
            let typeLabel = 'Local Disk';
            if (d.DriveType === 2) typeLabel = 'External / USB Drive';
            if (d.DriveType === 4) typeLabel = 'Network Drive';

            return { 
                drive: d.DeviceID, 
                name: d.VolumeName || (isExternal ? 'External Drive' : 'Local Disk'), 
                fileSystem: d.FileSystem || 'NTFS',
                driveType: d.DriveType,
                isExternal,
                typeLabel,
                sizeGB, 
                freeGB, 
                usedGB, 
                usedPercent 
            };
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

// ── 2B. GET /api/drive-details ───────────────────────────────────────────
app.get('/api/drive-details', async (req, res) => {
    const driveLetter = (req.query.drive || 'C:').toUpperCase().replace('\\', '');
    const driveRoot = `${driveLetter}\\`;

    if (!fs.existsSync(driveRoot)) {
        return res.status(404).json({ error: `Drive ${driveLetter} is not accessible` });
    }

    try {
        const items = fs.readdirSync(driveRoot, { withFileTypes: true });
        const folderList = [];

        for (const item of items) {
            if (item.name.startsWith('$') || item.name.startsWith('.') || 
                item.name === 'System Volume Information' || item.name === 'Windows' ||
                item.name === 'Program Files' || item.name === 'Program Files (x86)') {
                continue;
            }

            const fullPath = path.join(driveRoot, item.name);
            try {
                if (item.isDirectory()) {
                    const metrics = getFolderMetrics(fullPath, 2);
                    folderList.push({
                        name: item.name,
                        path: fullPath,
                        isDirectory: true,
                        count: metrics.fileCount,
                        sizeBytes: metrics.totalSize,
                        sizeMB: parseFloat((metrics.totalSize / (1024 * 1024)).toFixed(1)),
                        sizeGB: parseFloat((metrics.totalSize / (1024 ** 3)).toFixed(2))
                    });
                } else if (item.isFile()) {
                    const stats = fs.statSync(fullPath);
                    folderList.push({
                        name: item.name,
                        path: fullPath,
                        isDirectory: false,
                        count: 1,
                        sizeBytes: stats.size,
                        sizeMB: parseFloat((stats.size / (1024 * 1024)).toFixed(1)),
                        sizeGB: parseFloat((stats.size / (1024 ** 3)).toFixed(2))
                    });
                }
            } catch (_) {}
        }

        // Sort by size descending
        folderList.sort((a, b) => b.sizeBytes - a.sizeBytes);

        res.json({
            drive: driveLetter,
            path: driveRoot,
            topFolders: folderList
        });
    } catch (e) {
        res.status(500).json({ error: `Failed to read drive ${driveLetter}`, details: e.message });
    }
});

// ── 2C. GET /api/browse-drive ───────────────────────────────────────────
app.get('/api/browse-drive', (req, res) => {
    let targetPath = req.query.path || 'C:\\';
    if (!targetPath.endsWith('\\') && targetPath.length === 2) {
        targetPath += '\\';
    }

    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: `Path does not exist: ${targetPath}` });
    }

    try {
        const parentPath = path.dirname(targetPath);
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        const items = [];

        for (const entry of entries) {
            if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
            const fullPath = path.join(targetPath, entry.name);
            let sizeBytes = 0;
            if (entry.isFile()) {
                try { sizeBytes = fs.statSync(fullPath).size; } catch (_) {}
            }
            items.push({
                name: entry.name,
                path: fullPath,
                isDirectory: entry.isDirectory(),
                sizeBytes,
                sizeMB: parseFloat((sizeBytes / (1024 * 1024)).toFixed(1)),
                sizeGB: parseFloat((sizeBytes / (1024 ** 3)).toFixed(2))
            });
        }

        items.sort((a, b) => (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0) || a.name.localeCompare(b.name));

        res.json({
            currentPath: targetPath,
            parentPath: parentPath !== targetPath ? parentPath : null,
            items
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

let activeMoveProcess = null;
let moveProgressPercent = 0;
let moveCurrentItemName = '';
let moveBatchIndex = 0;
let moveBatchTotal = 0;

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

    moveProgressPercent = 0;
    moveCurrentItemName = folderName || path.basename(sourcePath);
    moveBatchIndex = 1;
    moveBatchTotal = 1;

    const args = [sourcePath, destinationDir, '/E', '/MOVE', '/BYTES', '/R:2', '/W:1'];
    let stdoutData = '';
    let stderrData = '';

    const { spawn } = require('child_process');
    activeMoveProcess = spawn('robocopy', args);

    activeMoveProcess.stdout.on('data', (data) => {
        const text = data.toString();
        stdoutData += text;
        const matches = text.match(/(\d{1,3}(\.\d+)?)%/g);
        if (matches && matches.length > 0) {
            const lastMatch = matches[matches.length - 1];
            const num = parseFloat(lastMatch.replace('%', ''));
            if (!isNaN(num) && num >= 0 && num <= 100) {
                moveProgressPercent = Math.round(num);
            }
        }
    });

    activeMoveProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
    });

    activeMoveProcess.on('close', (code) => {
        const wasKilled = activeMoveProcess && activeMoveProcess.killed;
        activeMoveProcess = null;

        if (wasKilled) {
            return res.json({ success: false, cancelled: true, message: 'Transfer cancelled by user' });
        }

        const isSuccess = typeof code === 'number' && code <= 7;
        if (isSuccess) {
            moveProgressPercent = 100;
            res.json({ success: true, message: `Migrated to ${destinationDir}`, sourcePath, destinationDir });
        } else {
            res.status(500).json({ error: `Robocopy failed (exit code ${code}). Check Controlled Folder Access or file permissions.`, stdout: stdoutData, stderr: stderrData });
        }
    });
});

// ── 3A2. POST /api/move-multiple ──────────────────────────────────────────
app.post('/api/move-multiple', async (req, res) => {
    const { items, targetDrive } = req.body; // items: [{ sourcePath, folderName }]

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Array of items required' });
    }
    if (!targetDrive) {
        return res.status(400).json({ error: 'Target drive is required (e.g. D: or F:)' });
    }

    const { spawn } = require('child_process');
    let successCount = 0;
    let failCount = 0;
    const errors = [];

    moveBatchTotal = items.length;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemSource = item.sourcePath || (item.folderName ? path.join(os.homedir(), item.folderName) : '');
        const itemName = item.folderName || path.basename(itemSource);
        const destinationDir = path.join(`${targetDrive}\\`, 'Migrated_Files', itemName);

        if (!itemSource || !fs.existsSync(itemSource)) {
            failCount++;
            errors.push(`Source does not exist: ${itemSource}`);
            continue;
        }

        moveBatchIndex = i + 1;
        moveCurrentItemName = itemName;
        moveProgressPercent = Math.round((i / items.length) * 100);

        const args = [itemSource, destinationDir, '/E', '/MOVE', '/BYTES', '/R:2', '/W:1'];

        const runRobocopy = () => new Promise((resolve) => {
            activeMoveProcess = spawn('robocopy', args);

            activeMoveProcess.stdout.on('data', (data) => {
                const text = data.toString();
                const matches = text.match(/(\d{1,3}(\.\d+)?)%/g);
                if (matches && matches.length > 0) {
                    const lastMatch = matches[matches.length - 1];
                    const num = parseFloat(lastMatch.replace('%', ''));
                    if (!isNaN(num) && num >= 0 && num <= 100) {
                        const itemContribution = (num / 100) * (100 / items.length);
                        const overall = Math.round((i / items.length) * 100 + itemContribution);
                        moveProgressPercent = Math.min(99, overall);
                    }
                }
            });

            activeMoveProcess.on('close', (code) => {
                const wasKilled = activeMoveProcess && activeMoveProcess.killed;
                activeMoveProcess = null;
                if (wasKilled) {
                    resolve({ cancelled: true });
                } else if (typeof code === 'number' && code <= 7) {
                    resolve({ success: true });
                } else {
                    resolve({ success: false, code });
                }
            });
        });

        const result = await runRobocopy();
        if (result.cancelled) {
            return res.json({ success: false, cancelled: true, message: 'Batch transfer cancelled by user', successCount, failCount });
        }
        if (result.success) {
            successCount++;
        } else {
            failCount++;
            errors.push(`Failed moving ${itemName} (exit code ${result.code})`);
        }
    }

    moveProgressPercent = 100;
    res.json({
        success: failCount === 0,
        message: `Migrated ${successCount}/${items.length} items to ${targetDrive}\\Migrated_Files`,
        successCount,
        failCount,
        errors
    });
});

// ── 3B. GET /api/move-progress ───────────────────────────────────────────
app.get('/api/move-progress', (req, res) => {
    res.json({
        active: activeMoveProcess !== null,
        percent: moveProgressPercent,
        currentItem: moveCurrentItemName,
        batchIndex: moveBatchIndex,
        batchTotal: moveBatchTotal
    });
});

// ── 3C. POST /api/cancel-move ─────────────────────────────────────────────
app.post('/api/cancel-move', (req, res) => {
    if (activeMoveProcess) {
        try {
            activeMoveProcess.kill('SIGTERM');
        } catch (_) {}
        activeMoveProcess = null;
    }
    // Force kill robocopy process
    taskkillName('robocopy');
    res.json({ success: true, message: 'Cancelled move transfer' });
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

// ── 4B. GET /api/file-usage-analysis ──────────────────────────────────────
app.get('/api/file-usage-analysis', (req, res) => {
    const driveParam = req.query.drive || 'ALL';
    const filter = req.query.filter || '1Y';

    const allDriveLetters = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];
    const connectedDrives = allDriveLetters.filter(d => fs.existsSync(d + '\\'));

    let targetDrives = connectedDrives;
    if (driveParam !== 'ALL') {
        targetDrives = targetDrives.filter(d => d.toUpperCase().startsWith(driveParam.toUpperCase().substring(0, 1)));
    }

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const items = [];

    for (const driveLetter of targetDrives) {
        const driveRoot = `${driveLetter}\\`;
        if (!fs.existsSync(driveRoot)) continue;

        let scanPaths = [];
        if (driveLetter.startsWith('C')) {
            const userHome = os.homedir();
            scanPaths = [
                path.join(userHome, 'Downloads'),
                path.join(userHome, 'Documents'),
                path.join(userHome, 'Desktop'),
                path.join(userHome, 'Videos'),
                path.join(userHome, 'Pictures'),
                path.join(userHome, 'Music'),
                'C:\\Program Files',
                'C:\\Program Files (x86)'
            ];
        } else {
            try {
                const subDirs = fs.readdirSync(driveRoot, { withFileTypes: true });
                scanPaths = subDirs
                    .filter(d => d.isDirectory() && !d.name.startsWith('$') && d.name !== 'System Volume Information')
                    .map(d => path.join(driveRoot, d.name));
            } catch (_) {}
        }

        for (const sp of scanPaths) {
            if (!fs.existsSync(sp)) continue;
            try {
                const stat = fs.statSync(sp);
                const lastAccess = stat.atimeMs || stat.mtimeMs || stat.ctimeMs;
                const daysInactive = Math.floor((now - lastAccess) / oneDay);
                
                let sizeBytes = 0;
                let fileCount = 0;
                if (stat.isDirectory()) {
                    const metrics = getFolderMetrics(sp, 2);
                    sizeBytes = metrics.totalSize;
                    fileCount = metrics.fileCount;
                } else {
                    sizeBytes = stat.size;
                    fileCount = 1;
                }

                let match = false;
                let statusLabel = '';
                let statusBadge = '';

                if (daysInactive <= 7) {
                    statusLabel = 'ប្រើប្រាស់រាល់ថ្ងៃ (1W)';
                    statusBadge = 'badge-c';
                    if (filter === '1W' || filter === 'ALL') match = true;
                } else if (daysInactive <= 30) {
                    statusLabel = 'មិនសូវប្រើ (1M)';
                    statusBadge = 'badge-d';
                    if (filter === '1M' || filter === 'ALL') match = true;
                } else if (daysInactive <= 180) {
                    statusLabel = 'មិនប៉ះពាល់ 6 ខែ (6M)';
                    statusBadge = 'badge-f';
                    if (filter === '6M' || filter === 'ALL') match = true;
                } else {
                    statusLabel = 'គ្មានប្រយោជន៍ (1Y+)';
                    statusBadge = 'badge-d';
                    if (filter === '1Y' || filter === 'ALL') match = true;
                }

                if (match) {
                    items.push({
                        name: path.basename(sp),
                        path: sp,
                        drive: driveLetter,
                        isDirectory: stat.isDirectory(),
                        count: fileCount,
                        sizeBytes,
                        sizeMB: parseFloat((sizeBytes / (1024 * 1024)).toFixed(1)),
                        sizeGB: parseFloat((sizeBytes / (1024 ** 3)).toFixed(2)),
                        lastAccessDate: new Date(lastAccess).toISOString().split('T')[0],
                        daysInactive,
                        statusLabel,
                        statusBadge
                    });
                }
            } catch (_) {}
        }
    }

    items.sort((a, b) => b.sizeBytes - a.sizeBytes);
    res.json({ items, filter, drive: driveParam });
});

// ── 5. POST /api/clean-temp ──────────────────────────────────────────────
app.post('/api/clean-temp', (req, res) => {
    const userTemp = os.tmpdir();
    const winTemp = 'C:\\Windows\\Temp';
    const targets = [userTemp, winTemp];

    let deletedBytes = 0;
    let deletedFiles = 0;
    let lockedFiles = 0;

    function cleanDirectory(dirPath) {
        if (!fs.existsSync(dirPath)) return;
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
                const fullPath = path.join(dirPath, entry.name);

                try {
                    if (entry.isDirectory()) {
                        cleanDirectory(fullPath);
                        try { fs.rmdirSync(fullPath); } catch (_) {}
                    } else if (entry.isFile()) {
                        const stats = fs.statSync(fullPath);
                        fs.unlinkSync(fullPath);
                        deletedBytes += stats.size;
                        deletedFiles += 1;
                    }
                } catch (e) {
                    lockedFiles += 1;
                }
            }
        } catch (_) {}
    }

    targets.forEach(t => cleanDirectory(t));

    const freedMB = parseFloat((deletedBytes / (1024 * 1024)).toFixed(1));
    const freedGB = parseFloat((deletedBytes / (1024 ** 3)).toFixed(2));
    const freedStr = freedGB > 1 ? `${freedGB} GB` : `${freedMB} MB`;

    res.json({
        success: true,
        deletedBytes,
        freedMB,
        freedStr,
        deletedFiles,
        lockedFiles
    });
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

// ── 9A. GET /api/portable/scan ───────────────────────────────────────────
app.get('/api/portable/scan', async (req, res) => {
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
    const scanDirs = [
        path.join(userProfile, 'Downloads'),
        'D:\\Migrated_Files\\Downloads\\Programs',
        'D:\\Downloads',
        'C:\\Downloads'
    ];

    const exeList = [];
    for (const dir of scanDirs) {
        if (fs.existsSync(dir)) {
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    if (file.toLowerCase().endsWith('.exe')) {
                        const fullPath = path.join(dir, file);
                        try {
                            const stat = fs.statSync(fullPath);
                            exeList.push({
                                name: file,
                                fullPath: fullPath,
                                dir: dir,
                                sizeMB: parseFloat((stat.size / (1024 * 1024)).toFixed(1)),
                                modified: stat.mtime
                            });
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        }
    }
    res.json({ success: true, count: exeList.length, files: exeList });
});

// ── 9B. POST /api/portable/extract ───────────────────────────────────────
app.post('/api/portable/extract', async (req, res) => {
    const { exePath, targetDrive = 'D:', customName = '', createShortcut = true } = req.body;

    if (!exePath || !fs.existsSync(exePath)) {
        return res.status(400).json({ error: 'File exePath មិនត្រឹមត្រូវ ឬមិនទាន់មាន' });
    }

    const appName = customName || path.basename(exePath, '.exe').replace(/[-_]/g, ' ');
    const safeFolderName = appName.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const destFolder = path.join(`${targetDrive}\\ExtractedApps`, safeFolderName);

    // PowerShell script to extract using tar.exe or Expand-Archive and create Desktop Shortcut
    const psScript = `
        $exePath = "${exePath.replace(/"/g, '`"')}"
        $destFolder = "${destFolder.replace(/"/g, '`"')}"
        $appName = "${appName.replace(/"/g, '`"')}"
        $createShortcut = $${createShortcut ? 'true' : 'false'}

        if (-not (Test-Path $destFolder)) {
            New-Item -Path $destFolder -ItemType Directory -Force | Out-Null
        }

        # Try extracting with built-in tar.exe (Windows 10/11)
        $tarPath = "C:\\Windows\\System32\\tar.exe"
        $extracted = $false
        if (Test-Path $tarPath) {
            & $tarPath -xf "$exePath" -C "$destFolder" *>&1 | Out-Null
            $extracted = $true
        }

        if (-not $extracted) {
            try {
                Expand-Archive -LiteralPath "$exePath" -DestinationPath "$destFolder" -Force -ErrorAction Stop
                $extracted = $true
            } catch {
                # Fallback: copy executable directly if uncompressed
                Copy-Item -Path "$exePath" -Destination "$destFolder\\$appName.exe" -Force
            }
        }

        # Find main executable in destFolder
        $exeFiles = Get-ChildItem -Path "$destFolder" -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue | Sort-Object Length -Descending
        $mainExe = $null
        if ($exeFiles.Count -gt 0) {
            $mainExe = $exeFiles[0].FullName
        } else {
            $mainExe = "$destFolder\\$appName.exe"
        }

        # Create Desktop Shortcut
        $shortcutCreated = $false
        if ($createShortcut -and $mainExe -and (Test-Path $mainExe)) {
            $desktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
            $shortcutPath = Join-Path $desktopPath "$appName.lnk"
            $WshShell = New-Object -ComObject WScript.Shell
            $Shortcut = $WshShell.CreateShortcut($shortcutPath)
            $Shortcut.TargetPath = $mainExe
            $Shortcut.WorkingDirectory = (Split-Path -Path $mainExe -Parent)
            $Shortcut.Save()
            $shortcutCreated = $true
        }

        [PSCustomObject]@{
            Extracted = $true
            DestFolder = $destFolder
            MainExe = $mainExe
            ShortcutCreated = $shortcutCreated
        } | ConvertTo-Json
    `;

    const result = await runPowerShell(psScript);

    if (!result.success) {
        return res.status(500).json({ error: 'Extraction failed', details: result.error });
    }

    try {
        const data = JSON.parse(result.stdout);
        res.json({
            success: true,
            appName,
            destFolder,
            mainExe: data.MainExe,
            shortcutCreated: data.ShortcutCreated
        });
    } catch (_) {
        res.json({
            success: true,
            appName,
            destFolder,
            mainExe: path.join(destFolder, `${appName}.exe`),
            shortcutCreated: true
        });
    }
});

// ── 9C. POST /api/portable/launch ─────────────────────────────────────────
app.post('/api/portable/launch', (req, res) => {
    const { exePath } = req.body;
    if (!exePath || !fs.existsSync(exePath)) {
        return res.status(400).json({ error: 'Executable not found' });
    }
    exec(`"${exePath}"`, { cwd: path.dirname(exePath) });
    res.json({ success: true });
});

// ── 10A. GET /api/shell-folders ──────────────────────────────────────────
app.get('/api/shell-folders', async (req, res) => {
    const psScript = `
        $regUserShell = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"
        $userProfile = $env:USERPROFILE

        function Get-ShellPath($regName, $defaultSub) {
            $val = (Get-ItemProperty -Path $regUserShell -Name $regName -ErrorAction SilentlyContinue).$regName
            if ($val) {
                return [System.Environment]::ExpandEnvironmentVariables($val)
            }
            return "$userProfile\\$defaultSub"
        }

        $downloads = (Get-ItemProperty -Path $regUserShell -Name "{374DE290-123F-4565-9164-39C4925E467B}" -ErrorAction SilentlyContinue)."{374DE290-123F-4565-9164-39C4925E467B}"
        if (-not $downloads) {
            $downloads = (Get-ItemProperty -Path $regUserShell -Name "{7d830070-267d-4354-8728-84e164612330}" -ErrorAction SilentlyContinue)."{7d830070-267d-4354-8728-84e164612330}"
        }
        if ($downloads) {
            $downloads = [System.Environment]::ExpandEnvironmentVariables($downloads)
        } else {
            $downloads = "$userProfile\\Downloads"
        }

        [PSCustomObject]@{
            UserProfile = $userProfile
            Downloads   = $downloads
            Documents   = (Get-ShellPath "Personal" "Documents")
            Pictures    = (Get-ShellPath "My Pictures" "Pictures")
            Videos      = (Get-ShellPath "My Video" "Videos")
            Desktop     = (Get-ShellPath "Desktop" "Desktop")
        } | ConvertTo-Json
    `;

    const result = await runPowerShell(psScript);

    if (!result.success) {
        return res.status(500).json({ error: 'Failed to fetch shell folders', details: result.error });
    }

    try {
        const folders = JSON.parse(result.stdout);
        // Calculate sizes for each folder
        const folderSizes = {};
        for (const [key, folderPath] of Object.entries(folders)) {
            if (key === 'UserProfile') continue;
            if (fs.existsSync(folderPath)) {
                const metrics = getFolderMetrics(folderPath, 3);
                folderSizes[key] = {
                    path: folderPath,
                    sizeBytes: metrics.totalSize,
                    sizeMB: parseFloat((metrics.totalSize / (1024 * 1024)).toFixed(1)),
                    sizeGB: parseFloat((metrics.totalSize / (1024 * 1024 * 1024)).toFixed(2)),
                    fileCount: metrics.fileCount
                };
            } else {
                folderSizes[key] = { path: folderPath, sizeBytes: 0, sizeMB: 0, sizeGB: 0, fileCount: 0 };
            }
        }

        res.json({ success: true, userProfile: folders.UserProfile, folders: folderSizes });
    } catch (e) {
        res.status(500).json({ error: 'Parse error', details: e.message });
    }
});

// ── 10B. POST /api/shell-folders/relocate ────────────────────────────────
app.post('/api/shell-folders/relocate', async (req, res) => {
    const { targetDrive = 'D:', moveFiles = true } = req.body;

    const psScript = `
        $targetDrive = "${targetDrive.replace(/"/g, '')}"
        $moveFiles = $${moveFiles ? 'true' : 'false'}
        $userProfile = $env:USERPROFILE
        $baseTarget = "$targetDrive\\UserFiles"

        $folderConfigs = @(
            @{ Name="Downloads"; RegName="{374DE290-123F-4565-9164-39C4925E467B}"; GUID2="{7d830070-267d-4354-8728-84e164612330}"; DefaultPath="$userProfile\\Downloads" },
            @{ Name="Documents"; RegName="Personal"; DefaultPath="$userProfile\\Documents" },
            @{ Name="Pictures";  RegName="My Pictures"; DefaultPath="$userProfile\\Pictures" },
            @{ Name="Videos";    RegName="My Video"; DefaultPath="$userProfile\\Videos" },
            @{ Name="Desktop";   RegName="Desktop"; DefaultPath="$userProfile\\Desktop" }
        )

        $regUserShell = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"
        $regShell     = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders"

        $relocationResults = @()

        foreach ($cfg in $folderConfigs) {
            $newPath = "$baseTarget\\$($cfg.Name)"
            if (-not (Test-Path $newPath)) {
                New-Item -Path $newPath -ItemType Directory -Force | Out-Null
            }

            # Update User Shell Folders
            Set-ItemProperty -Path $regUserShell -Name $cfg.RegName -Value $newPath -ErrorAction SilentlyContinue
            Set-ItemProperty -Path $regShell -Name $cfg.RegName -Value $newPath -ErrorAction SilentlyContinue
            if ($cfg.GUID2) {
                Set-ItemProperty -Path $regUserShell -Name $cfg.GUID2 -Value $newPath -ErrorAction SilentlyContinue
            }

            $movedFiles = 0
            $oldPath = $cfg.DefaultPath
            if ($moveFiles -and (Test-Path $oldPath) -and ($oldPath -ne $newPath)) {
                try {
                    Get-ChildItem -Path $oldPath -ErrorAction SilentlyContinue | ForEach-Object {
                        $dest = Join-Path $newPath $_.Name
                        Move-Item -Path $_.FullName -Destination $dest -Force -ErrorAction SilentlyContinue
                        $movedFiles++
                    }
                } catch (_) {}
            }

            $relocationResults += [PSCustomObject]@{
                Folder = $cfg.Name
                NewPath = $newPath
                MovedItems = $movedFiles
            }
        }

        # Refresh Windows Explorer Shell so Chrome, Word, Photoshop pick up new path instantly
        try {
            $code = @"
            using System;
            using System.Runtime.InteropServices;
            public class ShellUtil {
                [DllImport("shell32.dll", CharSet = CharSet.Auto)]
                public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
            }
"@
            Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
            [ShellUtil]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
        } catch (_) {}

        $relocationResults | ConvertTo-Json
    `;

    const result = await runPowerShell(psScript);

    if (!result.success) {
        return res.status(500).json({ error: 'Relocation failed', details: result.error });
    }

    try {
        const results = JSON.parse(result.stdout);
        res.json({ success: true, targetDrive, baseTarget: `${targetDrive}\\UserFiles`, results });
    } catch (_) {
        res.json({ success: true, targetDrive, baseTarget: `${targetDrive}\\UserFiles` });
    }
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

