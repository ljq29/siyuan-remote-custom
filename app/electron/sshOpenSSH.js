const getOpenSSHExecutable = () => process.platform === "win32" ? "ssh.exe" : "ssh";

const buildOpenSSHArgs = ({user, host, port, localPort, targetHost, targetPort, keyPath}) => {
    const args = [
        "-N", "-T",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3",
    ];
    if (keyPath) {
        args.push("-i", keyPath);
    }
    args.push("-p", String(port), "-L", "127.0.0.1:" + localPort + ":" + targetHost + ":" + targetPort,
        user + "@" + host);
    return args;
};

// 桥监听端口配置解析：undefined/0 表示随机临时端口，1-65535 为固定起始端口（被占用时由调用方递增重试），其余非法
const resolveSSHBridgePort = (value) => {
    if (value === undefined || value === null || value === 0 || value === "0") {
        return 0;
    }
    const port = typeof value === "number" ? value : (/^\d+$/.test(String(value)) ? parseInt(value, 10) : NaN);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
        return port;
    }
    throw new Error("--remote-ssh-bridge-port requires a TCP port number (0 for random)");
};

module.exports = {buildOpenSSHArgs, getOpenSSHExecutable, resolveSSHBridgePort};
