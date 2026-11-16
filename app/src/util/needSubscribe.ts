// 定制补丁：移除官方云订阅门控，所有云端功能直接放行，不再弹出订阅提示
export const needSubscribe = (tip = window.siyuan.languages._kernel[29]) => {
    void tip;
    return false;
};

/**
 * 判断是否可以使用第三方同步
 */
export const isPaidUser = () => {
    // 定制补丁：内核侧已恒为付费用户，前端直接放行第三方同步
    return true;
};
