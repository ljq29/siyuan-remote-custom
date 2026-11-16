import {escapeHtml} from "../../util/escape";
import {getLatencySegments, getLatencySummary, REMOTE_HISTORY_WINDOW, type ILatencySample} from "../remoteLatency";

export interface ILatencyLabels {
    title: string;
    range: string;
    ping: string;
    ssh: string;
    failed: string;
    empty: string;
    average: string;
    maximum: string;
    failureRate: string;
}

// 轻量 Canvas 曲线，保留 DOM 节点以支持侧栏缩放、主题切换和鼠标查看历史值。
export class RemoteLatencyChart {
    private canvas: HTMLCanvasElement;
    private readout: HTMLElement;
    private summary: HTMLElement;
    private resizeObserver: ResizeObserver;
    private themeObserver: MutationObserver;
    private samples: readonly ILatencySample[] = [];
    private hasSSH = false;
    private start = 0;
    private end = 0;

    constructor(private element: HTMLElement, private labels: ILatencyLabels) {
        element.classList.add("remote-status__section", "remote-status__trend");
        element.innerHTML = `<div class="remote-status__section-title">${escapeHtml(labels.title)}</div>
<div class="remote-status__flags">${escapeHtml(labels.range)}</div>
<div class="remote-status__legend">
    <span class="remote-status__series--ping">${escapeHtml(labels.ping)}</span>
    <span class="remote-status__series--ssh">${escapeHtml(labels.ssh)}</span>
</div>
<canvas class="remote-status__chart" role="img" aria-label="${escapeHtml(labels.title)}"></canvas>
<div class="remote-status__readout"></div>
<div class="remote-status__summary"></div>`;
        this.canvas = element.querySelector("canvas");
        this.readout = element.querySelector(".remote-status__readout");
        this.summary = element.querySelector(".remote-status__summary");
        this.canvas.addEventListener("mousemove", event => {
            const width = this.canvas.getBoundingClientRect().width;
            const time = this.start + Math.max(0, Math.min(1, (event.offsetX - 42) / (width - 50))) * (this.end - this.start);
            const closest = this.samples.reduce<ILatencySample>((selected, sample) =>
                !selected || Math.abs(sample.time - time) < Math.abs(selected.time - time) ? sample : selected, null);
            this.showSample(closest);
        });
        this.canvas.addEventListener("mouseleave", () => this.showSample(this.samples[this.samples.length - 1]));
        this.resizeObserver = new ResizeObserver(() => this.draw());
        this.resizeObserver.observe(element);
        this.themeObserver = new MutationObserver(() => this.draw());
        this.themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme-mode", "style"]});
        this.themeObserver.observe(document.body, {attributes: true, attributeFilter: ["class", "style"]});
        this.update([], false);
    }

    public update(samples: readonly ILatencySample[], hasSSH: boolean) {
        this.samples = samples;
        this.hasSSH = hasSSH;
        this.element.querySelector(".remote-status__series--ssh").classList.toggle("fn__none", !hasSSH);
        this.showSample(samples[samples.length - 1]);
        const ping = getLatencySummary(samples.map(sample => sample.pingMs));
        const ssh = getLatencySummary(samples.map(sample => sample.sshMs));
        const format = (value: number | null, unit: string) => value === null ? "—" : value + unit;
        this.summary.innerHTML = `<table><thead><tr><th></th><th>Ping</th>${hasSSH ? "<th>SSH</th>" : ""}</tr></thead><tbody>${[
            [this.labels.average, format(ping.average, " ms"), format(ssh.average, " ms")],
            [this.labels.maximum, format(ping.maximum, " ms"), format(ssh.maximum, " ms")],
            [this.labels.failureRate, format(ping.failureRate, "%"), format(ssh.failureRate, "%")],
        ].map(([label, pingValue, sshValue]) => `<tr><th>${escapeHtml(label)}</th><td>${pingValue}</td>${hasSSH ? `<td>${sshValue}</td>` : ""}</tr>`).join("")}</tbody></table>`;
        this.draw();
    }

    public destroy() {
        this.resizeObserver.disconnect();
        this.themeObserver.disconnect();
    }

    private showSample(sample: ILatencySample) {
        const latency = (value: number | null) => value === null ? "—" :
            !Number.isFinite(value) || value < 0 ? this.labels.failed : `${value} ms`;
        this.readout.textContent = sample ?
            `${new Date(sample.time).toLocaleTimeString()} · Ping ${latency(sample.pingMs)}` +
            (this.hasSSH ? ` · SSH ${latency(sample.sshMs)}` : "") : this.labels.empty;
        this.canvas.setAttribute("aria-label", `${this.labels.title}. ${this.readout.textContent}`);
    }

    private draw() {
        const width = this.canvas.getBoundingClientRect().width;
        if (width < 60) {
            return;
        }
        const height = 160;
        const ratio = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(width * ratio);
        this.canvas.height = Math.round(height * ratio);
        const ctx = this.canvas.getContext("2d");
        if (!ctx) {
            return;
        }
        ctx.scale(ratio, ratio);
        const style = getComputedStyle(this.element);
        const color = (name: string) => style.getPropertyValue(name).trim();
        const left = 42;
        const right = width - 8;
        const top = 16;
        const bottom = height - 24;
        const values = this.samples.flatMap(sample => [sample.pingMs, sample.sshMs])
            .filter(value => value !== null && Number.isFinite(value) && value >= 0);
        const maximum = Math.max(100, ...values);
        const step = Math.pow(10, Math.floor(Math.log10(maximum)));
        const ceiling = Math.ceil(maximum / step) * step;
        this.end = Math.max(Date.now(), this.samples[this.samples.length - 1]?.time || 0);
        this.start = this.end - REMOTE_HISTORY_WINDOW;
        const x = (time: number) => left + (time - this.start) / REMOTE_HISTORY_WINDOW * (right - left);
        const y = (value: number) => bottom - value / ceiling * (bottom - top);
        ctx.font = "10px sans-serif";
        ctx.lineWidth = 1;
        ctx.fillStyle = color("--b3-theme-on-surface-light");
        ctx.fillText("ms", 0, 10);
        for (let i = 0; i <= 2; i++) {
            const value = ceiling * i / 2;
            ctx.strokeStyle = color("--b3-border-color");
            ctx.beginPath();
            ctx.moveTo(left, y(value));
            ctx.lineTo(right, y(value));
            ctx.stroke();
            ctx.textAlign = "right";
            ctx.fillText(String(value), left - 5, y(value) + 3);
        }
        for (let i = 0; i <= 2; i++) {
            const time = this.start + REMOTE_HISTORY_WINDOW * i / 2;
            ctx.textAlign = i === 0 ? "left" : i === 2 ? "right" : "center";
            ctx.fillText(new Date(time).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}), x(time), height - 5);
        }
        const series: {key: "pingMs" | "sshMs"; color: string}[] = [
            {key: "pingMs", color: color("--b3-theme-primary")},
        ];
        if (this.hasSSH) {
            series.push({key: "sshMs", color: color("--b3-card-warning-color")});
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(left - 3, top - 3, right - left + 6, bottom - top + 6);
        ctx.clip();
        series.forEach(({key, color: seriesColor}) => {
            ctx.strokeStyle = seriesColor;
            ctx.fillStyle = seriesColor;
            ctx.lineWidth = 1.5;
            getLatencySegments(this.samples, key).forEach(segment => {
                ctx.beginPath();
                segment.forEach((point, index) => {
                    if (index === 0) {
                        ctx.moveTo(x(point.time), y(point.value));
                    } else {
                        ctx.lineTo(x(point.time), y(point.value));
                    }
                });
                ctx.stroke();
                if (segment.length === 1) {
                    ctx.beginPath();
                    ctx.arc(x(segment[0].time), y(segment[0].value), 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            });
            // 失败样本在图底标记，避免将超时误读成零延迟。
            this.samples.filter(sample => sample[key] !== null &&
                (!Number.isFinite(sample[key]) || sample[key] < 0)).forEach(sample => {
                ctx.strokeStyle = color("--b3-card-error-color");
                ctx.beginPath();
                const pointX = x(sample.time);
                const pointY = bottom - (key === "sshMs" ? 9 : 3);
                ctx.moveTo(pointX - 2, pointY - 2);
                ctx.lineTo(pointX + 2, pointY + 2);
                ctx.moveTo(pointX + 2, pointY - 2);
                ctx.lineTo(pointX - 2, pointY + 2);
                ctx.stroke();
            });
        });
        ctx.restore();
    }
}
