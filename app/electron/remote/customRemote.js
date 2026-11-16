const gNet = require("node:net");
const gTls = require("node:tls");
const gHttp = require("node:http");
const gStream = require("node:stream");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {buildOpenSSHArgs, getOpenSSHExecutable, resolveSSHBridgePort} = require("../sshOpenSSH");
const {
    createWebViewGateServer,
    isTrustedWebViewGateCertificate,
    loadWebViewGateCredentials,
    plantWebViewGateCookies,
} = require("../webviewGate");

const stripJsonComments = (text) => {
    let result = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            result += ch;
            if (ch === "\\") {
                result += text[++i] || "";
            } else if (ch === "\"") {
                inString = false;
            }
            continue;
        }
        if (ch === "\"") {
            inString = true;
            result += ch;
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") {
                i++;
            }
            result += "\n";
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
                if (text[i] === "\n") {
                    result += "\n";
                }
                i++;
            }
            i++;
            continue;
        }
        if (ch === ",") {
            // 前瞻跳过空白与注释，逗号后（允许隔注释）直接收尾则为尾逗号，剥掉
            let j = i + 1;
            for (;;) {
                while (j < text.length && /\s/.test(text[j])) {
                    j++;
                }
                if (text[j] === "/" && text[j + 1] === "/") {
                    while (j < text.length && text[j] !== "\n") {
                        j++;
                    }
                    continue;
                }
                if (text[j] === "/" && text[j + 1] === "*") {
                    j += 2;
                    while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) {
                        j++;
                    }
                    j += 2;
                    continue;
                }
                break;
            }
            if (text[j] === "}" || text[j] === "]") {
                continue;
            }
        }
        result += ch;
    }
    return result;
};

const createCustomRemote = ({
    app,
    target,
    argError,
    confDir,
    appVer,
    getArg,
    writeLog,
    reportRemoteBootProgress = () => {},
    refreshTrayToolTips = () => {},
}) => {
    let remoteKernelTarget = target;
    let remoteKernelArgError = argError;
    let remoteTrayStatus = "";
    let remoteKernelVersion = "";
    const bootStartedAt = Date.now();

// --remote-ssh-failed[=reason] 是远程不可用后本地模式重启的内部标记：存在时忽略 remote.json 与 --remote 系列
// 参数（取值处门控），托盘提示 srf 并在 tooltip 第二行给出原因；原始远程参数保留在 argv 中，供托盘菜单
// 「重试远程模式」剥离标记后恢复远程模式
const remoteSSHFailedArg = getArg("--remote-ssh-failed");
const remoteSSHFailed = remoteSSHFailedArg !== undefined;
// srf 原因码 → 中文说明：argv 中只传英文 code（避免 Windows 命令行中文编码风险），tooltip 展示时映射
const remoteSSHFailedReasons = {
    "tunnel": "SSH 隧道失败",
    "version-check": "远程内核连接失败",
    "boot-timeout": "等待远程内核就绪超时",
    "auth-probe": "鉴权状态检查失败",
};
const getRemoteSSHFailedReasonText = () => remoteSSHFailedReasons[remoteSSHFailedArg] || "连接失败";
// JSONC 兼容：逐字符扫描剥掉 // 与 /* */ 注释及对象/数组尾逗号后再 JSON.parse；
// 字符串（含转义）内的 // 与逗号原样保留，配置里的 https:// URL 不受影响；注释剥除时保留换行，解析报错的行号不漂移
// remote.json（按 JSONC 解析，支持 // 与块注释、尾逗号）提供远程模式参数的默认值，命令行参数优先于配置文件
let remoteConfig = {};
if (!remoteSSHFailed) {
    const remoteConfigPath = path.join(confDir, "remote.json");
    try {
        if (fs.existsSync(remoteConfigPath)) {
            remoteConfig = JSON.parse(stripJsonComments(fs.readFileSync(remoteConfigPath, "utf8"))) || {};
            writeLog("loaded remote config [path=" + remoteConfigPath + "]");
            reportRemoteBootProgress("config", "done", remoteConfigPath);
        }
    } catch (error) {
        writeLog("load remote config failed: " + error.message);
        remoteConfig = {};
    }
}
// 远程内核就绪等待超时：--remote-boot-timeout > remote.json bootTimeout（秒，接受数字或数字字符串）> 默认 30；
// 不走 getRemoteSetting（其只接受字符串，JSON 数字会被丢弃）；非法值记日志回落默认，合理范围钳制 5~600 秒
const resolveRemoteBootTimeout = () => {
    const bootTimeoutArg = getArg("--remote-boot-timeout");
    const raw = bootTimeoutArg !== undefined ? bootTimeoutArg : remoteConfig.bootTimeout;
    const seconds = typeof raw === "number" ? raw : (/^\d+$/.test(String(raw)) ? parseInt(raw, 10) : NaN);
    if (Number.isInteger(seconds) && seconds >= 5 && seconds <= 600) {
        return seconds * 1000;
    }
    if (raw !== undefined) {
        writeLog("invalid remote boot timeout [" + raw + "], using default 30s");
    }
    return 30000;
};
const remoteBootTimeoutMs = resolveRemoteBootTimeout();
const getRemoteSetting = (argName, configKey) => {
    const arg = getArg(argName);
    if (arg !== undefined) {
        return arg;
    }
    const value = remoteConfig[configKey];
    return typeof value === "string" && value !== "" ? value : undefined;
};

// webviewSites（仅 remote.json 配置）：经同一 SSH 隧道为每个站点建固定目标 TCP 转发器，供前端中心 Tab 以 <webview> 内嵌访问；
// 每项需含 name/url/target，target 为跳板机视角的 host[:port]（端口省略时取 url 端口，缺省 443），非法项跳过并记日志；
// icon 为可选的思源 litheness 图标 id（如 iconGlobe），未配置时为空字符串，由前端回落默认图标；
// auth 为可选的登录自动填充配置 {username, password, usernameSelector?, passwordSelector?, submitSelector?}，
// 仅提取字符串字段，其余类型视为未配置；
// listenPort 为可选的本机监听端口，省略时按站点域名哈希取固定端口：端口稳定则站点 origin 跨重启不变，
// localStorage 等按 origin 隔离的存储才能留住（随机端口等于每次启动都换命名空间，表现为登录态丢失）
const pickSiteAuth = (auth) => {
    if (!auth || typeof auth !== "object") {
        return null;
    }
    const result = {};
    ["username", "password", "usernameSelector", "passwordSelector", "submitSelector"].forEach((key) => {
        if (typeof auth[key] === "string") {
            result[key] = auth[key];
        }
    });
    return (result.username && result.password) ? result : null;
};
const deriveWebViewSitePort = (hostname) => {
    let hash = 0;
    for (let index = 0; index < hostname.length; index++) {
        hash = (hash * 31 + hostname.charCodeAt(index)) >>> 0;
    }
    return 18600 + hash % 800;
};
const webviewSites = [];
if (Array.isArray(remoteConfig.webviewSites)) {
    remoteConfig.webviewSites.forEach((site) => {
        if (!site || typeof site.name !== "string" || !site.name ||
            typeof site.url !== "string" || !site.url ||
            typeof site.target !== "string" || !site.target) {
            writeLog("webview site ignored: invalid entry " + JSON.stringify(site));
            return;
        }
        try {
            const siteURL = new URL(site.url);
            const targetMatch = /^([^:]+)(?::(\d+))?$/.exec(site.target);
            if (!targetMatch) {
                throw new Error("target requires the format host[:port]");
            }
            let localPort = 0;
            if (site.listenPort !== undefined) {
                if (/^\d+$/.test(String(site.listenPort)) && Number(site.listenPort) > 0 && Number(site.listenPort) < 65536) {
                    localPort = Number(site.listenPort);
                } else {
                    writeLog("webview site listenPort ignored [name=" + site.name + "]: requires a TCP port number");
                }
            }
            webviewSites.push({
                name: site.name,
                icon: typeof site.icon === "string" ? site.icon : "",
                auth: pickSiteAuth(site.auth),
                protocol: siteURL.protocol,
                hostname: siteURL.hostname,
                targetHost: targetMatch[1],
                targetPort: targetMatch[2] || siteURL.port || "443",
                localPort: localPort || deriveWebViewSitePort(siteURL.hostname),
                insecure: site.insecure === true,
            });
        } catch (error) {
            writeLog("webview site ignored [name=" + site.name + "]: " + error.message);
        }
    });
}

// webview 站点门禁（remote.json 配 webviewGate: true）：站点转发器改由 webviewGate.js 的 TLS 网关承载，
// 校验门禁 Cookie 后才转发，同机其他程序连上即被断连；缺省关闭保持裸 TCP 管道。
// 凭据惰性加载并缓存：加载失败记日志并置 null，站点按 fail-closed 处理（不降级为无门禁管道）
const webviewGateEnabled = remoteConfig.webviewGate === true && webviewSites.length > 0;
let webviewGateCredentials;
const getWebViewGateCredentials = () => {
    if (!webviewGateEnabled) {
        return null;
    }
    if (webviewGateCredentials === undefined) {
        const startedAt = Date.now();
        writeLog("webview gate credentials loading [boot +" + (startedAt - bootStartedAt) + "ms]");
        try {
            webviewGateCredentials = loadWebViewGateCredentials(app.getPath("userData"),
                webviewSites.map((site) => site.hostname), writeLog);
            writeLog("webview gate credentials loaded [" + (Date.now() - startedAt) + "ms]");
        } catch (error) {
            writeLog("webview gate credentials failed: " + error.message);
            webviewGateCredentials = null;
        }
    }
    return webviewGateCredentials;
};

// httpProxy（仅 remote.json 配置）：经同一 SSH 隧道在 127.0.0.1 的指定端口开放标准 HTTP 代理，本机任意程序
// （浏览器、curl 等）把它设为代理后即可访问任意 http/https 网站；HTTPS 走 CONNECT 透明隧道（TLS 端到端，SNI 仍是
// 域名，证书校验不受影响），HTTP 把请求行的绝对路径改写为源站形式后经隧道透传；
// sites 每项需含 url（仅 http/https，声明后端协议与域名，语义同 webviewSites），target 可选，为跳板机视角的
// host[:port]（省略时由跳板机解析 url 的域名；端口省略时取 url 端口，缺省按协议 80/443）；
// 客户端用 http 访问 https 站点时由代理向目标发起 TLS（协议转换），insecure 仅对该路径有效，跳过对后端证书的
// 校验（自签场景）；listenPort 可选，配置后为该站点在 127.0.0.1 单开监听（一端口一站点），浏览器直连
// http://127.0.0.1:listenPort 即明文访问，Host 头改写为站点域名，https 站点同样由代理消化 TLS；
// rewrite 可选，缺省 true：listenPort 入口的响应换源改写（Location/HTML 里的绝对地址替换为本地入口、
// Set-Cookie 剥 Domain 与 Secure、剔除 CSP/HSTS），写 false 关闭；
// 未列入 sites 的域名由跳板机解析并直连请求里的 host:port；
// port 缺省 18080，写 0 时不开正向代理（只保留各站点 listenPort 入口），非法时整个代理配置被忽略并记日志
let httpProxyConfig = null;
if (remoteConfig.httpProxy && typeof remoteConfig.httpProxy === "object") {
    const proxyPort = parseInt(remoteConfig.httpProxy.port, 10);
    if (remoteConfig.httpProxy.port === undefined || (proxyPort >= 0 && proxyPort < 65536)) {
        const proxySites = {};
        if (Array.isArray(remoteConfig.httpProxy.sites)) {
            remoteConfig.httpProxy.sites.forEach((site) => {
                if (!site || typeof site.url !== "string" || !site.url) {
                    writeLog("http proxy site ignored: invalid entry " + JSON.stringify(site));
                    return;
                }
                try {
                    const siteURL = new URL(site.url);
                    if (siteURL.protocol !== "http:" && siteURL.protocol !== "https:") {
                        throw new Error("url requires http or https");
                    }
                    let siteHost = siteURL.hostname;
                    let sitePort = siteURL.port || (siteURL.protocol === "https:" ? "443" : "80");
                    if (site.target !== undefined) {
                        const targetMatch = typeof site.target === "string" && /^([^:]+)(?::(\d+))?$/.exec(site.target);
                        if (!targetMatch) {
                            throw new Error("target requires the format host[:port]");
                        }
                        siteHost = targetMatch[1];
                        if (targetMatch[2]) {
                            sitePort = targetMatch[2];
                        }
                    }
                    let listenPort = 0;
                    if (site.listenPort !== undefined) {
                        listenPort = parseInt(site.listenPort, 10);
                        if (!(listenPort > 0 && listenPort < 65536)) {
                            throw new Error("listenPort requires a TCP port number");
                        }
                    }
                    proxySites[siteURL.hostname.toLowerCase()] = {
                        tls: siteURL.protocol === "https:",
                        insecure: site.insecure === true,
                        host: siteHost,
                        port: parseInt(sitePort, 10),
                        hostHeader: siteURL.host,
                        listenPort,
                        rewrite: site.rewrite !== false,
                    };
                } catch (error) {
                    writeLog("http proxy site ignored [url=" + site.url + "]: " + error.message);
                }
            });
        }
        httpProxyConfig = {
            port: remoteConfig.httpProxy.port === undefined ? 18080 : proxyPort,
            sites: proxySites,
        };
    } else {
        writeLog("http proxy ignored: port requires a TCP port number");
    }
}

// sshServer（仅 remote.json 配置）：隧道就绪后起内嵌 SSH Server 并经 forwardIn 反向打洞（等价 ssh -N -R），
// 让跳板机侧的 remotePort 穿透回本机，外部可 SSH 进本机（shell/exec/SFTP）；username 必填，password 或
// publicKeys（OpenSSH 公钥字符串数组）至少配一种，并存时任一通过即可，都没有则整体忽略并记
// `ssh server ignored: no credentials`；shell 缺省 pwsh，未安装时依次回退 powershell -> cmd；
// listenPort 0/省略 = 随机回环端口（仅作反向隧道内部管道，本机不开放固定端口），>0 时本机也固定监听（调试用）；
// remoteHost 缺省 127.0.0.1（仅跳板机本机可连，填 0.0.0.0 暴露给跳板机所在网络时跳板机 sshd 需
// GatewayPorts yes）；remotePort 缺省 2222，被占用时 forwardIn 失败只记日志，不影响内核隧道
let sshServerConfig = null;
if (remoteConfig.sshServer && typeof remoteConfig.sshServer === "object") {
    const sshServer = remoteConfig.sshServer;
    const sshServerUsername = typeof sshServer.username === "string" ? sshServer.username : "";
    const sshServerPassword = typeof sshServer.password === "string" ? sshServer.password : "";
    const sshServerPublicKeys = Array.isArray(sshServer.publicKeys) ?
        sshServer.publicKeys.filter((key) => typeof key === "string" && key) : [];
    const sshServerListenPort = sshServer.listenPort === undefined ? 0 : parseInt(sshServer.listenPort, 10);
    const sshServerRemotePort = sshServer.remotePort === undefined ? 2222 : parseInt(sshServer.remotePort, 10);
    if (!(sshServerListenPort >= 0 && sshServerListenPort < 65536) ||
        !(sshServerRemotePort > 0 && sshServerRemotePort < 65536)) {
        writeLog("ssh server ignored: listenPort/remotePort requires a TCP port number");
    } else if (!sshServerUsername || (!sshServerPassword && sshServerPublicKeys.length === 0)) {
        writeLog("ssh server ignored: no credentials");
    } else {
        sshServerConfig = {
            username: sshServerUsername,
            password: sshServerPassword,
            publicKeys: sshServerPublicKeys,
            shell: typeof sshServer.shell === "string" && sshServer.shell ? sshServer.shell : "pwsh",
            listenPort: sshServerListenPort,
            remoteHost: typeof sshServer.remoteHost === "string" && sshServer.remoteHost ?
                sshServer.remoteHost : "127.0.0.1",
            remotePort: sshServerRemotePort,
        };
    }
}

// HTTP 代理解析目标：sites 按域名命中时返回配置的实际落点（含后端协议 tls 标记与证书校验开关），
// 未命中返回 null，由调用方按请求里的 host:port 走跳板机解析的动态转发
const findHttpProxySite = (hostname) => httpProxyConfig.sites[hostname.toLowerCase()] || null;

// 读入站连接的首个请求头块（\r\n\r\n 截止，上限 64KB），回调给出按行拆分的头块与头块之后的原始字节
const HTTP_PROXY_MAX_HEAD = 65536;
const readHttpRequestHead = (socket, onHead) => {
    let head = Buffer.alloc(0);
    let handled = false;
    const onData = (chunk) => {
        if (handled) {
            return;
        }
        head = Buffer.concat([head, chunk]);
        const headEnd = head.indexOf("\r\n\r\n");
        if (headEnd === -1) {
            if (head.length > HTTP_PROXY_MAX_HEAD) {
                socket.destroy();
            }
            return;
        }
        handled = true;
        socket.removeListener("data", onData);
        onHead(head.slice(0, headEnd).toString("latin1").split("\r\n"), head.slice(headEnd + 4));
    };
    socket.on("data", onData);
    socket.on("error", () => {});
};

// 把改写好的请求头块经隧道通道发往目标并双向透传；tlsOptions 非空时先向目标发起 TLS（SNI 用其 servername，
// insecure 跳过证书校验），代理消化掉后端 https，客户端全程明文；失败只断本条连接并记日志
const pipeHttpThroughChannel = (socket, channel, newHead, rest, tlsOptions, requestLine) => {
    if (!tlsOptions) {
        channel.write(newHead);
        if (rest.length > 0) {
            channel.write(rest);
        }
        socket.pipe(channel).pipe(socket);
        channel.on("error", () => socket.destroy());
        return;
    }
    const tlsSocket = gTls.connect({
        socket: channel,
        servername: tlsOptions.servername,
        rejectUnauthorized: !tlsOptions.insecure,
    });
    tlsSocket.on("secureConnect", () => {
        tlsSocket.write(newHead);
        if (rest.length > 0) {
            tlsSocket.write(rest);
        }
        socket.pipe(tlsSocket).pipe(socket);
    });
    tlsSocket.on("error", (tlsError) => {
        writeLog("remote http proxy tls failed [" + requestLine + "]: " + tlsError.message);
        socket.destroy();
    });
    channel.on("error", () => tlsSocket.destroy());
};

// HTTP 代理服务器：CONNECT 方法回复 200 后做透明 TCP 隧道（HTTPS 场景 TLS 由客户端与目标站点端到端完成）；
// 其余方法要求绝对路径请求行，改写为源站形式并剔除 Proxy-Connection 头后经隧道透传；转发失败只断开本条连接并记日志
const createHttpProxyServer = (getSSHClient) => gNet.createServer((socket) => {
    readHttpRequestHead(socket, (lines, rest) => {
        const requestLine = lines[0];
        const connectMatch = /^CONNECT ([^ :]+):(\d+) HTTP\/\d(?:\.\d)?$/.exec(requestLine);
        if (connectMatch) {
            // CONNECT 是客户端发起的端到端 TLS，始终透明转发；站点配置只决定落点，其 tls 标记不参与
            const connectSite = findHttpProxySite(connectMatch[1]);
            const target = connectSite
                ? {host: connectSite.host, port: connectSite.port}
                : {host: connectMatch[1], port: parseInt(connectMatch[2], 10)};
            const connectClient = getSSHClient();
            if (!connectClient) {
                socket.destroy();
                return;
            }
            connectClient.forwardOut("127.0.0.1", 0, target.host, target.port, (error, channel) => {
                if (error) {
                    writeLog("remote http proxy forward failed [" + requestLine + "]: " + error.message);
                    socket.destroy();
                    return;
                }
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (rest.length > 0) {
                    channel.write(rest);
                }
                socket.pipe(channel).pipe(socket);
                channel.on("error", () => socket.destroy());
            });
            return;
        }
        const requestMatch = /^(\S+) (\S+) HTTP\/(\d(?:\.\d)?)$/.exec(requestLine);
        let url;
        try {
            url = requestMatch ? new URL(requestMatch[2]) : null;
        } catch (error) {
            url = null;
        }
        if (!url || !url.hostname) {
            writeLog("remote http proxy request ignored [" + requestLine + "]");
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.destroy();
            return;
        }
        const newLines = [requestMatch[1] + " " + (url.pathname + url.search) + " HTTP/" + requestMatch[3]];
        lines.slice(1).forEach((line) => {
            if (!/^proxy-connection:/i.test(line)) {
                newLines.push(line);
            }
        });
        const newHead = newLines.join("\r\n") + "\r\n\r\n";
        const site = findHttpProxySite(url.hostname);
        const target = site
            ? {host: site.host, port: site.port}
            : {host: url.hostname, port: parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10)};
        const proxyClient = getSSHClient();
        if (!proxyClient) {
            socket.destroy();
            return;
        }
        proxyClient.forwardOut("127.0.0.1", 0, target.host, target.port, (error, channel) => {
            if (error) {
                writeLog("remote http proxy forward failed [" + requestLine + "]: " + error.message);
                socket.destroy();
                return;
            }
            // 站点 url 为 https 时进入协议转换：客户端明文 http，代理向目标发起 TLS（SNI 用原域名）
            pipeHttpThroughChannel(socket, channel, newHead, rest,
                site && site.tls ? {servername: url.hostname, insecure: site.insecure} : null, requestLine);
        });
    });
});

// 经 SSH 隧道建立的惰性连接流：http.request 的 createConnection 要求同步返回 socket，而 forwardOut 是异步的；
// 先返回占位 Duplex 缓冲写入，通道就绪后接通（https 站点再包一层 TLS 消化后端加密）并发出 connect 事件；
// setNoDelay/setTimeout 等空实现是 http 客户端会调用的 net.Socket 接口；任一端关闭时销毁对端
const createTunnelSocket = (getSSHClient, site, servername, onConnect, onError) => {
    const pending = [];
    let upstream = null;
    const socket = new gStream.Duplex({
        write(chunk, encoding, callback) {
            if (upstream) {
                upstream.write(chunk, encoding, callback);
            } else {
                pending.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
                callback();
            }
        },
        read() {},
    });
    socket.connecting = true;
    socket.setNoDelay = () => {};
    socket.setKeepAlive = () => {};
    socket.setTimeout = () => {};
    socket.unref = () => {};
    socket.ref = () => {};
    socket.on("close", () => {
        if (upstream) {
            upstream.destroy();
        }
    });
    const attach = (stream) => {
        upstream = stream;
        pending.forEach((chunk) => upstream.write(chunk));
        pending.length = 0;
        upstream.on("data", (chunk) => socket.push(chunk));
        upstream.on("end", () => socket.push(null));
        upstream.on("close", () => socket.destroy());
        upstream.on("error", (error) => socket.destroy(error));
        socket.connecting = false;
        socket.emit("connect");
        if (onConnect) {
            onConnect(upstream);
        }
    };
    const tunnelClient = getSSHClient();
    if (!tunnelClient) {
        const noClientError = new Error("SSH tunnel is not connected");
        if (onError) {
            onError(noClientError);
        }
        socket.destroy(noClientError);
        return socket;
    }
    tunnelClient.forwardOut("127.0.0.1", 0, site.host, site.port, (error, channel) => {
        if (error) {
            if (onError) {
                onError(error);
            }
            socket.destroy(error);
            return;
        }
        if (!site.tls) {
            attach(channel);
            return;
        }
        const tlsSocket = gTls.connect({socket: channel, servername, rejectUnauthorized: !site.insecure});
        tlsSocket.on("secureConnect", () => attach(tlsSocket));
        tlsSocket.on("error", (tlsError) => {
            writeLog("remote http site tls failed [" + servername + "]: " + tlsError.message);
            socket.destroy(tlsError);
        });
        channel.on("error", () => tlsSocket.destroy());
    });
    return socket;
};

// 单站点 HTTP 服务器（一端口一站点，sites[].listenPort）：浏览器直连 127.0.0.1:listenPort，入站由 Node http
// 模块完整处理协议细节（keep-alive/chunked/流式 body），每个请求经隧道新建通道转发，Host 头改写为站点域名，
// 剔除 connection 等逐跳头（无连接池，由 http 客户端自行补 Connection: close，响应后通道即关）；
// 后端为 https 时由传输层发起 TLS 消化掉，浏览器全程明文 http 不碰证书；upgrade（WebSocket）请求同样改写
// 请求头后经隧道通道双向透传；
// 换源改写（site.rewrite，缺省开启）：浏览器地址栏源（http://127.0.0.1:listenPort）与后端自认的源（url 的
// scheme+host，如 Gitea 的 ROOT_URL）不一致时，后端吐出的绝对地址会把浏览器带离本地入口，故改写响应——
// Location 头与 text/html body 里的 http(s)://域名[:端口] 及协议相对 //域名 统一替换为本地入口；
// 本地入口随入站请求的 Host 头构造（不硬编码 127.0.0.1）：浏览器用 localhost 访问就改写成 localhost，
// 用 127.0.0.1/局域网 IP 亦然——Cookie 按 host 隔离，改写后 host 变了登录态就丢，必须保持访问时的 host；
// Set-Cookie 剥掉 Domain 属性与 Secure 标志（本地明文 http 下带 Domain 的 Cookie 存错域、带 Secure 的可能被拒）；
// Content-Security-Policy/HSTS 直接剔除（CSP 的域名白名单会拦本地入口加载的资源，HSTS 在 http 下本不生效）；
// HTML body 需整段改写，故对 accept 含 text/html 的请求把 Accept-Encoding 强制为 identity 让后端不压缩
//（后端仍返回压缩时放弃 body 改写直接透传）；body 以 latin1 解码改写再按原字节编码回去，非 ASCII 内容不受损
const createHttpProxySiteServer = (getSSHClient, site, hostname) => {
    const escapedHost = site.hostHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const absoluteUrlPattern = new RegExp("https?://" + escapedHost + "(?::\\d+)?", "g");
    const relativeUrlPattern = new RegExp("//" + escapedHost + "(?::\\d+)?", "g");
    const rewriteCookie = (value) =>
        value.replace(/;\s*domain=[^;]*/ig, "").replace(/;\s*secure\b/ig, "");
    const rewriteHeaders = (headers, wantHtml) => {
        const out = {};
        Object.keys(headers).forEach((key) => {
            if (["host", "connection", "proxy-connection", "keep-alive"].includes(key)) {
                return;
            }
            out[key] = headers[key];
        });
        out.host = site.hostHeader;
        if (wantHtml) {
            out["accept-encoding"] = "identity";
        }
        return out;
    };
    const server = gHttp.createServer((req, res) => {
        const wantHtml = site.rewrite && (req.headers.accept || "").includes("text/html");
        // 本地入口随入站 Host 构造：保持浏览器访问时用的 host（localhost/127.0.0.1/局域网 IP），Cookie 不跨 host 丢失
        const localOrigin = "http://" + (req.headers.host || ("127.0.0.1:" + site.listenPort));
        const proxyReq = gHttp.request({
            createConnection: () => createTunnelSocket(getSSHClient, site, hostname),
            method: req.method,
            path: req.url,
            headers: rewriteHeaders(req.headers, wantHtml),
        }, (proxyRes) => {
            // 剔除响应里的逐跳头：后端按 Connection: close 应答，但不透传给浏览器——入站连接保持 keep-alive，
            // 浏览器可复用连接发后续请求（每请求新建隧道通道）；body 边界由 Content-Length 或 Node 自动补的
            // chunked 保证，与后端是否关连接无关
            const resHeaders = {};
            Object.keys(proxyRes.headers).forEach((key) => {
                if (["connection", "keep-alive", "transfer-encoding",
                    "proxy-authenticate", "proxy-authorization"].includes(key)) {
                    return;
                }
                resHeaders[key] = proxyRes.headers[key];
            });
            if (site.rewrite) {
                if (typeof resHeaders.location === "string") {
                    resHeaders.location = resHeaders.location.replace(absoluteUrlPattern, localOrigin);
                }
                if (Array.isArray(resHeaders["set-cookie"])) {
                    resHeaders["set-cookie"] = resHeaders["set-cookie"].map(rewriteCookie);
                }
                delete resHeaders["content-security-policy"];
                delete resHeaders["content-security-policy-report-only"];
                delete resHeaders["strict-transport-security"];
            }
            const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();
            const contentEncoding = (proxyRes.headers["content-encoding"] || "identity").toLowerCase();
            const rewriteBody = site.rewrite && contentType.includes("text/html") && contentEncoding === "identity";
            if (!rewriteBody) {
                res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, resHeaders);
                proxyRes.pipe(res);
                return;
            }
            // HTML 整段缓冲后换源：先替换带 scheme 的绝对地址，再替换协议相对地址；改写后重算
            // Content-Length 并剔除 ETag（内容与原始摘要已不一致）；HTML 体积有限，缓冲代价可接受
            const chunks = [];
            proxyRes.on("data", (chunk) => chunks.push(chunk));
            proxyRes.on("end", () => {
                const bodyText = Buffer.concat(chunks).toString("latin1")
                    .replace(absoluteUrlPattern, localOrigin)
                    .replace(relativeUrlPattern, "//" + (req.headers.host || ("127.0.0.1:" + site.listenPort)));
                const body = Buffer.from(bodyText, "latin1");
                delete resHeaders.etag;
                resHeaders["content-length"] = body.length;
                res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, resHeaders);
                res.end(body);
            });
            proxyRes.on("error", () => res.destroy());
        });
        proxyReq.on("error", (error) => {
            writeLog("remote http site request failed [" + hostname + " " + req.method + " " + req.url + "]: " +
                error.message);
            if (!res.headersSent) {
                res.writeHead(502, {"Content-Type": "text/plain; charset=utf-8"});
            }
            res.end("remote http site upstream failed");
        });
        req.pipe(proxyReq);
    });
    server.on("upgrade", (req, socket, head) => {
        const tunnel = createTunnelSocket(getSSHClient, site, hostname, (channel) => {
            const headers = rewriteHeaders(req.headers, false);
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
        // upgrade 后 socket 已脱离 http 服务器管理，浏览器 RST 时无监听会抛未捕获异常
        socket.on("error", () => tunnel.destroy());
        tunnel.on("error", () => socket.destroy());
    });
    return server;
};

// 任务栏标题固定为 remote.json 的 title 或工作空间目录名，不随文档标题变化
const resolveFixedWindowTitle = (workspaceDir) => {
    if (typeof remoteConfig.title === "string" && remoteConfig.title.trim()) {
        return remoteConfig.title.trim();
    }
    if (workspaceDir) {
        const baseName = path.basename(workspaceDir.replace(/\\/g, "/").replace(/\/+$/, ""));
        if (baseName) {
            return baseName;
        }
    }
    return "SiYuan v" + appVer;
};


// 内置 SSH 隧道：经跳板机把远程内核流量转发到本机回环，内核转发器固定监听 127.0.0.1:6806（可用
// --remote-forward-port/forwardPort 覆盖）做固定目标转发，webview 站点转发器仍用随机端口，不向系统暴露通用代理。
// 通过 host-resolver-rules 把内核域名与 webview 站点域名映射到 127.0.0.1（仅本进程生效，不改系统 hosts），
// TLS 的 SNI 仍是域名，证书校验不受影响。
let remoteSSHTunnelPromise;
// 解析为 [{name, url}]（url 的端口已改写为站点转发器本地端口）；无隧道、无站点或隧道失败时保持 undefined
let webviewSitesReadyPromise;
// 需要剥掉嵌套限制的站点域名集合，仅在隧道建立流程中填充，webRequest 响应头处理按它过滤
const webviewSiteHostnames = new Set();
// 站点域名 -> 本地转发入口（协议与端口），站点转发器监听成功时填充；页面里写死的原域名绝对地址
// （缺省 443/80 或原端口）经 host-resolver-rules 解析到 127.0.0.1 的缺省端口后必连接失败，
// onBeforeRequest 据此把这类请求重定向到本地入口
const webviewSiteLocalEndpoints = new Map();
// 远程状态面板数据源：sshClient 引用与隧道描述在隧道建立流程中赋值，供 siyuan-get-remote-status 读取；
// alive 由 close/error 事件维护，建连成功后的掉线也能被面板感知
let remoteSSHClient = null;
let remoteSSHProcess = null;
process.once("exit", () => {
    remoteSSHQuitting = true;
    if (remoteSSHReconnectTimer) {
        clearTimeout(remoteSSHReconnectTimer);
    }
    if (remoteSSHProcess && !remoteSSHProcess.killed) {
        remoteSSHProcess.kill();
    }
});
let remoteSSHAlive = false;
// 隧道重连状态：everReady 门控重连循环只在首次建连成功后激活；reconnecting/attempt 供状态面板与托盘展示；
// reconnectTimer 持有退避定时器；quitting 在进程退出路径置位以停止重连
let remoteSSHEverReady = false;
let remoteSSHReconnecting = false;
let remoteSSHReconnectAttempt = 0;
let remoteSSHReconnectTimer = null;
let remoteSSHQuitting = false;
// 转发辅助函数经取值函数获取当前隧道连接：重连热替换后旧闭包自动用上新连接；断开期间返回 null，调用方短路断开
const getActiveSSHClient = () => remoteSSHAlive ? remoteSSHClient : null;
// 隧道客户端类型（ssh2/openssh），在隧道建立流程中赋值，供远程状态面板展示
let remoteSSHClientMode = "";
let remoteSSHServerDesc = "";
let remoteSSHTargetHost = "";
let remoteSSHTargetPort = 0;
let remoteSSHForwardPort = 0;
// OpenSSH TCP 桥的实际监听端口（127.0.0.1），桥就绪后赋值；非 openssh 模式或未就绪时保持 0，供远程状态面板展示
let remoteSSHBridgePort = 0;
// 内嵌 SSH Server 的实际监听状态，listen 回调里赋值；未监听或隧道未就绪时保持 null
let sshServerListenState = null;
// 隧道延迟探测结果缓存（2 秒），避免状态面板轮询反复对隧道打探测通道
let remoteSSHLatencyCache = {time: 0, value: -1};
// 隧道延迟探测：经 SSH 连接向内核目标开一条 forwardOut 通道随即关闭，耗时即「本机 -> 跳板机 -> 目标」的
// SSH RTT；5 秒超时或通道建立失败返回 -1
const probeSSHTunnelLatency = () => new Promise((resolve) => {
    if (!remoteSSHClient || !remoteSSHAlive) {
        resolve(-1);
        return;
    }
    if (Date.now() - remoteSSHLatencyCache.time < 2000) {
        resolve(remoteSSHLatencyCache.value);
        return;
    }
    const startedAt = Date.now();
    let settled = false;
    let timer;
    const done = (value) => {
        if (settled) {
            return;
        }
        settled = true;
        clearTimeout(timer);
        remoteSSHLatencyCache = {time: Date.now(), value};
        resolve(value);
    };
    timer = setTimeout(() => done(-1), 5000);
    remoteSSHClient.forwardOut("127.0.0.1", 0, remoteSSHTargetHost, remoteSSHTargetPort, (error, channel) => {
        if (error) {
            done(-1);
            return;
        }
        channel.on("error", () => done(-1));
        channel.close();
        done(Date.now() - startedAt);
    });
});
const remoteSSHArg = getRemoteSetting("--remote-ssh", "ssh");
if (remoteKernelTarget && !remoteKernelArgError && remoteSSHArg !== undefined) {
    const sshMatch = /^(?:([^@]+)@)?([^:@]+)(?::(\d+))?$/.exec(remoteSSHArg);
    const originURL = new URL(remoteKernelTarget.origin);
    let targetHost = originURL.hostname;
    let targetPort = originURL.port || "443";
    const remoteTargetArg = getRemoteSetting("--remote-target", "target");
    if (remoteTargetArg) {
        // 端口可省略，省略时继承 --remote URL 的端口；仅当隧道目标端口与 URL 端口不同时才需要写 host:port
        const targetMatch = /^([^:]+)(?::(\d+))?$/.exec(remoteTargetArg);
        if (targetMatch) {
            targetHost = targetMatch[1];
            if (targetMatch[2]) {
                targetPort = targetMatch[2];
            }
        } else {
            remoteKernelArgError = new Error("--remote-target requires the format host[:port]");
        }
    }
    if (!sshMatch) {
        remoteKernelArgError = new Error("--remote-ssh requires the format [user@]host[:port]");
    }
    // 内核转发器的回环监听端口，默认固定 6806，可用 --remote-forward-port/forwardPort 覆盖
    let forwardListenPort = 6806;
    const remoteForwardPortArg = getRemoteSetting("--remote-forward-port", "forwardPort");
    if (remoteForwardPortArg !== undefined) {
        const parsedPort = parseInt(remoteForwardPortArg, 10);
        if (/^\d+$/.test(remoteForwardPortArg) && parsedPort > 0 && parsedPort < 65536) {
            forwardListenPort = parsedPort;
        } else {
            remoteKernelArgError = new Error("--remote-forward-port requires a TCP port number");
        }
    }
    // OpenSSH TCP 桥的回环监听端口，缺省 0 为随机临时端口，可用 --remote-ssh-bridge-port/sshBridgePort 固定起始端口
    let sshBridgePort = 0;
    const remoteSSHBridgePortArg = getRemoteSetting("--remote-ssh-bridge-port", "sshBridgePort");
    if (remoteSSHBridgePortArg !== undefined) {
        try {
            sshBridgePort = resolveSSHBridgePort(remoteSSHBridgePortArg);
        } catch (error) {
            remoteKernelArgError = error;
        }
    }
    if (!remoteKernelArgError) {
        const sshUser = sshMatch[1] || process.env.USER || process.env.USERNAME || "root";
        const sshHost = sshMatch[2];
        const sshPort = parseInt(sshMatch[3] || "22", 10);
        const sshKeyPath = getRemoteSetting("--remote-ssh-key", "sshKey");
        const sshPassword = getRemoteSetting("--remote-ssh-password", "sshPassword");
        remoteSSHClientMode = (getRemoteSetting("--remote-ssh-client", "sshClient") || "ssh2").toLowerCase();
        const sshClientMode = remoteSSHClientMode;
        // 供远程状态面板展示的隧道描述信息
        remoteSSHServerDesc = sshUser + "@" + sshHost + ":" + sshPort;
        remoteSSHTargetHost = targetHost;
        remoteSSHTargetPort = parseInt(targetPort, 10);
        remoteSSHForwardPort = forwardListenPort;
        // 多条 MAP 规则用逗号拼接在同一个 switch 里：内核域名加全部 webview 站点域名（去重）
        const mappedHostnames = new Set([originURL.hostname]);
        webviewSites.forEach((site) => mappedHostnames.add(site.hostname));
        app.commandLine.appendSwitch("host-resolver-rules",
            Array.from(mappedHostnames).map((hostname) => "MAP " + hostname + " 127.0.0.1").join(", "));
        webviewSites.forEach((site) => webviewSiteHostnames.add(site.hostname));
        // OpenSSH TCP 桥：ssh.exe 只做本机回环到跳板机 SSH 服务的 TCP 桥，不携带思源 ssh2 凭据，ssh2 经桥端口
        // 另起连接完成认证；startOpenSSHBridge 可重复调用，桥进程 ready 后退出时由重连流程重启桥
        let remoteSSHBridgeAlive = false;
        const startOpenSSHBridge = () => new Promise((resolve, reject) => {
            const reservation = gNet.createServer();
            // 桥端口固定时（sshBridgePort > 0）被占用则递增重试，重试耗尽回退随机端口，不作为隧道失败处理
            let bridgePort = sshBridgePort;
            let bridgeRetriesLeft = 20;
            reservation.on("error", (error) => {
                if (sshBridgePort > 0 && error.code === "EADDRINUSE") {
                    if (bridgeRetriesLeft > 0) {
                        bridgeRetriesLeft--;
                        bridgePort++;
                    } else {
                        bridgePort = 0;
                    }
                    reservation.listen(bridgePort, "127.0.0.1");
                    return;
                }
                reject(error);
            });
            reservation.listen(bridgePort, "127.0.0.1", () => {
                const bootstrapPort = reservation.address().port;
                if (sshBridgePort > 0 && bootstrapPort !== sshBridgePort) {
                    writeLog("OpenSSH bridge port " + sshBridgePort +
                        " unavailable, bound to 127.0.0.1:" + bootstrapPort + " instead");
                }
                reservation.close(() => {
                    const args = buildOpenSSHArgs({user: sshUser, host: sshHost, port: sshPort,
                        localPort: bootstrapPort, targetHost: "127.0.0.1", targetPort: 22, keyPath: sshKeyPath});
                    writeLog("remote SSH client [openssh] TCP bridge [127.0.0.1:" + bootstrapPort + " -> " +
                        sshHost + ":" + sshPort + "]");
                    let process;
                    if (sshPassword) {
                        let pty;
                        try {
                            pty = require("node-pty");
                        } catch (error) {
                            reject(new Error("OpenSSH password mode requires node-pty: " + error.message));
                            return;
                        }
                        process = pty.spawn(getOpenSSHExecutable(), args, {
                            name: "xterm",
                            cols: 120,
                            rows: 30,
                            cwd: globalThis.process.cwd(),
                            env: globalThis.process.env,
                        });
                    } else {
                        process = childProcess.spawn(getOpenSSHExecutable(), args,
                            {stdio: ["ignore", "ignore", "pipe"]});
                        process.stderr.on("data", (data) => {
                            const message = String(data).trim();
                            if (message) {
                                writeLog("OpenSSH: " + message);
                            }
                        });
                    }
                    remoteSSHProcess = process;
                    let ready = false;
                    let passwordSent = false;
                    const fail = (error) => {
                        if (!ready) {
                            ready = true;
                            reject(error);
                        }
                    };
                    // 桥进程退出：ready 前视为启动失败；ready 后标记桥不可用并触发隧道重连（重连流程开头重启桥）
                    const handleBridgeExit = (exitCode) => {
                        if (!ready) {
                            fail(new Error("OpenSSH TCP bridge exited with code " + exitCode));
                            return;
                        }
                        remoteSSHBridgeAlive = false;
                        writeLog("OpenSSH TCP bridge exited with code " + exitCode + ", scheduling tunnel reconnect");
                        scheduleSSHTunnelReconnect("bridge exited");
                    };
                    const handleOutput = (data) => {
                        const message = String(data);
                        if (sshPassword && !passwordSent && /password\s*:/i.test(message)) {
                            passwordSent = true;
                            process.write(sshPassword + "\r");
                        }
                        const visibleMessage = message.replace(/password\s*:\s*.*$/gim, "password: [redacted]").trim();
                        if (visibleMessage) {
                            writeLog("OpenSSH: " + visibleMessage);
                        }
                    };
                    if (sshPassword) {
                        process.onData(handleOutput);
                        process.onExit(({exitCode}) => handleBridgeExit(exitCode));
                    } else {
                        process.once("error", (error) => {
                            if (!ready) {
                                fail(new Error("OpenSSH TCP bridge failed: " + error.message));
                                return;
                            }
                            remoteSSHBridgeAlive = false;
                            writeLog("OpenSSH TCP bridge failed: " + error.message + ", scheduling tunnel reconnect");
                            scheduleSSHTunnelReconnect("bridge error");
                        });
                        process.once("exit", (code) => handleBridgeExit(code));
                    }
                    const probe = () => {
                        if (ready) {
                            return;
                        }
                        const socket = gNet.connect(bootstrapPort, "127.0.0.1");
                        socket.once("connect", () => {
                            socket.destroy();
                            ready = true;
                            remoteSSHBridgePort = bootstrapPort;
                            remoteSSHBridgeAlive = true;
                            resolve({host: "127.0.0.1", port: bootstrapPort});
                        });
                        socket.once("error", () => {
                            socket.destroy();
                            setTimeout(probe, 200);
                        });
                    };
                    setTimeout(probe, 100);
                });
            });
        });
        let openSSHBootstrapPromise = Promise.resolve();
        if (sshClientMode === "openssh") {
            openSSHBootstrapPromise = startOpenSSHBridge();
        }
        const {Client: SSHClient} = require("ssh2");
        const sshConnectConfig = {
            host: sshHost,
            port: sshPort,
            username: sshUser,
            readyTimeout: 30000,
            keepaliveInterval: 10000,
        };
        // 到跳板机的首条 TCP 流可能被中间设备丢 SYN（实测冷路径首连 17 秒以上，路径热后毫秒级），单次 20 秒超时擦边；
        // 建连最多重试 3 次：首次 readyTimeout 30 秒覆盖 Windows SYN 重传全程（约 21 秒），后续尝试路径已热，15 秒足够
        let sshClient;
        let sshAttempt = 0;
        let sshConnectSettled = false;
        // 一次性服务（内核/站点转发器、http 代理、内嵌 SSH Server 监听）只在首次 ready 建立，本地监听端口全程不动；
        // 连接级服务（forwardIn 与反向通道监听）每次 ready 重挂，断线重连后服务随之恢复
        let tunnelServicesStarted = false;
        const attachConnectionScopedServices = (client) => {
            if (!sshServerConfig || !sshServerListenState || !sshServerListenState.listening) {
                return;
            }
            client.forwardIn(sshServerConfig.remoteHost, sshServerConfig.remotePort, (error) => {
                if (error) {
                    writeLog("remote ssh server forward failed [" + sshServerConfig.remoteHost + ":" +
                        sshServerConfig.remotePort + "]: " + error.message);
                    return;
                }
                writeLog("remote ssh server forwarding [" + sshServerConfig.remoteHost + ":" +
                    sshServerConfig.remotePort + " -> 127.0.0.1:" + sshServerListenState.port + "]");
            });
            // 跳板机上每条到 remotePort 的入站连接经隧道回到这里，校验目标端口后接到本地服务端口
            client.on("tcp connection", (info, accept, reject) => {
                if (info.destPort !== sshServerConfig.remotePort) {
                    writeLog("remote ssh server tcp connection ignored [destPort=" + info.destPort + "]");
                    reject();
                    return;
                }
                const channel = accept();
                const local = gNet.connect(sshServerListenState.port, "127.0.0.1");
                channel.pipe(local).pipe(channel);
                channel.on("error", () => local.destroy());
                local.on("error", () => channel.destroy());
            });
        };
        // 掉线感知与重连触发：close/end 任一触发即标记隧道不可用；首次 ready 之后的 close 进入重连循环
        const wireSSHTunnelCloseEvents = (client) => {
            client.on("close", () => {
                if (remoteSSHAlive) {
                    writeLog("remote SSH tunnel closed");
                }
                remoteSSHAlive = false;
                scheduleSSHTunnelReconnect("connection closed");
            });
            client.on("end", () => {
                remoteSSHAlive = false;
            });
        };
        // 断线重连：退避梯 2s/5s/15s/30s 后固定 60s，无限重试；恢复后重挂连接级服务、刷新托盘，
        // 本地监听端口全程不动，前端 WebSocket 每 3 秒重试在隧道恢复后自行复活
        const scheduleSSHTunnelReconnect = (reason) => {
            if (!remoteSSHEverReady || remoteSSHQuitting || remoteSSHReconnectTimer) {
                return;
            }
            remoteSSHReconnecting = true;
            remoteSSHReconnectAttempt++;
            const attempt = remoteSSHReconnectAttempt;
            const reconnectDelays = [2000, 5000, 15000, 30000];
            const delay = attempt <= reconnectDelays.length ? reconnectDelays[attempt - 1] : 60000;
            writeLog("remote SSH tunnel reconnect scheduled [attempt " + attempt + "] [in " + delay + "ms] [reason: " +
                reason + "]");
            remoteTrayStatus = "隧道断开，" + Math.round(delay / 1000) + " 秒后重连（第 " + attempt + " 次）";
            refreshTrayToolTips();
            remoteSSHReconnectTimer = setTimeout(() => {
                remoteSSHReconnectTimer = null;
                reconnectSSHTunnel();
            }, delay);
        };
        const reconnectSSHTunnel = async () => {
            if (remoteSSHQuitting) {
                return;
            }
            // openssh 模式桥进程已死时先重启桥，ssh2 连接改经新桥端口
            if (sshClientMode === "openssh" && !remoteSSHBridgeAlive) {
                try {
                    const bridge = await startOpenSSHBridge();
                    sshConnectConfig.host = bridge.host;
                    sshConnectConfig.port = bridge.port;
                    writeLog("remote SSH tunnel reconnecting through restarted OpenSSH bridge [127.0.0.1:" +
                        bridge.port + "]");
                } catch (error) {
                    writeLog("OpenSSH bridge restart failed: " + error.message);
                    scheduleSSHTunnelReconnect("bridge restart failed");
                    return;
                }
            }
            const client = new SSHClient();
            sshClient = client;
            remoteSSHClient = client;
            client.on("ready", () => {
                remoteSSHAlive = true;
                remoteSSHReconnecting = false;
                const attempts = remoteSSHReconnectAttempt;
                remoteSSHReconnectAttempt = 0;
                attachConnectionScopedServices(client);
                writeLog("remote SSH tunnel recovered [after " + attempts + " attempt(s)]");
                remoteTrayStatus = "隧道 " + remoteSSHServerDesc + " 已连接 · 内核 v" + remoteKernelVersion;
                refreshTrayToolTips();
            });
            client.on("error", (error) => {
                // 重试失败只记日志，下一次重试由随后的 close 事件排程
                writeLog("remote SSH tunnel reconnect attempt " + remoteSSHReconnectAttempt + " failed: " +
                    error.message);
            });
            wireSSHTunnelCloseEvents(client);
            client.connect(sshConnectConfig);
        };
        const connectSSHTunnel = (resolve, reject) => {
            sshAttempt++;
            sshClient = new SSHClient();
            remoteSSHClient = sshClient;
            sshConnectConfig.readyTimeout = sshAttempt === 1 ? 30000 : 15000;
            sshClient.once("ready", () => {
                sshConnectSettled = true;
            });
            sshClient.on("ready", () => {
                remoteSSHEverReady = true;
                remoteSSHAlive = true;
                writeLog("remote SSH tunnel connected [" + sshUser + "@" + sshHost + ":" + sshPort +
                    "] [handshake " + (Date.now() - sshConnectStartedAt) + "ms]");
                reportRemoteBootProgress("ssh", "done", "握手 " + (Date.now() - sshConnectStartedAt) + "ms");
                reportRemoteBootProgress("forward", "active");
                if (tunnelServicesStarted) {
                    // ready 只应触发一次（ssh2 不会因 rekey 重发），兜底防重复初始化
                    resolve();
                    return;
                }
                tunnelServicesStarted = true;
                // 固定目标转发器：入站连接经 SSH 通道转发到内核，外部程序即使连上回环端口也只能到达内核且仍需授权码
                const forwardServer = gNet.createServer((socket) => {
                    // 隧道断开（重连中）期间入站连接直接断开，隧道恢复后新连接自动可用
                    if (!remoteSSHAlive) {
                        socket.destroy();
                        return;
                    }
                    // 入站 socket 与隧道通道都必须挂 error 监听：任一端 RST 时销毁对端，否则 error 事件抛成未捕获异常
                    let channel;
                    socket.on("error", () => {
                        if (channel) {
                            channel.destroy();
                        }
                    });
                    sshClient.forwardOut("127.0.0.1", 0, targetHost, parseInt(targetPort, 10), (error, ch) => {
                        if (error) {
                            writeLog("remote SSH tunnel forward failed: " + error.message);
                            socket.destroy();
                            return;
                        }
                        channel = ch;
                        channel.on("error", () => socket.destroy());
                        socket.pipe(channel).pipe(socket);
                    });
                });
                forwardServer.on("error", reject);
                // 内核转发器固定监听 forwardListenPort（默认 6806），端口被占用时报错走隧道失败回落，不静默换端口
                forwardServer.listen(forwardListenPort, "127.0.0.1", () => {
                    const localPort = forwardServer.address().port;
                    remoteKernelTarget.origin = "https://" + originURL.hostname + ":" + localPort;
                    writeLog("remote SSH tunnel forwarding [127.0.0.1:" + localPort + " -> " + targetHost + ":" + targetPort + "]");
                    reportRemoteBootProgress("forward", "done", "内核 127.0.0.1:" + localPort +
                        (webviewSites.length > 0 ? " + " + webviewSites.length + " 站点" : ""));
                    resolve();
                });
                if (webviewSites.length > 0) {
                    // webview 站点转发器与内核转发器同机制：复用同一 SSH 连接做固定目标转发；监听端口取站点固定端口
                    // （listenPort 或域名哈希），被占用时递增重试，仍失败才剔除该站点——不可用随机端口兜底，
                    // 否则站点 origin 每次启动都变，localStorage 等按 origin 隔离的存储随之失效（表现为登录态丢失）；
                    // 单站点失败只从列表剔除该站点并记日志，不影响其余站点；webviewSitesReadyPromise 在 ready 回调内
                    // 同步赋值，而隧道 Promise 在更晚的 listen 回调里 resolve，先等隧道 Promise 即可拿到完整列表
                    webviewSitesReadyPromise = Promise.all(webviewSites.map((site) => new Promise((resolveSite) => {
                        // 门禁开启但凭据不可用时不降级为无门禁管道（fail-closed），只剔除该站点
                        const gateCredentials = getWebViewGateCredentials();
                        if (webviewGateEnabled && !gateCredentials) {
                            writeLog("remote webview site forwarding failed [" + site.name +
                                "]: webview gate credentials unavailable");
                            resolveSite(null);
                            return;
                        }
                        const siteServer = gateCredentials
                            ? createWebViewGateServer({
                                site,
                                credentials: gateCredentials,
                                createTunnel: (tunnelSite, servername, onConnect, onError) =>
                                    createTunnelSocket(getActiveSSHClient, tunnelSite, servername, onConnect, onError),
                                writeLog,
                            })
                            : gNet.createServer((socket) => {
                                // 隧道断开（重连中）期间入站连接直接断开，隧道恢复后新连接自动可用
                                if (!remoteSSHAlive) {
                                    socket.destroy();
                                    return;
                                }
                                // 同内核转发器：入站 socket 与隧道通道都挂 error 监听，任一端 RST 销毁对端
                                let channel;
                                socket.on("error", () => {
                                    if (channel) {
                                        channel.destroy();
                                    }
                                });
                                sshClient.forwardOut("127.0.0.1", 0, site.targetHost, parseInt(site.targetPort, 10),
                                    (error, ch) => {
                                        if (error) {
                                            writeLog("remote webview site forward failed [" + site.name + "]: " +
                                                error.message);
                                            socket.destroy();
                                            return;
                                        }
                                        channel = ch;
                                        channel.on("error", () => socket.destroy());
                                        socket.pipe(channel).pipe(socket);
                                    });
                            });
                        let listenPort = site.localPort;
                        let listenRetriesLeft = 20;
                        siteServer.on("error", (error) => {
                            if (error.code === "EADDRINUSE" && listenRetriesLeft > 0) {
                                listenRetriesLeft--;
                                listenPort++;
                                siteServer.listen(listenPort, "127.0.0.1");
                                return;
                            }
                            writeLog("remote webview site forwarding failed [" + site.name + "]: " + error.message);
                            resolveSite(null);
                        });
                        siteServer.listen(listenPort, "127.0.0.1", () => {
                            const siteLocalPort = siteServer.address().port;
                            webviewSiteLocalEndpoints.set(site.hostname, {protocol: site.protocol, port: siteLocalPort});
                            writeLog("remote webview site forwarding [" + site.name + " 127.0.0.1:" + siteLocalPort +
                                " -> " + site.targetHost + ":" + site.targetPort + "]");
                            resolveSite({name: site.name, icon: site.icon, auth: site.auth,
                                url: site.protocol + "//" + site.hostname + ":" + siteLocalPort});
                        });
                    }))).then((results) => results.filter(Boolean));
                    // 提前挂上拒绝处理，避免站点转发器先于 IPC 调用失败时产生未处理的 Promise 拒绝
                    webviewSitesReadyPromise.catch(() => {});
                }
                if (httpProxyConfig) {
                    // HTTP 代理复用同一 SSH 连接：每条入站连接按请求目标动态建 forwardOut 通道，监听失败只记日志，
                    // 不影响内核转发器与 webview 站点转发器；port 为 0 时不开正向代理，只保留各站点 listenPort 入口
                    if (httpProxyConfig.port > 0) {
                        const httpProxyServer = createHttpProxyServer(getActiveSSHClient);
                        httpProxyServer.on("error", (error) => writeLog("remote http proxy failed: " + error.message));
                        httpProxyServer.listen(httpProxyConfig.port, "127.0.0.1", () => {
                            writeLog("remote http proxy listening [127.0.0.1:" + httpProxyConfig.port + "]");
                        });
                    }
                    // 一端口一站点：配了 listenPort 的站点各建独立 HTTP 服务器，浏览器直连 http://127.0.0.1:端口
                    // 明文访问，https 站点由服务器消化 TLS；单站监听失败只记日志剔除该站，不影响其余站点与代理
                    Object.keys(httpProxyConfig.sites).forEach((hostname) => {
                        const site = httpProxyConfig.sites[hostname];
                        if (!site.listenPort) {
                            return;
                        }
                        const httpSiteServer = createHttpProxySiteServer(getActiveSSHClient, site, hostname);
                        httpSiteServer.on("error", (error) =>
                            writeLog("remote http site failed [" + hostname + "]: " + error.message));
                        httpSiteServer.listen(site.listenPort, "127.0.0.1", () => {
                            writeLog("remote http site listening [" + hostname + " 127.0.0.1:" + site.listenPort +
                                " -> " + site.host + ":" + site.port + (site.tls ? " tls" : "") + "]");
                        });
                    });
                }
                if (sshServerConfig) {
                    // 内嵌 SSH Server + 反向打洞（等价 ssh -N -R）：随机回环端口仅作反向隧道内部管道；监听只建一次；
                    // forwardIn 与反向通道监听是连接级服务，每次 ready（含重连）由 attachConnectionScopedServices 重挂；
                    // 监听/forwardIn 失败只记日志，不影响内核隧道与其余转发器
                    const {createSSHServer} = require("../sshServer");
                    const embeddedSSHServer = createSSHServer({
                        username: sshServerConfig.username,
                        password: sshServerConfig.password,
                        publicKeys: sshServerConfig.publicKeys,
                        shell: sshServerConfig.shell,
                        hostKeyPath: path.join(confDir, "ssh-server-host-key"),
                        writeLog,
                    });
                    embeddedSSHServer.on("error", (error) => writeLog("remote ssh server failed: " + error.message));
                    embeddedSSHServer.listen(sshServerConfig.listenPort, "127.0.0.1", () => {
                        const sshServerPort = embeddedSSHServer.address().port;
                        sshServerListenState = {listening: true, port: sshServerPort};
                        writeLog("remote ssh server listening [127.0.0.1:" + sshServerPort + "]");
                        attachConnectionScopedServices(sshClient);
                    });
                }
            });
            const sshConnectStartedAt = Date.now();
            sshClient.on("error", (error) => {
                // 只在从未 ready 过且未到次数上限时重试；ready 之后的运行期错误交给重连循环（close 事件触发排程）
                if (!sshConnectSettled && sshAttempt < 3) {
                    writeLog("remote SSH tunnel attempt " + sshAttempt + " failed: " + error.message +
                        " [after " + (Date.now() - sshConnectStartedAt) + "ms], retrying");
                    setTimeout(() => connectSSHTunnel(resolve, reject), 2000);
                    return;
                }
                if (sshConnectSettled) {
                    writeLog("remote SSH tunnel error: " + error.message);
                    return;
                }
                reject(new Error("SSH connection failed: " + error.message +
                    " [after " + (Date.now() - sshConnectStartedAt) + "ms]"));
                reportRemoteBootProgress("ssh", "error", error.message);
            });
            wireSSHTunnelCloseEvents(sshClient);
            writeLog("remote SSH tunnel connecting [" + sshUser + "@" + sshHost + ":" + sshPort +
                "] [attempt " + sshAttempt + "/3] [boot +" + (Date.now() - bootStartedAt) + "ms]");
            reportRemoteBootProgress("ssh", "active",
                "第 " + sshAttempt + "/3 次 · " + sshUser + "@" + sshHost + ":" + sshPort);
            sshClient.connect(sshConnectConfig);
        };
        remoteSSHTunnelPromise = new Promise((resolve, reject) => {
            if (sshKeyPath) {
                try {
                    sshConnectConfig.privateKey = fs.readFileSync(sshKeyPath);
                } catch (error) {
                    reject(new Error("failed to read SSH private key: " + error.message));
                    return;
                }
            } else if (sshPassword) {
                sshConnectConfig.password = sshPassword;
            } else {
                reject(new Error("--remote-ssh requires --remote-ssh-key or --remote-ssh-password"));
                return;
            }
            openSSHBootstrapPromise.then((bridge) => {
                if (bridge) {
                    sshConnectConfig.host = bridge.host;
                    sshConnectConfig.port = bridge.port;
                    // The second SSH connection carries the configured SiYuan credentials.
                    writeLog("remote SSH tunnel connecting through local OpenSSH bridge [127.0.0.1:" +
                        bridge.port + "]");
                }
                connectSSHTunnel(resolve, reject);
            }, reject);
        });
        // 提前挂上拒绝处理，避免隧道先于 initRemoteKernel 失败时产生未处理的 Promise 拒绝
        remoteSSHTunnelPromise.catch(() => {});
    }
}
if (webviewSites.length > 0 && !remoteSSHTunnelPromise) {
    writeLog("webview sites ignored: no SSH tunnel");
}
if (httpProxyConfig && !remoteSSHTunnelPromise) {
    writeLog("http proxy ignored: no SSH tunnel");
}
if (sshServerConfig && !remoteSSHTunnelPromise) {
    writeLog("ssh server ignored: no SSH tunnel");
}

    const getWebViewSites = async () => {
        try {
            if (remoteSSHTunnelPromise) {
                await remoteSSHTunnelPromise;
            }
            if (webviewSitesReadyPromise) {
                return await webviewSitesReadyPromise;
            }
        } catch (error) {
            writeLog("get webview sites failed: " + error.message);
        }
        return [];
    };

    const getRemoteStatus = async (kernelTarget) => {
        const status = {
            mode: kernelTarget ? kernelTarget.mode : "local",
            origin: kernelTarget ? kernelTarget.origin : "",
            title: typeof remoteConfig.title === "string" ? remoteConfig.title : "",
            statusIndicator: remoteConfig.statusIndicator !== false,
            ssh: null,
            httpProxy: null,
            webviewSites: [],
            sshServer: null,
        };
        if (remoteSSHTunnelPromise) {
            status.ssh = {
                failed: remoteSSHFailed,
                alive: remoteSSHAlive,
                reconnecting: remoteSSHReconnecting,
                reconnectAttempt: remoteSSHReconnectAttempt,
                server: remoteSSHServerDesc,
                client: remoteSSHClientMode,
                target: remoteSSHTargetHost + ":" + remoteSSHTargetPort,
                forwardPort: remoteSSHForwardPort,
                bridgePort: remoteSSHBridgePort,
                latencyMs: await probeSSHTunnelLatency(),
            };
        }
        if (httpProxyConfig) {
            status.httpProxy = {
                port: httpProxyConfig.port,
                sites: Object.keys(httpProxyConfig.sites).map((hostname) => {
                    const site = httpProxyConfig.sites[hostname];
                    return {
                        hostname,
                        host: site.host,
                        port: site.port,
                        tls: site.tls,
                        insecure: site.insecure,
                        listenPort: site.listenPort,
                    };
                }),
            };
        }
        status.webviewSites = await getWebViewSites();
        if (sshServerConfig) {
            status.sshServer = {
                username: sshServerConfig.username,
                listenPort: sshServerConfig.listenPort,
                remoteHost: sshServerConfig.remoteHost,
                remotePort: sshServerConfig.remotePort,
                listening: sshServerListenState ? sshServerListenState.listening : false,
                localPort: sshServerListenState ? sshServerListenState.port : 0,
            };
        }
        return status;
    };

    const composeRemoteToolTip = () => {
        const suffix = remoteSSHTunnelPromise ? "sr" : "r";
        return "SiYuan v" + appVer + " " + suffix + (remoteTrayStatus ? "\n" + remoteTrayStatus : "");
    };

    const getWebViewSiteRedirect = (value) => {
        if (webviewSiteHostnames.size === 0) {
            return {site: false, redirectURL: ""};
        }
        try {
            const requestURL = new URL(value);
            if (!webviewSiteHostnames.has(requestURL.hostname)) {
                return {site: false, redirectURL: ""};
            }
            const endpoint = webviewSiteLocalEndpoints.get(requestURL.hostname);
            const isHttpScheme = requestURL.protocol === "http:" || requestURL.protocol === "https:";
            const requestPort = requestURL.port || (requestURL.protocol === "https:" ? "443" : "80");
            if (endpoint && isHttpScheme && parseInt(requestPort, 10) !== endpoint.port) {
                return {
                    site: true,
                    redirectURL: endpoint.protocol + "//" + requestURL.hostname + ":" + endpoint.port +
                        requestURL.pathname + requestURL.search,
                };
            }
            return {site: true, redirectURL: ""};
        } catch (error) {
            return {site: false, redirectURL: ""};
        }
    };

    const installGateCookies = (electronSession) => {
        const credentials = getWebViewGateCredentials();
        if (credentials) {
            plantWebViewGateCookies(electronSession, webviewSites, credentials.secret);
        }
    };

    const trustsGateCertificate = (hostname, fingerprint) => {
        const credentials = getWebViewGateCredentials();
        return !!credentials && isTrustedWebViewGateCertificate(hostname, fingerprint,
            (value) => webviewSiteHostnames.has(value), credentials.fingerprint);
    };

    return {
        get target() { return remoteKernelTarget; },
        get argError() { return remoteKernelArgError; },
        get failed() { return remoteSSHFailed; },
        get failedReason() { return getRemoteSSHFailedReasonText(); },
        get tunnelPromise() { return remoteSSHTunnelPromise; },
        get bootTimeoutMs() { return remoteBootTimeoutMs; },
        get autoAuthCode() { return getRemoteSetting("--remote-auth-code", "authCode"); },
        get ignoreVersionMismatch() { return remoteConfig.ignoreVersionMismatch === true; },
        get title() { return typeof remoteConfig.title === "string" ? remoteConfig.title : ""; },
        get trayStatus() { return remoteTrayStatus; },
        config: remoteConfig,
        getWebViewSites,
        getRemoteStatus,
        resolveFixedWindowTitle,
        composeRemoteToolTip,
        getWebViewSiteRedirect,
        installGateCookies,
        trustsGateCertificate,
        isWebViewSiteHostname: (hostname) => webviewSiteHostnames.has(hostname),
        setRemoteKernelVersion: (version) => { remoteKernelVersion = version; },
        setTrayStatus: (status) => { remoteTrayStatus = status; refreshTrayToolTips(); },
    };
};


const resolveCustomRemoteArgument = (launchArguments, confDir) => {
    const getArg = (name) => {
        const prefix = name + "=";
        const index = launchArguments.findIndex((item) => item === name || item.startsWith(prefix));
        if (index < 0) return undefined;
        if (launchArguments[index] !== name) return launchArguments[index].slice(prefix.length);
        const value = launchArguments[index + 1];
        return value !== undefined && !value.startsWith("-") ? value : "";
    };
    if (getArg("--remote-ssh-failed") !== undefined) return undefined;
    const arg = getArg("--remote");
    if (arg !== undefined) return arg;
    try {
        const file = path.join(confDir, "remote.json");
        if (!fs.existsSync(file)) return undefined;
        const config = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8"))) || {};
        return typeof config.remote === "string" && config.remote ? config.remote : undefined;
    } catch (error) {
        return undefined;
    }
};

module.exports = {createCustomRemote, resolveCustomRemoteArgument};
