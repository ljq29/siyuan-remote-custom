import {Tab} from "../Tab";
import {Model} from "../Model";
import type {App} from "../../index";
import type {IRemoteStatus} from "../remoteLatency";
import {remoteStatusMonitor} from "../remoteStatusMonitor";
import {RemoteLatencyChart} from "./remoteLatencyChart";

const escapeHTML = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 延迟分档：<100ms 正常，100-500ms 偏高，>500ms 或超时（-1）异常
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

export class RemoteStatus extends Model {
    private element: Element;
    private contentElement: HTMLElement;
    private unsubscribe: () => void;
    private chart: RemoteLatencyChart;

    constructor(app: App, tab: Tab) {
        super({app});
        this.element = tab.panelElement;
        this.element.classList.add("fn__flex-column", "file-tree", "sy__remoteStatus", "dockPanel");
        this.element.innerHTML = `<div class="block__icons">
    <div class="block__logo fn__flex-1">远程状态</div>
    <span data-type="refresh" class="block__icon ariaLabel" data-position="north" aria-label="${window.siyuan.languages.refresh}"><svg><use xlink:href="#iconRefresh"></use></svg></span>
</div>
<div class="fn__flex-1 remote-status__content">
    <div class="remote-status__chart-container"></div>
    <div class="remote-status__details"></div>
</div>`;
        this.contentElement = this.element.querySelector(".remote-status__details");
        this.element.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).closest('[data-type="refresh"]')) {
                /// #if !BROWSER
                void remoteStatusMonitor.refresh(true);
                /// #endif
            }
        });
        /// #if !BROWSER
        this.chart = new RemoteLatencyChart(this.element.querySelector(".remote-status__chart-container"),
            window.siyuan.languages.remoteLatency);
        this.unsubscribe = remoteStatusMonitor.subscribe(({status, samples}) => {
            this.chart.update(samples, Boolean(status?.ssh) || samples.some(sample => sample.sshMs !== null));
            this.render(status, samples[samples.length - 1]?.pingMs ?? -1);
        });
        /// #else
        this.render(null, -1);
        /// #endif
    }

    public destroy() {
        this.unsubscribe?.();
        this.chart?.destroy();
    }

    private render(status: IRemoteStatus, kernelPing: number) {
        if (!status) {
            this.contentElement.innerHTML = "<div class=\"remote-status__empty\">状态不可用（仅桌面端支持）</div>";
            return;
        }
        const rows = (items: string[]) => items.filter(Boolean).join("");
        const row = (label: string, value: string) =>
            `<div class="remote-status__row"><span class="remote-status__label">${label}</span><span class="remote-status__value">${value}</span></div>`;
        const latencyRow = (label: string, ms: number) => row(label,
            `<span class="remote-status__latency ${latencyClass(ms)}">${latencyText(ms)}</span>`);
        let html = `<div class="remote-status__section">
    <div class="remote-status__section-title">内核</div>
    ${rows([
            row("模式", status.mode === "remote" ? "远程" : "本地"),
            status.title ? row("标题", escapeHTML(status.title)) : "",
            row("地址", escapeHTML(status.origin || "-")),
            latencyRow("Ping", kernelPing),
        ])}
</div>`;
        if (status.ssh) {
            const sshState = status.ssh.failed ? '<span class="remote-status__latency remote-status__latency--bad">建连失败</span>' :
                status.ssh.alive ? '<span class="remote-status__latency remote-status__latency--good">已连接</span>' :
                    '<span class="remote-status__latency remote-status__latency--bad">已断开</span>';
            html += `<div class="remote-status__section">
    <div class="remote-status__section-title">SSH 隧道</div>
    ${rows([
                row("状态", sshState),
                status.ssh.client ? row("客户端", escapeHTML(status.ssh.client)) : "",
                row("服务器", escapeHTML(status.ssh.server)),
                row("目标", escapeHTML(status.ssh.target)),
                row("本地端口", "127.0.0.1:" + status.ssh.forwardPort),
                status.ssh.client === "openssh" && status.ssh.bridgePort ?
                    row("桥接端口", "127.0.0.1:" + status.ssh.bridgePort + "（至远端 sshd）") : "",
                latencyRow("延迟", status.ssh.latencyMs),
            ])}
</div>`;
        }
        if (status.httpProxy) {
            const siteRows = status.httpProxy.sites.map((site) => {
                const flags = [site.tls ? "tls" : "", site.insecure ? "insecure" : "",
                    site.listenPort ? "端口 " + site.listenPort : ""].filter(Boolean).join(" · ");
                return row(escapeHTML(site.hostname),
                    escapeHTML(site.host + ":" + site.port) + (flags ? ` <span class="remote-status__flags">${escapeHTML(flags)}</span>` : ""));
            }).join("");
            html += `<div class="remote-status__section">
    <div class="remote-status__section-title">UI 内代理</div>
    ${rows([
                status.httpProxy.port > 0 ? row("正向代理", "127.0.0.1:" + status.httpProxy.port) : row("正向代理", "未启用"),
            ])}
    ${siteRows || '<div class="remote-status__empty">无站点规则</div>'}
</div>`;
        }
        const portProxyRows: string[] = [];
        status.webviewSites.forEach((site) => {
            portProxyRows.push(row(escapeHTML(site.name), escapeHTML(site.url)));
        });
        if (status.httpProxy) {
            status.httpProxy.sites.filter((site) => site.listenPort > 0).forEach((site) => {
                portProxyRows.push(row(escapeHTML(site.hostname), "http://127.0.0.1:" + site.listenPort));
            });
        }
        if (status.sshServer) {
            const sshServerState = status.sshServer.listening ?
                '<span class="remote-status__latency remote-status__latency--good">监听中</span>' :
                '<span class="remote-status__latency remote-status__latency--bad">未监听</span>';
            portProxyRows.push(row("SSH Server",
                `${escapeHTML(status.sshServer.remoteHost + ":" + status.sshServer.remotePort)} → 127.0.0.1:${status.sshServer.localPort || status.sshServer.listenPort} ${sshServerState}`));
        }
        if (portProxyRows.length > 0) {
            html += `<div class="remote-status__section">
    <div class="remote-status__section-title">端口代理</div>
    ${portProxyRows.join("")}
</div>`;
        }
        this.contentElement.innerHTML = html;
    }
}
