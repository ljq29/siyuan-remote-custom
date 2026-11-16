export const REMOTE_SAMPLE_INTERVAL = 5000;
export const REMOTE_HISTORY_WINDOW = 10 * 60 * 1000;
const MAX_SAMPLES = REMOTE_HISTORY_WINDOW / REMOTE_SAMPLE_INTERVAL;

// 与主进程 siyuan-get-remote-status 的返回结构对应。
export interface IRemoteStatus {
    mode: string;
    origin: string;
    title: string;
    statusIndicator: boolean;
    ssh: {
        failed: boolean;
        alive: boolean;
        server: string;
        client?: string;
        target: string;
        forwardPort: number;
        bridgePort?: number;
        latencyMs: number;
    } | null;
    httpProxy: {
        port: number;
        sites: {
            hostname: string;
            host: string;
            port: number;
            tls: boolean;
            insecure: boolean;
            listenPort: number;
        }[];
    } | null;
    webviewSites: {name: string; url: string; icon?: string}[];
    sshServer: {
        username: string;
        listenPort: number;
        remoteHost: string;
        remotePort: number;
        listening: boolean;
        localPort: number;
    } | null;
}

export interface ILatencySample {
    time: number;
    pingMs: number;
    // null 表示未配置 SSH，-1 表示探测失败。
    sshMs: number | null;
}

export interface IRemoteSnapshot {
    status: IRemoteStatus | null;
    samples: readonly ILatencySample[];
}

const isValidLatency = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0;

export const shouldMonitorRemoteStatus = (status: IRemoteStatus | null) =>
    !status || (status.mode === "remote" && status.statusIndicator !== false);

export const probeKernelLatency = async (
    fetcher: typeof fetch = fetch,
    now = () => performance.now(),
    timeout = REMOTE_SAMPLE_INTERVAL,
) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = now();
    try {
        const response = await fetcher("/api/system/version", {cache: "no-store", signal: controller.signal});
        if (!response.ok || response.redirected) {
            await response.body?.cancel();
            return -1;
        }
        const result = await response.json();
        if (result.code !== 0 || typeof result.data !== "string") {
            return -1;
        }
        return Math.max(0, Math.round(now() - started));
    } catch (error) {
        return -1;
    } finally {
        clearTimeout(timer);
    }
};

// 同一窗口的面板和底栏共用采样与历史；最后一个订阅取消后停止轮询，保留有界历史供重开使用。
export class RemoteStatusMonitor {
    private status: IRemoteStatus | null = null;
    private samples: ILatencySample[] = [];
    private origin: string;
    private sshConfigured = false;
    private listeners = new Set<(snapshot: IRemoteSnapshot) => void>();
    private timer: ReturnType<typeof setTimeout>;
    private startedAt: number;
    private pending: Promise<IRemoteSnapshot>;

    constructor(
        private readStatus: () => Promise<IRemoteStatus | null>,
        private fetcher: typeof fetch = fetch,
        private now = Date.now,
    ) {}

    public getSnapshot(): IRemoteSnapshot {
        const cutoff = this.now() - REMOTE_HISTORY_WINDOW;
        this.samples = this.samples.filter(sample => sample.time >= cutoff).slice(-MAX_SAMPLES);
        return {status: this.status, samples: this.samples.slice()};
    }

    public subscribe(listener: (snapshot: IRemoteSnapshot) => void) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        void this.refresh();
        this.schedule();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                clearTimeout(this.timer);
                this.timer = undefined;
            }
        };
    }

    public refresh(force = false): Promise<IRemoteSnapshot> {
        if (this.pending) {
            return this.pending;
        }
        const latest = this.samples[this.samples.length - 1];
        if (!force && latest && this.now() - latest.time < REMOTE_SAMPLE_INTERVAL) {
            return Promise.resolve(this.getSnapshot());
        }
        const startedAt = this.now();
        this.startedAt = startedAt;
        this.pending = Promise.all([this.probeStatus(), probeKernelLatency(this.fetcher)]).then(([status, pingMs]) => {
            if (status) {
                if (this.origin !== status.origin) {
                    this.samples = [];
                }
                this.origin = status.origin;
                this.sshConfigured = Boolean(status.ssh);
            }
            this.status = status;
            this.samples.push({
                time: startedAt,
                pingMs,
                sshMs: status?.ssh ? (status.ssh.alive && !status.ssh.failed ? status.ssh.latencyMs : -1) :
                    this.sshConfigured ? -1 : null,
            });
            const snapshot = this.getSnapshot();
            this.listeners.forEach(listener => {
                try {
                    listener(snapshot);
                } catch (error) {
                    console.error("Remote status listener failed", error);
                }
            });
            return snapshot;
        }).finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }

    private schedule() {
        if (this.timer || this.listeners.size === 0) {
            return;
        }
        const delay = Math.max(0, (this.startedAt ?? this.now()) + REMOTE_SAMPLE_INTERVAL - this.now());
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh().finally(() => this.schedule());
        }, delay);
    }

    private async probeStatus(): Promise<IRemoteStatus | null> {
        let timer: ReturnType<typeof setTimeout>;
        try {
            return await Promise.race([
                this.readStatus(),
                new Promise<null>(resolve => {
                    timer = setTimeout(() => resolve(null), REMOTE_SAMPLE_INTERVAL + 1000);
                }),
            ]);
        } catch (error) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
}

export const getLatencySegments = (samples: readonly ILatencySample[], key: "pingMs" | "sshMs") => {
    const segments: {time: number; value: number}[][] = [];
    let segment: {time: number; value: number}[] = [];
    samples.forEach(sample => {
        const value = sample[key];
        if (!isValidLatency(value)) {
            segment = [];
            return;
        }
        if (segment.length && sample.time - segment[segment.length - 1].time > REMOTE_SAMPLE_INTERVAL * 2) {
            segment = [];
        }
        if (!segment.length) {
            segments.push(segment);
        }
        segment.push({time: sample.time, value});
    });
    return segments;
};

export const getLatencySummary = (values: (number | null)[]) => {
    const configured = values.filter(value => value !== null);
    const valid = configured.filter(isValidLatency);
    return {
        average: valid.length ? Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null,
        maximum: valid.length ? Math.max(...valid) : null,
        failureRate: configured.length ? Math.round((configured.length - valid.length) * 100 / configured.length) : null,
    };
};
