/// #if !BROWSER
import {ipcRenderer} from "electron";
/// #endif

export interface IWebViewSiteAuth {
    username: string;
    password: string;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
}

export interface IWebViewSite {
    name: string;
    url: string;
    icon?: string;
    auth?: IWebViewSiteAuth | null;
}

// 站点列表只拉取一次并缓存：主进程 handler 内部会等转发器就绪，前端拿到的是最终结果
let webViewSitesPromise: Promise<IWebViewSite[]> | null = null;
export const fetchWebViewSites = (): Promise<IWebViewSite[]> => {
    if (!webViewSitesPromise) {
        /// #if !BROWSER
        webViewSitesPromise = ipcRenderer.invoke("siyuan-get-webview-sites")
            .then((sites: IWebViewSite[]) => Array.isArray(sites) ? sites : [])
            .catch((): IWebViewSite[] => []);
        /// #else
        webViewSitesPromise = Promise.resolve([]);
        /// #endif
    }
    return webViewSitesPromise;
};

interface ISiteFrame {
    container: HTMLElement;
    webview: Electron.WebviewTag;
    homeUrl: string;
}

let overlayElement: HTMLElement | null = null;
let activeSiteName = "";
const siteFrames = new Map<string, ISiteFrame>();

// 覆盖层只遮文档内容区，不遮页签栏（页签栏可点是"点其他页签即隐藏"的前提）；top 取页签栏高度
const updateOverlayOffset = () => {
    const tabBarElement = document.querySelector(".layout__center .layout-tab-bar");
    overlayElement.style.top = (tabBarElement ? tabBarElement.getBoundingClientRect().height : 0) + "px";
};

const hideWebViewSiteOverlay = () => {
    if (overlayElement) {
        overlayElement.classList.add("fn__none");
    }
    activeSiteName = "";
};

const getActiveFrame = () => siteFrames.get(activeSiteName);

const updateNavState = () => {
    if (!overlayElement) {
        return;
    }
    const frame = getActiveFrame();
    const backElement = overlayElement.querySelector('[data-type="back"]');
    const forwardElement = overlayElement.querySelector('[data-type="forward"]');
    if (frame && frame.webview.canGoBack()) {
        backElement.removeAttribute("disabled");
    } else {
        backElement.setAttribute("disabled", "disabled");
    }
    if (frame && frame.webview.canGoForward()) {
        forwardElement.removeAttribute("disabled");
    } else {
        forwardElement.setAttribute("disabled", "disabled");
    }
};

// 自动填充脚本：页面不存在密码框（=已登录）时不动作；存在则填充并提交。
// 站点名、账号、密码与选择器一律 JSON.stringify 转义后注入，防引号截断
const buildAutofillScript = (auth: IWebViewSiteAuth) => {
    const pickSelector = (selector: string | undefined, fallback: string) =>
        `document.querySelector(${JSON.stringify(selector || "")} || ${JSON.stringify(fallback)})`;
    return `(() => {
        const setValue = (input, value) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
            input.dispatchEvent(new Event("input", {bubbles: true}));
            input.dispatchEvent(new Event("change", {bubbles: true}));
        };
        const passwordInput = ${pickSelector(auth.passwordSelector, 'input[type="password"]')};
        if (!passwordInput) {
            return;
        }
        const form = passwordInput.closest("form");
        let usernameInput = ${auth.usernameSelector
            ? `document.querySelector(${JSON.stringify(auth.usernameSelector)})`
            : "null"};
        if (!usernameInput && form) {
            usernameInput = form.querySelector('input[type="email"], input[type="text"], input[name*="user" i], input[name*="email" i], input:not([type])');
        }
        if (usernameInput) {
            setValue(usernameInput, ${JSON.stringify(auth.username)});
        }
        setValue(passwordInput, ${JSON.stringify(auth.password)});
        let submitButton = ${auth.submitSelector
            ? `document.querySelector(${JSON.stringify(auth.submitSelector)})`
            : "null"};
        if (!submitButton && form) {
            submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
        }
        if (submitButton) {
            submitButton.click();
        } else if (form) {
            form.requestSubmit();
        }
    })();`;
};

// 每站点一个常驻 webview（display 切换保活：登录态、页面状态、滚动位置全保留）；
// webview 必须先设 src 再插入 DOM，否则 attach 时主进程白名单校验不到目标地址会拦截且不再重试
const ensureSiteFrame = (site: IWebViewSite): ISiteFrame => {
    const existing = siteFrames.get(site.name);
    if (existing) {
        return existing;
    }
    const container = document.createElement("div");
    container.className = "siyuan-webview-overlay__frame fn__none";
    const frameElement = document.createElement("webview") as Electron.WebviewTag;
    frameElement.setAttribute("src", site.url);
    container.append(frameElement);
    overlayElement.querySelector('[data-role="frames"]').append(container);
    const frame: ISiteFrame = {container, webview: frameElement, homeUrl: site.url};
    siteFrames.set(site.name, frame);
    frameElement.addEventListener("did-navigate", updateNavState);
    frameElement.addEventListener("did-navigate-in-page", updateNavState);
    frameElement.addEventListener("dom-ready", () => {
        updateNavState();
        if (site.auth) {
            frameElement.executeJavaScript(buildAutofillScript(site.auth)).catch(() => {
                // 自动填充失败静默，页面停留在登录框由用户手动处理
            });
        }
    });
    return frame;
};

const ensureOverlay = (centerElement: HTMLElement) => {
    if (overlayElement) {
        return;
    }
    overlayElement = document.createElement("div");
    overlayElement.className = "siyuan-webview-overlay fn__none";
    overlayElement.innerHTML = `<div class="block__icons">
    <span data-type="back" class="block__icon block__icon--show ariaLabel"><svg><use xlink:href="#iconBack"></use></svg></span>
    <span data-type="forward" class="block__icon block__icon--show ariaLabel"><svg><use xlink:href="#iconForward"></use></svg></span>
    <span data-type="refresh" class="block__icon block__icon--show ariaLabel"><svg><use xlink:href="#iconRefresh"></use></svg></span>
    <span data-type="home" class="block__icon block__icon--show ariaLabel"><svg><use xlink:href="#iconHome"></use></svg></span>
    <div class="fn__flex-1"></div>
    <span class="fn__ellipsis" data-role="name" style="color: var(--b3-theme-on-surface-light);max-width: 50%"></span>
</div>
<div class="fn__flex-1" data-role="frames" style="position: relative;min-height: 0"></div>`;
    centerElement.append(overlayElement);
    const backElement = overlayElement.querySelector('[data-type="back"]');
    const forwardElement = overlayElement.querySelector('[data-type="forward"]');
    const refreshElement = overlayElement.querySelector('[data-type="refresh"]');
    const homeElement = overlayElement.querySelector('[data-type="home"]');
    backElement.setAttribute("aria-label", window.siyuan.languages.goBack);
    forwardElement.setAttribute("aria-label", window.siyuan.languages.goForward);
    refreshElement.setAttribute("aria-label", window.siyuan.languages.refresh);
    backElement.addEventListener("click", () => {
        const frame = getActiveFrame();
        if (frame && frame.webview.canGoBack()) {
            frame.webview.goBack();
        }
    });
    forwardElement.addEventListener("click", () => {
        const frame = getActiveFrame();
        if (frame && frame.webview.canGoForward()) {
            frame.webview.goForward();
        }
    });
    refreshElement.addEventListener("click", () => {
        const frame = getActiveFrame();
        if (frame) {
            frame.webview.reload();
        }
    });
    homeElement.addEventListener("click", () => {
        const frame = getActiveFrame();
        if (frame) {
            frame.webview.loadURL(frame.homeUrl).catch(() => updateNavState());
        }
    });
    // 捕获阶段监听 center 内的按下事件：落在覆盖层之外（页签栏、分隔条等）即隐藏覆盖层，
    // 程序化页签切换（快捷键、文档树开文档）由 Wnd.switchTab 里的 DOM 兜底隐藏
    centerElement.addEventListener("pointerdown", (event) => {
        if (overlayElement && !overlayElement.classList.contains("fn__none") &&
            !overlayElement.contains(event.target as Node)) {
            hideWebViewSiteOverlay();
        }
    }, true);
};

const showSite = (site: IWebViewSite) => {
    updateOverlayOffset();
    ensureSiteFrame(site);
    siteFrames.forEach((item, name) => {
        item.container.classList.toggle("fn__none", name !== site.name);
    });
    activeSiteName = site.name;
    const nameElement = overlayElement.querySelector('[data-role="name"]');
    nameElement.textContent = site.name;
    overlayElement.querySelector('[data-type="home"]').setAttribute("aria-label", site.name);
    overlayElement.classList.remove("fn__none");
    updateNavState();
};

// dock 站点图标与「面板」菜单的入口：当前正显示该站点则收起，否则显示/切换到该站点
export const toggleWebViewSiteOverlay = (site: IWebViewSite) => {
    /// #if !BROWSER
    const centerElement = document.querySelector(".layout__center") as HTMLElement;
    if (!centerElement) {
        return;
    }
    ensureOverlay(centerElement);
    if (activeSiteName === site.name && !overlayElement.classList.contains("fn__none")) {
        hideWebViewSiteOverlay();
        return;
    }
    showSite(site);
    /// #endif
};
