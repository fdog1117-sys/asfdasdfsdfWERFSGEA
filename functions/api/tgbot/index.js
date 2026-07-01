/**
 * Telegram Bot Webhook 处理器
 * 路径: /api/tgbot
 *
 * 功能：
 *  - 接收 Telegram Webhook 推送的 Update
 *  - /start /help /list 命令 + 内联按钮主菜单
 *  - 用户发送文件 → 弹出确认菜单 → 确认后下载并上传到图床
 *  - 上传成功后回复文件访问链接
 *
 * 所需环境变量：
 *  - TG_BOT_TOKEN        (必须) Telegram Bot Token
 *  - TG_WEBHOOK_SECRET   (推荐) Webhook 鉴权 secret，与 setWebhook 的 secret_token 一致
 *  - TG_PROXY_URL        (可选) Telegram API 代理域名
 *
 * 设置 Webhook（部署后执行一次）：
 *  curl "https://api.telegram.org/bot<TOKEN>/setWebhook\
 *    ?url=https://<your-domain>/api/tgbot\
 *    &secret_token=<YOUR_SECRET>"
 */

import { getDatabase } from '../../utils/databaseAdapter.js';
import { fetchUploadConfig, fetchSecurityConfig, fetchPageConfig } from '../../utils/sysConfig.js';
import { buildUniqueFileId, endUpload, resolveFileExt } from '../../upload/uploadTools.js';
import { TelegramAPI } from '../../utils/storage/telegramAPI.js';

// ─────────────────────────────────────────────────────────────────────────────
// Telegram API 工具函数
// ─────────────────────────────────────────────────────────────────────────────

async function tgCall(botToken, method, body = {}, proxyUrl = '') {
    const apiBase = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
    const res = await fetch(`${apiBase}/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

async function sendMessage(botToken, chatId, text, options = {}, proxyUrl = '') {
    return tgCall(botToken, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options,
    }, proxyUrl);
}

async function editMessage(botToken, chatId, messageId, text, options = {}, proxyUrl = '') {
    return tgCall(botToken, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...options,
    }, proxyUrl);
}

async function answerCallback(botToken, callbackQueryId, text = '', proxyUrl = '') {
    return tgCall(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
    }, proxyUrl);
}

async function copyMessage(botToken, chatId, fromChatId, messageId, options = {}, proxyUrl = '') {
    return tgCall(botToken, 'copyMessage', {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId,
        ...options,
    }, proxyUrl);
}

/**
 * 通过 file_id 下载文件，返回 { arrayBuffer, filePath }
 * 注意：TG Bot API 最大可下载 20 MB
 */
async function downloadTgFile(botToken, fileId, proxyUrl = '') {
    const apiBase = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
    const infoRes = await fetch(`${apiBase}/bot${botToken}/getFile?file_id=${fileId}`);
    const info = await infoRes.json();
    if (!info.ok) throw new Error(`getFile 失败: ${info.description}`);
    const filePath = info.result.file_path;
    const fileRes = await fetch(`${apiBase}/file/bot${botToken}/${filePath}`);
    if (!fileRes.ok) throw new Error(`下载文件失败: HTTP ${fileRes.status}`);
    return { arrayBuffer: await fileRes.arrayBuffer(), filePath };
}
/**
 * 下载大文件并自动切片上传到 Telegram 频道
 * 注意：内嵌实现，不依赖 chunkUpload.js，避免拦破 @aws-sdk 导入导致 Worker 崩溃
 */
async function downloadAndSliceTelegramFile(botToken, fileId, proxyUrl, targetBotToken, targetChatId, targetProxyUrl, fileName, fileSize) {
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    if (totalChunks > 100) {
        throw new Error('文件过大，超出转存限制（最大 1.6 GB）');
    }

    const apiBase = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
    const infoRes = await fetch(`${apiBase}/bot${botToken}/getFile?file_id=${fileId}`);
    const info = await infoRes.json();
    if (!info.ok) {
        if (info.description && info.description.includes('file is too big')) {
            throw new Error('下载失败：文件大于 20MB。请在 TG_PROXY_URL 配置本地 Telegram Bot API 代理。');
        }
        throw new Error(`getFile 失败: ${info.description}`);
    }

    const filePath = info.result.file_path;
    const fileRes = await fetch(`${apiBase}/file/bot${botToken}/${filePath}`);
    if (!fileRes.ok) throw new Error(`下载文件失败: HTTP ${fileRes.status}`);

    const arrayBuffer = await fileRes.arrayBuffer();
    const fileData = new Uint8Array(arrayBuffer);

    const chunks = [];
    const tgAPI = new TelegramAPI(targetBotToken, targetProxyUrl);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, fileData.length);
        const chunkData = fileData.slice(start, end);
        const chunkFileName = `${fileName}.part${i.toString().padStart(3, '0')}`;
        const chunkBlob = new Blob([chunkData], { type: 'application/octet-stream' });
        const caption = `Part ${i + 1}/${totalChunks}`;

        const uploadRes = await tgAPI.sendFile(chunkBlob, targetChatId, 'sendDocument', 'document', caption, chunkFileName);
        if (!uploadRes.ok) {
            throw new Error(`分片 ${i + 1} 上传失败: ${uploadRes.description || '未知错误'}`);
        }
        const fileInfo = tgAPI.getFileInfo(uploadRes);
        if (!fileInfo) throw new Error(`解析分片 ${i + 1} 响应失败`);

        chunks.push({
            index: i,
            fileId: fileInfo.file_id,
            size: fileInfo.file_size,
            fileName: chunkFileName
        });
    }

    return chunks;
}



// ─────────────────────────────────────────────────────────────────────────────
// 内联键盘构建
// ─────────────────────────────────────────────────────────────────────────────

function buildMainMenuKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '📂 最近上传', callback_data: 'bot_list' },
                { text: '❓ 使用帮助', callback_data: 'bot_help' },
            ],
        ],
    };
}

function buildConfirmKeyboard(pendingKey) {
    return {
        inline_keyboard: [
            [
                { text: '✅ 上传到图床', callback_data: `upload_${pendingKey}` },
                { text: '❌ 取消',       callback_data: `cancel_${pendingKey}` },
            ],
        ],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 从消息中提取文件信息
// ─────────────────────────────────────────────────────────────────────────────

function extractFileFromMessage(message) {
    if (!message) return null;
    if (message.photo?.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        return { file_id: photo.file_id, file_name: `photo_${photo.file_unique_id}.jpg`, mime_type: 'image/jpeg', file_size: photo.file_size || 0 };
    }
    if (message.document) {
        const d = message.document;
        return { file_id: d.file_id, file_name: d.file_name || `file_${d.file_unique_id}`, mime_type: d.mime_type || 'application/octet-stream', file_size: d.file_size || 0 };
    }
    if (message.video) {
        const v = message.video;
        return { file_id: v.file_id, file_name: v.file_name || `video_${v.file_unique_id}.mp4`, mime_type: v.mime_type || 'video/mp4', file_size: v.file_size || 0 };
    }
    if (message.audio) {
        const a = message.audio;
        return { file_id: a.file_id, file_name: a.file_name || `audio_${a.file_unique_id}.mp3`, mime_type: a.mime_type || 'audio/mpeg', file_size: a.file_size || 0 };
    }
    if (message.voice) {
        const v = message.voice;
        return { file_id: v.file_id, file_name: `voice_${v.file_unique_id}.ogg`, mime_type: v.mime_type || 'audio/ogg', file_size: v.file_size || 0 };
    }
    if (message.sticker) {
        const s = message.sticker;
        const ext = s.is_animated ? '.tgs' : s.is_video ? '.webm' : '.webp';
        return { file_id: s.file_id, file_name: `sticker_${s.file_unique_id}${ext}`, mime_type: s.is_video ? 'video/webm' : 'image/webp', file_size: s.file_size || 0 };
    }
    if (message.animation) {
        const a = message.animation;
        return { file_id: a.file_id, file_name: a.file_name || `anim_${a.file_unique_id}.gif`, mime_type: a.mime_type || 'image/gif', file_size: a.file_size || 0 };
    }
    return null;
}

function formatSize(bytes) {
    if (!bytes) return '未知';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${units[i]}`;
}

function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending 文件缓存（存 KV，TTL 10 分钟）
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_PREFIX = 'tgbot_pending_';

async function savePending(db, key, data) {
    // 尝试用 TTL（仅 Cloudflare KV 支持）
    try {
        await db.put(`${PENDING_PREFIX}${key}`, JSON.stringify(data), { expirationTtl: 600 });
    } catch {
        await db.put(`${PENDING_PREFIX}${key}`, JSON.stringify({ ...data, _expireAt: Date.now() + 600000 }));
    }
}

async function getPending(db, key) {
    try {
        const raw = await db.get(`${PENDING_PREFIX}${key}`);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (data._expireAt && Date.now() > data._expireAt) {
            await db.delete(`${PENDING_PREFIX}${key}`);
            return null;
        }
        return data;
    } catch { return null; }
}

async function deletePending(db, key) {
    try { await db.delete(`${PENDING_PREFIX}${key}`); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 上传文件到图床（通过图床内部 upload 接口）
// ─────────────────────────────────────────────────────────────────────────────

async function doUpload(context, pending, arrayBuffer, originUrl) {
    const { env } = context;

    const blob = new Blob([arrayBuffer], { type: pending.mime_type });
    const file = new File([blob], pending.file_name, { type: pending.mime_type });

    const formData = new FormData();
    formData.append('file', file);

    // 构造内部上传 URL，走 Telegram 渠道（与前端上传相同）
    const uploadUrl = new URL('/upload', originUrl);
    uploadUrl.searchParams.set('uploadChannel', 'telegram');

    // ── 认证处理 ─────────────────────────────────────────────────────────────
    // 优先使用环境变量，其次从数据库中获取系统安全配置的用户认证码
    let authCode = env.TG_UPLOAD_AUTH_CODE || '';
    if (!authCode) {
        try {
            const securityConfig = await fetchSecurityConfig(env);
            authCode = securityConfig.auth?.user?.authCode || '';
        } catch (e) {}
    }

    if (authCode) {
        uploadUrl.searchParams.set('authCode', authCode);
    }

    const uploadHeaders = {
        'CF-Connecting-IP': context.request.headers.get('CF-Connecting-IP') || '127.0.0.1',
    };

    // 如果配置了 API Token（TG_UPLOAD_API_TOKEN），通过 Authorization 头传递
    const apiToken = env.TG_UPLOAD_API_TOKEN || '';
    if (apiToken) {
        uploadHeaders['Authorization'] = `Bearer ${apiToken}`;
    }

    const fakeReq = new Request(uploadUrl.toString(), {
        method: 'POST',
        body: formData,
        headers: uploadHeaders,
    });

    // 构造 fake context 调用图床 upload handler
    const fakeContext = {
        ...context,
        request: fakeReq,
        url: uploadUrl,
        params: {},
        data: {},
        next: async () => new Response('not found', { status: 404 }),
        waitUntil: (p) => context.waitUntil(p),
    };

    // 动态 import 避免循环依赖
    const { onRequest: uploadHandler } = await import('../../upload/index.js');
    const res = await uploadHandler(fakeContext);

    let body;
    try { body = await res.json(); } catch { body = null; }

    if (res.status !== 200 || !body) {
        const errMsg = body ? JSON.stringify(body) : `HTTP ${res.status}`;
        throw new Error(`上传失败：${errMsg}${!authCode && !apiToken ? '（提示：请配置 TG_UPLOAD_AUTH_CODE 或 TG_UPLOAD_API_TOKEN 环境变量）' : ''}`);
    }

    const item = Array.isArray(body) ? body[0] : body;
    const publicUrl = item?.publicUrl;
    const src = item?.src;
    if (!src && !publicUrl) throw new Error('图床未返回有效链接');

    return publicUrl || `${originUrl}${src}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 获取最近上传文件列表
// ─────────────────────────────────────────────────────────────────────────────

async function fetchRecentFiles(db, originUrl) {
    try {
        const listRes = await db.list({ limit: 20 });
        const keys = (listRes.keys || []).filter(k =>
            !k.name.startsWith('manage@') &&
            !k.name.startsWith('tgbot_') &&
            !k.name.startsWith('index_')
        ).slice(0, 10);

        if (keys.length === 0) {
            return '📭 <b>最近上传</b>\n\n暂无文件记录，快发一个文件来试试吧！';
        }

        const lines = ['📂 <b>最近上传的文件：</b>\n'];
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i].name;
            const raw = await db.getWithMetadata(key).catch(() => null);
            const meta = raw?.metadata;
            const name = meta?.FileName || key.split('/').pop() || key;
            const sizeMB = meta?.FileSize;
            const link = `${originUrl}/file/${key}`;
            lines.push(`${i + 1}. <a href="${link}">${escapeHtml(name)}</a>${sizeMB ? ` (${sizeMB} MB)` : ''}`);
        }
        return lines.join('\n');
    } catch (e) {
        return `❌ 获取列表失败：${escapeHtml(e.message)}`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // ── 验证 Webhook Secret ─────────────────────────────────────────────────
    const webhookSecret = env.TG_WEBHOOK_SECRET || '';
    if (webhookSecret) {
        const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (header !== webhookSecret) {
            return new Response('Unauthorized', { status: 401 });
        }
    }

    const db = getDatabase(env);

    // ── 从环境变量或数据库中读取 Bot 配置 ──────────────────────────────────────
    let botToken = env.TG_BOT_TOKEN || '';
    let proxyUrl = env.TG_PROXY_URL || '';

    if (!botToken) {
        try {
            const uploadConfig = await fetchUploadConfig(env);
            const tgChannels = uploadConfig.telegram?.channels || [];
            if (tgChannels.length > 0) {
                botToken = tgChannels[0].botToken || '';
                proxyUrl = tgChannels[0].proxyUrl || env.TG_PROXY_URL || '';
            }
        } catch (e) {
            console.error('[TgBot] Failed to fetch upload config:', e);
        }
    }

    if (!botToken) {
        return new Response('Telegram Bot Token 未配置（环境变量或管理面板图床设置中均未找到）', { status: 500 });
    }

    const originUrl = new URL(request.url).origin;

    let update;
    try {
        update = await request.json();
    } catch {
        return new Response('Bad Request', { status: 400 });
    }

    // 异步处理，立即返回 200
    const handle = async () => {
        let errChatId = null;
        try {
            // ── ID 过滤 ──────────────────────────────────────────────────────
            let userId = null;
            if (update.callback_query) {
                userId = update.callback_query.from?.id;
                errChatId = update.callback_query.message?.chat?.id;
            } else if (update.message) {
                userId = update.message.from?.id;
                errChatId = update.message.chat?.id;
            } else if (update.edited_message) {
                userId = update.edited_message.from?.id;
                errChatId = update.edited_message.chat?.id;
            } else if (update.inline_query) {
                userId = update.inline_query.from?.id;
            } else if (update.chosen_inline_result) {
                userId = update.chosen_inline_result.from?.id;
            }

            if (!userId || (userId !== 8506720558 && String(userId) !== '8506720558')) {
                // 如果不是8506720558这个id和机器人对话都不回复
                return;
            }

            // ── CallbackQuery ──────────────────────────────────────────────
            if (update.callback_query) {
                const cb = update.callback_query;
                const chatId = cb.message.chat.id;
                const msgId = cb.message.message_id;
                const data = cb.data || '';

                if (data === 'bot_help') {
                    await answerCallback(botToken, cb.id, '', proxyUrl);
                    await editMessage(botToken, chatId, msgId,
                        '❓ <b>使用帮助</b>\n\n' +
                        '直接把 <b>文件、图片、视频</b> 发给我，\n' +
                        '我会帮你上传到图床并返回访问链接。\n\n' +
                        '<b>📋 支持的类型：</b>\n' +
                        '• 图片（jpg / png / gif / webp）\n' +
                        '• 视频（mp4 等）\n' +
                        '• 音频（mp3 / ogg 等）\n' +
                        '• 任意文件（文档、压缩包 等）\n\n' +
                        '<b>📌 命令列表：</b>\n' +
                        '/start — 打开主菜单\n' +
                        '/list  — 最近上传的文件\n' +
                        '/help  — 显示此帮助\n\n' +
                        '<i>⚠️ 单文件最大 2 GB（免下载转存模式）</i>',
                        { reply_markup: buildMainMenuKeyboard(), disable_web_page_preview: true },
                        proxyUrl,
                    );
                    return;
                }

                if (data === 'bot_list') {
                    await answerCallback(botToken, cb.id, '正在获取列表…', proxyUrl);
                    const txt = await fetchRecentFiles(db, originUrl);
                    await editMessage(botToken, chatId, msgId, txt,
                        { reply_markup: buildMainMenuKeyboard(), disable_web_page_preview: true },
                        proxyUrl,
                    );
                    return;
                }

                if (data.startsWith('upload_')) {
                    const pendingKey = data.slice(7);
                    await answerCallback(botToken, cb.id, '正在转存到图床…', proxyUrl);

                    const pending = await getPending(db, pendingKey);
                    if (!pending) {
                        await editMessage(botToken, chatId, msgId,
                            '⚠️ 操作已超时（10 分钟），请重新发送文件。',
                            {}, proxyUrl,
                        );
                        return;
                    }

                    await editMessage(botToken, chatId, msgId,
                        `⏳ 正在转存 <b>${escapeHtml(pending.file_name)}</b> 到频道，请稍候…`,
                        {}, proxyUrl,
                    );

                    try {
                        const uploadConfig = await fetchUploadConfig(env, context);
                        const tgChannels = uploadConfig.telegram?.channels || [];
                        const tgChannel = tgChannels[0];
                        if (!tgChannel) {
                            throw new Error('未配置 Telegram 存储渠道，请在后台系统设置中启用并配置');
                        }

                        const targetChatId = tgChannel.chatId;
                        const targetBotToken = tgChannel.botToken || botToken;
                        const targetProxyUrl = tgChannel.proxyUrl || proxyUrl || env.TG_PROXY_URL || '';

                        // 构建唯一文件ID
                        const fakeUrl = new URL(context.request.url);
                        fakeUrl.searchParams.set('uploadNameType', 'default');
                        fakeUrl.searchParams.set('uploadFolder', '');
                        const fakeContext = {
                            ...context,
                            url: fakeUrl
                        };

                        const fullId = await buildUniqueFileId(fakeContext, pending.file_name, pending.mime_type);

                        const isLarge = pending.file_size > 20 * 1024 * 1024;
                        let metadata;

                        // 获取公开链接配置
                        const pageConfig = await fetchPageConfig(env);
                        const urlPrefixConfig = pageConfig.config?.find(c => c.id === 'urlPrefix');
                        const urlPrefix = urlPrefixConfig?.value || '';
                        const link = urlPrefix ? `${urlPrefix.replace(/\/+$/, '')}/${fullId}` : `${originUrl}/file/${fullId}`;

                        if (isLarge) {
                            await editMessage(botToken, chatId, msgId,
                                `⏳ 文件大于 20MB，正在下载并切片转存 <b>${escapeHtml(pending.file_name)}</b> 到频道，请稍候…`,
                                {}, proxyUrl
                            );



                            metadata = {
                                FileName: pending.file_name,
                                FileType: pending.mime_type,
                                FileSize: (pending.file_size / 1024 / 1024).toFixed(2),
                                FileSizeBytes: pending.file_size,
                                UploadIP: context.request.headers.get('CF-Connecting-IP') || '127.0.0.1',
                                UploadAddress: 'Telegram Bot',
                                ListType: "None",
                                TimeStamp: Date.now(),
                                Label: "None",
                                Directory: "",
                                Tags: ["tgbot_large"],
                                IsLargeFile: true,
                            };

                            const chunks = await downloadAndSliceTelegramFile(
                                botToken,
                                pending.file_id,
                                proxyUrl,
                                targetBotToken,
                                targetChatId,
                                targetProxyUrl,
                                pending.file_name,
                                pending.file_size
                            );

                            metadata.IsChunked = true;
                            metadata.TotalChunks = chunks.length;
                            metadata.Channel = "TelegramNew";
                            metadata.ChannelName = tgChannel.name;

                            await db.put(fullId, JSON.stringify(chunks), { metadata });
                            context.waitUntil(endUpload(fakeContext, fullId, metadata));
                        } else {
                            // 直接转存（免下载）
                            const copyRes = await copyMessage(targetBotToken, targetChatId, pending.chat_id, pending.message_id, {}, targetProxyUrl);
                            if (!copyRes.ok) {
                                throw new Error(`Telegram API copyMessage 失败: ${copyRes.description}`);
                            }

                            metadata = {
                                FileName: pending.file_name,
                                FileType: pending.mime_type,
                                FileSize: (pending.file_size / 1024 / 1024).toFixed(2),
                                FileSizeBytes: pending.file_size,
                                UploadIP: context.request.headers.get('CF-Connecting-IP') || '127.0.0.1',
                                UploadAddress: 'Telegram Bot',
                                ListType: "None",
                                TimeStamp: Date.now(),
                                Label: "None",
                                Directory: "",
                                Tags: [],
                                IsLargeFile: false,
                                Channel: "TelegramNew",
                                ChannelName: tgChannel.name,
                                TgFileId: pending.file_id,
                                TgMsgId: copyRes.result.message_id,
                                TgChatId: targetChatId,
                            };

                            // 写入 KV 数据库
                            await db.put(fullId, "", { metadata });

                            // 触发结束上传的后台任务（清除缓存、增加索引）
                            context.waitUntil(endUpload(fakeContext, fullId, metadata));
                        }

                        await deletePending(db, pendingKey);

                        await editMessage(botToken, chatId, msgId,
                            `✅ <b>上传成功！</b>\n\n` +
                            `📄 文件名：<code>${escapeHtml(pending.file_name)}</code>\n` +
                            `📦 大小：${formatSize(pending.file_size)}\n` +
                            `📎 类型：<code>${escapeHtml(pending.mime_type)}</code>\n\n` +
                            `🔗 <b>链接：</b>\n${link}`,
                            { disable_web_page_preview: true },
                            proxyUrl,
                        );
                    } catch (err) {
                        console.error('[TgBot] Copy & Register failed:', err);
                        await editMessage(botToken, chatId, msgId,
                            `❌ <b>上传失败</b>\n\n<code>${escapeHtml(String(err.message || err))}</code>\n\n` +
                            `请检查 Telegram 渠道配置后重试。`,
                            {}, proxyUrl,
                        );
                    }
                    return;
                }

                if (data.startsWith('cancel_')) {
                    const pendingKey = data.slice(7);
                    await answerCallback(botToken, cb.id, '已取消', proxyUrl);
                    await deletePending(db, pendingKey);
                    await editMessage(botToken, chatId, msgId,
                        '❌ 已取消，文件未上传到图床。',
                        {}, proxyUrl,
                    );
                    return;
                }

                await answerCallback(botToken, cb.id, '', proxyUrl);
                return;
            }

            // ── 普通消息 ───────────────────────────────────────────────────
            const message = update.message || update.channel_post;
            if (!message) return;

            const chatId = message.chat.id;
            const text = (message.text || '').trim();

            // /start 或 /menu
            if (/^\/start(@\S+)?(\s|$)/i.test(text) || /^\/menu(@\S+)?(\s|$)/i.test(text)) {
                await sendMessage(botToken, chatId,
                    '👋 <b>欢迎使用图床机器人！</b>\n\n' +
                    '直接把 <b>文件 / 图片 / 视频</b> 发给我，\n' +
                    '确认后即可自动上传到图床并获取访问链接。\n\n' +
                    '点击下方按钮快速操作 👇',
                    { reply_markup: buildMainMenuKeyboard() },
                    proxyUrl,
                );
                return;
            }

            // /help
            if (/^\/help(@\S+)?(\s|$)/i.test(text)) {
                await sendMessage(botToken, chatId,
                    '❓ <b>使用帮助</b>\n\n' +
                    '直接把 <b>文件、图片、视频</b> 发给我，\n' +
                    '我会帮你上传到图床并返回访问链接。\n\n' +
                    '<b>📋 支持的类型：</b>\n' +
                    '• 图片（jpg / png / gif / webp）\n' +
                    '• 视频（mp4 等）\n' +
                    '• 音频（mp3 / ogg 等）\n' +
                    '• 任意文件（文档、压缩包 等）\n\n' +
                    '<b>📌 命令列表：</b>\n' +
                    '/start — 打开主菜单\n' +
                    '/list  — 最近上传的文件\n' +
                    '/help  — 显示此帮助\n\n' +
                    '<i>⚠️ 单文件最大 2 GB（免下载转存模式）</i>',
                    { reply_markup: buildMainMenuKeyboard(), disable_web_page_preview: true },
                    proxyUrl,
                );
                return;
            }

            // /list
            if (/^\/list(@\S+)?(\s|$)/i.test(text)) {
                const txt = await fetchRecentFiles(db, originUrl);
                await sendMessage(botToken, chatId, txt,
                    { reply_markup: buildMainMenuKeyboard(), disable_web_page_preview: true },
                    proxyUrl,
                );
                return;
            }

            // 收到文件 → 直接上传到图床
            const fileInfo = extractFileFromMessage(message);
            if (fileInfo) {
                const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
                if (fileInfo.file_size > MAX_SIZE) {
                    await sendMessage(botToken, chatId,
                        `⚠️ <b>文件过大</b>\n\n` +
                        `<code>${escapeHtml(fileInfo.file_name)}</code>\n` +
                        `大小 ${formatSize(fileInfo.file_size)} 超过 2 GB 限制。\n\n` +
                        `请直接拖拽小于 2 GB 的文件。`,
                        {}, proxyUrl,
                    );
                    return;
                }

                // 发送 "正在转存..." 提示消息
                const replyRes = await sendMessage(botToken, chatId,
                    `⏳ 正在转存 <b>${escapeHtml(fileInfo.file_name)}</b> 到频道，请稍候…`,
                    { reply_to_message_id: message.message_id },
                    proxyUrl,
                );
                const msgId = replyRes?.ok ? replyRes.result.message_id : null;

                try {
                    const uploadConfig = await fetchUploadConfig(env, context);
                    const tgChannels = uploadConfig.telegram?.channels || [];
                    const tgChannel = tgChannels[0];
                    if (!tgChannel) {
                        throw new Error('未配置 Telegram 存储渠道，请在后台系统设置中启用并配置');
                    }

                    const targetChatId = tgChannel.chatId;
                    const targetBotToken = tgChannel.botToken || botToken;
                    const targetProxyUrl = tgChannel.proxyUrl || proxyUrl || env.TG_PROXY_URL || '';

                    // 构建唯一文件ID
                    const fakeUrl = new URL(context.request.url);
                    fakeUrl.searchParams.set('uploadNameType', 'default');
                    fakeUrl.searchParams.set('uploadFolder', '');
                    const fakeContext = {
                        ...context,
                        url: fakeUrl
                    };

                    const fullId = await buildUniqueFileId(fakeContext, fileInfo.file_name, fileInfo.mime_type);

                    const isLarge = fileInfo.file_size > 20 * 1024 * 1024;
                    let metadata;

                    // 获取公开链接配置
                    const pageConfig = await fetchPageConfig(env);
                    const urlPrefixConfig = pageConfig.config?.find(c => c.id === 'urlPrefix');
                    const urlPrefix = urlPrefixConfig?.value || '';
                    const link = urlPrefix ? `${urlPrefix.replace(/\/+$/, '')}/${fullId}` : `${originUrl}/file/${fullId}`;

                    if (isLarge) {
                        if (msgId) {
                            await editMessage(botToken, chatId, msgId,
                                `⏳ 文件大于 20MB，正在下载并切片转存 <b>${escapeHtml(fileInfo.file_name)}</b> 到频道，请稍候…`,
                                {}, proxyUrl
                            );
                        }



                        metadata = {
                            FileName: fileInfo.file_name,
                            FileType: fileInfo.mime_type,
                            FileSize: (fileInfo.file_size / 1024 / 1024).toFixed(2),
                            FileSizeBytes: fileInfo.file_size,
                            UploadIP: context.request.headers.get('CF-Connecting-IP') || '127.0.0.1',
                            UploadAddress: 'Telegram Bot',
                            ListType: "None",
                            TimeStamp: Date.now(),
                            Label: "None",
                            Directory: "",
                            Tags: ["tgbot_large"],
                            IsLargeFile: true,
                        };

                        const chunks = await downloadAndSliceTelegramFile(
                            botToken,
                            fileInfo.file_id,
                            proxyUrl,
                            targetBotToken,
                            targetChatId,
                            targetProxyUrl,
                            fileInfo.file_name,
                            fileInfo.file_size
                        );

                        metadata.IsChunked = true;
                        metadata.TotalChunks = chunks.length;
                        metadata.Channel = "TelegramNew";
                        metadata.ChannelName = tgChannel.name;

                        await db.put(fullId, JSON.stringify(chunks), { metadata });
                        context.waitUntil(endUpload(fakeContext, fullId, metadata));
                    } else {
                        // 直接转存（免下载）
                        const copyRes = await copyMessage(targetBotToken, targetChatId, chatId, message.message_id, {}, targetProxyUrl);
                        if (!copyRes.ok) {
                            throw new Error(`Telegram API copyMessage 失败: ${copyRes.description}`);
                        }

                        metadata = {
                            FileName: fileInfo.file_name,
                            FileType: fileInfo.mime_type,
                            FileSize: (fileInfo.file_size / 1024 / 1024).toFixed(2),
                            FileSizeBytes: fileInfo.file_size,
                            UploadIP: context.request.headers.get('CF-Connecting-IP') || '127.0.0.1',
                            UploadAddress: 'Telegram Bot',
                            ListType: "None",
                            TimeStamp: Date.now(),
                            Label: "None",
                            Directory: "",
                            Tags: [],
                            IsLargeFile: false,
                            Channel: "TelegramNew",
                            ChannelName: tgChannel.name,
                            TgFileId: fileInfo.file_id,
                            TgMsgId: copyRes.result.message_id,
                            TgChatId: targetChatId,
                        };

                        // 写入 KV 数据库
                        await db.put(fullId, "", { metadata });

                        // 触发结束上传的后台任务（清除缓存、增加索引）
                        context.waitUntil(endUpload(fakeContext, fullId, metadata));
                    }



                    const successText = `✅ <b>上传成功！</b>\n\n` +
                        `📄 文件名：<code>${escapeHtml(fileInfo.file_name)}</code>\n` +
                        `📦 大小：${formatSize(fileInfo.file_size)}\n` +
                        `📎 类型：<code>${escapeHtml(fileInfo.mime_type)}</code>\n\n` +
                        `🔗 <b>链接：</b>\n${link}`;

                    if (msgId) {
                        await editMessage(botToken, chatId, msgId, successText, { disable_web_page_preview: true }, proxyUrl);
                    } else {
                        await sendMessage(botToken, chatId, successText, { disable_web_page_preview: true, reply_to_message_id: message.message_id }, proxyUrl);
                    }
                } catch (err) {
                    console.error('[TgBot] Auto-upload failed:', err);
                    const errorText = `❌ <b>上传失败</b>\n\n<code>${escapeHtml(String(err.message || err))}</code>\n\n` +
                        `请检查 Telegram 渠道配置后重试。`;
                    if (msgId) {
                        await editMessage(botToken, chatId, msgId, errorText, {}, proxyUrl);
                    } else {
                        await sendMessage(botToken, chatId, errorText, { reply_to_message_id: message.message_id }, proxyUrl);
                    }
                }
                return;
            }

            // 其他文本消息
            if (text && !text.startsWith('/')) {
                await sendMessage(botToken, chatId,
                    '💡 请直接发送 <b>文件、图片或视频</b> 给我，我会帮你上传到图床。\n\n' +
                    '发送 /start 打开主菜单。',
                    {}, proxyUrl,
                );
            }

        } catch (err) {
            console.error('[TgBot] Handler error:', err);
            try {
                if (errChatId) {
                    await sendMessage(botToken, errChatId, `❌ <b>机器人运行出错：</b>\n<code>${escapeHtml(err.stack || err.message || err)}</code>`, {}, proxyUrl);
                }
            } catch (sendErr) {
                console.error('[TgBot] Failed to send error message:', sendErr);
            }
        }
    };

    context.waitUntil(handle());
    return new Response('ok', { status: 200 });
}
