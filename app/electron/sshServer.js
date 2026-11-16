// 内嵌 SSH Server（移植自 shell-test/ssh-server-ref/SSH_Server/server.js，收敛为工厂模块）：
// 密码/公钥认证、shell（node-pty 的 ConPTY 真伪终端）、exec、SFTP（/mnt/<盘符> 挂载本机盘符，WSL 风格）；
// 本模块只创建 ssh2 Server 实例，监听与 forwardIn 反向打洞由 main.js 的隧道 ready 回调完成；
// node-pty 为 N-API 原生模块，加载失败（如杀软删 dll）时只拒绝 shell 请求，exec/SFTP 不受影响
const fs = require("fs");
const path = require("path");
const os = require("os");
const {spawn, spawnSync} = require("child_process");
const {
    Server,
    utils: {generateKeyPairSync, parseKey},
    SFTP_STATUS_CODE,
    SFTP_OPEN_MODE,
} = require("ssh2");

let pty = null;
let ptyLoadError = null;
try {
    pty = require("node-pty");
} catch (error) {
    ptyLoadError = error;
}

const STATUS = SFTP_STATUS_CODE || {
    OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8,
};
const OPEN_MODE = SFTP_OPEN_MODE || {
    READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32,
};

// ---------- shell 配置 ----------
const SHELL_PRESETS = {
    pwsh: {bin: "pwsh.exe", interactive: ["-NoLogo"], execArgs: (c) => ["-NoProfile", "-Command", c]},
    powershell: {bin: "powershell.exe", interactive: ["-NoLogo"], execArgs: (c) => ["-NoProfile", "-Command", c]},
    cmd: {bin: process.env.COMSPEC || "cmd.exe", interactive: ["/q"], execArgs: (c) => ["/d", "/s", "/c", c]},
};

const commandExists = (bin) => {
    if (/[\\/]/.test(bin)) {
        return fs.existsSync(bin);
    }
    return spawnSync("where.exe", [bin], {stdio: "ignore"}).status === 0;
};

// 解析 shell 指定项（pwsh/powershell/cmd/可执行文件路径），返回 {name, bin, interactive, execArgs}；不可用返回 null
const resolveShell = (spec) => {
    const cfg = SHELL_PRESETS[spec.toLowerCase()];
    if (cfg) {
        if (!commandExists(cfg.bin)) {
            return null;
        }
        return {name: spec.toLowerCase(), ...cfg};
    }
    // 自定义可执行文件：按文件名推断参数风格
    if (!commandExists(spec)) {
        return null;
    }
    const base = path.basename(spec).toLowerCase();
    const style = /pwsh|powershell/.test(base) ? SHELL_PRESETS.pwsh : SHELL_PRESETS.cmd;
    return {name: spec, bin: spec, interactive: style.interactive, execArgs: style.execArgs};
};

// 缺省 pwsh，未安装时依次回退 powershell -> cmd；自定义路径不可用时也回退到同一链
const pickShell = (spec, writeLog) => {
    const cfg = resolveShell(spec || "pwsh");
    if (cfg) {
        return cfg;
    }
    for (const fallback of ["pwsh", "powershell", "cmd"]) {
        const fb = resolveShell(fallback);
        if (fb) {
            writeLog("remote ssh server shell fallback [" + (spec || "pwsh") + " -> " + fallback + "]");
            return fb;
        }
    }
    return null;
};

// ---------- host key：存在则读，否则生成 ED25519 并写 0600 ----------
const loadOrCreateHostKey = (hostKeyPath, writeLog) => {
    if (fs.existsSync(hostKeyPath)) {
        return fs.readFileSync(hostKeyPath, "utf8");
    }
    const keys = generateKeyPairSync("ed25519");
    fs.writeFileSync(hostKeyPath, keys.private, {mode: 0o600});
    writeLog("remote ssh server host key generated [path=" + hostKeyPath + "]");
    return keys.private;
};

// ---------- /mnt/<drive> 虚拟路径映射 ----------
const getDrives = () => {
    const drives = [];
    for (let i = 67; i <= 90; i++) { // C..Z
        const letter = String.fromCharCode(i);
        try {
            fs.accessSync(letter + ":\\");
            drives.push(letter);
        } catch (_) { /* drive not present */ }
    }
    return drives;
};

const normalizeVPath = (p) => {
    p = String(p).replace(/\\/g, "/");
    if (!p.startsWith("/")) {
        p = "/" + p;
    }
    p = path.posix.normalize(p);
    if (p.length > 1 && p.endsWith("/")) {
        p = p.slice(0, -1);
    }
    return p;
};

// 返回 { kind: 'root' | 'mnt' | 'real', vpath, real? }
const resolveVPath = (vpath) => {
    const p = normalizeVPath(vpath);
    if (p === "/") {
        return {kind: "root", vpath: "/"};
    }
    if (p === "/mnt") {
        return {kind: "mnt", vpath: "/mnt"};
    }
    const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
    if (m) {
        const drive = m[1].toUpperCase();
        if (!getDrives().includes(drive)) {
            return null;
        }
        const rest = (m[2] || "").replace(/\//g, "\\");
        return {kind: "real", vpath: p, real: drive + ":\\" + rest};
    }
    return null;
};

// ---------- SFTP 辅助 ----------
const statToAttrs = (st) => ({
    mode: st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
});

const dirAttrs = () => {
    const now = Math.floor(Date.now() / 1000);
    return {mode: 0o40755, uid: 0, gid: 0, size: 0, atime: now, mtime: now};
};

// 模仿 pwsh Get-ChildItem 的列格式: Mode  LastWriteTime  Length  Name
const longname = (filename, attrs) => {
    const isDir = (attrs.mode & 0o170000) === 0o040000;
    const mode = isDir ? "d-----" : "-a----";
    const d = new Date(attrs.mtime * 1000);
    const p2 = (n) => String(n).padStart(2, "0");
    const time = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ` +
        `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const len = isDir ? "" : String(attrs.size);
    return `${mode}  ${time.padStart(19)}  ${len.padStart(14)}  ${filename}`;
};

const entry = (filename, attrs) => ({filename, longname: longname(filename, attrs), attrs});

const errStatus = (err) => {
    switch (err && err.code) {
        case "ENOENT": return STATUS.NO_SUCH_FILE;
        case "EACCES":
        case "EPERM": return STATUS.PERMISSION_DENIED;
        default: return STATUS.FAILURE;
    }
};

const openFlagsToFs = (flags) => {
    const read = !!(flags & OPEN_MODE.READ);
    const write = !!(flags & OPEN_MODE.WRITE);
    if (write) {
        if (flags & OPEN_MODE.APPEND) {
            return (flags & OPEN_MODE.CREAT) ? "a+" : "r+";
        }
        if (flags & OPEN_MODE.TRUNC) {
            return "w+";
        }
        return (flags & OPEN_MODE.CREAT) ? "wx+" : "r+";
    }
    return "r";
};

// 虚拟目录列表
const listVirtual = (kind) => {
    if (kind === "root") {
        return [entry("mnt", dirAttrs())];
    }
    return getDrives().map((d) => entry(d.toLowerCase(), dirAttrs()));
};

// ---------- SFTP 会话 ----------
const setupSftp = (sftp) => {
    let handleCount = 0;
    const handles = new Map(); // handle(Buffer -> string key) -> { type: 'fd', fd } | { type: 'dir', entries, pos }

    const newHandle = (obj) => {
        const h = Buffer.from(String(++handleCount).padStart(4, "0"));
        handles.set(h.toString("hex"), obj);
        return h;
    };
    const getHandle = (h) => handles.get(Buffer.from(h).toString("hex"));
    const delHandle = (h) => handles.delete(Buffer.from(h).toString("hex"));

    sftp.on("OPEN", (reqid, filename, flags, attrs) => {
        const r = resolveVPath(filename);
        if (!r || r.kind !== "real") {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        fs.open(r.real, openFlagsToFs(flags), attrs && attrs.mode, (err, fd) => {
            if (err) {
                return sftp.status(reqid, errStatus(err));
            }
            sftp.handle(reqid, newHandle({type: "fd", fd}));
        });
    });

    sftp.on("READ", (reqid, handle, offset, length) => {
        const h = getHandle(handle);
        if (!h || h.type !== "fd") {
            return sftp.status(reqid, STATUS.FAILURE);
        }
        const buf = Buffer.alloc(length);
        fs.read(h.fd, buf, 0, length, offset, (err, bytesRead) => {
            if (err) {
                return sftp.status(reqid, errStatus(err));
            }
            if (bytesRead === 0) {
                return sftp.status(reqid, STATUS.EOF);
            }
            sftp.data(reqid, buf.slice(0, bytesRead));
        });
    });

    sftp.on("WRITE", (reqid, handle, offset, data) => {
        const h = getHandle(handle);
        if (!h || h.type !== "fd") {
            return sftp.status(reqid, STATUS.FAILURE);
        }
        fs.write(h.fd, data, 0, data.length, offset, (err) => {
            if (err) {
                return sftp.status(reqid, errStatus(err));
            }
            sftp.status(reqid, STATUS.OK);
        });
    });

    sftp.on("CLOSE", (reqid, handle) => {
        const h = getHandle(handle);
        delHandle(handle);
        if (!h) {
            return sftp.status(reqid, STATUS.FAILURE);
        }
        if (h.type === "fd") {
            fs.close(h.fd, (err) => sftp.status(reqid, err ? errStatus(err) : STATUS.OK));
        } else {
            sftp.status(reqid, STATUS.OK);
        }
    });

    sftp.on("OPENDIR", (reqid, vpath) => {
        const r = resolveVPath(vpath);
        if (!r) {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        if (r.kind !== "real") {
            return sftp.handle(reqid, newHandle({type: "dir", entries: listVirtual(r.kind), pos: 0}));
        }
        fs.readdir(r.real, (err, files) => {
            if (err) {
                return sftp.status(reqid, errStatus(err));
            }
            const entries = files.map((f) => {
                let attrs;
                try {
                    attrs = statToAttrs(fs.lstatSync(path.join(r.real, f)));
                } catch (_) {
                    attrs = {mode: 0o100644, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0};
                }
                return entry(f, attrs);
            });
            sftp.handle(reqid, newHandle({type: "dir", entries, pos: 0}));
        });
    });

    sftp.on("READDIR", (reqid, handle) => {
        const h = getHandle(handle);
        if (!h || h.type !== "dir") {
            return sftp.status(reqid, STATUS.FAILURE);
        }
        if (h.pos >= h.entries.length) {
            return sftp.status(reqid, STATUS.EOF);
        }
        const batch = h.entries.slice(h.pos, h.pos + 64);
        h.pos += batch.length;
        sftp.name(reqid, batch);
    });

    const doStat = (reqid, vpath, statFn) => {
        const r = resolveVPath(vpath);
        if (!r) {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        if (r.kind !== "real") {
            return sftp.attrs(reqid, dirAttrs());
        }
        statFn(r.real, (err, st) => {
            if (err) {
                return sftp.status(reqid, errStatus(err));
            }
            sftp.attrs(reqid, statToAttrs(st));
        });
    };

    sftp.on("STAT", (reqid, vpath) => doStat(reqid, vpath, fs.stat));
    sftp.on("LSTAT", (reqid, vpath) => doStat(reqid, vpath, fs.lstat));

    sftp.on("FSTAT", (reqid, handle) => {
        const h = getHandle(handle);
        if (!h || h.type !== "fd") {
            return sftp.status(reqid, STATUS.FAILURE);
        }
        fs.fstat(h.fd, (err, st) => {
            if (err) {
                return sftp.status(reqid, errStatus(err));
            }
            sftp.attrs(reqid, statToAttrs(st));
        });
    });

    sftp.on("SETSTAT", (reqid, vpath, attrs) => {
        const r = resolveVPath(vpath);
        if (!r || r.kind !== "real") {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        const ops = [];
        if (attrs.mode != null) {
            ops.push((cb) => fs.chmod(r.real, attrs.mode, cb));
        }
        if (attrs.size != null) {
            ops.push((cb) => fs.truncate(r.real, attrs.size, cb));
        }
        if (attrs.atime != null && attrs.mtime != null) {
            ops.push((cb) => fs.utimes(r.real, attrs.atime, attrs.mtime, cb));
        }
        (function next(i) {
            if (i >= ops.length) {
                return sftp.status(reqid, STATUS.OK);
            }
            ops[i]((err) => (err ? sftp.status(reqid, errStatus(err)) : next(i + 1)));
        })(0);
    });

    sftp.on("FSETSTAT", (reqid, handle, attrs) => {
        const h = getHandle(handle);
        if (!h || h.type !== "fd") {
            return sftp.status(reqid, STATUS.FAILURE);
        }
        sftp.status(reqid, STATUS.OK); // 简化：直接成功
    });

    sftp.on("REMOVE", (reqid, vpath) => {
        const r = resolveVPath(vpath);
        if (!r || r.kind !== "real") {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        fs.unlink(r.real, (err) => sftp.status(reqid, err ? errStatus(err) : STATUS.OK));
    });

    sftp.on("MKDIR", (reqid, vpath, attrs) => {
        const r = resolveVPath(vpath);
        if (!r || r.kind !== "real") {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        fs.mkdir(r.real, (err) => sftp.status(reqid, err ? errStatus(err) : STATUS.OK));
    });

    sftp.on("RMDIR", (reqid, vpath) => {
        const r = resolveVPath(vpath);
        if (!r || r.kind !== "real") {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        fs.rmdir(r.real, (err) => sftp.status(reqid, err ? errStatus(err) : STATUS.OK));
    });

    sftp.on("RENAME", (reqid, oldPath, newPath) => {
        const o = resolveVPath(oldPath);
        const n = resolveVPath(newPath);
        if (!o || !n || o.kind !== "real" || n.kind !== "real") {
            return sftp.status(reqid, STATUS.NO_SUCH_FILE);
        }
        fs.rename(o.real, n.real, (err) => sftp.status(reqid, err ? errStatus(err) : STATUS.OK));
    });

    sftp.on("REALPATH", (reqid, vpath) => {
        const r = resolveVPath(vpath);
        const name = r ? r.vpath : normalizeVPath(vpath);
        sftp.name(reqid, [{filename: name, longname: name, attrs: dirAttrs()}]);
    });

    const unsupported = ["READLINK", "SYMLINK", "LINK", "EXTENDED"];
    for (const ev of unsupported) {
        sftp.on(ev, (reqid) => sftp.status(reqid, STATUS.OP_UNSUPPORTED));
    }
};

// ---------- shell / exec ----------
const setupSession = (accept, reject, info, shellCfg, writeLog) => {
    const session = accept();
    let ptyInfo = null;
    let shellProc = null;

    session.on("pty", (acceptPty, rejectPty, info) => {
        ptyInfo = info;
        acceptPty();
    });

    session.on("shell", (acceptShell, rejectShell) => {
        if (!pty || !shellCfg) {
            // node-pty 不可用（加载失败或 shell 解析失败）时拒绝 shell，exec/SFTP 不受影响
            writeLog("remote ssh server shell request rejected: pty unavailable");
            rejectShell();
            return;
        }
        const stream = acceptShell();
        // 使用 ConPTY 真伪终端：行编辑（退格/方向键/历史）、窗口大小同步、全屏 TUI 均可用；
        // cwd 用用户家目录（打包版 process.cwd() 不可靠），env 继承主进程环境
        shellProc = pty.spawn(shellCfg.bin, shellCfg.interactive, {
            name: (ptyInfo && ptyInfo.term) || "xterm-256color",
            cols: (ptyInfo && ptyInfo.cols) || 80,
            rows: (ptyInfo && ptyInfo.rows) || 24,
            cwd: os.homedir(),
            env: process.env,
        });
        shellProc.onData((d) => stream.write(d));
        shellProc.onExit(({exitCode}) => {
            stream.exit(exitCode || 0);
            stream.end();
        });
        stream.on("data", (d) => shellProc.write(d));
        stream.on("close", () => {
            try {
                shellProc.kill();
            } catch (_) {
                // shell 进程可能已退出，忽略
            }
        });
    });

    session.on("window-change", (acceptWc, rejectWc, info) => {
        if (shellProc) {
            try {
                shellProc.resize(info.cols, info.rows);
            } catch (_) {
                // 进程已退出时 resize 会抛错，忽略
            }
        }
        if (acceptWc) {
            acceptWc();
        }
    });

    session.on("exec", (acceptExec, rejectExec, info) => {
        if (!shellCfg) {
            writeLog("remote ssh server exec request rejected: shell unavailable");
            rejectExec();
            return;
        }
        const stream = acceptExec();
        const cmd = info.command;
        writeLog("remote ssh server exec [" + cmd + "]");
        const proc = spawn(shellCfg.bin, shellCfg.execArgs(cmd), {stdio: ["ignore", "pipe", "pipe"]});
        proc.stdout.on("data", (d) => stream.stdout.write(d));
        proc.stderr.on("data", (d) => stream.stderr.write(d));
        proc.on("error", (err) => {
            stream.stderr.write(String(err));
            stream.exit(1);
            stream.end();
        });
        proc.on("close", (code) => {
            stream.exit(code == null ? 1 : code);
            stream.end();
        });
    });

    session.on("sftp", (acceptSftp, rejectSftp) => {
        writeLog("remote ssh server sftp session started");
        setupSftp(acceptSftp());
    });

    session.on("close", () => {
        if (shellProc) {
            try {
                shellProc.kill();
            } catch (_) {
                // shell 进程可能已退出，忽略
            }
        }
    });
};

// ---------- 工厂 ----------
// options: {username, password, publicKeys, shell, hostKeyPath, writeLog}
// 认证：password 比对 username+password；publickey 解析配置公钥后与 ctx.key 比对 algo+data，任一通过即可
const createSSHServer = (options) => {
    const writeLog = options.writeLog;
    if (ptyLoadError) {
        writeLog("remote ssh server pty unavailable: " + ptyLoadError.message);
    }
    const shellCfg = pickShell(options.shell, writeLog);
    if (!shellCfg) {
        writeLog("remote ssh server shell unavailable: " + (options.shell || "pwsh"));
    }
    const methods = [];
    if (options.password) {
        methods.push("password");
    }
    if (options.publicKeys && options.publicKeys.length > 0) {
        methods.push("publickey");
    }
    // 预解析配置公钥，解析失败的条目记日志剔除
    const parsedKeys = (options.publicKeys || []).map((key) => {
        const parsed = parseKey(key);
        if (parsed instanceof Error) {
            writeLog("remote ssh server public key ignored: " + parsed.message);
            return null;
        }
        return Array.isArray(parsed) ? parsed[0] : parsed;
    }).filter(Boolean);

    const server = new Server({hostKeys: [loadOrCreateHostKey(options.hostKeyPath, writeLog)]}, (client) => {
        client.on("authentication", (ctx) => {
            if (ctx.username !== options.username) {
                ctx.reject(methods);
                return;
            }
            if (ctx.method === "password" && options.password && ctx.password === options.password) {
                writeLog("remote ssh server auth ok [" + ctx.username + " password]");
                ctx.accept();
                return;
            }
            if (ctx.method === "publickey" && parsedKeys.length > 0) {
                const match = parsedKeys.some((key) =>
                    key.type === ctx.key.algo && key.getPublicSSH().equals(ctx.key.data));
                if (match) {
                    writeLog("remote ssh server auth ok [" + ctx.username + " publickey]");
                    ctx.accept();
                    return;
                }
            }
            writeLog("remote ssh server auth rejected [" + ctx.username + " " + ctx.method + "]");
            ctx.reject(methods);
        });

        client.on("ready", () => {
            client.on("session", (accept, reject, info) => setupSession(accept, reject, info, shellCfg, writeLog));
        });

        client.on("error", () => {});
    });
    return server;
};

module.exports = {createSSHServer};
