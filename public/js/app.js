document.addEventListener('DOMContentLoaded', () => {
    // State
    let drivesData = [];
    let processesData = [];
    let pendingTransfer = null; // { folderName, targetDrive }
    let pendingBatchTransfer = null; // { items: [{ sourcePath, folderName }], targetDrive }
    let pendingEndTask = null;  // { pid, name }
    let pendingEndAll = null;   // { filter, items: [{ pid, name, ramMB }] }
    let transferTimerInterval = null;
    let transferProgressPollInterval = null;
    let currentTab = 'drives-tab';

    // Universal Transfer & Queue State
    let univSourceItems = [];
    let currentUnivDrive = 'C:';
    let transferQueue = []; // [{ id, sourceDrive, sourcePath, itemName, sizeBytes, sizeStr }]

    // DOM Elements
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const drivesGrid = document.getElementById('drives-grid');
    const userFoldersTbody = document.getElementById('user-folders-tbody');
    const tempBadge = document.getElementById('temp-badge');
    const cleanTempBtn = document.getElementById('clean-temp-btn');
    
    // Drive Details Modal Elements
    const driveDetailsModal = document.getElementById('drive-details-modal');
    const driveDetailsTitle = document.getElementById('drive-details-title');
    const driveDetailsSub = document.getElementById('drive-details-sub');
    const detailTotalSize = document.getElementById('detail-total-size');
    const detailUsedSize = document.getElementById('detail-used-size');
    const detailFreeSize = document.getElementById('detail-free-size');
    const detailPercentText = document.getElementById('detail-percent-text');
    const detailProgressBar = document.getElementById('detail-progress-bar');
    const driveDetailsFoldersList = document.getElementById('drive-details-folders-list');
    const driveDetailsCloseBtn = document.getElementById('drive-details-close-btn');
    const btnDetailSetSource = document.getElementById('btn-detail-set-source');
    const btnDetailSetTarget = document.getElementById('btn-detail-set-target');
    let currentDetailDrive = 'C:';

    // Batch User Folders Elements
    const userFolderSelectAll = document.getElementById('user-folder-select-all');
    const userFoldersBatchTarget = document.getElementById('user-folders-batch-target');
    const btnBatchMoveUserFolders = document.getElementById('btn-batch-move-user-folders');

    // Universal Transfer Elements
    const sourceDrivesCheckboxGroup = document.getElementById('source-drives-checkbox-group');
    const univTargetDriveSelect = document.getElementById('univ-target-drive');
    const univSourceName = document.getElementById('univ-source-name');
    const univFolderList = document.getElementById('univ-folder-list');
    const btnUnivSelectAll = document.getElementById('btn-univ-select-all');
    const btnUnivClearAll = document.getElementById('btn-univ-clear-all');
    const univSelectedCount = document.getElementById('univ-selected-count');
    const univSelectedSize = document.getElementById('univ-selected-size');
    const btnUnivTransfer = document.getElementById('btn-univ-transfer');

    // Queue UI Elements
    const btnAddToQueue = document.getElementById('btn-add-to-queue');
    const queueCountBadge = document.getElementById('queue-count-badge');
    const btnClearQueue = document.getElementById('btn-clear-queue');
    const queueTbody = document.getElementById('queue-tbody');
    const queueTotalItems = document.getElementById('queue-total-items');
    const queueTotalSize = document.getElementById('queue-total-size');
    const btnExecuteQueue = document.getElementById('btn-execute-queue');

    // Boost & Processes Elements
    const editorBoostBtn = document.getElementById('editor-boost-btn');
    const coderBoostBtn = document.getElementById('coder-boost-btn');
    const boostResultCard = document.getElementById('boost-result-card');
    const resultTitleText = document.getElementById('result-title-text');
    const resultFreedBadge = document.getElementById('result-freed-badge');
    const resultText = document.getElementById('result-text');
    const closedAppsList = document.getElementById('closed-apps-list');
    const processesTbody = document.getElementById('processes-tbody');
    const procSearchInput = document.getElementById('proc-search-input');
    const refreshAllBtn = document.getElementById('refresh-all-btn');
    const btnEndAll = document.getElementById('btn-end-all');
    const endAllLabel = document.getElementById('end-all-label');
    const pageTitle = document.getElementById('page-title');
    const pageDesc = document.getElementById('page-desc');

    // Modals DOM
    const confirmModalOverlay = document.getElementById('confirm-modal-overlay');
    const modalTitle = document.getElementById('modal-title');
    const modalDesc = document.getElementById('modal-desc');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');
    const modalConfirmBtn = document.getElementById('modal-confirm-btn');

    const transferLoadingOverlay = document.getElementById('transfer-loading-overlay');
    const loadingTitle = document.getElementById('loading-title');
    const loadingDesc = document.getElementById('loading-desc');


    // 3. Load Drives Info
    async function loadDrives() {
        try {
            const res = await fetch('/api/drives');
            const data = await res.json();
            if (data.drives) {
                drivesData = data.drives;
                renderDrives(data.drives);
                populateDriveDropdowns(data.drives);
            }
        } catch (err) {
            drivesGrid.innerHTML = `<div class="error-msg">មានបញ្ហាក្នុងការទាញយកទិន្នន័យ Drives</div>`;
        }
    }

    function populateDriveDropdowns(drives) {
        if (!univTargetDriveSelect) return;

        const targetOptions = drives.map(d => {
            const tag = d.isExternal ? '🔌 External' : '💻 Local';
            return `<option value="${d.drive}">${d.drive} (${d.name} - ${tag} - ទំនេរ ${d.freeGB} GB)</option>`;
        }).join('');
        univTargetDriveSelect.innerHTML = targetOptions;

        // Default target to External or non-C drive
        const defaultTarget = drives.find(d => d.isExternal) || drives.find(d => !d.drive.startsWith('C')) || drives[0];
        if (defaultTarget) univTargetDriveSelect.value = defaultTarget.drive;

        renderSourceDriveCheckboxes(drives);
    }

    // Render drive checkboxes into #source-drives-checkbox-group
    function renderSourceDriveCheckboxes(drives) {
        if (!sourceDrivesCheckboxGroup) return;

        sourceDrivesCheckboxGroup.innerHTML = drives.map((d, i) => {
            let badgeClass = d.drive.startsWith('C') ? 'badge-c' : d.drive.startsWith('F') ? 'badge-f' : 'badge-d';
            const isDefaultChecked = i === 0 ? 'checked' : ''; // Default: first drive (usually C:) checked
            const externalTag = d.isExternal ? ' 🔌' : '';
            return `
                <label style="display:inline-flex; align-items:center; gap:7px; cursor:pointer;
                              background:rgba(255,255,255,0.05); border:1px solid var(--border-color);
                              border-radius:8px; padding:6px 12px; user-select:none; transition:background 0.2s;"
                       onmouseover="this.style.background='rgba(6,182,212,0.1)'"
                       onmouseout="this.style.background='rgba(255,255,255,0.05)'">
                    <input type="checkbox" class="source-drive-cb" data-drive="${d.drive}"
                           ${isDefaultChecked}
                           style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent-cyan);"
                           onchange="this.closest('label').style.border=this.checked?'1px solid var(--accent-cyan)':'1px solid var(--border-color)'">
                    <span class="badge-drive ${badgeClass}" style="padding:2px 7px;font-size:11px;">${d.drive}</span>
                    <span style="font-size:12px;font-weight:600;color:var(--text-main);">${d.name || 'Drive'}${externalTag}</span>
                    <span style="font-size:11px;color:var(--text-muted);">${d.freeGB}GB free</span>
                </label>
            `;
        }).join('');

        // Highlight the default-checked drive labels
        sourceDrivesCheckboxGroup.querySelectorAll('.source-drive-cb:checked').forEach(cb => {
            cb.closest('label').style.border = '1px solid var(--accent-cyan)';
        });

        // Wire up change event: reload source list whenever checkbox selection changes
        sourceDrivesCheckboxGroup.querySelectorAll('.source-drive-cb').forEach(cb => {
            cb.addEventListener('change', () => loadSelectedSourceDrives());
        });
    }

    function renderDrives(drives) {
        drivesGrid.innerHTML = drives.map(d => {
            let driveClass = 'd-drive';
            let fillClass = 'fill-d';
            let badgeClass = 'badge-d';

            if (d.drive.startsWith('C')) {
                driveClass = 'c-drive';
                fillClass = 'fill-c';
                badgeClass = 'badge-c';
            } else if (d.drive.startsWith('F')) {
                driveClass = 'f-drive';
                fillClass = 'fill-f';
                badgeClass = 'badge-f';
            }

            return `
                <div class="drive-card ${driveClass}">
                    <div class="drive-header">
                        <div class="drive-info">
                            <h3><i class="fa-solid fa-hard-drive"></i> ${d.drive}</h3>
                            <span>${d.name || 'Local Storage'} (${d.fileSystem || 'NTFS'})</span>
                        </div>
                        <span class="badge-drive ${badgeClass}">${d.usedPercent}% ប្រើប្រាស់</span>
                    </div>

                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill ${fillClass}" style="width: ${d.usedPercent}%"></div>
                    </div>

                    <div class="drive-meta" style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                        <div>
                            <div>ទំនេរ៖ <strong>${d.freeGB} GB</strong></div>
                            <span style="font-size:11px; color:var(--text-sub);">ទំហំសរុប៖ ${d.sizeGB} GB</span>
                        </div>
                        <button class="btn btn-secondary btn-drive-details" data-drive="${d.drive}" style="padding: 6px 12px; font-size:12px;">
                            <i class="fa-solid fa-magnifying-glass"></i> Details
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        document.querySelectorAll('.btn-drive-details').forEach(btn => {
            btn.addEventListener('click', () => {
                const driveLetter = btn.getAttribute('data-drive');
                openDriveDetailsModal(driveLetter);
            });
        });
    }

    // DRIVE DETAILS MODAL LOGIC
    async function openDriveDetailsModal(driveLetter) {
        currentDetailDrive = driveLetter;
        const driveObj = drivesData.find(d => d.drive === driveLetter) || { drive: driveLetter, name: 'Drive', fileSystem: 'NTFS', sizeGB: 0, usedGB: 0, freeGB: 0, usedPercent: 0 };
        
        driveDetailsTitle.textContent = `ព័ត៌មានលម្អិត Drive ${driveLetter}`;
        driveDetailsSub.textContent = `Volume Name: ${driveObj.name} | File System: ${driveObj.fileSystem}`;
        detailTotalSize.textContent = `${driveObj.sizeGB} GB`;
        detailUsedSize.textContent = `${driveObj.usedGB} GB`;
        detailFreeSize.textContent = `${driveObj.freeGB} GB`;
        detailPercentText.textContent = `${driveObj.usedPercent}%`;
        detailProgressBar.style.width = `${driveObj.usedPercent}%`;

        driveDetailsFoldersList.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i> កំពុងស្កែន Top Folders...</div>`;
        driveDetailsModal.classList.remove('hidden');

        try {
            const res = await fetch(`/api/drive-details?drive=${driveLetter}`);
            const data = await res.json();
            if (data.topFolders) {
                renderDriveDetailsFolders(data.topFolders);
            }
        } catch (e) {
            driveDetailsFoldersList.innerHTML = `<div class="text-center" style="color:var(--accent-rose)">❌ មានបញ្ហាក្នុងការទាញយក Folders</div>`;
        }
    }

    function renderDriveDetailsFolders(folders) {
        if (folders.length === 0) {
            driveDetailsFoldersList.innerHTML = `<div class="text-center" style="padding: 12px; color: var(--text-muted);">គ្មាន Folder ធំៗឡើយ</div>`;
            return;
        }

        driveDetailsFoldersList.innerHTML = folders.map(item => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 13px;">
                <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
                    <i class="${item.isDirectory ? 'fa-solid fa-folder color-cyan' : 'fa-solid fa-file color-blue'}"></i>
                    <span style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px;" title="${item.path}">${item.name}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="color: var(--text-muted); font-size: 12px;">${item.count} files</span>
                    <strong style="color: var(--accent-emerald); font-size: 13px;">${item.sizeGB > 1 ? item.sizeGB + ' GB' : item.sizeMB + ' MB'}</strong>
                </div>
            </div>
        `).join('');
    }

    if (driveDetailsCloseBtn) {
        driveDetailsCloseBtn.addEventListener('click', () => driveDetailsModal.classList.add('hidden'));
    }
    if (btnDetailSetSource) {
        btnDetailSetSource.addEventListener('click', () => {
            driveDetailsModal.classList.add('hidden');
            // Check the corresponding source drive checkbox then reload
            const driveCb = document.querySelector(`.source-drive-cb[data-drive="${currentDetailDrive}"]`);
            if (driveCb) {
                driveCb.checked = true;
                loadSelectedSourceDrives();
            }
            showToast(`បានកំណត់ Drive ${currentDetailDrive} ជា Source Drive`, 'info');
        });
    }
    if (btnDetailSetTarget) {
        btnDetailSetTarget.addEventListener('click', () => {
            driveDetailsModal.classList.add('hidden');
            if (univTargetDriveSelect) {
                univTargetDriveSelect.value = currentDetailDrive;
                showToast(`បានកំណត់ Drive ${currentDetailDrive} ជា Target Drive`, 'info');
            }
        });
    }


    // 4. Load User Folders in C: (With Multi-Select)
    async function loadUserFolders() {
        try {
            const res = await fetch('/api/user-folders');
            const data = await res.json();
            if (data.folders) {
                renderUserFolders(data.folders);
            }
        } catch (err) {
            userFoldersTbody.innerHTML = `<tr><td colspan="7" class="text-center">មានបញ្ហាក្នុងការទាញយកទិន្នន័យ Folders</td></tr>`;
        }
    }

    function renderUserFolders(folders) {
        const availableTargetDrives = drivesData.filter(d => !d.drive.startsWith('C')).map(d => d.drive);
        
        userFoldersTbody.innerHTML = folders.map(f => {
            const defaultSelected = availableTargetDrives.find(d => d.startsWith('F')) || availableTargetDrives[0] || 'F:';

            const optionsHtml = availableTargetDrives.map(drive => 
                `<option value="${drive}" ${drive === defaultSelected ? 'selected' : ''}>${drive} (Drive ${drive.replace(':', '')})</option>`
            ).join('');

            return `
                <tr>
                    <td style="text-align: center;">
                        <input type="checkbox" class="user-folder-cb" data-folder="${f.folder}" data-path="${f.path}" style="width:16px; height:16px; cursor:pointer;">
                    </td>
                    <td><strong><i class="fa-solid fa-folder-open color-cyan"></i> ${f.folder}</strong></td>
                    <td class="text-sub">${f.path}</td>
                    <td>${f.count.toLocaleString()} ឯកសារ</td>
                    <td><strong class="color-cyan">${f.sizeGB > 1 ? f.sizeGB + ' GB' : f.sizeMB + ' MB'}</strong></td>
                    <td>
                        <select class="drive-select" id="select-${f.folder}" data-folder="${f.folder}">
                            ${optionsHtml}
                        </select>
                    </td>
                    <td>
                        <button class="btn btn-cyan btn-move" id="btn-move-${f.folder}" data-folder="${f.folder}">
                            <i class="fa-solid fa-arrow-right"></i> <span class="btn-text">ផ្ទេរទៅ ${defaultSelected}</span>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        // Select All Handler for User Folders
        if (userFolderSelectAll) {
            userFolderSelectAll.checked = false;
            userFolderSelectAll.onclick = () => {
                const checked = userFolderSelectAll.checked;
                document.querySelectorAll('.user-folder-cb').forEach(cb => cb.checked = checked);
                updateBatchUserFoldersState();
            };
        }

        document.querySelectorAll('.user-folder-cb').forEach(cb => {
            cb.addEventListener('change', updateBatchUserFoldersState);
        });

        // Dropdown dynamic button text updater
        document.querySelectorAll('.drive-select').forEach(selectElem => {
            selectElem.addEventListener('change', () => {
                const folderName = selectElem.getAttribute('data-folder');
                const selectedDrive = selectElem.value;
                const btnElem = document.getElementById(`btn-move-${folderName}`);
                if (btnElem) {
                    const btnTextSpan = btnElem.querySelector('.btn-text');
                    if (btnTextSpan) {
                        btnTextSpan.textContent = `ផ្ទេរទៅ ${selectedDrive}`;
                    }
                }
            });
        });

        // Single Move Buttons
        document.querySelectorAll('.btn-move').forEach(btn => {
            btn.addEventListener('click', () => {
                const folderName = btn.getAttribute('data-folder');
                const selectElem = document.getElementById(`select-${folderName}`);
                const targetDrive = selectElem ? selectElem.value : 'F:';

                pendingTransfer = { folderName, targetDrive };
                pendingBatchTransfer = null;
                
                modalTitle.textContent = `បញ្ជាក់ការផ្ទេរ Folder "${folderName}"`;
                modalDesc.innerHTML = `តើអ្នកពិតជាចង់ផ្ទេរឯកសារក្នុង <strong>${folderName}</strong> ពី Drive C ទៅកាន់ <strong>${targetDrive}</strong> មែនទេ?`;
                confirmModalOverlay.classList.remove('hidden');
            });
        });
    }

    function updateBatchUserFoldersState() {
        const checkedCbs = document.querySelectorAll('.user-folder-cb:checked');
        const count = checkedCbs.length;
        if (btnBatchMoveUserFolders) {
            btnBatchMoveUserFolders.disabled = count === 0;
            btnBatchMoveUserFolders.innerHTML = `<i class="fa-solid fa-truck-ramp-box"></i> ផ្ទេរ Folders ដែលបានជ្រើស (${count})`;
        }
    }

    if (btnBatchMoveUserFolders) {
        btnBatchMoveUserFolders.addEventListener('click', () => {
            const checkedCbs = document.querySelectorAll('.user-folder-cb:checked');
            if (checkedCbs.length === 0) return;

            const targetDrive = userFoldersBatchTarget ? userFoldersBatchTarget.value : 'F:';
            const items = Array.from(checkedCbs).map(cb => ({
                folderName: cb.getAttribute('data-folder'),
                sourcePath: cb.getAttribute('data-path')
            }));

            pendingBatchTransfer = { items, targetDrive };
            pendingTransfer = null;

            modalTitle.innerHTML = `<span style="color:var(--accent-cyan)"><i class="fa-solid fa-truck-ramp-box"></i> បញ្ជាក់ការផ្ទេរ ${items.length} Folders ទៅកាន់ ${targetDrive}</span>`;
            modalDesc.innerHTML = `
                តើអ្នកពិតជាចង់ផ្ទេរ <strong>${items.length} Folders</strong> ពី Drive C ទៅកាន់ <strong>${targetDrive}</strong> មែនទេ?<br><br>
                <div style="max-height:100px; overflow-y:auto; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px; font-size:12px;">
                    ${items.map(i => `<span class="closed-app-tag" style="margin:2px; display:inline-block;"><i class="fa-solid fa-folder color-cyan"></i> ${i.folderName}</span>`).join('')}
                </div>
            `;
            modalConfirmBtn.className = 'btn btn-cyan';
            modalConfirmBtn.textContent = `យល់ព្រមផ្ទេរទាំង ${items.length} Folders`;
            confirmModalOverlay.classList.remove('hidden');
        });
    }


    // UNIVERSAL DRIVE-TO-DRIVE TRANSFER LOGIC
    async function loadSelectedSourceDrives() {
        const checkedDriveCbs = document.querySelectorAll('.source-drive-cb:checked');
        const selectedDrives = Array.from(checkedDriveCbs).map(cb => cb.getAttribute('data-drive'));

        if (selectedDrives.length === 0) {
            // Default to C: if none checked
            const defaultCb = document.querySelector('.source-drive-cb[data-drive="C:"]');
            if (defaultCb) defaultCb.checked = true;
            selectedDrives.push('C:');
        }

        if (univSourceName) univSourceName.textContent = `Drives (${selectedDrives.join(', ')})`;
        if (univFolderList) univFolderList.innerHTML = `<div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i> កំពុងស្កែន Items ក្នុង (${selectedDrives.join(', ')})...</div>`;

        try {
            const results = await Promise.all(selectedDrives.map(d => 
                fetch(`/api/drive-details?drive=${d}`).then(r => r.json()).catch(() => ({ topFolders: [], drive: d }))
            ));

            let allFolders = [];
            results.forEach(res => {
                const driveLetter = res.drive || 'C:';
                if (res.topFolders) {
                    res.topFolders.forEach(item => {
                        allFolders.push({ ...item, sourceDrive: driveLetter });
                    });
                }
            });

            // Sort by size descending
            allFolders.sort((a, b) => b.sizeBytes - a.sizeBytes);
            univSourceItems = allFolders;
            renderUnivFolderList(allFolders);
        } catch (e) {
            if (univFolderList) univFolderList.innerHTML = `<div class="text-center" style="color:var(--accent-rose)">❌ មានបញ្ហាក្នុងការស្កែន Drives (${selectedDrives.join(', ')})</div>`;
        }
    }

    function renderUnivFolderList(items) {
        if (!univFolderList) return;

        if (items.length === 0) {
            univFolderList.innerHTML = `<div class="text-center" style="padding: 12px; color: var(--text-muted);">គ្មាន Folder/File អាចផ្ទេរបានឡើយ</div>`;
            return;
        }

        univFolderList.innerHTML = items.map(item => {
            let badgeClass = item.sourceDrive.startsWith('C') ? 'badge-c' : item.sourceDrive.startsWith('F') ? 'badge-f' : 'badge-d';

            return `
                <label style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer; user-select: none;">
                    <div style="display: flex; align-items: center; gap: 10px; overflow: hidden;">
                        <input type="checkbox" class="univ-cb" data-sourcedrive="${item.sourceDrive}" data-path="${item.path}" data-name="${item.name}" data-sizebytes="${item.sizeBytes}" style="width:16px; height:16px; cursor:pointer;">
                        <span class="badge-drive ${badgeClass}" style="padding: 2px 6px; font-size: 11px;">Drive ${item.sourceDrive}</span>
                        <i class="${item.isDirectory ? 'fa-solid fa-folder color-cyan' : 'fa-solid fa-file color-blue'}"></i>
                        <span style="font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px;" title="${item.path}">${item.name}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 11px; color: var(--text-muted);">${item.count} files</span>
                        <strong style="color: var(--accent-emerald); font-size: 13px;">${item.sizeGB > 1 ? item.sizeGB + ' GB' : item.sizeMB + ' MB'}</strong>
                    </div>
                </label>
            `;
        }).join('');

        document.querySelectorAll('.univ-cb').forEach(cb => cb.addEventListener('change', updateUnivSelectionState));
        updateUnivSelectionState();
    }

    function updateUnivSelectionState() {
        const checkedCbs = document.querySelectorAll('.univ-cb:checked');
        const count = checkedCbs.length;
        if (btnAddToQueue) {
            btnAddToQueue.innerHTML = `<i class="fa-solid fa-plus"></i> បន្ថែម ${count} Items ចូល Queue`;
        }
    }

    if (btnUnivSelectAll) {
        btnUnivSelectAll.addEventListener('click', () => {
            document.querySelectorAll('.univ-cb').forEach(cb => cb.checked = true);
            updateUnivSelectionState();
        });
    }
    if (btnUnivClearAll) {
        btnUnivClearAll.addEventListener('click', () => {
            document.querySelectorAll('.univ-cb').forEach(cb => cb.checked = false);
            updateUnivSelectionState();
        });
    }

    // ADD TO QUEUE HANDLER
    if (btnAddToQueue) {
        btnAddToQueue.addEventListener('click', () => {
            const checkedCbs = document.querySelectorAll('.univ-cb:checked');
            if (checkedCbs.length === 0) {
                showToast('សូមជ្រើសរើស Folder/File យ៉ាងហោចណាស់ 1 ដើម្បីបន្ថែមចូល Queue', 'info');
                return;
            }

            let addedCount = 0;

            checkedCbs.forEach(cb => {
                const sourceDrive = cb.getAttribute('data-sourcedrive') || 'C:';
                const itemPath = cb.getAttribute('data-path');
                const itemName = cb.getAttribute('data-name');
                const sizeBytes = parseInt(cb.getAttribute('data-sizebytes') || '0', 10);

                // Avoid duplicate entries in queue
                if (!transferQueue.some(q => q.sourcePath === itemPath)) {
                    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
                    const sizeGB = (sizeBytes / (1024 ** 3)).toFixed(2);
                    const sizeStr = parseFloat(sizeGB) > 1 ? `${sizeGB} GB` : `${sizeMB} MB`;

                    transferQueue.push({
                        id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                        sourceDrive,
                        sourcePath: itemPath,
                        itemName,
                        sizeBytes,
                        sizeStr
                    });
                    addedCount++;
                }

                cb.checked = false;
            });

            renderTransferQueue();
            updateUnivSelectionState();
            if (addedCount > 0) {
                showToast(`✅ បានបន្ថែម ${addedCount} items ចូលក្នុង Queue!`, 'success');
            } else {
                showToast(`⚠️ Items ទាំងនេះមានក្នុង Queue រួចហើយ`, 'info');
            }
        });
    }

    function renderTransferQueue() {
        if (!queueTbody) return;

        if (transferQueue.length === 0) {
            queueTbody.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center text-sub" style="padding: 16px;">
                        មិនទាន់មាន Item ក្នុង Queue ឡើយ (សូមជ្រើសរើស Folder ក្នុង Source Drive រួចចុច "បន្ថែមចូល Queue")
                    </td>
                </tr>
            `;
            if (queueCountBadge) queueCountBadge.textContent = '0 items';
            if (queueTotalItems) queueTotalItems.textContent = '0';
            if (queueTotalSize) queueTotalSize.textContent = '0.0 MB';
            if (btnExecuteQueue) btnExecuteQueue.disabled = true;
            return;
        }

        let totalBytes = 0;
        queueTbody.innerHTML = transferQueue.map(item => {
            totalBytes += item.sizeBytes;
            let badgeClass = item.sourceDrive.startsWith('C') ? 'badge-c' : item.sourceDrive.startsWith('F') ? 'badge-f' : 'badge-d';

            return `
                <tr>
                    <td><span class="badge-drive ${badgeClass}" style="padding:3px 8px; font-size:11px;">Drive ${item.sourceDrive}</span></td>
                    <td>
                        <div style="font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-folder color-cyan"></i> ${item.itemName}
                        </div>
                        <div class="text-sub" style="font-size:11px;">${item.sourcePath}</div>
                    </td>
                    <td><strong style="color: var(--accent-emerald);">${item.sizeStr}</strong></td>
                    <td style="text-align: center;">
                        <button class="btn btn-secondary btn-remove-queue-item" data-id="${item.id}" style="padding: 4px 8px; font-size: 11px;" title="លុបចេញពី Queue">
                            <i class="fa-solid fa-xmark color-rose"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        document.querySelectorAll('.btn-remove-queue-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-id');
                transferQueue = transferQueue.filter(q => q.id !== id);
                renderTransferQueue();
            });
        });

        const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
        const totalGB = (totalBytes / (1024 ** 3)).toFixed(2);
        const totalStr = parseFloat(totalGB) > 1 ? `${totalGB} GB` : `${totalMB} MB`;

        if (queueCountBadge) queueCountBadge.textContent = `${transferQueue.length} items`;
        if (queueTotalItems) queueTotalItems.textContent = transferQueue.length;
        if (queueTotalSize) queueTotalSize.textContent = totalStr;

        if (btnExecuteQueue) {
            btnExecuteQueue.disabled = false;
            const targetDrive = univTargetDriveSelect ? univTargetDriveSelect.value : 'Target Drive';
            btnExecuteQueue.innerHTML = `<i class="fa-solid fa-paper-plane"></i> ផ្ទេរ ${transferQueue.length} Items ក្នុង Queue ទៅកាន់ ${targetDrive}`;
        }
    }

    if (btnClearQueue) {
        btnClearQueue.addEventListener('click', () => {
            transferQueue = [];
            renderTransferQueue();
            showToast('បានសម្អាតបញ្ជី Queue រួចរាល់', 'info');
        });
    }

    if (btnExecuteQueue) {
        btnExecuteQueue.addEventListener('click', () => {
            if (transferQueue.length === 0) return;

            const targetDrive = univTargetDriveSelect ? univTargetDriveSelect.value : 'F:';
            const items = transferQueue.map(q => ({
                sourcePath: q.sourcePath,
                folderName: q.itemName,
                sourceDrive: q.sourceDrive
            }));

            // Group drives breakdown for confirmation text
            const uniqueDrives = Array.from(new Set(transferQueue.map(q => q.sourceDrive)));

            pendingBatchTransfer = { items, targetDrive };
            pendingTransfer = null;

            modalTitle.innerHTML = `<span style="color:var(--accent-cyan)"><i class="fa-solid fa-paper-plane"></i> បញ្ជាក់ការផ្ទេរ ${items.length} Items ទៅកាន់ ${targetDrive}</span>`;
            modalDesc.innerHTML = `
                តើអ្នកពិតជាចង់ផ្ទេរ <strong>${items.length} Items</strong> មកពី <strong>Drives (${uniqueDrives.join(', ')})</strong> ទៅកាន់ Target Drive <strong>${targetDrive}\\Migrated_Files</strong> មែនទេ?<br><br>
                <div style="max-height:110px; overflow-y:auto; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px; font-size:12px;">
                    ${items.map(i => `<span class="closed-app-tag" style="margin:2px; display:inline-block;"><i class="fa-solid fa-hard-drive color-cyan"></i> [Drive ${i.sourceDrive}] ${i.folderName}</span>`).join('')}
                </div>
            `;
            modalConfirmBtn.className = 'btn btn-emerald';
            modalConfirmBtn.textContent = `យល់ព្រមផ្ទេរទាំង ${items.length} Items ចូល ${targetDrive}`;
            confirmModalOverlay.classList.remove('hidden');
        });
    }



    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            navButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(t => t.classList.remove('active'));

            btn.classList.add('active');
            const targetTab = btn.getAttribute('data-tab');
            currentTab = targetTab;
            document.getElementById(targetTab).classList.add('active');

            if (targetTab === 'drives-tab') {
                pageTitle.textContent = 'ផ្ទេរឯកសារ និងសម្អាត Drive C';
                pageDesc.textContent = 'ប្តូរទំហំទំនេរ Drive C ទៅកាន់ Drive D ឬ F ដោយសុវត្ថិភាព';
            } else if (targetTab === 'boost-tab') {
                pageTitle.textContent = 'បិទ Task ឥតប្រយោជន៍ (Edit & Code Booster)';
                pageDesc.textContent = 'ជ្រើសរើស Mode សម្រាប់ Editor ឬ Coder & AI ដើម្បីទាញយក Speed';
            } else if (targetTab === 'processes-tab') {
                pageTitle.textContent = 'គ្រប់គ្រង Processes (Tasks)';
                pageDesc.textContent = 'ស្វែងរក និងបិទ Process ណាដែលអ្នកមិនត្រូវការដោយផ្ទាល់';
                loadProcesses();
            }
        });
    });


    // Toast Notifications — FIX: use DOM API + textContent to prevent XSS
    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = document.createElement('i');
        const iconName = type === 'error' ? 'fa-circle-exclamation' : type === 'info' ? 'fa-circle-info' : 'fa-circle-check';
        icon.className = `fa-solid ${iconName}`;

        const span = document.createElement('span');
        span.textContent = message; // safe — no HTML injection from API errors

        toast.appendChild(icon);
        toast.appendChild(span);
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 4500);
    }





    modalCancelBtn.addEventListener('click', () => {
        confirmModalOverlay.classList.add('hidden');
        pendingTransfer = null;
        pendingEndTask = null;
        pendingEndAll = null;
    });

    modalConfirmBtn.addEventListener('click', async () => {
        // Handle BULK END ALL confirmation
        if (pendingEndAll) {
            const { items, filterName } = pendingEndAll;
            pendingEndAll = null;
            confirmModalOverlay.classList.add('hidden');

            btnEndAll.disabled = true;
            btnEndAll.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> កំពុងបិទ ${items.length} Tasks...`;

            try {
                const res = await fetch('/api/end-multiple-processes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items })
                });
                const data = await res.json();

                if (data.success) {
                    showToast(`✅ បានបិទ ${data.killedCount} Tasks (${filterName}) និងទាញយក RAM ${data.freedMB} MB!`, 'success');
                    setTimeout(() => loadProcesses(), 1200);
                } else {
                    showToast(`❌ កំហុស៖ ${data.error}`, 'error');
                }
            } catch (e) {
                showToast('❌ កំហុសក្នុងការបិទ Tasks', 'error');
            } finally {
                btnEndAll.disabled = false;
            }
            return;
        }

        // Handle END TASK confirmation
        if (pendingEndTask) {
            const { pid, name } = pendingEndTask;
            pendingEndTask = null;
            confirmModalOverlay.classList.add('hidden');

            const originalBtn = document.querySelector(`.btn-end-proc[data-pid="${pid}"]`);
            if (originalBtn) {
                originalBtn.disabled = true;
                originalBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Killing...`;
            }

            try {
                const res = await fetch('/api/end-process', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pid, name })
                });
                const data = await res.json();

                if (data.success) {
                    showToast(`✅ បានបិទ "${name}" (PID: ${pid}) រួចរាល់!`, 'success');
                    setTimeout(() => loadProcesses(), 1200);
                } else {
                    showToast(`❌ កំហុស៖ ${data.error}`, 'error');
                    if (originalBtn) { originalBtn.disabled = false; originalBtn.innerHTML = `<i class="fa-solid fa-xmark"></i> End Task`; }
                }
            } catch (e) {
                showToast('❌ កំហុសក្នុងការបិទ Task', 'error');
                if (originalBtn) { originalBtn.disabled = false; originalBtn.innerHTML = `<i class="fa-solid fa-xmark"></i> End Task`; }
            }
            return;
        }


        // Handle BATCH FILE TRANSFER confirmation
        if (pendingBatchTransfer) {
            const { items, targetDrive } = pendingBatchTransfer;
            pendingBatchTransfer = null;
            confirmModalOverlay.classList.add('hidden');

            loadingTitle.textContent = `កំពុងផ្ទេរ ${items.length} Items ទៅកាន់ ${targetDrive}...`;
            loadingDesc.innerHTML = `ប្រព័ន្ធកំពុងផ្ទេរ ${items.length} items ទៅកាន់ <strong>${targetDrive}\\Migrated_Files</strong> ដោយសុវត្ថិភាព...`;

            const percentText = document.getElementById('progress-percent-text');
            const barFill = document.getElementById('progress-bar-fill');
            if (percentText) percentText.textContent = '0%';
            if (barFill) barFill.style.width = '0%';

            let elapsedSeconds = 0;
            const timerCounter = document.getElementById('timer-counter');
            if (timerCounter) timerCounter.textContent = '00:00';

            if (transferTimerInterval) clearInterval(transferTimerInterval);
            transferTimerInterval = setInterval(() => {
                elapsedSeconds++;
                const mins = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
                const secs = String(elapsedSeconds % 60).padStart(2, '0');
                if (timerCounter) timerCounter.textContent = `${mins}:${secs}`;
            }, 1000);

            if (transferProgressPollInterval) clearInterval(transferProgressPollInterval);
            transferProgressPollInterval = setInterval(async () => {
                try {
                    const res = await fetch('/api/move-progress');
                    const data = await res.json();
                    if (data && typeof data.percent === 'number') {
                        if (percentText) percentText.textContent = `${data.percent}%`;
                        if (barFill) barFill.style.width = `${data.percent}%`;
                        if (data.currentItem && data.batchTotal) {
                            loadingTitle.textContent = `កំពុងផ្ទេរ (${data.batchIndex}/${data.batchTotal}): "${data.currentItem}"`;
                        }
                    }
                } catch (_) {}
            }, 300);

            transferLoadingOverlay.classList.remove('hidden');

            try {
                const res = await fetch('/api/move-multiple', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items, targetDrive })
                });
                const result = await res.json();

                if (result.success) {
                    if (percentText) percentText.textContent = '100%';
                    if (barFill) barFill.style.width = '100%';
                    showToast(`✅ បានផ្ទេរ ${result.successCount}/${items.length} items ទៅ ${targetDrive} រួចរាល់ដោយសុវត្ថិភាព!`, 'success');
                } else if (result.cancelled) {
                    showToast(`⚠️ បានបោះបង់ការផ្ទេរ (${result.successCount} បានផ្ទេររួច)`, 'info');
                } else {
                    showToast(`❌ កំហុសក្នុងការផ្ទេរ៖ ${result.errors?.[0] || result.error || 'Failed'}`, 'error');
                }
            } catch (err) {
                showToast('❌ មានបញ្ហាក្នុងការផ្ទេរឯកសារ', 'error');
            } finally {
                if (transferTimerInterval) { clearInterval(transferTimerInterval); transferTimerInterval = null; }
                if (transferProgressPollInterval) { clearInterval(transferProgressPollInterval); transferProgressPollInterval = null; }
                transferLoadingOverlay.classList.add('hidden');
                await loadDrives();
                await loadUserFolders();
                loadSelectedSourceDrives();
            }
            return;
        }

        // Handle SINGLE FILE TRANSFER confirmation
        if (!pendingTransfer) return;

        const { folderName, targetDrive } = pendingTransfer;

        // FIX: hide modal FIRST, then reset button — no visible text flicker
        confirmModalOverlay.classList.add('hidden');
        modalConfirmBtn.innerHTML = `<i class="fa-solid fa-check"></i> យល់ព្រមផ្ទេរ (Confirm Move)`;

        // Show Transfer Progress Overlay
        loadingTitle.textContent = `កំពុងផ្ទេរ Folder "${folderName}"...`;
        loadingDesc.innerHTML = `ប្រព័ន្ធកំពុងផ្ទេរឯកសារពី Drive C ទៅកាន់ <strong>${targetDrive}\\Migrated_Files\\${folderName}</strong> ដោយសុវត្ថិភាព (Robocopy Transfer)...`;
        
        // Reset Percentage & Bar
        const percentText = document.getElementById('progress-percent-text');
        const barFill = document.getElementById('progress-bar-fill');
        if (percentText) percentText.textContent = '0%';
        if (barFill) barFill.style.width = '0%';

        // Start Live Timer Counter
        let elapsedSeconds = 0;
        const timerCounter = document.getElementById('timer-counter');
        if (timerCounter) timerCounter.textContent = '00:00';

        if (transferTimerInterval) clearInterval(transferTimerInterval);
        transferTimerInterval = setInterval(() => {
            elapsedSeconds++;
            const mins = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
            const secs = String(elapsedSeconds % 60).padStart(2, '0');
            if (timerCounter) timerCounter.textContent = `${mins}:${secs}`;
        }, 1000);

        // Start Progress Polling (every 300ms)
        if (transferProgressPollInterval) clearInterval(transferProgressPollInterval);
        transferProgressPollInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/move-progress');
                const data = await res.json();
                if (data && typeof data.percent === 'number') {
                    if (percentText) percentText.textContent = `${data.percent}%`;
                    if (barFill) barFill.style.width = `${data.percent}%`;
                }
            } catch (_) {}
        }, 300);

        transferLoadingOverlay.classList.remove('hidden');

        try {
            const res = await fetch('/api/move-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderName, targetDrive })
            });
            const result = await res.json();

            if (result.success) {
                if (percentText) percentText.textContent = '100%';
                if (barFill) barFill.style.width = '100%';
                showToast(`✅ ផ្ទេរ "${folderName}" ទៅ ${targetDrive} រួចរាល់ដោយសុវត្ថិភាព (100%)!`, 'success');
                await loadDrives();
                await loadUserFolders();
            } else if (result.cancelled) {
                showToast(`⚠️ បានបោះបង់ការផ្ទេរ Folder "${folderName}"`, 'info');
            } else {
                showToast(`❌ កំហុសក្នុងការផ្ទេរ៖ ${result.error || 'Controlled Folder Access blocked Robocopy'}`, 'error');
            }
        } catch (err) {
            showToast('❌ មានបញ្ហាក្នុងការផ្ទេរឯកសារ', 'error');
        } finally {
            if (transferTimerInterval) {
                clearInterval(transferTimerInterval);
                transferTimerInterval = null;
            }
            if (transferProgressPollInterval) {
                clearInterval(transferProgressPollInterval);
                transferProgressPollInterval = null;
            }
            transferLoadingOverlay.classList.add('hidden');
            pendingTransfer = null;
        }
    });

    // Cancel Transfer Button Event Handler
    const cancelTransferBtn = document.getElementById('cancel-transfer-btn');
    if (cancelTransferBtn) {
        cancelTransferBtn.addEventListener('click', async () => {
            if (transferTimerInterval) {
                clearInterval(transferTimerInterval);
                transferTimerInterval = null;
            }
            if (transferProgressPollInterval) {
                clearInterval(transferProgressPollInterval);
                transferProgressPollInterval = null;
            }
            transferLoadingOverlay.classList.add('hidden');
            showToast('⚠️ កំពុងបោះបង់ការផ្ទេរ...', 'info');

            try {
                await fetch('/api/cancel-move', { method: 'POST' });
            } catch (_) {}

            pendingTransfer = null;
            await loadDrives();
            await loadUserFolders();
        });
    }



    // 5. Scan & Clean Temp Files
    async function scanTemp() {
        try {
            const res = await fetch('/api/scan-temp');
            const data = await res.json();
            if (data.sizeMB !== undefined) {
                tempBadge.innerHTML = `<i class="fa-solid fa-calculator"></i> ${data.sizeMB > 1024 ? data.sizeGB + ' GB' : data.sizeMB + ' MB'} (${data.filesCount} files)`;
            }
        } catch (e) {
            tempBadge.textContent = '0 MB';
        }
    }

    cleanTempBtn.addEventListener('click', async () => {
        cleanTempBtn.disabled = true;
        cleanTempBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> កំពុងសម្អាត...`;

        try {
            const res = await fetch('/api/clean-temp', { method: 'POST' });
            const data = await res.json();

            if (data.success) {
                showToast('សម្អាត Temp & Cache files រួចរាល់!', 'success');
                scanTemp();
                loadDrives();
            }
        } catch (e) {
            showToast('មានបញ្ហាក្នុងការសម្អាត', 'error');
        } finally {
            cleanTempBtn.disabled = false;
            cleanTempBtn.innerHTML = `<i class="fa-solid fa-trash-can"></i> សម្អាតភ្លាមៗ (Clean Now)`;
        }
    });

    // 6A. Editor Boost Mode Handler
    if (editorBoostBtn) {
        editorBoostBtn.addEventListener('click', () => runBoost('/api/boost-editor', 'Editor Mode', editorBoostBtn));
    }

    // 6B. Coder & AI Boost Mode Handler
    if (coderBoostBtn) {
        coderBoostBtn.addEventListener('click', () => runBoost('/api/boost-coder', 'Coder & AI Mode (Antigravity, Gemini, Claude)', coderBoostBtn));
    }

    async function runBoost(endpoint, modeName, btnElement) {
        const originalHtml = btnElement.innerHTML;
        btnElement.disabled = true;
        btnElement.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> កំពុងបង្កើនល្បឿន ${modeName}...`;

        try {
            const res = await fetch(endpoint, { method: 'POST' });
            const data = await res.json();

            if (data.success) {
                boostResultCard.classList.remove('hidden');
                resultTitleText.innerHTML = `<i class="fa-solid fa-circle-check"></i> លទ្ធផលនៃការ Boost សម្រាប់ ${modeName}`;
                resultFreedBadge.textContent = `+${data.freedMB} MB RAM Freed`;
                resultText.textContent = `បិទបានចំនួន ${data.killedCount} ដំណើរការ background ឥតប្រយោជន៍។`;

                if (data.terminatedApps && data.terminatedApps.length > 0) {
                    closedAppsList.innerHTML = data.terminatedApps.map(app => 
                        `<span class="closed-app-tag"><i class="fa-solid fa-xmark color-red"></i> ${app}</span>`
                    ).join('');
                } else {
                    closedAppsList.innerHTML = `<span class="text-sub">គ្មាន Background process កំពុងរត់ឡើយ (ប្រព័ន្ធស្អាតស្រាប់)</span>`;
                }

                showToast(`✅ Boost ${modeName} — ទាញយក RAM ${data.freedMB} MB!`, 'success');

                // If user is on the processes tab, auto-refresh it
                if (currentTab === 'processes-tab') {
                    setTimeout(() => loadProcesses(), 1500);
                }
            } else {
                showToast('❌ មានបញ្ហាក្នុងការ Boost', 'error');
            }
        } catch (e) {
            showToast('❌ មានបញ្ហាក្នុងការ Boost', 'error');
        } finally {
            btnElement.disabled = false;
            btnElement.innerHTML = originalHtml;
        }
    }

    // PROCESS KNOWLEDGE BASE & CATEGORY DICTIONARY
    const PROCESS_MAP = {
        // AI & IDE / Coder Tools
        'language_server_windows_x64': { cat: 'system', title: '🤖 AI Code Engine', desc: 'វិភាគ Code, Autocomplete, Syntax Check & AI Assist របស់ Antigravity IDE (កុំបិទ)' },
        'antigravity ide': { cat: 'system', title: '💻 Antigravity IDE', desc: 'កម្មវិធីសរសេរ Code Antigravity IDE (កុំបិទ)' },
        'code': { cat: 'system', title: '💻 VS Code Editor', desc: 'កម្មវិធីសរសេរ Code Visual Studio Code (កុំបិទ)' },
        'node': { cat: 'safe', title: '🟢 Node.js Runtime', desc: 'ដំណើរការ Web Server & Development Environment' },
        'git': { cat: 'safe', title: '🐙 Git Version Control', desc: 'ប្រព័ន្ធគ្រប់គ្រង Code Version Control' },
        'python': { cat: 'safe', title: '🐍 Python Runtime', desc: 'ប្រព័ន្ធដំណើរការសរសេរ Code ភាសា Python' },
        'autoclickerpc': { cat: 'safe', title: '🖱️ Auto Clicker Tool', desc: 'App ចុច Mouse ដោយស្វ័យប្រវត្តិ សម្រាប់ការងារ Test' },

        // Bloatware & Background Updaters (ឥតប្រយោជន៍)
        'googleupdate': { cat: 'bloatware', title: '🔴 Google Updater', desc: 'បច្ចុប្បន្នភាព Chrome/Google ក្នុង Background (ឥតប្រយោជន៍)' },
        'edgeupdate': { cat: 'bloatware', title: '🔴 Edge Updater', desc: 'បច្ចុប្បន្នភាព Microsoft Edge (ឥតប្រយោជន៍)' },
        'microsoftedgeupdate': { cat: 'bloatware', title: '🔴 Edge Updater', desc: 'បច្ចុប្បន្នភាព Microsoft Edge (ឥតប្រយោជន៍)' },
        'adobeupdateservice': { cat: 'bloatware', title: '🔴 Adobe Updater', desc: 'បច្ចុប្បន្នភាព Adobe Background Service (ឥតប្រយោជន៍)' },
        'adobearm': { cat: 'bloatware', title: '🔴 Adobe ARM Helper', desc: 'បច្ចុប្បន្នភាព Adobe Acrobat (ឥតប្រយោជន៍)' },
        'agsservice': { cat: 'bloatware', title: '🔴 Adobe Genuine Service', desc: 'ប្រព័ន្ធពិនិត្យ Adobe License (ឥតប្រយោជន៍)' },
        'agmservice': { cat: 'bloatware', title: '🔴 Adobe Global Service', desc: 'Background Service របស់ Adobe (ឥតប្រយោជន៍)' },
        'adobeipcbroker': { cat: 'bloatware', title: '🔴 Adobe IPC Broker', desc: 'ប្រព័ន្ធទាក់ទង App Adobe ក្នុង Background (ឥតប្រយោជន៍)' },
        'coresync': { cat: 'bloatware', title: '🔴 Adobe Cloud Sync', desc: 'បកប្រែឯកសារ Adobe Creative Cloud Sync (ឥតប្រយោជន៍)' },
        'ituneshelper': { cat: 'bloatware', title: '🔴 iTunes Helper', desc: 'Background Listener របស់ Apple iTunes (ឥតប្រយោជន៍)' },
        'onedrive': { cat: 'bloatware', title: '☁️ Microsoft OneDrive', desc: 'ប្រព័ន្ធ Synced ឯកសារ Cloud របស់ Microsoft (អាចបិទបាន)' },
        'spotify': { cat: 'safe', title: '🎵 Spotify Player', desc: 'កម្មវិធីចាក់ចម្រៀង Spotify' },
        'cortana': { cat: 'bloatware', title: '🎙️ Microsoft Cortana', desc: 'អ្នកជំនួយការសំឡេង Cortana របស់ Windows (ឥតប្រយោជន៍)' },
        'widgets': { cat: 'bloatware', title: '📰 Windows Widgets', desc: 'ផ្ទាំងព័ត៌មាន News & Widgets Board (ឥតប្រយោជន៍)' },
        'widgetservice': { cat: 'bloatware', title: '📰 Windows Widgets Service', desc: 'Background Task របស់ Widgets (ឥតប្រយោជន៍)' },
        'gamebarpresencewriter': { cat: 'bloatware', title: '🎮 Xbox Game Bar', desc: 'ប្រព័ន្ធ Xbox Gaming Recording (ឥតប្រយោជន៍)' },
        'xboxgamebar': { cat: 'bloatware', title: '🎮 Xbox Game Bar Overlay', desc: 'ប្រព័ន្ធ Overlay ហ្គេមរបស់ Xbox (ឥតប្រយោជន៍)' },
        'xboxappservices': { cat: 'bloatware', title: '🎮 Xbox Services', desc: 'Background Task របស់ Xbox Live (ឥតប្រយោជន៍)' },
        'searchapp': { cat: 'bloatware', title: '🔍 Windows Search Bar', desc: 'ប្រអប់ស្វែងរក Windows Search លើ Taskbar (អាចបិទបាន)' },
        'searchindexer': { cat: 'safe', title: '🔍 Search Indexer', desc: 'ប្រព័ន្ធស្វែងរក Index ឯកសារក្នុង Windows' },
        'phoneexperiencehost': { cat: 'bloatware', title: '📱 Phone Link App', desc: 'ប្រព័ន្ធភ្ជាប់ Phone Link ជាមួយទូរស័ព្ទ (ឥតប្រយោជន៍)' },
        'yourphone': { cat: 'bloatware', title: '📱 Your Phone Companion', desc: 'Background Link របស់ទូរស័ព្ទ (ឥតប្រយោជន៍)' },
        'feedbackhub': { cat: 'bloatware', title: '💬 Feedback Hub', desc: 'ប្រព័ន្ធផ្ញើ Feedback ទៅ Microsoft (ឥតប្រយោជន៍)' },
        'video.ui': { cat: 'bloatware', title: '📺 Films & TV App', desc: 'កម្មវិធីមើលវីដេអូដើមរបស់ Windows (ឥតប្រយោជន៍)' },
        'zunemusic': { cat: 'bloatware', title: '🎵 Groove Music App', desc: 'កម្មវិធីចាក់ចម្រៀង Groove Music (ឥតប្រយោជន៍)' },
        'zunevideo': { cat: 'bloatware', title: '🎬 Movies & TV App', desc: 'កម្មវិធីមើល Movie របស់ Windows (ឥតប្រយោជន៍)' },

        // Windows System Processes (ប្រព័ន្ធ - កុំបិទ)
        'msmpeng': { cat: 'system', title: '🛡️ Microsoft Defender', desc: 'ប្រព័ន្ធការពារវីរុស Real-time Antivirus (កុំបិទ)' },
        'nissrv': { cat: 'system', title: '🛡️ Defender Network Inspection', desc: 'ប្រព័ន្ធការពារ Network Security របស់ Windows (កុំបិទ)' },
        'securityhealthservice': { cat: 'system', title: '🛡️ Windows Security Health', desc: 'ប្រព័ន្ធសុវត្ថិភាពទូទៅរបស់ Windows (កុំបិទ)' },
        'dwm': { cat: 'system', title: '🖼️ Desktop Window Manager', desc: 'គ្រប់គ្រង Graphics & អេក្រង់ Windows (កុំបិទដាច់ខាត)' },
        'svchost': { cat: 'system', title: '⚙️ Windows Service Host', desc: 'គ្រប់គ្រង Network, Audio, Bluetooth, USB (កុំបិទដាច់ខាត)' },
        'explorer': { cat: 'system', title: '📁 Windows File Explorer', desc: 'ផ្ទាំង Desktop, Folder & Taskbar របស់ Windows (កុំបិទ)' },
        'sihost': { cat: 'system', title: '⚙️ Shell Infrastructure Host', desc: 'ប្រព័ន្ធ Core Interface របស់ Windows (កុំបិទ)' },
        'shellexperiencehost': { cat: 'system', title: '🎨 Windows Start Menu', desc: 'ផ្ទាំង Start Menu & Visual Layout (កុំបិទ)' },
        'textinputhost': { cat: 'system', title: '⌨️ Touch Keyboard & Emoji', desc: 'ប្រព័ន្ធវាយអក្សរ Touch & Emoji Picker (កុំបិទ)' },
        'runtimebroker': { cat: 'system', title: '🔒 App Runtime Broker', desc: 'គ្រប់គ្រងសិទ្ធិ App Permissions របស់ Windows (កុំបិទ)' },
        'applicationframehost': { cat: 'system', title: '🔲 Universal App Host', desc: 'ប្រព័ន្ធគ្រប់គ្រង Windows Store Apps (កុំបិទ)' },
        'system': { cat: 'system', title: '🧠 Windows System Kernel', desc: 'ស្នូលប្រព័ន្ធប្រតិបត្តិការ Windows (កុំបិទដាច់ខាត)' },
        'system interrupts': { cat: 'system', title: '⚡ Hardware Interrupts', desc: 'ការទាក់ទង Hardware ជាមួយ CPU (កុំបិទដាច់ខាត)' },
        'memory compression': { cat: 'system', title: '🧠 Memory Compression', desc: 'ប្រព័ន្ធបង្រួម RAM ដើម្បីចំណេញទំហំ (កុំបិទ)' },
        'registry': { cat: 'system', title: '📋 Windows Registry', desc: 'ប្រព័ន្ធទិន្នន័យកំណត់តម្លៃរបស់ Windows (កុំបិទ)' },
        'lsass': { cat: 'system', title: '🔐 Local Security Authority', desc: 'ប្រព័ន្ធសុវត្ថិភាព Login & User Accounts (កុំបិទ)' },

        // General User Applications
        'chrome': { cat: 'safe', title: '🌐 Google Chrome Browser', desc: 'កម្មវិធីទុយោ Web Browser Google Chrome' },
        'msedge': { cat: 'safe', title: '🌐 Microsoft Edge Browser', desc: 'កម្មវិធី Web Browser Microsoft Edge' },
        'msedgewebview2': { cat: 'safe', title: '🌐 Edge WebView Render', desc: 'ប្រព័ន្ធបង្ហាញ Web Content ក្នុង App' },
        'taskmgr': { cat: 'safe', title: '📊 Task Manager', desc: 'កម្មវិធីគ្រប់គ្រង Task Manager របស់ Windows' },
        'idman': { cat: 'safe', title: '⬇️ Internet Download Manager', desc: 'កម្មវិធីទាញយកឯកសារ IDM' }
    };

    let activeFilter = 'all';

    // Helper to get process metadata
    function getProcessMeta(procName) {
        const key = procName.toLowerCase().trim();
        if (PROCESS_MAP[key]) return PROCESS_MAP[key];

        // System heuristics
        if (key.includes('system') || key.includes('winlogon') || key.includes('csrss')) {
            return { cat: 'system', title: `⚙️ ${procName}`, desc: 'ដំណើរការប្រព័ន្ធសុវត្ថិភាព Windows (កុំបិទ)' };
        }
        return { cat: 'safe', title: `⚙️ ${procName}`, desc: 'ដំណើរការ App ឬ Service ទូទៅក្នុងប្រព័ន្ធ' };
    }

    // Process Category Filter Buttons Event Handlers
    document.querySelectorAll('.proc-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.proc-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.getAttribute('data-filter');
            renderProcesses(processesData);
        });
    });

    // Load Processes for Task Manager Tab
    async function loadProcesses() {
        processesTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding:28px;color:var(--text-muted)"><i class="fa-solid fa-circle-notch fa-spin" style="margin-right:8px"></i>កំពុងទាញយក Processes...</td></tr>`;
        try {
            const res = await fetch('/api/processes');
            const data = await res.json();
            if (data.processes) {
                processesData = data.processes;
                renderProcesses(data.processes);
            }
        } catch (err) {
            processesTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color:var(--accent-rose)">❌ មានបញ្ហាក្នុងការទាញយក Processes</td></tr>`;
        }
    }

    function renderProcesses(processes) {
        const query = procSearchInput.value.toLowerCase().trim();

        // 1. Calculate counts for filter badges
        let countAll = processes.length;
        let countBloatware = 0;
        let countSafe = 0;
        let countSystem = 0;

        processes.forEach(p => {
            const meta = getProcessMeta(p.name);
            if (meta.cat === 'bloatware') countBloatware++;
            else if (meta.cat === 'system') countSystem++;
            else countSafe++;
        });

        // Update badge counts in filter buttons
        document.getElementById('count-all').textContent = countAll;
        document.getElementById('count-bloatware').textContent = countBloatware;
        document.getElementById('count-safe').textContent = countSafe;
        document.getElementById('count-system').textContent = countSystem;

        // 2. Filter processes by category and search query
        const filtered = processes.filter(p => {
            const meta = getProcessMeta(p.name);

            // Category filter
            if (activeFilter === 'bloatware' && meta.cat !== 'bloatware') return false;
            if (activeFilter === 'safe' && meta.cat !== 'safe') return false;
            if (activeFilter === 'system' && meta.cat !== 'system') return false;

            // Search query filter (search by name, title or description)
            if (query) {
                const matchName = p.name.toLowerCase().includes(query);
                const matchTitle = meta.title.toLowerCase().includes(query);
                const matchDesc = meta.desc.toLowerCase().includes(query);
                const matchPid = String(p.pid).includes(query);
                return matchName || matchTitle || matchDesc || matchPid;
            }

            return true;
        });

        // 3. Update End All Button label and state based on active filter tab
        if (activeFilter === 'system') {
            btnEndAll.disabled = true;
            endAllLabel.textContent = '🔒 មិនអនុញ្ញាត End All លើ System Tasks';
        } else {
            const killableItems = filtered.filter(p => getProcessMeta(p.name).cat !== 'system');
            if (killableItems.length === 0) {
                btnEndAll.disabled = true;
                endAllLabel.textContent = 'គ្មាន Task អាចបិទបានទេ';
            } else {
                btnEndAll.disabled = false;
                if (activeFilter === 'bloatware') {
                    endAllLabel.textContent = `🔴 បិទ Task ឥតប្រយោជន៍ទាំងអស់ (${killableItems.length})`;
                } else if (activeFilter === 'safe') {
                    endAllLabel.textContent = `🟢 បិទ Task អាចបិទបានទាំងអស់ (${killableItems.length})`;
                } else {
                    endAllLabel.textContent = `💥 បិទ Non-System Tasks ទាំងអស់ (${killableItems.length})`;
                }
            }
        }

        if (filtered.length === 0) {
            processesTbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding:28px;color:var(--text-sub)">គ្មាន Process ត្រូវនឹងការស្វែងរកឡើយ</td></tr>`;
            return;
        }

        processesTbody.innerHTML = filtered.map(p => {
            const meta = getProcessMeta(p.name);

            let badgeHtml = `<span class="proc-cat-badge badge-safe"><i class="fa-solid fa-circle-check"></i> អាចបិទបាន</span>`;
            if (meta.cat === 'bloatware') {
                badgeHtml = `<span class="proc-cat-badge badge-bloatware"><i class="fa-solid fa-ban"></i> ឥតប្រយោជន៍</span>`;
            } else if (meta.cat === 'system') {
                badgeHtml = `<span class="proc-cat-badge badge-system"><i class="fa-solid fa-shield-halved"></i> ប្រព័ន្ធ (កុំបិទ)</span>`;
            }

            const isSystem = meta.cat === 'system';
            const btnClass = isSystem ? 'btn-secondary' : 'btn-rose';
            const btnIcon = isSystem ? 'fa-shield-halved' : 'fa-xmark';
            const btnLabel = isSystem ? 'បិទ (ប្រយ័ត្ន)' : 'End Task';

            return `
                <tr>
                    <td><code>${p.pid}</code></td>
                    <td>
                        <div class="proc-info-cell">
                            <div class="proc-name-title">
                                <span>${p.name}</span>
                                <small style="color:var(--accent-cyan);font-weight:normal;">[${meta.title}]</small>
                            </div>
                            <span class="proc-role-desc">👉 ${meta.desc}</span>
                        </div>
                    </td>
                    <td>${badgeHtml}</td>
                    <td><span class="color-cyan"><strong>${p.ramMB} MB</strong></span></td>
                    <td class="text-sub" style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${p.path || 'System Process'}">${p.path || 'System Process'}</td>
                    <td>
                        <button class="btn ${btnClass} btn-end-proc" data-pid="${p.pid}" data-name="${p.name}" data-cat="${meta.cat}">
                            <i class="fa-solid ${btnIcon}"></i> ${btnLabel}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        document.querySelectorAll('.btn-end-proc').forEach(btn => {
            btn.addEventListener('click', () => {
                const pid = btn.getAttribute('data-pid');
                const name = btn.getAttribute('data-name');
                const cat = btn.getAttribute('data-cat');

                pendingEndTask = { pid, name };
                pendingTransfer = null;

                const meta = getProcessMeta(name);

                if (cat === 'system') {
                    modalTitle.innerHTML = `<span style="color:var(--accent-amber)"><i class="fa-solid fa-triangle-exclamation"></i> ប្រយ័ត្ន! បិទ System Task "${name}"</span>`;
                    modalDesc.innerHTML = `
                        Process <strong>${name}</strong> គឺជា <strong>${meta.title}</strong><br>
                        <small style="color:var(--text-sub)">${meta.desc}</small><br><br>
                        <div style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);padding:10px;border-radius:8px;color:#fcd34d;font-size:13px;text-align:left;">
                            ⚠️ <strong>ការព្រមាន៖</strong> ការបិទ System Process អាចបណ្ដាលឲ្យ Windows គាំង, អេក្រង់ខ្មៅ, ឬ Antigravity IDE ឈប់ដំណើរការ!
                        </div>
                    `;
                    modalConfirmBtn.className = 'btn btn-rose';
                    modalConfirmBtn.textContent = 'ខ្ញុំយល់ព្រមបិទ (Force Kill)';
                } else {
                    modalTitle.textContent = `បញ្ជាក់ការបិទ Task "${name}"`;
                    modalDesc.innerHTML = `
                        តើអ្នកពិតជាចង់បិទ Process <strong>${name}</strong> (PID: ${pid}) មែនទេ?<br>
                        <small style="color:var(--accent-cyan)">👉 ${meta.desc}</small>
                    `;
                    modalConfirmBtn.className = 'btn btn-rose';
                    modalConfirmBtn.textContent = 'បិទ Task (Kill)';
                }

                confirmModalOverlay.classList.remove('hidden');
            });
        });
    }



    // End All Button Click Handler
    btnEndAll.addEventListener('click', () => {
        if (activeFilter === 'system') return;

        // Get all filtered killable items (exclude system processes for safety)
        const currentFiltered = processesData.filter(p => {
            const meta = getProcessMeta(p.name);
            if (activeFilter === 'bloatware') return meta.cat === 'bloatware';
            if (activeFilter === 'safe') return meta.cat === 'safe';
            return meta.cat !== 'system'; // 'all' filter: kill non-system tasks
        });

        if (currentFiltered.length === 0) {
            showToast('គ្មាន Task អាចបិទបានក្នុង Filter នេះទេ', 'info');
            return;
        }

        const totalRAM = currentFiltered.reduce((sum, p) => sum + p.ramMB, 0).toFixed(1);
        let filterName = 'ទាំងអស់';
        if (activeFilter === 'bloatware') filterName = 'Task ឥតប្រយោជន៍';
        if (activeFilter === 'safe') filterName = 'Task អាចបិទបាន';

        pendingEndAll = { filterName, items: currentFiltered };
        pendingEndTask = null;
        pendingTransfer = null;

        modalTitle.innerHTML = `<span style="color:var(--accent-rose)"><i class="fa-solid fa-dumpster-fire"></i> បញ្ជាក់ការបិទ ${currentFiltered.length} Tasks (${filterName})</span>`;
        modalDesc.innerHTML = `
            តើអ្នកពិតជាចង់បិទ <strong>${currentFiltered.length} Tasks</strong> ទាំងអស់ក្នុង Filter "${filterName}" មែនទេ?<br>
            <strong style="color:var(--accent-cyan)">+${totalRAM} MB RAM នឹងត្រូវទាញយកមកវិញ!</strong><br><br>
            <div style="max-height:120px;overflow-y:auto;background:rgba(0,0,0,0.3);padding:10px;border-radius:8px;font-size:12px;text-align:left;">
                ${currentFiltered.map(p => `<span class="closed-app-tag" style="margin:2px;display:inline-block;"><i class="fa-solid fa-xmark color-red"></i> ${p.name} (PID: ${p.pid})</span>`).join('')}
            </div>
        `;
        modalConfirmBtn.className = 'btn btn-rose';
        modalConfirmBtn.textContent = `យល់ព្រមបិទទាំង ${currentFiltered.length} Tasks`;

        confirmModalOverlay.classList.remove('hidden');
    });

    procSearchInput.addEventListener('input', () => renderProcesses(processesData));

    refreshAllBtn.addEventListener('click', async () => {
        // FIX: await drives first — drivesData must be populated before folder dropdowns render
        await loadDrives();
        await loadUserFolders();
        scanTemp();
        if (currentTab === 'processes-tab') {
            loadProcesses();
        }
        showToast('🔄 បានធ្វើបច្ចុប្បន្នភាពទិន្នន័យ!', 'info');
    });


    // Non-blocking Parallel Initial Load (Instant UI rendering)
    function init() {
        // Load drives immediately; load folders once drivesData is ready
        loadDrives().then(() => {
            loadUserFolders();
            loadSelectedSourceDrives();
        });
        scanTemp();
    }

    init();
});

