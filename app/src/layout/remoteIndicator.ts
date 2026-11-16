import {remoteStatusMonitor} from "./remoteStatusMonitor";
import {shouldMonitorRemoteStatus, type IRemoteStatus, type IRemoteSnapshot} from "./remoteLatency";

// 延迟分档阈值与 dock 远程状态面板一致：<100ms 正常，100-500ms 偏高，>500ms 或超时（-1）异常
const latencyClass = (ms: number) => {
    if (ms < 0 || ms > 500) {
        return "remote-status__latency--bad";
    }
    if (ms > 100) {
        return "remote-status__latency--warn";
    }
    return "remote-status__latency--good";
};
const latencyText = (ms: number) => ms < 0 ? "超时" : ms + " ms";

// 底栏与面板共用采样；本地模式或 statusIndicator:false 时不订阅持续轮询。
export const initRemoteStatusIndicator = () => {
    /// #if !BROWSER
    const element = document.getElementById("statusRemote") as HTMLElement;
    if (!element) {
        return;
    }
    const latencySpan = (label: string, ms: number) =>
        `${label} <span class="remote-status__latency ${latencyClass(ms)}">${latencyText(ms)}</span>`;
    const updateBadge = (status: IRemoteStatus, kernelPing: number) => {
        // dock 左下「远程状态」图标右上角叠延迟角标，取内核 Ping 与 SSH 延迟中较差的一档
        const dockItem = document.querySelector(".dock__item[data-type=\"remoteStatus\"]");
        if (!dockItem) {
            return;
        }
        let dot = dockItem.querySelector(".remote-status__dot");
        if (!dot) {
            dot = document.createElement("span");
            dockItem.appendChild(dot);
        }
        const sshLatency = status.ssh && (status.ssh.failed || !status.ssh.alive ? -1 : status.ssh.latencyMs);
        const worst = kernelPing < 0 || (status.ssh && sshLatency < 0) ? -1 :
            status.ssh ? Math.max(kernelPing, sshLatency) : kernelPing;
        dot.className = "remote-status__dot remote-status__dot--" +
            (worst < 0 || worst > 500 ? "bad" : worst > 100 ? "warn" : "good");
    };
    let unsubscribe: () => void;
    const update = ({status, samples}: IRemoteSnapshot) => {
        if (!status || status.mode !== "remote" || status.statusIndicator === false) {
            element.classList.add("fn__none");
            if (!shouldMonitorRemoteStatus(status)) {
                unsubscribe?.();
            }
            return;
        }
        const kernelPing = samples[samples.length - 1]?.pingMs ?? -1;
        const parts = [latencySpan("Ping", kernelPing)];
        if (status.ssh) {
            parts.push(latencySpan("SSH", status.ssh.failed || !status.ssh.alive ? -1 : status.ssh.latencyMs));
        }
        element.innerHTML = parts.join("<span class=\"remote-status__sep\">·</span>");
        element.classList.remove("fn__none");
        updateBadge(status, kernelPing);
    };
    element.addEventListener("click", () => {
        (document.querySelector(".dock__item[data-type=\"remoteStatus\"]") as HTMLElement)?.click();
    });
    remoteStatusMonitor.refresh().then(({status}) => {
        if (shouldMonitorRemoteStatus(status)) {
            unsubscribe = remoteStatusMonitor.subscribe(update);
        }
    });
    /// #endif
};
