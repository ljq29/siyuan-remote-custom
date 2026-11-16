/// #if !BROWSER
import {ipcRenderer} from "electron";
/// #endif
import {RemoteStatusMonitor} from "./remoteLatency";

export const remoteStatusMonitor = new RemoteStatusMonitor(async () => {
    /// #if !BROWSER
    return ipcRenderer.invoke("siyuan-get-remote-status");
    /// #else
    return null;
    /// #endif
});
