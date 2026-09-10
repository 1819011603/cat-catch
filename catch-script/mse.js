// 猫抓 MSE 追踪
// 解决的问题：MSE 播放时 video.currentSrc 是 blob: 开头的假地址 跟真实资源地址没有任何关系
// 于是从 SourceBuffer.appendBuffer 反查 —— 喂给这个 video 的数据是从哪个 URL 拉来的
// 拿到的映射交给 content-script 缓存 popup 的「定位」按钮据此勾选正在播放的资源
// 必须在页面脚本之前执行 所以走 document_start 注入 开启后需要刷新页面才能挂上钩子
(function () {
    if (typeof MediaSource == "undefined" || typeof SourceBuffer == "undefined") { return; }
    // 同一 frame 重复注入时 第二次直接退出 否则钩子套钩子
    if (self.__catCatchMSE) { return; }
    self.__catCatchMSE = true;

    // 防止被页面劫持
    const _postMessage = self.postMessage;

    const msBlob = new WeakMap();   // MediaSource -> createObjectURL 生成的 blob 地址
    const sbSource = new WeakMap(); // SourceBuffer -> 所属 MediaSource
    const bufUrl = new WeakMap();   // ArrayBuffer -> 数据来源 URL
    const sizeUrl = [];             // {size, url} 页面拷贝过 buffer 导致对象对不上时 按体积兜底
    const posted = new Set();       // 已上报的 blobSrc|url 去重
    const SIZE_CACHE = 64;
    const POSTED_MAX = 500;

    /**
     * 记录「某个 ArrayBuffer 来自某个 URL」
     * 不复制数据 只在响应体已经被页面自己解出来时顺手记一笔
     */
    function remember(url, buffer) {
        if (!url || !buffer || !buffer.byteLength) { return; }
        try { bufUrl.set(buffer, url); } catch (e) { }
        sizeUrl.push({ size: buffer.byteLength, url: url });
        sizeUrl.length > SIZE_CACHE && sizeUrl.shift();
    }

    /**
     * 按体积倒查来源 取最近的一条
     * 页面做过 slice/拼接 体积就对不上 查不到就放弃 不猜
     */
    function bySize(size) {
        if (!size) { return undefined; }
        for (let i = sizeUrl.length - 1; i >= 0; i--) {
            if (sizeUrl[i].size === size) { return sizeUrl[i].url; }
        }
        return undefined;
    }

    /**
     * appendBuffer 时上报 这段数据进了哪个 blob 地址 来自哪个真实 URL
     */
    function report(sourceBuffer, data) {
        if (!data) { return; }
        // 传进来的多半是 Uint8Array 之类的视图 取底层 buffer 才能跟 remember 记的对上
        const buffer = data.buffer instanceof ArrayBuffer ? data.buffer : data;
        const url = bufUrl.get(buffer) ?? bySize(data.byteLength);
        if (!url) { return; }

        const mediaSource = sbSource.get(sourceBuffer);
        // srcObject 直接挂 MediaSource 时没有 blob 地址 上报空串 由 popup 兜底使用
        const blobSrc = (mediaSource && msBlob.get(mediaSource)) ?? "";

        const flag = blobSrc + "|" + url;
        if (posted.has(flag)) { return; }
        posted.size > POSTED_MAX && posted.clear();
        posted.add(flag);

        _postMessage({ action: "catCatchMSE", blobSrc: blobSrc, url: url, href: location.href });
    }

    // fetch 分支 页面调 response.arrayBuffer() 时把结果和 response.url 关联起来
    // 用 Proxy 而不是普通函数 toString 结果仍是 [native code] 少踩页面的反劫持检测
    if (typeof Response == "function" && Response.prototype.arrayBuffer) {
        Response.prototype.arrayBuffer = new Proxy(Response.prototype.arrayBuffer, {
            apply(target, thisArg, args) {
                const url = thisArg.url;
                return target.apply(thisArg, args).then(function (buffer) {
                    remember(url, buffer);
                    return buffer;
                });
            }
        });
    }

    // XHR 分支 responseType 为 arraybuffer 时同理
    XMLHttpRequest.prototype.send = new Proxy(XMLHttpRequest.prototype.send, {
        apply(target, thisArg, args) {
            try {
                thisArg.addEventListener("load", function () {
                    thisArg.response instanceof ArrayBuffer && remember(thisArg.responseURL, thisArg.response);
                });
            } catch (e) { }
            return target.apply(thisArg, args);
        }
    });

    // MediaSource 与 blob 地址的对应关系
    URL.createObjectURL = new Proxy(URL.createObjectURL, {
        apply(target, thisArg, args) {
            const url = target.apply(thisArg, args);
            try {
                args[0] instanceof MediaSource && msBlob.set(args[0], url);
            } catch (e) { }
            return url;
        }
    });

    // SourceBuffer 属于哪个 MediaSource
    MediaSource.prototype.addSourceBuffer = new Proxy(MediaSource.prototype.addSourceBuffer, {
        apply(target, thisArg, args) {
            const sourceBuffer = target.apply(thisArg, args);
            try { sbSource.set(sourceBuffer, thisArg); } catch (e) { }
            return sourceBuffer;
        }
    });

    // 钩子本体 只读不改 原样透传
    SourceBuffer.prototype.appendBuffer = new Proxy(SourceBuffer.prototype.appendBuffer, {
        apply(target, thisArg, args) {
            try { report(thisArg, args[0]); } catch (e) { }
            return target.apply(thisArg, args);
        }
    });
})();
