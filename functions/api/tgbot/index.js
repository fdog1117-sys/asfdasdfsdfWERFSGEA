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
    // 优先使用 TG_UPLOAD_AUTH_CODE（专用上传认证码），其次从 URL 获取当前认证码
    const authCode = env.TG_UPLOAD_AUTH_CODE || '';
    if (authCode) {
        // 作为 URL 参数传递 authCode（图床认证核心会从 URL 中提取）
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

    const botToken = env.TG_BOT_TOKEN;
    if (!botToken) {
        return new Response('TG_BOT_TOKEN not configured', { status: 500 });
    }

    const proxyUrl = env.TG_PROXY_URL || '';
    const db = getDatabase(env);
    const originUrl = new URL(request.url).origin;

    let update;
    try {
        update = await request.json();
    } catch {
        return new Response('Bad Request', { status: 400 });
    }

    // 异步处理，立即返回 200
    const handle = async () => {
        try {

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
                        '<i>⚠️ 单文件最大 20 MB（Telegram Bot API 限制）</i>',
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
                    await answerCallback(botToken, cb.id, '正在上传…', proxyUrl);

                    const pending = await getPending(db, pendingKey);
                    if (!pending) {
                        await editMessage(botToken, chatId, msgId,
                            '⚠️ 操作已超时（10 分钟），请重新发送文件。',
                            {}, proxyUrl,
                        );
                        return;
                    }

                    await editMessage(botToken, chatId, msgId,
                        `⏳ 正在下载 <b>${escapeHtml(pending.file_name)}</b> 并上传到图床，请稍候…`,
                        {}, proxyUrl,
                    );

                    try {
                        const { arrayBuffer } = await downloadTgFile(botToken, pending.file_id, proxyUrl);
                        const link = await doUpload(context, pending, arrayBuffer, originUrl);
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
                        console.error('[TgBot] Upload failed:', err);
                        await editMessage(botToken, chatId, msgId,
                            `❌ <b>上传失败</b>\n\n<code>${escapeHtml(String(err.message || err))}</code>\n\n` +
                            `请检查图床渠道配置后重试，或直接通过网页上传。`,
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
                    '<i>⚠️ 单文件最大 20 MB（Telegram Bot API 限制）</i>',
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

            // 收到文件 → 弹出确认菜单
            const fileInfo = extractFileFromMessage(message);
            if (fileInfo) {
                const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
                if (fileInfo.file_size > MAX_SIZE) {
                    await sendMessage(botToken, chatId,
                        `⚠️ <b>文件过大</b>\n\n` +
                        `<code>${escapeHtml(fileInfo.file_name)}</code>\n` +
                        `大小 ${formatSize(fileInfo.file_size)} 超过 20 MB 限制。\n\n` +
                        `请直接通过图床网页上传大文件。`,
                        {}, proxyUrl,
                    );
                    return;
                }

                const pendingKey = `${chatId}_${message.message_id}`;
                await savePending(db, pendingKey, {
                    file_id: fileInfo.file_id,
                    file_name: fileInfo.file_name,
                    mime_type: fileInfo.mime_type,
                    file_size: fileInfo.file_size,
                    chat_id: chatId,
                });

                await sendMessage(botToken, chatId,
                    `📥 <b>收到文件，是否上传到图床？</b>\n\n` +
                    `📄 文件名：<code>${escapeHtml(fileInfo.file_name)}</code>\n` +
                    `📦 大小：${formatSize(fileInfo.file_size)}\n` +
                    `📎 类型：<code>${escapeHtml(fileInfo.mime_type)}</code>\n\n` +
                    `<i>请在 10 分钟内操作，超时需重新发送文件</i>`,
                    {
                        reply_to_message_id: message.message_id,
                        reply_markup: buildConfirmKeyboard(pendingKey),
                    },
                    proxyUrl,
                );
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
        }
    };

    context.waitUntil(handle());
    return new Response('ok', { status: 200 });
}
