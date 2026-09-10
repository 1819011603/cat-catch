// 复制选项
function copyLink(data) {
    let text = data.url;
    if (data.parsing == "m3u8") {
        text = G.copyM3U8;
    } else if (data.parsing == "mpd") {
        text = G.copyMPD;
    } else {
        text = G.copyOther;
    }
    return templates(text, data);
}
function isM3U8(data) {
    return (
        data.ext == "m3u8" ||
        data.ext == "m3u" ||
        data.type?.endsWith("/vnd.apple.mpegurl") ||
        data.type?.endsWith("/x-mpegurl") ||
        data.type?.endsWith("/mpegurl") ||
        data.type?.endsWith("/octet-stream-m3u8")
    )
}
function isMPD(data) {
    return (data.ext == "mpd" ||
        data.type == "application/dash+xml"
    )
}
function isJSON(data) {
    return (data.ext == "json" ||
        data.type == "application/json" ||
        data.type == "text/json"
    )
}
function isPicture(data) {
    return (data.type?.startsWith("image/") ||
        data.ext == "jpg" ||
        data.ext == "png" ||
        data.ext == "jpeg" ||
        data.ext == "bmp" ||
        data.ext == "gif" ||
        data.ext == "webp" ||
        data.ext == "svg"
    )
}
function isMediaExt(ext) {
    return ['ogg', 'ogv', 'mp4', 'webm', 'mp3', 'wav', 'm4a', '3gp', 'mpeg', 'mov', 'm4s', 'aac'].includes(ext);
}
function isMedia(data) {
    return isMediaExt(data.ext) || data.type?.startsWith("video/") || data.type?.startsWith("audio/");
}

// 一键下载 同组内第二名体积达到第一名此比例 视为无法区分主次
const PICK_AMBIGUOUS_RATIO = 0.8;
const PICK_AUDIO_EXT = ['mp3', 'm4a', 'aac', 'opus', 'wav', 'weba', 'ogg', 'flac'];
const PICK_VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'flv', 'ogv', '3gp', 'mpeg', 'avi', 'ts', 'm4s'];

/**
 * 判断资源是音轨还是视频轨
 * Content-Type 优先于后缀 都判定不了按视频处理 由歧义检查兜底
 * @param {Object} data 资源对象
 * @returns {String} "audio" | "video"
 */
function trackKind(data) {
    if (data.type?.startsWith("audio/")) { return "audio"; }
    if (data.type?.startsWith("video/")) { return "video"; }
    if (PICK_AUDIO_EXT.includes(data.ext)) { return "audio"; }
    if (PICK_VIDEO_EXT.includes(data.ext)) { return "video"; }
    return "video";
}

/**
 * 一键下载 从资源列表中挑出本页主媒体
 * 纯通用启发式 只看 Content-Type / 后缀 / 体积 / 清单结构 不依赖任何站点规则
 * 纯函数 不修改传入的资源对象
 * @param {Array} list 当前标签的资源数组
 * @returns {Object} { mode, picked, candidates, ambiguous, maybeNoAudio }
 *   mode "parser" 交给 m3u8/mpd 解析页 | "merge" 音视频分轨合并 | "direct" 直接下载 | "none" 无候选
 *   ambiguous 为 true 时 picked 为空 应由用户从 candidates 中确认
 *   maybeNoAudio 为 true 表示只挑到视频轨但列表里还有其他资源 产物可能无声
 */
function pickMainMedia(list) {
    const result = { mode: "none", picked: [], candidates: [], ambiguous: false, maybeNoAudio: false };
    if (!list || !list.length) { return result; }

    const size = data => data._size ?? 0;
    const bySizeDesc = (a, b) => size(b) - size(a);
    // 第一名明显大于第二名才算主次分明
    const distinct = group => group.length < 2 || size(group[1]) < size(group[0]) * PICK_AMBIGUOUS_RATIO;

    // Step 1 候选池 只留媒体和清单 滤掉图片 JSON key
    const pool = list.filter(data => isMedia(data) || isM3U8(data) || isMPD(data));
    if (!pool.length) { return result; }

    // Step 2 清单优先 存在清单时分片交由解析页自己去拉 不进候选
    const mpd = pool.filter(isMPD);
    const m3u8 = pool.filter(isM3U8);
    const manifests = mpd.length ? mpd : m3u8;
    if (manifests.length) {
        // 解析页自带码率选择与音轨配对 唯一时直接交给它
        result.mode = "parser";
        result.candidates = manifests;
        manifests.length === 1 ? result.picked = [manifests[0]] : result.ambiguous = true;
        return result;
    }

    // Step 3 无清单 纯文件 按体积降序分音视频两组
    const video = pool.filter(data => trackKind(data) === "video").sort(bySizeDesc);
    const audio = pool.filter(data => trackKind(data) === "audio").sort(bySizeDesc);

    // 音视频分轨 各取最大一条送去合并
    if (video.length && audio.length) {
        result.mode = "merge";
        result.candidates = [...video, ...audio];
        if (distinct(video) && distinct(audio)) {
            result.picked = [video[0], audio[0]];
        } else {
            result.ambiguous = true;
        }
        return result;
    }

    // 只有一组 取最大一条直接下载
    const single = video.length ? video : audio;
    result.mode = "direct";
    result.candidates = single;
    if (distinct(single)) {
        result.picked = [single[0]];
        // 音轨可能被站点标成 video/* 而混进视频组 提示用户自查
        result.maybeNoAudio = !audio.length && pool.length > 1;
    } else {
        result.ambiguous = true;
    }
    return result;
}

/**
 * 定位 去掉 query 和 hash 只留 URL 主体
 * 同一个资源常常带一次性签名参数 光比完整 URL 会漏
 * @param {String} url
 * @returns {String}
 */
function urlBody(url) {
    if (typeof url != "string") { return ""; }
    const index = url.search(/[?#]/);
    return index == -1 ? url : url.slice(0, index);
}


/**
 * 定位 从资源列表中挑出「正在播放的那一个」
 * 只做精确匹配 命中一级就不再往下走
 *   1 完整 URL 相同        直链播放 精确
 *   2 去掉 query 后相同     同一资源换了签名参数
 * 原来还有一级「与 MSE 分片同目录」 已去掉 —— 大站 CDN 一个目录底下放着无数不相干的视频
 * (抖音全站都在 /video/tos/cn/tos-cn-ve-15/ 下面) 同目录说明不了任何事 只会乱匹配
 * 那一级本来是给「分片没被捕获 反推清单」用的 现在按时长匹配能更准地办同一件事
 * 纯函数 不修改传入的资源对象
 * @param {Array} list 当前标签的资源数组
 * @param {Array} srcList 页面媒体元素的 currentSrc 数组 blob: 的会被剔除
 * @param {Array} mseUrls mse.js 反查到的真实地址数组
 * @returns {Object} { picked, tier } tier 为 0 表示没匹配上
 */
function pickPlayingMedia(list, srcList, mseUrls) {
    const result = { picked: [], tier: 0 };
    if (!list || !list.length) { return result; }

    const exact = new Set();
    const body = new Set();
    [...(srcList ?? []), ...(mseUrls ?? [])].forEach(function (url) {
        if (!url || url.startsWith("blob:")) { return; }
        exact.add(url);
        body.add(urlBody(url));
    });
    if (!exact.size) { return result; }

    result.picked = list.filter(data => exact.has(data.url));
    if (result.picked.length) { result.tier = 1; return result; }

    result.picked = list.filter(data => body.has(urlBody(data.url)));
    result.tier = result.picked.length ? 2 : 0;
    return result;
}

// 定位 按时长匹配的容差 单位秒 超过就不认
const PICK_DURATION_TOLERANCE = 1;

/**
 * 定位 判断探到元数据的资源是音轨还是视频轨
 * 探过之后有更硬的依据 有画面高度就是视频 没有就是没有视频轨
 * 比只看后缀准 音轨常被站点标成 .mp4
 * @param {Object} data 已探到时长的资源对象
 * @returns {String} "audio" | "video"
 */
function probedKind(data) {
    if (data.videoHeight) { return "video"; }
    // 清单没走解码这条路 高度不可靠 一律按视频算
    if (isM3U8(data) || isMPD(data)) { return "video"; }
    return "audio";
}

/**
 * 定位 第三级 从已探到时长的候选里挑出与页面播放时长一致的
 * 结果最多两条 且只有同组时才给两条 —— 组号是按到达时间差配的
 * 音视频分轨必然同时发起 落在同一组 组号不同的音轨跟这个视频没关系 不能凑一对
 * 同一轨有多条命中时 依次比 高度是否对得上 → 时长差 → 体积
 * 纯函数 不修改传入的资源对象
 * @param {Array} probed 已探到时长的资源数组
 * @param {Number} target 页面媒体的时长 秒
 * @param {Number} targetHeight 页面媒体的高度 0 表示未知
 * @returns {Object} { picked, diff } diff 为命中项里最接近的那条差了多少秒
 */
function pickByDuration(probed, target, targetHeight) {
    const result = { picked: [], diff: 0 };
    if (!probed || !probed.length || !target || !isFinite(target)) { return result; }

    // 硬上限 1 秒 时长必须基本相同才算同一份媒体
    // 留这 1 秒是因为清单总时长是分片累加 跟解码出来的时长常有零点几秒出入 不是给「相近」留余量
    const diffOf = data => Math.abs(data.duration - target);
    const hit = probed.filter(data =>
        data.duration && isFinite(data.duration) && diffOf(data) <= PICK_DURATION_TOLERANCE);
    if (!hit.length) { return result; }

    // 同一轨里挑最像的那条
    const best = function (group) {
        return group.slice().sort(function (a, b) {
            if (targetHeight) {
                const order = (a.videoHeight == targetHeight ? 0 : 1) - (b.videoHeight == targetHeight ? 0 : 1);
                if (order) { return order; }
            }
            if (Math.abs(diffOf(a) - diffOf(b)) > 0.001) { return diffOf(a) - diffOf(b); }
            return (b._size ?? 0) - (a._size ?? 0);
        })[0];
    };

    const video = hit.filter(data => probedKind(data) == "video");
    const audio = hit.filter(data => probedKind(data) == "audio");

    if (!video.length) {
        // 只有音轨 就它一条
        result.picked.push(best(audio));
    } else {
        const main = best(video);
        result.picked.push(main);
        // 只认同组的音轨 没有组号说明没跟谁同时发起 那就是单文件 不配对
        const mate = main.group ? best(audio.filter(data => data.group === main.group)) : undefined;
        mate && result.picked.push(mate);
    }

    result.diff = Math.min(...result.picked.map(diffOf));
    return result;
}

/**
 * ari2a RPC发送一套资源
 * @param {object} data 资源对象
 * @param {Function} success 成功运行函数
 * @param {Function} error 失败运行函数
 */
function aria2AddUri(data, success, error) {
    const json = {
        "jsonrpc": "2.0",
        "id": "cat-catch-" + (data.requestId || Date.now()),
        "method": "aria2.addUri",
        "params": []
    };
    if (G.aria2RpcToken) {
        json.params.push(`token:${G.aria2RpcToken}`);
    }
    const params = {};
    if (data.downFileName) {
        params.out = data.downFileName;
    }
    if (G.aria2RpcDir) {
        params.dir = G.aria2RpcDir;
    }
    if (G.enableAria2RpcReferer) {
        params.header = [];
        params.header.push("User-Agent: " + (G.userAgent ? G.userAgent : navigator.userAgent));
        if (data.requestHeaders?.referer) {
            params.header.push("Referer: " + data.requestHeaders.referer);
        }
        if (data.cookie) {
            params.header.push("Cookie: " + data.cookie);
        }
        if (data.requestHeaders?.authorization) {
            params.header.push("Authorization: " + data.requestHeaders.authorization);
        }
    }
    json.params.push([data.url], params);
    fetch(G.aria2Rpc, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(json)
    }).then(response => {
        return response.json();
    }).then(data => {
        success && success(data);
    }).catch(errMsg => {
        error && error(errMsg);
    });
}

// MQTT 相关功能
/**
 * 发送数据到 MQTT 服务器
 * @param {Object} data - 要发送的媒体数据
 * @returns {Promise} - 返回发送结果的 Promise
 */
function sendToMQTT(data, config) {
    return new Promise((resolve, reject) => {
        if (!G.mqttEnable) {
            reject("MQTT is not enabled");
            return;
        }

        // 使用配置的标题长度，如果未设置则默认为100
        const titleLength = G.mqttTitleLength || 100;
        data.title = data.title.slice(0, titleLength) || "";
        data.action = "media_found";
        data = trimData(data);

        // 创建 MQTT 连接并发送数据
        connectAndSendMQTT(data, config)
            .then(() => {
                resolve(true);
            })
            .catch((error) => {
                console.error("MQTT send error:", error);
                reject("MQTT send failed: " + error.message);
            });
    });
}

/**
 * 连接到 MQTT 服务器并发送消息
 * @param {Object} data - 要发送的数据
 * @returns {Promise} - 连接和发送的 Promise
 */
function connectAndSendMQTT(data, config) {
    return new Promise((resolve, reject) => {
        try {
            // 构建 MQTT 连接 URL
            const protocol = G.mqttProtocol;
            const broker = G.mqttBroker;
            const port = G.mqttPort;
            const path = G.mqttPath;

            if (!protocol || !broker || !port || !path) {
                throw new Error("MQTT connection parameters are missing");
            }

            const mqttUrl = `${protocol}://${broker}:${port}${path}`;

            // 创建 MQTT 客户端选项
            const options = {
                clientId: `${G.mqttClientId || "cat-catch-client"}-${Math.random().toString(16).slice(2)}`,
                clean: true,
                connectTimeout: 10000,
                reconnectPeriod: 0 // 不自动重连，用完即断
            };

            // 添加用户名和密码（如果有）
            if (G.mqttUser) {
                options.username = G.mqttUser;
            }
            if (G.mqttPassword) {
                options.password = G.mqttPassword;
            }

            const mqttLib = window.mqtt || (typeof mqtt !== 'undefined' ? mqtt : null);
            if (!mqttLib) {
                throw new Error("MQTT library not found. Please check if lib/mqtt.min.js is loaded correctly.");
            }
            if (!mqttLib.connect) {
                throw new Error("MQTT.connect method not found. Available methods: " + Object.keys(mqttLib));
            }

            // 如果提供了提示回调函数，则使用它
            if (typeof config?.alert === 'function') {
                Tips = config.alert;
            }
            // 2. 创建连接阶段提示：正在连接 MQTT 服务器
            Tips(i18n.connectingToMQTT || "Connecting to MQTT server...", 2000);

            const client = mqttLib.connect(mqttUrl, options);
            // 连接成功
            client.on('connect', () => {

                const topic = G.mqttTopic || "cat-catch/media";
                const qos = parseInt(G.mqttQos) || 2;

                // 处理自定义数据格式
                let message;
                if (G.mqttDataFormat?.trim()) {
                    message = templates(G.mqttDataFormat, data);
                } else {
                    // 使用默认JSON格式
                    message = JSON.stringify(data);
                }

                // 3. 正在发送消息到 MQTT 服务器
                Tips(i18n.sendingMessageToMQTT || "Sending message to MQTT server...", 2000);

                // 发送消息
                client.publish(topic, message, { qos: qos }, (error) => {
                    if (error) {
                        console.error("MQTT publish error:", error);
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            // 连接错误
            client.on('error', (error) => {
                console.error("MQTT connection error:", error);
                reject(error);
            });

            // 连接超时
            setTimeout(() => {
                if (!client.connected) {
                    client.end();
                    reject(new Error("MQTT connection timeout"));
                }
            }, 6000);

            // client.on('close', () => {
            //     console.log('MQTT connection closed');
            // });            

        } catch (error) {
            console.error("MQTT setup error:", error);
            reject(error);
        }
    });
}