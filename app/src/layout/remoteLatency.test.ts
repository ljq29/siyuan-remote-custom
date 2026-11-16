import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {
    getLatencySegments,
    getLatencySummary,
    probeKernelLatency,
    RemoteStatusMonitor,
    shouldMonitorRemoteStatus,
    type IRemoteStatus,
} from "./remoteLatency";

const status = (ssh = true): IRemoteStatus => ({
    mode: "remote", origin: "https://kernel.example", title: "", statusIndicator: true,
    ssh: ssh ? {
        failed: false, alive: true, server: "jump", target: "kernel:443", forwardPort: 6806, latencyMs: 40,
    } : null,
    httpProxy: null, webviewSites: [], sshServer: null,
});
const version = async () => new Response(JSON.stringify({code: 0, data: "3.8.3"}));

// 项目沿用 Node 18 类型，运行测试的 Node 22 支持可控定时器。
interface ITimerTestContext {
    mock: {timers: {
        enable(options: {apis: string[]}): void;
        tick(ms: number): void;
    }};
}

describe("remote latency history", () => {
    it("schedules from the previous sample despite timer jitter", async (context) => {
        const timers = (context as unknown as ITimerTestContext).mock.timers;
        timers.enable({apis: ["setTimeout", "setInterval"]});
        let time = 0;
        const monitor = new RemoteStatusMonitor(async () => status(), version, () => time);
        const stop = monitor.subscribe(() => {});
        await monitor.refresh();
        for (const [next, elapsed] of [[5001, 5001], [10000, 4999], [10001, 1]]) {
            time = next;
            timers.tick(elapsed);
            await new Promise(resolve => setImmediate(resolve));
        }
        stop();
        assert.deepEqual(monitor.getSnapshot().samples.map(sample => sample.time), [0, 5001, 10001]);
    });

    it("resumes immediately after a slow IPC timeout without overlapping probes", async (context) => {
        const timers = (context as unknown as ITimerTestContext).mock.timers;
        timers.enable({apis: ["setTimeout", "setInterval"]});
        let time = 0;
        let calls = 0;
        const monitor = new RemoteStatusMonitor(() => {
            calls++;
            return calls === 1 ? new Promise(() => {}) : Promise.resolve(status());
        }, version, () => time);
        const stop = monitor.subscribe(() => {});
        await new Promise(resolve => setImmediate(resolve));
        time = 5000;
        timers.tick(5000);
        assert.equal(calls, 1);
        time = 6000;
        timers.tick(1000);
        await new Promise(resolve => setImmediate(resolve));
        timers.tick(0);
        await new Promise(resolve => setImmediate(resolve));
        stop();
        assert.equal(monitor.getSnapshot().status?.ssh.alive, true);
        assert.equal(calls, 2);
    });

    it("retries unknown status but stops the indicator for explicitly disabled or local status", () => {
        assert.equal(shouldMonitorRemoteStatus(null), true);
        assert.equal(shouldMonitorRemoteStatus(status()), true);
        assert.equal(shouldMonitorRemoteStatus({...status(), mode: "local"}), false);
        assert.equal(shouldMonitorRemoteStatus({...status(), statusIndicator: false}), false);
    });

    it("shares an in-flight sample and caches it for panel and indicator subscribers", async () => {
        let reads = 0;
        const monitor = new RemoteStatusMonitor(async () => {
            reads++;
            return status();
        }, version, () => 1000);
        const [panel, indicator] = await Promise.all([monitor.refresh(), monitor.refresh()]);
        assert.equal(reads, 1);
        assert.deepEqual(panel, indicator);
        assert.equal(panel.samples.length, 1);
        assert.equal(panel.samples[0].sshMs, 40);
        await monitor.refresh();
        assert.equal(reads, 1);
    });

    it("retains at most 120 points and expires history by elapsed time", async () => {
        let time = 0;
        const monitor = new RemoteStatusMonitor(async () => status(), version, () => time);
        for (let i = 0; i < 125; i++) {
            await monitor.refresh(true);
            time += 1000;
        }
        const snapshot = monitor.getSnapshot();
        assert.equal(snapshot.samples.length, 120);
        assert.equal(snapshot.samples[0].time, 5000);
        time = 725000;
        assert.deepEqual(monitor.getSnapshot().samples, []);
    });

    it("preserves history across unsubscribe and reopening without duplicate probes", async () => {
        const monitor = new RemoteStatusMonitor(async () => status(), version, () => 1000);
        const received: number[] = [];
        const unsubscribe = monitor.subscribe(snapshot => received.push(snapshot.samples.length));
        await monitor.refresh();
        unsubscribe();
        const reopened: number[] = [];
        const stop = monitor.subscribe(snapshot => reopened.push(snapshot.samples.length));
        await monitor.refresh();
        stop();
        assert.deepEqual(received, [0, 1]);
        assert.deepEqual(reopened, [1]);
    });

    it("distinguishes absent SSH from a disconnected tunnel and recovers after IPC failure", async () => {
        let current = status(false);
        let fail = false;
        const monitor = new RemoteStatusMonitor(async () => {
            if (fail) {
                throw new Error("IPC unavailable");
            }
            return current;
        }, version);
        assert.equal((await monitor.refresh()).samples[0].sshMs, null);
        current = status();
        current.ssh.alive = false;
        assert.equal((await monitor.refresh(true)).samples[1].sshMs, -1);
        fail = true;
        const unavailable = await monitor.refresh(true);
        assert.equal(unavailable.status, null);
        assert.equal(unavailable.samples[2].sshMs, -1);
        await monitor.refresh(true);
        assert.equal(monitor.getSnapshot().samples[3].sshMs, -1);
        fail = false;
        current.ssh.alive = true;
        assert.equal((await monitor.refresh(true)).status.ssh.alive, true);
    });

    it("clears samples when the kernel origin changes", async () => {
        const current = status();
        const monitor = new RemoteStatusMonitor(async () => ({...current}), version);
        await monitor.refresh();
        current.origin = "https://other.example";
        const snapshot = await monitor.refresh(true);
        assert.equal(snapshot.samples.length, 1);
        assert.equal(snapshot.status.origin, current.origin);
    });
});

describe("kernel latency probe", () => {
    it("measures the complete successful version response", async () => {
        const times = [10, 38];
        assert.equal(await probeKernelLatency(version, () => times.shift()), 28);
    });

    it("records HTTP errors, login HTML, API errors and network errors as failures", async () => {
        for (const fetcher of [
            async () => new Response("error", {status: 503}),
            async () => new Response("<html>login</html>"),
            async () => new Response(JSON.stringify({code: -1, msg: "unauthorized"})),
            async () => { throw new Error("offline"); },
        ]) {
            assert.equal(await probeKernelLatency(fetcher), -1);
        }
    });

    it("aborts a hung request instead of blocking future samples", async () => {
        let signal: AbortSignal;
        const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
            signal = options.signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        assert.equal(await probeKernelLatency(fetcher, Date.now, 5), -1);
        assert.equal(signal.aborted, true);
    });
});

describe("latency chart data", () => {
    it("leaves gaps for failures, missing SSH and pauses instead of drawing false zeroes", () => {
        const samples = [
            {time: 0, pingMs: 0, sshMs: 30},
            {time: 5000, pingMs: 20, sshMs: -1},
            {time: 10000, pingMs: -1, sshMs: null},
            {time: 15000, pingMs: 40, sshMs: 25},
            {time: 60000, pingMs: 10, sshMs: 20},
        ];
        assert.deepEqual(getLatencySegments(samples, "pingMs"), [
            [{time: 0, value: 0}, {time: 5000, value: 20}],
            [{time: 15000, value: 40}], [{time: 60000, value: 10}],
        ]);
        assert.deepEqual(getLatencySegments(samples, "sshMs"), [
            [{time: 0, value: 30}], [{time: 15000, value: 25}], [{time: 60000, value: 20}],
        ]);
    });

    it("excludes invalid samples from latency averages and absent SSH from failure rates", () => {
        assert.deepEqual(getLatencySummary([0, 20, 40, -1, null]), {
            average: 20, maximum: 40, failureRate: 25,
        });
        assert.deepEqual(getLatencySummary([-1, -1]), {average: null, maximum: null, failureRate: 100});
        assert.deepEqual(getLatencySummary([]), {average: null, maximum: null, failureRate: null});
        assert.deepEqual(getLatencySummary([NaN, Infinity, 10]), {average: 10, maximum: 10, failureRate: 67});
    });
});
