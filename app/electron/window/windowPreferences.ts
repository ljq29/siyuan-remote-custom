// 主窗口与独立文档窗口共用的 webPreferences。远程窗口仅放行 remote.json 白名单站点的 webview。
import type {Session, WebPreferences} from "electron";
import type {KernelTarget} from "../shared/types";

// 远程内核使用独立的会话分区，本机内核沿用默认会话。
const kernelWindowPreferences = (kernelTarget: KernelTarget,
    getRemoteSession: (target: KernelTarget) => Session): WebPreferences => {
    const remote = kernelTarget.mode === "remote";
    return {
        nodeIntegration: true,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: true,
        webSecurity: remote,
        ...(remote ? {session: getRemoteSession(kernelTarget)} : {}),
        contextIsolation: false,
        // 桌面端禁止自动播放多媒体 https://github.com/siyuan-note/siyuan/issues/7587
        autoplayPolicy: "user-gesture-required",
    };
};

export {kernelWindowPreferences};
