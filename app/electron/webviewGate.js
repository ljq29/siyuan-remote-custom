// webview 站点门禁（remote.json 配 webviewGate: true 时启用）：站点转发器从裸 TCP 管道升级为本机终结 TLS 的
// 反向代理——webview 与本机网关之间用本机自签证书建 TLS（由 installWebViewGateTrust 按证书指纹+站点域名精确放行，
// 用户无感知、不影响其他任何连接的证书校验），网关校验每个请求（含 WebSocket 握手）携带的门禁 Cookie 后才经
// SSH 隧道转发到真实后端；同机其他程序不知道密钥，请求一到即被断连（reset）。
// 门禁密钥与证书首次运行时生成并持久化在 userData（不写进 remote.json）；站点域名集合变化时用原私钥重签证书；
// 本模块不依赖 electron，可独立单测
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const gHttp = require("node:http");
const gHttps = require("node:https");

const WEBVIEW_GATE_COOKIE_NAME = "__siyuan_gate";
const CREDENTIALS_FILE_NAME = "webview-gate.json";
const CERT_VALIDITY_YEARS = 10;

// 生成 RSA-2048 自签证书：SAN 覆盖全部站点域名（Chromium 只认 SAN），指纹取证书 DER 的 SHA-256（小写无冒号），
// 供 setCertificateVerifyProc 精确比对。
// 密钥对用 Node 原生 crypto 生成（OpenSSL，毫秒级）再转 forge 对象：node-forge 纯 JS 生成 RSA-2048 会阻塞事件
// 循环数十秒，首次启动正好把 SSH 隧道握手超时耗光（test 机实测：卡住 55 秒后 SSH handshake timeout 回落本地模式）
const generateGateCertificate = (hostnames, privateKey) => {
    const forge = require("node-forge");
    let keyPair;
    if (privateKey) {
        keyPair = {privateKey, publicKey: forge.pki.setRsaPublicKey(privateKey.n, privateKey.e)};
    } else {
        const nodeKey = crypto.generateKeyPairSync("rsa", {modulusLength: 2048}).privateKey;
        const forgeKey = forge.pki.privateKeyFromPem(nodeKey.export({type: "pkcs1", format: "pem"}));
        keyPair = {privateKey: forgeKey, publicKey: forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e)};
    }
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keyPair.publicKey;
    certificate.serialNumber = crypto.randomBytes(16).toString("hex");
    certificate.validity.notBefore = new Date(Date.now() - 86400000);
    certificate.validity.notAfter = new Date(Date.now() + CERT_VALIDITY_YEARS * 365 * 86400000);
    const attributes = [{name: "commonName", value: "SiYuan WebView Gate"}];
    certificate.setSubject(attributes);
    certificate.setIssuer(attributes);
    certificate.setExtensions([
        {name: "basicConstraints", cA: false},
        {name: "keyUsage", digitalSignature: true, keyEncipherment: true},
        {name: "extKeyUsage", serverAuth: true},
        {name: "subjectAltName", altNames: hostnames.map((hostname) => ({type: 2, value: hostname}))},
    ]);
    certificate.sign(keyPair.privateKey, forge.md.sha256.create());
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
    return {
        keyPem: forge.pki.privateKeyToPem(keyPair.privateKey),
        certPem: forge.pki.certificateToPem(certificate),
        fingerprint: crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex"),
    };
};

const fingerprintFromCertPem = (certPem) => {
    const forge = require("node-forge");
    const certificate = forge.pki.certificateFromPem(certPem);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
    return crypto.createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");
};

// 加载或生成门禁凭据（密钥 + 证书）：文件缺失/损坏时全新生成；密钥不变、站点域名集合变化时用原私钥重签证书；
// 写盘权限 0600。返回 {secret, keyPem, certPem, fingerprint}
const loadWebViewGateCredentials = (userDataDir, hostnames, writeLog) => {
    const credentialsPath = path.join(userDataDir, CREDENTIALS_FILE_NAME);
    const sortedHostnames = [...new Set(hostnames)].sort();
    let stored = null;
    try {
        stored = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    } catch (error) {
        stored = null;
    }
    const save = (credentials) => {
        fs.writeFileSync(credentialsPath, JSON.stringify(credentials), {mode: 0o600});
        return {secret: credentials.secret, keyPem: credentials.keyPem,
            certPem: credentials.certPem, fingerprint: fingerprintFromCertPem(credentials.certPem)};
    };
    if (stored && typeof stored.secret === "string" && stored.secret &&
        typeof stored.keyPem === "string" && typeof stored.certPem === "string" &&
        Array.isArray(stored.hostnames)) {
        const covered = sortedHostnames.every((hostname) => stored.hostnames.includes(hostname));
        if (covered) {
            return save(stored);
        }
        // 站点域名集合变化：用原私钥重签证书（私钥不变，已放行的指纹信任随之更新为新证书指纹）
        const forge = require("node-forge");
        const regenerated = generateGateCertificate(sortedHostnames, forge.pki.privateKeyFromPem(stored.keyPem));
        writeLog("webview gate certificate regenerated for hostnames [" + sortedHostnames.join(", ") + "]");
        return save({secret: stored.secret, hostnames: sortedHostnames, ...regenerated});
    }
    writeLog("webview gate credentials generated");
    return save({secret: crypto.randomBytes(32).toString("hex"), hostnames: sortedHostnames,
        ...generateGateCertificate(sortedHostnames)});
};

// Electron 回调里的指纹是冒号分隔大写 hex，统一归一化后比较
const normalizeCertificateFingerprint = (value) =>
    String(value || "").replace(/[^0-9a-f]/gi, "").toLowerCase();

// 网关证书信任判定：仅当「请求主机名是 webview 站点域名」且「出示的证书指纹与本机网关证书一致」时为 true；
// 由调用方合并进会话唯一的 setCertificateVerifyProc（会话只允许一个校验回调，不能重复安装）
const isTrustedWebViewGateCertificate = (hostname, certificateFingerprint, isGateHostname, fingerprint) =>
    isGateHostname(hostname) && normalizeCertificateFingerprint(certificateFingerprint) === fingerprint;

// 把门禁 Cookie 写进会话 Cookie 罐（按站点域名，持久 10 年）：webview 的普通请求与 WebSocket 握手都会自动携带；
// httpOnly 防页面脚本读取，https 站点带 secure
const plantWebViewGateCookies = (electronSession, sites, secret) => {
    sites.forEach((site) => {
        electronSession.cookies.set({
            url: site.protocol + "//" + site.hostname + "/",
            name: WEBVIEW_GATE_COOKIE_NAME,
            value: secret,
            httpOnly: true,
            secure: site.protocol === "https:",
            expirationDate: Math.floor(Date.now() / 1000) + CERT_VALIDITY_YEARS * 365 * 86400,
        }).catch(() => {});
    });
};

// 校验 Cookie 头中的门禁 Cookie 并剥离（门禁 Cookie 不发给后端）；返回 {authorized, cookie}，
// cookie 为剥离后的 Cookie 头（可能为空串，调用方据此删除该头）
const extractGateCookie = (cookieHeader, secret) => {
    if (!cookieHeader) {
        return {authorized: false, cookie: ""};
    }
    const expected = WEBVIEW_GATE_COOKIE_NAME + "=" + secret;
    const kept = [];
    let authorized = false;
    cookieHeader.split(/;\s*/).forEach((part) => {
        if (part === expected) {
            authorized = true;
        } else {
            kept.push(part);
        }
    });
    return {authorized, cookie: kept.join("; ")};
};

const stripHopByHopHeaders = (headers) => {
    const out = {};
    Object.keys(headers).forEach((key) => {
        if (["connection", "proxy-connection", "keep-alive"].includes(key)) {
            return;
        }
        out[key] = headers[key];
    });
    return out;
};

// 单站点门禁网关：入站为 https（站点协议）时本机自签证书终结 TLS（Node 不宣告 ALPN，客户端回退 http/1.1），
// http 站点则明文网关；每个请求（含 upgrade）先验门禁 Cookie——缺失直接销毁 socket（对端表现为连接被重置），
// 通过则剥离门禁 Cookie 后经 createTunnel 建的隧道通道转发到真实后端；除逐跳头外请求头原样保留
// （Host 与裸管道时期一致，后端路由行为不变），响应剔除逐跳头后透传，不做换源改写
const createWebViewGateServer = ({site, credentials, createTunnel, writeLog}) => {
    const tunnelSite = {
        host: site.targetHost,
        port: parseInt(site.targetPort, 10),
        tls: site.protocol === "https:",
        insecure: site.insecure === true,
    };
    const rejectRequest = (req, socket) => {
        writeLog("webview gate rejected [" + site.hostname + " from " + (socket.remoteAddress || "?") + "]");
        socket.destroy();
    };
    const requestHandler = (req, res) => {
        const gate = extractGateCookie(req.headers.cookie, credentials.secret);
        if (!gate.authorized) {
            rejectRequest(req, req.socket);
            return;
        }
        const headers = stripHopByHopHeaders(req.headers);
        if (gate.cookie) {
            headers.cookie = gate.cookie;
        } else {
            delete headers.cookie;
        }
        const proxyReq = gHttp.request({
            createConnection: () => createTunnel(tunnelSite, site.hostname),
            method: req.method,
            path: req.url,
            headers,
        }, (proxyRes) => {
            const resHeaders = {};
            Object.keys(proxyRes.headers).forEach((key) => {
                if (["connection", "keep-alive", "transfer-encoding",
                    "proxy-authenticate", "proxy-authorization"].includes(key)) {
                    return;
                }
                resHeaders[key] = proxyRes.headers[key];
            });
            res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, resHeaders);
            proxyRes.pipe(res);
        });
        proxyReq.on("error", (error) => {
            writeLog("webview gate request failed [" + site.hostname + " " + req.method + " " + req.url + "]: " +
                error.message);
            if (!res.headersSent) {
                res.writeHead(502, {"Content-Type": "text/plain; charset=utf-8"});
            }
            res.end("webview gate upstream failed");
        });
        req.pipe(proxyReq);
    };
    const upgradeHandler = (req, socket, head) => {
        const gate = extractGateCookie(req.headers.cookie, credentials.secret);
        if (!gate.authorized) {
            rejectRequest(req, socket);
            return;
        }
        const tunnel = createTunnel(tunnelSite, site.hostname, (channel) => {
            const headers = stripHopByHopHeaders(req.headers);
            if (gate.cookie) {
                headers.cookie = gate.cookie;
            } else {
                delete headers.cookie;
            }
            const lines = [req.method + " " + req.url + " HTTP/" + req.httpVersion];
            Object.keys(headers).forEach((key) => {
                (Array.isArray(headers[key]) ? headers[key] : [headers[key]]).forEach((value) => {
                    lines.push(key + ": " + value);
                });
            });
            channel.write(lines.join("\r\n") + "\r\n\r\n");
            if (head && head.length > 0) {
                channel.write(head);
            }
            socket.pipe(channel).pipe(socket);
        }, () => socket.destroy());
        // upgrade 后 socket 已脱离 http 服务器管理，对端 RST 时无监听会抛未捕获异常
        socket.on("error", () => tunnel.destroy());
        tunnel.on("error", () => socket.destroy());
    };
    let server;
    if (site.protocol === "https:") {
        server = gHttps.createServer({key: credentials.keyPem, cert: credentials.certPem}, requestHandler);
    } else {
        server = gHttp.createServer(requestHandler);
    }
    server.on("upgrade", upgradeHandler);
    return server;
};

module.exports = {
    WEBVIEW_GATE_COOKIE_NAME,
    loadWebViewGateCredentials,
    normalizeCertificateFingerprint,
    isTrustedWebViewGateCertificate,
    plantWebViewGateCookies,
    extractGateCookie,
    createWebViewGateServer,
};
