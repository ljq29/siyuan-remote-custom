const assert = require("node:assert/strict");
const test = require("node:test");
const {buildOpenSSHArgs, getOpenSSHExecutable, resolveSSHBridgePort} = require("./sshOpenSSH");

test("buildOpenSSHArgs creates only a TCP forward to the remote SSH port", () => {
    assert.deepEqual(buildOpenSSHArgs({
        user: "tester",
        host: "192.0.2.1",
        port: 22,
        localPort: 49152,
        targetHost: "127.0.0.1",
        targetPort: 22,
    }), [
        "-N", "-T", "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3", "-p", "22",
        "-L", "127.0.0.1:49152:127.0.0.1:22",
        "tester@192.0.2.1",
    ]);
});

test("buildOpenSSHArgs passes a configured key only when one is provided", () => {
    const args = buildOpenSSHArgs({user: "tester", host: "host", port: 22, localPort: 49152,
        targetHost: "127.0.0.1", targetPort: 22, keyPath: "C:/key"});
    assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), ["-i", "C:/key"]);
});

test("OpenSSH executable defaults to Windows ssh", () => {
    assert.equal(getOpenSSHExecutable(), "ssh.exe");
});

test("resolveSSHBridgePort treats undefined and 0 as random", () => {
    assert.equal(resolveSSHBridgePort(undefined), 0);
    assert.equal(resolveSSHBridgePort(null), 0);
    assert.equal(resolveSSHBridgePort(0), 0);
    assert.equal(resolveSSHBridgePort("0"), 0);
});

test("resolveSSHBridgePort accepts numeric ports", () => {
    assert.equal(resolveSSHBridgePort(20022), 20022);
    assert.equal(resolveSSHBridgePort("20022"), 20022);
});

test("resolveSSHBridgePort rejects invalid values", () => {
    assert.throws(() => resolveSSHBridgePort("abc"));
    assert.throws(() => resolveSSHBridgePort(-1));
    assert.throws(() => resolveSSHBridgePort(70000));
    assert.throws(() => resolveSSHBridgePort("22.5"));
});
