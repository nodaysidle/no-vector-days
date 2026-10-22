// Exposes native Open/Save to the editor. Paths are only ever chosen in main-process dialogs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vectorstudio', {
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (text, filePath) => ipcRenderer.invoke('file:save', text, filePath)
});
