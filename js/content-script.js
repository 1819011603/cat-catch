(function () {
    var _videoObj = [];
    var _videoSrc = [];
    var _key = new Set();
    var m3u8Text = new Map();
    // mse.js 上报的映射 blob地址 -> 喂给它的真实URL集合
    // 只在本 frame 的页面生命周期内有效 刷新即失效 正好也是这份映射的有效期
    var mseMap = new Map();
    const MSE_MAP_MAX = 32;
    const MSE_URL_MAX = 200;
    chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
        if (chrome.runtime.lastError) { return; }
        // 获取页面视频对象
        if (Message.Message == "getVideoState") {
            let videoObj = [];
            let videoSrc = [];
            document.querySelectorAll("video, audio").forEach(function (video) {
                if (video.currentSrc != "" && video.currentSrc != undefined) {
                    videoObj.push(video);
                    videoSrc.push(video.currentSrc);
                }
            });
            const iframe = document.querySelectorAll("iframe");
            if (iframe.length > 0) {
                iframe.forEach(function (iframe) {
                    if (iframe.contentDocument == null) { return true; }
                    iframe.contentDocument.querySelectorAll("video, audio").forEach(function (video) {
                        if (video.currentSrc != "" && video.currentSrc != undefined) {
                            videoObj.push(video);
                            videoSrc.push(video.currentSrc);
                        }
                    });
                });
            }
            if (videoObj.length > 0) {
                if (videoObj.length !== _videoObj.length || videoSrc.toString() !== _videoSrc.toString()) {
                    _videoSrc = videoSrc;
                    _videoObj = videoObj;
                }
                Message.index = Message.index == -1 ? 0 : Message.index;
                const video = videoObj[Message.index];
                const timePCT = video.currentTime / video.duration * 100;
                sendResponse({
                    time: timePCT,
                    currentTime: video.currentTime,
                    duration: video.duration,
                    volume: video.volume,
                    count: _videoObj.length,
                    src: _videoSrc,
                    paused: video.paused,
                    loop: video.loop,
                    speed: video.playbackRate,
                    muted: video.muted,
                    type: video.tagName.toLowerCase(),
                    videoStatus: videoObj.map(v => v.paused ? 1 : 0)
                });
                return true;
            }
            sendResponse({ count: 0 });
            return true;
        }
        /**
         * 定位 返回本页媒体元素的播放状态与真实来源
         * src 是 blob: 时 mseUrls 给出 mse.js 反查到的真实地址 没开 MSE 追踪则为空
         */
        if (Message.Message == "getPlayingMedia") {
            const list = [];
            // TimeRanges 取最后一段的结束位置 没有区间就是 0
            const range = function (ranges) {
                return ranges && ranges.length ? ranges.end(ranges.length - 1) : 0;
            };
            // 时间文本 mm:ss 或 hh:mm:ss
            const TIME = "\\d{1,3}:[0-5]\\d(?::[0-5]\\d)?";
            const TIME_ALL = new RegExp(TIME, "g");
            // 成对时间 播放器进度条上的 00:22 / 10:37
            const TIME_PAIR = new RegExp("(" + TIME + ")\\s*/\\s*(" + TIME + ")");
            const toSeconds = function (text) {
                const part = text.split(":").map(Number);
                return part.length == 3 ? part[0] * 3600 + part[1] * 60 + part[2] : part[0] * 60 + part[1];
            };
            /**
             * 取子树里所有元素 顺带钻进 open shadow root
             * 播放器控制条常常在 shadow DOM 里 普通 querySelectorAll 钻不进去 什么也找不到
             * @param {Element|ShadowRoot} root
             * @param {Array} out
             * @returns {Array}
             */
            const deepAll = function (root, out) {
                out = out ?? [];
                root.querySelectorAll("*").forEach(function (element) {
                    out.push(element);
                    element.shadowRoot && deepAll(element.shadowRoot, out);
                });
                return out;
            };

            /**
             * 从播放器界面上的时间文本反推总时长
             * MSE 播放器把 duration 设成 Infinity 时 元素报不出总时长 但进度条上明明写着 00:22 / 10:37
             * 一律不认 class / id 选择器 只认文本形状 站点改版也不影响
             * 靠一条自检站住脚 —— 必须有个时间值跟 currentTime 对得上
             * 才能说明找到的是播放器自己的时间显示 而不是信息流里别的视频的时长
             * 两遍
             *   一 从 video 往上 6 层祖先里找 找到自检通过的那层 取其中最大值
             *   二 全页找成对时间 A / B 左边跟 currentTime 对得上 右边就是总时长
             *     抖音的控制栏离 video 很远 6 层罩不住 只能全页找
             *     全页搜就必须用更具体的形状 成对时间比单个时间具体得多 才不会乱认
             * @param {HTMLMediaElement} media
             * @returns {Number} 拿不到返回 0
             */
            const uiDuration = function (media) {
                const log = function (result, why) {
                    console.log("%c[猫抓定位] 界面时长", "color:#1a73e8;font-weight:bold",
                        `进度 ${media.currentTime} -> ${result || "拿不到"}`, why);
                    return result;
                };
                const current = media.currentTime;
                // 还没开始播 没有可对照的数 一律不采信
                if (!(current > 1)) { return log(0, "播放进度不足 1 秒 没有可自检的参照"); }
                const near = value => Math.abs(value - current) <= 2;

                // 第一遍 成对时间 A / B —— 抖音的控制栏是 <span>00</span>:<span>09</span> / <span>02</span>:<span>52</span>
                // 单个叶子里没有冒号 匹配不到 但它们的父容器 textContent 拼出来就是 00:09/02:52
                // 所以这里看的是小块容器的整段文本 而不是叶子
                for (const element of deepAll(document.body)) {
                    // 只看小块容器 时间显示最多也就几个 span 包在一起
                    if (element.children.length > 6) { continue; }
                    const text = element.textContent;
                    if (!text || text.length > 40) { continue; }
                    const pair = text.match(TIME_PAIR);
                    if (!pair) { continue; }
                    const total = toSeconds(pair[2]);
                    if (near(toSeconds(pair[1])) && total > current) {
                        return log(total, `成对时间 "${text.trim()}" 于 ${element.className || element.tagName}`);
                    }
                }

                // 第二遍 只有单独的总时长没有成对显示时 从 video 往上逐层找
                let node = media.parentElement;
                for (let level = 0; level < 6 && node; level++, node = node.parentElement) {
                    const values = [];
                    deepAll(node).forEach(function (element) {
                        // 这遍看叶子 父节点会把整片文本拼在一起 混进无关数字
                        if (element.children.length) { return; }
                        const found = element.textContent.match(TIME_ALL);
                        found && found.forEach(text => values.push(toSeconds(text)));
                    });
                    if (!values.length || !values.some(near)) { continue; }
                    const max = Math.max(...values);
                    if (max > current) { return log(max, `第 ${level + 1} 层祖先 时间值 ${values.join()}`); }
                }
                return log(0, "全页成对时间和祖先层都没找到能通过自检的时间文本");
            };
            /**
             * 从播放器附近抓作者和视频描述 给文件名用
             * 抖音的信息区形如  @山河旧影客 · 8月29日  换行  详细解读《高山下的花环》第四集 备战!
             * 同样不认 class / id 只认形状 —— 作者以 @ 开头 描述取同一块里最长的一段文字
             * 找到作者就立刻返回 不再往上走 免得跑到信息流上下条的信息区去
             * @param {HTMLMediaElement} media
             * @returns {Object} { author, desc } 抓不到就是空串
             */
            const pageInfo = function (media) {
                let node = media.parentElement;
                for (let level = 0; level < 6 && node; level++, node = node.parentElement) {
                    let author = "";
                    let desc = "";
                    node.querySelectorAll("*").forEach(function (element) {
                        if (element.children.length) { return; }
                        const text = element.textContent.trim();
                        if (!text || text.length > 200) { return; }
                        if (!author && text.startsWith("@")) {
                            // @山河旧影客 · 8月29日 里只要名字 分隔符后面的日期不要
                            author = text.slice(1).split(/[·•|\s]/)[0].trim();
                            return;
                        }
                        // 话题标签和时间显示不是描述
                        if (text.startsWith("#") || new RegExp("^" + TIME + "$").test(text)) { return; }
                        if (text.length > desc.length) { desc = text; }
                    });
                    if (author) { return { author: author, desc: desc }; }
                }
                return { author: "", desc: "" };
            };
            const collect = function (root) {
                root.querySelectorAll("video, audio").forEach(function (media) {
                    // 不能要求 currentSrc 非空
                    // srcObject 挂 MediaSource 的播放器(抖音就是)按规范 currentSrc 就是空串
                    // 以 readyState 判断这个元素里到底有没有媒体 空占位的 video 标签 readyState 为 0
                    if (!media.currentSrc && !media.readyState) { return; }
                    // MSE 播放时 duration 取的是 mediaSource.duration 播放器不设它就是 NaN
                    // 而 sendResponse 走 JSON NaN 和 Infinity 都会变成 null 到不了对面
                    // 所以多带几个来源 并把原值转成字符串一起送过去 定位失败时才说得清是哪一步没拿到
                    list.push({
                        src: media.currentSrc,
                        playing: !media.paused,
                        duration: media.duration,
                        durationText: String(media.duration),
                        seekableEnd: range(media.seekable),
                        bufferedEnd: range(media.buffered),
                        uiDuration: uiDuration(media),
                        currentTime: media.currentTime,
                        videoWidth: media.videoWidth ?? 0,
                        videoHeight: media.videoHeight ?? 0,
                        type: media.tagName.toLowerCase(),
                        mseUrls: [...(mseMap.get(media.currentSrc) ?? [])]
                    });
                });
            };
            collect(document);
            // 同源 iframe 里的媒体 跨源的拿不到 那种情况下 iframe 自己的 content-script 才有数据
            document.querySelectorAll("iframe").forEach(function (iframe) {
                try {
                    iframe.contentDocument && collect(iframe.contentDocument);
                } catch (e) { }
            });
            // srcObject 挂 MediaSource 时没有 blob 地址 mse.js 用空串上报 统一兜给调用方
            sendResponse({ list: list, orphanMseUrls: [...(mseMap.get("") ?? [])] });
            return true;
        }
        // 速度控制
        if (Message.Message == "speed") {
            if (_videoObj[Message.index]?.playbackRate !== undefined) {
                _videoObj[Message.index].playbackRate = Message.speed;
            }
            return true;
        }
        // 画中画
        if (Message.Message == "pip") {
            if (document.pictureInPictureElement) {
                try { document.exitPictureInPicture(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            try { _videoObj[Message.index].requestPictureInPicture(); } catch (e) { return true; }
            sendResponse({ state: true });
            return true;
        }
        // 全屏
        if (Message.Message == "fullScreen") {
            if (document.fullscreenElement) {
                try { document.exitFullscreen(); } catch (e) { return true; }
                sendResponse({ state: false });
                return true;
            }
            setTimeout(function () {
                try { _videoObj[Message.index].requestFullscreen(); } catch (e) { return true; }
            }, 500);
            sendResponse({ state: true });
            return true;
        }
        // 播放
        if (Message.Message == "play") {
            _videoObj[Message.index]?.play();
            return true;
        }
        // 暂停
        if (Message.Message == "pause") {
            _videoObj[Message.index]?.pause();
            return true;
        }
        // 循环播放
        if (Message.Message == "loop") {
            if (_videoObj[Message.index]?.loop !== undefined) {
                _videoObj[Message.index].loop = Message.action;
            }
            return true;
        }
        // 设置音量
        if (Message.Message == "setVolume") {
            if (_videoObj[Message.index]?.volume !== undefined) {
                _videoObj[Message.index].volume = Message.volume;
            }
            sendResponse("ok");
            return true;
        }
        // 静音
        if (Message.Message == "muted") {
            if (_videoObj[Message.index]?.muted !== undefined) {
                _videoObj[Message.index].muted = Message.action;
            }
            return true;
        }
        // 设置视频进度
        if (Message.Message == "setTime") {
            if (_videoObj[Message.index]?.currentTime !== undefined && _videoObj[Message.index]?.duration !== undefined) {
                _videoObj[Message.index].currentTime = Message.time * _videoObj[Message.index].duration / 100;
            }
            sendResponse("ok");
            return true;
        }
        // 截图视频图片
        if (Message.Message == "screenshot") {
            try {
                let video = _videoObj[Message.index];
                let canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
                let link = document.createElement("a");
                link.href = canvas.toDataURL("image/jpeg");
                link.download = `${location.hostname}-${secToTime(video.currentTime)}.jpg`;
                link.click();
                canvas = null;
                link = null;
                sendResponse("ok");
                return true;
            } catch (e) { console.log(e); return true; }
        }
        if (Message.Message == "getKey") {
            sendResponse(Array.from(_key));
            return true;
        }
        if (Message.Message == "ffmpeg") {
            if (!Message.files) {
                window.postMessage(Message);
                sendResponse("ok");
                return true;
            }
            Message.quantity ??= Message.files.length;
            for (let item of Message.files) {
                const data = { ...Message, ...item };
                data.type = item.type ?? "video";
                if (data.data instanceof Blob) {
                    window.postMessage(data);
                } else {
                    fetch(data.data)
                        .then(response => response.blob())
                        .then(blob => {
                            data.data = blob;
                            window.postMessage(data);
                        });
                }
            }
            sendResponse("ok");
            return true;
        }
        if (Message.Message == "getPage") {
            if (Message.find) {
                const DOM = document.querySelector(Message.find);
                DOM ? sendResponse(DOM.innerHTML) : sendResponse("");
                return true;
            }
            sendResponse(document.documentElement.outerHTML);
            return true;
        }
        if (Message.Message == "getM3u8Text") {
            if (Message.url && m3u8Text.has(Message.url)) {
                sendResponse(m3u8Text.get(Message.url));
                return true;
            }
            sendResponse("");
            return true;
        }
        if (Message.Message == "getM3u8Cache") {
            fetch(Message.url, { method: "GET", cache: "force-cache" })
                .then(response => response.text())
                .then(text => sendResponse({ success: true, data: text }))
                .catch(() => sendResponse({ success: false, error: "Failed to fetch" }));
            return true;
        }
    });

    // Heart Beat
    var Port;
    function connect() {
        Port = chrome.runtime.connect(chrome.runtime.id, { name: "HeartBeat" });
        Port.postMessage("HeartBeat");
        Port.onMessage.addListener(function (message, Port) { return true; });
        Port.onDisconnect.addListener(connect);
    }
    connect();

    function secToTime(sec) {
        let time = "";
        let hour = Math.floor(sec / 3600);
        let min = Math.floor((sec % 3600) / 60);
        sec = Math.floor(sec % 60);
        if (hour > 0) { time = hour + "'"; }
        if (min < 10) { time += "0"; }
        time += min + "'";
        if (sec < 10) { time += "0"; }
        time += sec;
        return time;
    }
    const isFirefox = navigator.userAgent.includes('Firefox');
    const sendAddMedia = (data) => {
        chrome.runtime.sendMessage({
            Message: "addMedia",
            url: data.url,
            href: data.href ?? location.href,
            extraExt: data.ext,
            mime: data.mime,
            requestHeaders: { referer: data.referer },
            requestId: data.requestId
        });
    };
    window.addEventListener("message", (event) => {
        const action = ["catCatchAddMedia", "catCatchAddKey", "catCatchFFmpeg", "catCatchFFmpegResult", "catCatchCloseScript", "catCatchMSE"];
        if (!event.data || !event.data.action || event.origin !== window.location.origin || !action.includes(event.data.action)) { return; }
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (event.data.action == "catCatchAddMedia") {
            if (!event.data.url) { return; }

            /*
             * firefox 不允许直接下载跨域blob内容
             * fetch获取文本内容并缓存到m3u8Text中，供 m3u8.html调用获取。
             */
            if (event.data.url.startsWith("blob:") && isFirefox) {
                fetch(event.data.url)
                    .then(response => response.text())
                    .then(text => {
                        m3u8Text.set(event.data.url, text);
                        sendAddMedia(event.data);
                    });
                return;
            }
            sendAddMedia(event.data);
        }
        if (event.data.action == "catCatchAddKey") {
            let key = event.data.key;
            if (key instanceof ArrayBuffer || key instanceof Array) {
                key = ArrayToBase64(key);
            }
            if (_key.has(key)) { return; }
            _key.add(key);
            chrome.runtime.sendMessage({
                Message: "send2local",
                action: "addKey",
                data: key,
            });
            chrome.runtime.sendMessage({
                Message: "popupAddKey",
                data: key,
                url: event.data.url,
            });
        }
        if (event.data.action == "catCatchFFmpeg") {
            if (!event.data.use ||
                !event.data.files ||
                !event.data.files instanceof Array ||
                event.data.files.length == 0
            ) { return; }
            event.data.title = event.data.title ?? document.title ?? new Date().getTime().toString();
            event.data.title = event.data.title.replaceAll('"', "").replaceAll("'", "").replaceAll(" ", "");
            let data = {
                Message: event.data.action,
                action: event.data.use,
                files: event.data.files,
                url: event.data.href ?? event.source.location.href,
            };
            data = { ...event.data, ...data };
            chrome.runtime.sendMessage(data);
        }
        if (event.data.action == "catCatchFFmpegResult") {
            if (!event.data.state || !event.data.tabId) { return; }
            chrome.runtime.sendMessage({ Message: "catCatchFFmpegResult", ...event.data });
        }
        // mse.js 的映射上报 只在本 frame 内存里存一份 不惊动后台
        if (event.data.action == "catCatchMSE") {
            if (typeof event.data.url != "string" || !event.data.url) { return; }
            const blobSrc = typeof event.data.blobSrc == "string" ? event.data.blobSrc : "";
            let urls = mseMap.get(blobSrc);
            if (!urls) {
                // blob 地址会随播放不断新建 只留最近的若干个
                if (mseMap.size >= MSE_MAP_MAX) { mseMap.delete(mseMap.keys().next().value); }
                urls = new Set();
                mseMap.set(blobSrc, urls);
            }
            if (urls.size < MSE_URL_MAX) { urls.add(event.data.url); }
            return;
        }
        if (event.data.action == "catCatchCloseScript") {
            if (!event.data.script || !event.isTrusted) { return; }
            chrome.runtime.sendMessage({ Message: "closeScript", ...event.data });
        }

    }, { capture: true });

    function ArrayToBase64(data) {
        try {
            let bytes = new Uint8Array(data);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            if (typeof _btoa == "function") {
                return _btoa(binary);
            }
            return btoa(binary);
        } catch (e) {
            return false;
        }
    }
})();