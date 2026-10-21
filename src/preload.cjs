const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
    loadDb: invoke('db:load'),
    rev: invoke('db:rev'),
    authHas: invoke('auth:has'),
    authVerify: invoke('auth:verify'),
    authSet: invoke('auth:set'),
    webStatus: invoke('web:status'),
    webSet: invoke('web:set'),
    saveMonth: invoke('db:saveMonth'),
    saveClosedMonth: invoke('db:saveClosedMonth'),
    closeMonth: invoke('db:closeMonth'),
    saveSettings: invoke('db:saveSettings'),
    applyTagsEverywhere: invoke('db:apply-tags'),
    importsApply: invoke('db:imports-apply'),
    simplefinStatus: invoke('db:simplefin-status'),
    simplefinSetup: invoke('db:simplefin-setup'),
    simplefinSync: invoke('db:simplefin-sync'),
    simplefinDisconnect: invoke('db:simplefin-disconnect'),
    listBackups: invoke('backups:list'),
    restoreBackup: invoke('backups:restore'),
    openBackupsFolder: invoke('backups:open-folder'),
    exportDb: invoke('db:export'),
    changeDbLocation: invoke('db:change-location'),
    migrateScan: invoke('db:migrate-scan'),
    migrateLegacy: invoke('db:migrate-legacy'),
    checkUpdate: invoke('update:check'),
    openReleases: invoke('update:open'),
    openSimplefinSite: invoke('sf:open-site'),
    remoteStatus: invoke('remote:status'),
    remoteLogin: invoke('remote:login'),
    remoteLogout: invoke('remote:logout'),
    remoteConnect: invoke('remote:connect'),
    remoteDisconnect: invoke('remote:disconnect'),
});

// Remote mode changes what the renderer shows (offline handling on, local-file
// features off) - read synchronously so the flag exists before any script runs.
contextBridge.exposeInMainWorld('IS_REMOTE', ipcRenderer.sendSync('remote:mode-sync') === true);

// The desktop binary's own version. Absent in web clients, where the window's
// code and the serving process are the same thing and loadDb's version covers both.
contextBridge.exposeInMainWorld('APP_VERSION', ipcRenderer.sendSync('app:version-sync') || '');
