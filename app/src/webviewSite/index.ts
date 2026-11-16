import {saveLayout} from "../layout/util";
import {escapeAriaLabel} from "../util/escape";
import {fetchWebViewSites, toggleWebViewSiteOverlay} from "./overlay";
import type {IWebViewSite} from "./overlay";

// 配置的图标 id 需存在于当前页面图标 sprite 中，否则回落 iconGlobe
const resolveWebViewSiteIcon = (site: IWebViewSite) => {
    if (site.icon && document.getElementById(site.icon)) {
        return site.icon;
    }
    return "iconGlobe";
};

// dock 站点图标与「面板」菜单的入口：点击切换该站点的覆盖层（再点一次当前站点收起）
export const toggleWebViewSiteOverlayByName = async (name: string) => {
    const site = (await fetchWebViewSites()).find((item) => item.name === name);
    if (site) {
        toggleWebViewSiteOverlay(site);
    }
};

// 左侧 dock 栏每站一个图标（type 均为 websites，以 data-title 区分站点）：新增站点补条目、下线的站点删条目、
// 已存在的条目保持原位（用户可能拖拽过）；只改 DOM，保存布局时由 dockToJSON 序列化回配置
export const reconcileWebViewSiteDockEntries = async () => {
    /// #if !BROWSER
    const sites = await fetchWebViewSites();
    const docks = [window.siyuan.layout.leftDock, window.siyuan.layout.rightDock, window.siyuan.layout.bottomDock];
    if (docks.some((dock) => !dock)) {
        return;
    }
    let changed = false;
    const existingItems: Element[] = [];
    docks.forEach((dock) => {
        dock.elements.forEach((container) => {
            Array.from(container.querySelectorAll('.dock__item[data-type="websites"]')).forEach((item) => {
                const site = sites.find((siteItem) => siteItem.name === item.getAttribute("data-title"));
                if (!site) {
                    item.remove();
                    changed = true;
                    return;
                }
                existingItems.push(item);
                const iconId = resolveWebViewSiteIcon(site);
                const useElement = item.querySelector("use");
                if (useElement && useElement.getAttribute("xlink:href") !== `#${iconId}`) {
                    useElement.setAttribute("xlink:href", `#${iconId}`);
                    changed = true;
                }
            });
        });
    });
    const container = window.siyuan.layout.leftDock.elements[0];
    sites.forEach((site) => {
        if (existingItems.some((item) => item.getAttribute("data-title") === site.name)) {
            return;
        }
        const itemElement = document.createElement("span");
        itemElement.className = "dock__item ariaLabel";
        itemElement.setAttribute("data-height", "0");
        itemElement.setAttribute("data-width", "232");
        itemElement.setAttribute("data-type", "websites");
        itemElement.setAttribute("data-index", "0");
        itemElement.setAttribute("data-hotkeylangid", "");
        itemElement.setAttribute("data-title", site.name);
        itemElement.setAttribute("data-position", "8east");
        itemElement.setAttribute("aria-label",
            `<span style='white-space:pre'>${escapeAriaLabel(site.name)} ${window.siyuan.languages.dockTip}</span>`);
        // svg 元素必须走 createElementNS（document.createElement 建出的是 HTML 命名空间未知元素，图标不渲染），
        // 且 xlink:href 必须 setAttributeNS 写入（setAttribute 写上的是无命名空间属性，use 不解析）
        const svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const useElement = document.createElementNS("http://www.w3.org/2000/svg", "use");
        useElement.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${resolveWebViewSiteIcon(site)}`);
        svgElement.append(useElement);
        itemElement.append(svgElement);
        container.append(itemElement);
        changed = true;
    });
    docks.forEach((dock) => {
        const hasEntry = dock.elements.some((element) => element.querySelector('.dock__item[data-type="websites"]'));
        if (hasEntry) {
            dock.data["websites"] = true;
        } else {
            delete dock.data["websites"];
        }
    });
    if (changed) {
        saveLayout();
    }
    /// #endif
};
