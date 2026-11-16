// webviewGate.js 单元测试：凭据生成/持久化/重签、指纹归一化与信任判定、门禁 Cookie 校验剥离
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    WEBVIEW_GATE_COOKIE_NAME,
    loadWebViewGateCredentials,
    normalizeCertificateFingerprint,
    isTrustedWebViewGateCertificate,
    extractGateCookie,
} = require("./webviewGate");

const noopLog = () => {};
const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "webview-gate-test-"));

test("credentials are generated once and reused while hostnames stay covered", () => {
    const dir = makeTempDir();
    const first = loadWebViewGateCredentials(dir, ["a.example.cn", "b.example.cn"], noopLog);
    const second = loadWebViewGateCredentials(dir, ["b.example.cn", "a.example.cn"], noopLog);
    assert.equal(typeof first.secret, "string");
    assert.equal(first.secret.length, 64);
    assert.equal(first.secret, second.secret);
    assert.equal(first.keyPem, second.keyPem);
    assert.equal(first.certPem, second.certPem);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(first.certPem.includes("BEGIN CERTIFICATE"));
    assert.ok(first.keyPem.includes("BEGIN RSA PRIVATE KEY"));
    const subset = loadWebViewGateCredentials(dir, ["a.example.cn"], noopLog);
    assert.equal(subset.fingerprint, first.fingerprint);
});

test("hostname set changes re-sign the certificate with the same key and secret", () => {
    const dir = makeTempDir();
    const first = loadWebViewGateCredentials(dir, ["a.example.cn"], noopLog);
    const second = loadWebViewGateCredentials(dir, ["a.example.cn", "c.example.cn"], noopLog);
    assert.equal(first.secret, second.secret);
    assert.equal(first.keyPem, second.keyPem);
    assert.notEqual(first.certPem, second.certPem);
    assert.notEqual(first.fingerprint, second.fingerprint);
});

test("corrupted credentials file triggers a fresh generation", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "webview-gate.json"), "{not json");
    const credentials = loadWebViewGateCredentials(dir, ["a.example.cn"], noopLog);
    assert.equal(typeof credentials.secret, "string");
    const reloaded = loadWebViewGateCredentials(dir, ["a.example.cn"], noopLog);
    assert.equal(reloaded.secret, credentials.secret);
});

test("normalizeCertificateFingerprint strips separators and lowercases", () => {
    assert.equal(normalizeCertificateFingerprint("AA:BB:cc:DD"), "aabbccdd");
    assert.equal(normalizeCertificateFingerprint("aabbccdd"), "aabbccdd");
    assert.equal(normalizeCertificateFingerprint(undefined), "");
    assert.equal(normalizeCertificateFingerprint(null), "");
});

test("isTrustedWebViewGateCertificate requires both gate hostname and exact fingerprint", () => {
    const isGateHostname = (hostname) => hostname === "a.example.cn";
    assert.equal(isTrustedWebViewGateCertificate("a.example.cn", "AA:BB", isGateHostname, "aabb"), true);
    assert.equal(isTrustedWebViewGateCertificate("evil.example.cn", "AA:BB", isGateHostname, "aabb"), false);
    assert.equal(isTrustedWebViewGateCertificate("a.example.cn", "AA:BC", isGateHostname, "aabb"), false);
    assert.equal(isTrustedWebViewGateCertificate("a.example.cn", undefined, isGateHostname, "aabb"), false);
});

test("extractGateCookie authorizes and strips only the exact gate cookie", () => {
    const secret = "s3cret";
    const header = "sid=1; " + WEBVIEW_GATE_COOKIE_NAME + "=" + secret + "; theme=dark";
    const result = extractGateCookie(header, secret);
    assert.equal(result.authorized, true);
    assert.equal(result.cookie, "sid=1; theme=dark");
    const only = extractGateCookie(WEBVIEW_GATE_COOKIE_NAME + "=" + secret, secret);
    assert.equal(only.authorized, true);
    assert.equal(only.cookie, "");
});

test("extractGateCookie rejects missing, wrong-value and look-alike cookies", () => {
    const secret = "s3cret";
    assert.equal(extractGateCookie("sid=1", secret).authorized, false);
    assert.equal(extractGateCookie(WEBVIEW_GATE_COOKIE_NAME + "=wrong", secret).authorized, false);
    assert.equal(extractGateCookie(WEBVIEW_GATE_COOKIE_NAME + "=" + secret + "x", secret).authorized, false);
    assert.equal(extractGateCookie("x" + WEBVIEW_GATE_COOKIE_NAME + "=" + secret, secret).authorized, false);
    assert.equal(extractGateCookie("", secret).authorized, false);
    assert.equal(extractGateCookie(undefined, secret).authorized, false);
});
