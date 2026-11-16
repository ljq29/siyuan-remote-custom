const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createCustomRemote, resolveCustomRemoteArgument} = require("./customRemote");

const withConfig = (text, run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siyuan-custom-remote-"));
    try {
        fs.writeFileSync(path.join(dir, "remote.json"), text, "utf8");
        run(dir);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
};

test("remote argument uses CLI before JSONC config", () => {
    withConfig(`{
        // 注释中的 URL 不应影响解析
        "remote": "https://config.example.com",
}`, dir => {
        assert.equal(resolveCustomRemoteArgument([], dir), "https://config.example.com");
        assert.equal(resolveCustomRemoteArgument(["--remote=https://cli.example.com"], dir),
            "https://cli.example.com");
        assert.equal(resolveCustomRemoteArgument(["--remote-ssh-failed=tunnel"], dir), undefined);
    });
});

test("custom remote exposes fixed title and automatic authentication config without starting a tunnel", () => {
    withConfig('{"title":"  固定标题  ","remote":"https://config.example.com","authCode":"secret"}', dir => {
        const remote = createCustomRemote({
            app: {commandLine: {appendSwitch: () => {}}, getPath: () => dir},
            target: undefined,
            argError: undefined,
            confDir: dir,
            appVer: "3.8.10",
            getArg: () => undefined,
            writeLog: () => {},
        });
        assert.equal(remote.resolveFixedWindowTitle(), "固定标题");
        assert.equal(remote.autoAuthCode, "secret");
        assert.equal(remote.composeRemoteToolTip(), "SiYuan v3.8.10 r");
        assert.equal(remote.tunnelPromise, undefined);
        assert.equal(remote.ignoreVersionMismatch, false);
    });
});

test("version mismatch ignore flag is opt-in", () => {
    withConfig('{"ignoreVersionMismatch":true}', dir => {
        const remote = createCustomRemote({
            app: {commandLine: {appendSwitch: () => {}}, getPath: () => dir},
            target: undefined,
            argError: undefined,
            confDir: dir,
            appVer: "3.8.10",
            getArg: () => undefined,
            writeLog: () => {},
        });
        assert.equal(remote.ignoreVersionMismatch, true);
    });
});
