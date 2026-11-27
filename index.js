import { cleanStoryboardSource, filterStoryboardSource, segmentSource, validatePlan, sceneIssues, shortSceneBatch, dialogueWarnings, DIALOGUE_WARNING_PREFIX, buildPagePrompt, buildSingleFramePrompt, singleFrames, DEFAULT_STORYBOARD_RULES, DEFAULT_SINGLE_STORYBOARD_RULES, DEFAULT_IMAGE_TEMPLATES, validateImageTemplate, fillWorkflow, workflowNodes, prepareComfyWorkflow, COMFY_WORKFLOW_FIELDS, bindingMatches, runPages } from './core.mjs';
import { checkHost, planWithCurrentConnection, detailScenesWithCurrentConnection, extractWorldbookProfiles, generateImage, normalizeComfyUrl, testComfyConnection, testNovelConnection, testWebUiConnection, readHostGenerationState, saveNovelKey, describeHistoryChat, listHistoryChats, readHistoryChat, HISTORY_CHAT_LIMIT } from './services.mjs';
import { collectReferences } from './references.mjs';
import { cleanCharacterProfiles, observedProfiles, reuseCharacterProfiles } from './character-cache.mjs';
import { DEFAULT_PREFERENCES, LEGACY_STYLE, upgradePreferences } from './preferences.mjs';

const ID = 'tw_comic';
const RUNTIME = '__twComicRuntime';
let runtime;
// 生命周期重启不清除此锁；旧请求返回前，重新启用也不能启动另一模型调用。
let activeTask = null;
const context = () => globalThis.SillyTavern.getContext();

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, action, className = '') {
    const node = el('button', `menu_button twc-button ${className}`, text);
    node.type = 'button'; node.addEventListener('click', action);
    return node;
}
function field(parent, label, value, multiline = true) {
    const wrap = el('label', 'twc-field'); wrap.append(el('span', '', label));
    const input = el(multiline ? 'textarea' : 'input', 'text_pole'); input.value = value;
    wrap.append(input); parent.append(wrap); return input;
}
function toggle(parent, label, checked) {
    const wrap = el('label', 'twc-toggle'); const input = el('input');
    input.type = 'checkbox'; input.checked = checked === true;
    wrap.append(input, el('span', '', label)); parent.append(wrap); return input;
}
function settings() {
    const ctx = context();
    const saved = ctx.extensionSettings[ID] ??= {};
    if (upgradePreferences(saved)) ctx.saveSettingsDebounced();
    return saved;
}
function showError(error) {
    // 不打印请求对象、模型原始响应或宿主配置。
    globalThis.toastr?.error(error?.message || '操作失败，请检查当前连接。', '漫画工作台');
}
function capture(index) {
    const ctx = context(); const message = ctx.chat[index];
    if (!ctx.chatId || !message || message.is_user || message.is_system) throw new Error('请选择聊天中的一条角色回复。');
    return { chatId: ctx.chatId, characterId: ctx.characterId, groupId: ctx.groupId, index, message, text: message.mes, swipe: message.swipe_id ?? 0 };
}
function current(bound) { return !runtime?.destroyed && bindingMatches(context(), bound); }
function newComicId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // 局域网 HTTP 页面也可以使用 getRandomValues。
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
const recordMode = record => record?.storyboardMode === 'single' ? 'single' : 'multi';
function recordFor(bound, mode) {
    const records = bound.message.extra?.[ID]?.variants ?? [];
    const matching = records.filter(r => r.original === bound.text && r.swipe === bound.swipe);
    if (mode) return matching.findLast(record => recordMode(record) === mode);
    return matching.reduce((latest, record) => (record.updated ?? 0) >= (latest?.updated ?? 0) ? record : latest, undefined);
}
async function saveRecord(bound, record) {
    if (!current(bound)) throw new Error('聊天或原消息已变化，结果未写回。');
    bound.message.extra ??= {};
    const store = bound.message.extra[ID] ??= { version: 1, variants: [] };
    if (!Array.isArray(store.variants)) throw new Error('漫画记录格式不兼容，请先导出备份。');
    const at = store.variants.findLastIndex(r => r.original === bound.text && r.swipe === bound.swipe && recordMode(r) === recordMode(record));
    if (at < 0) store.variants.push(record);
    else {
        const previous = store.variants[at];
        if (previous !== record) archiveImages(store, recordImages(previous));
        store.variants[at] = record;
    }
    await context().saveChat();
}
function safeImage(path) { return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\u0000-\u0020\\]/u.test(path); }
function recordImages(record) {
    const planPages = Array.isArray(record?.plan?.pages) ? record.plan.pages : [];
    const frameTitles = planPages.flatMap(page => Array.isArray(page?.panels) ? page.panels.map(() => page.title) : []);
    return [[record?.pages, recordMode(record) === 'single' ? '格' : '页', planPages.map(page => page?.title)], [record?.singlePages, '格', frameTitles]]
        .flatMap(([pages, unit, titles]) => Array.isArray(pages) ? pages.flatMap((page, index) => {
            if (!safeImage(page?.image)) return [];
            const title = typeof titles[index] === 'string' ? ` · ${titles[index]}` : '';
            return [{ image: page.image, label: `第 ${index + 1} ${unit}${title}` }];
        }) : []);
}
function primaryPrompts(plan, mode, style, appearance, templates) {
    return mode === 'single'
        ? singleFrames(plan).map(frame => buildSingleFramePrompt(plan, frame, style, appearance, templates?.single))
        : plan.pages.map((_, i) => buildPagePrompt(plan, i, style, appearance, templates?.multi));
}
function archiveImages(store, images) {
    if (!images.length) return;
    const archive = Array.isArray(store.archive) ? store.archive : (store.archive = []);
    const known = new Set(archive.map(item => item?.image));
    for (const item of images) if (!known.has(item.image)) {
        archive.push(item);
        known.add(item.image);
    }
}
function extractHistory(messages) {
    const seen = new Set();
    let number = 0;
    return messages.flatMap(message => {
        if (typeof message?.mes !== 'string') return [];
        number++;
        const stores = [message.extra?.[ID], ...(Array.isArray(message.swipe_info) ? message.swipe_info.map(swipe => swipe?.extra?.[ID]) : [])];
        return stores.flatMap(store => {
            const images = Array.isArray(store?.variants) ? store.variants.flatMap(recordImages) : [];
            if (Array.isArray(store?.archive)) images.push(...store.archive);
            return images.flatMap(item => {
                if (!safeImage(item?.image) || seen.has(item.image)) return [];
                seen.add(item.image);
                return [{ image: item.image, label: typeof item.label === 'string' ? item.label : '漫画图片', number }];
            });
        });
    });
}
function imageNode(path, label, openViewer) {
    const link = el('a', 'twc-image-link'); link.href = path; link.target = '_blank'; link.rel = 'noopener';
    const image = el('img', 'twc-image'); image.src = path; image.alt = label; image.loading = 'lazy';
    if (openViewer) {
        link.setAttribute('aria-haspopup', 'dialog');
        link.setAttribute('aria-label', `放大查看${label}`);
        link.addEventListener('click', event => { event.preventDefault(); openViewer(); });
    }
    link.append(image); return link;
}
function appendPanelText(parent, panel) {
    if (!panel?.texts.length) return;
    const lines = el('ul', 'twc-dialogue');
    lines.setAttribute('aria-label', '分镜对白、旁白与拟声');
    for (const line of panel.texts) {
        const label = line.speaker || (line.kind === 'sfx' ? '拟声' : line.kind === 'narration' ? '旁白' : '对白');
        lines.append(el('li', '', `${label}　${line.text}`));
    }
    parent.append(lines);
}
function showImageViewer(parent, path, label) {
    if (parent.querySelector('.twc-image-viewer')) return;
    const viewer = el('dialog', 'twc-image-viewer'); viewer.setAttribute('aria-label', `${label}大图`);
    const toolbar = el('div', 'twc-viewer-toolbar');
    const controls = el('div', 'twc-viewer-controls');
    const viewport = el('div', 'twc-viewer-viewport'); viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', '可滚动的漫画大图');
    const canvas = el('div', 'twc-viewer-canvas');
    const image = el('img', ''); image.alt = label; image.draggable = false;
    const level = el('output', '', '100%');
    level.setAttribute('aria-label', '缩放比例');
    let zoom = 100;
    const less = button('缩小', () => changeZoom(zoom - 25));
    const more = button('放大', () => changeZoom(zoom + 25));
    const fit = button('适合窗口', () => changeZoom(100));
    const close = button('关闭大图', () => viewer.close());
    close.autofocus = true;
    function sizeImage() {
        if (!image.naturalWidth || !viewport.clientWidth || !viewport.clientHeight) return;
        const scale = Math.min(1, viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight) * zoom / 100;
        image.style.width = `${Math.max(1, Math.floor(image.naturalWidth * scale))}px`;
    }
    function changeZoom(value) {
        const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth;
        const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight;
        zoom = Math.min(400, Math.max(100, value));
        level.textContent = `${zoom}%`;
        less.disabled = zoom === 100; more.disabled = zoom === 400;
        sizeImage();
        if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
            viewport.scrollLeft = zoom === 100 ? 0 : viewport.scrollWidth * centerX - viewport.clientWidth / 2;
            viewport.scrollTop = zoom === 100 ? 0 : viewport.scrollHeight * centerY - viewport.clientHeight / 2;
        }
    }
    viewport.addEventListener('wheel', event => {
        if (!event.ctrlKey || !event.deltaY) return;
        event.preventDefault(); changeZoom(zoom + (event.deltaY < 0 ? 25 : -25));
    }, { passive: false });
    image.addEventListener('load', sizeImage);
    image.src = path;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sizeImage) : null;
    viewer.addEventListener('close', () => { observer?.disconnect(); viewer.remove(); }, { once: true });
    controls.append(less, level, more, fit);
    toolbar.append(controls, close);
    canvas.append(image); viewport.append(canvas); viewer.append(toolbar, viewport); parent.append(viewer);
    viewer.showModal(); observer?.observe(viewport); changeZoom(100);
}

function mountOutputHistory(output, dialog) {
    const views = el('div', 'twc-output-formats');
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', '出图视图');
    const currentButton = button('本次出图', () => show(false));
    const historyButton = button('历史出图', () => { if (history.hidden) show(true); });
    views.append(currentButton, historyButton);
    const currentOutput = el('div');
    const history = el('section', 'twc-history');
    const toolbar = el('div', 'twc-history-toolbar');
    const pickerLabel = el('label', 'twc-field');
    const picker = el('select', 'text_pole');
    pickerLabel.append(el('span', '', '聊天'), picker);
    toolbar.append(pickerLabel, button('刷新历史', load));
    const status = el('p', 'twc-help twc-history-status');
    status.setAttribute('role', 'status');
    const gallery = el('div', 'twc-history-gallery');
    history.append(toolbar, status, gallery);
    output.append(views, currentOutput, history);
    let scan;
    let albums = new Map();

    function stop() { scan?.abort(); }
    function show(historical) {
        currentOutput.hidden = historical;
        history.hidden = !historical;
        currentButton.setAttribute('aria-pressed', String(!historical));
        historyButton.setAttribute('aria-pressed', String(historical));
        if (historical) void load();
        else stop();
    }
    function renderGallery() {
        gallery.replaceChildren();
        const album = albums.get(picker.value);
        if (!album) return;
        const groups = new Map();
        for (const { image, label, number } of album.images) {
            if (!groups.has(number)) {
                const group = el('section', 'twc-surface twc-history-group');
                const grid = el('div', 'twc-history-grid');
                group.append(el('h3', '', `第 ${number} 条消息`), grid);
                gallery.append(group); groups.set(number, grid);
            }
            const card = el('div', 'twc-history-card');
            const picture = imageNode(image, label, () => showImageViewer(dialog, image, label));
            const fallback = el('p', 'twc-help', '图片文件无法加载。'); fallback.hidden = true;
            picture.querySelector('img').addEventListener('error', () => { picture.hidden = true; fallback.hidden = false; });
            const downloadLink = el('a', 'menu_button twc-button', '下载');
            downloadLink.href = image; downloadLink.setAttribute('download', '');
            card.append(picture, fallback, el('span', '', label), downloadLink);
            groups.get(number).append(card);
        }
    }
    picker.addEventListener('change', renderGallery);

    function updatePicker(changedKey) {
        const selected = picker.value;
        const ordered = [...albums.values()].sort((a, b) => a.order - b.order);
        picker.replaceChildren(...ordered.map(album => {
            const option = el('option', '', `${album.name}（${album.images.length} 张）`);
            option.value = album.key;
            return option;
        }));
        picker.disabled = !ordered.length;
        picker.value = albums.has(selected) ? selected : ordered[0]?.key ?? '';
        if (selected !== picker.value || changedKey === picker.value) renderGallery();
    }
    async function load() {
        stop();
        const controller = scan = new AbortController();
        const { signal } = controller;
        const ctx = context();
        const live = describeHistoryChat({ file_name: ctx.chatId, group: ctx.groupId, avatar: ctx.characters?.[ctx.characterId]?.avatar }, ctx)
            ?? { key: 'current', name: `${ctx.chatId ?? '聊天'}` };
        const liveImages = extractHistory(ctx.chat ?? []);
        let checked = 0;
        let failed = 0;
        albums = new Map();
        if (liveImages.length) albums.set(live.key, { ...live, name: `${live.name}（当前聊天）`, images: liveImages, order: -1 });
        updatePicker(live.key);
        status.textContent = '正在查找聊天里的历史图片…';
        try {
            const { chats, limited } = await listHistoryChats(ctx, signal);
            if (signal.aborted) return;
            let next = 0;
            async function scanChats() {
                while (!signal.aborted && next < chats.length) {
                    const index = next++;
                    const chat = chats[index];
                    try {
                        const messages = await readHistoryChat(ctx, chat, signal);
                        if (signal.aborted) return;
                        const images = extractHistory(messages);
                        const isCurrent = chat.key === live.key;
                        if (isCurrent) {
                            const savedPaths = new Set(images.map(item => item.image));
                            images.push(...liveImages.filter(item => !savedPaths.has(item.image)));
                        }
                        if (images.length) {
                            albums.set(chat.key, { ...chat, name: isCurrent ? `${chat.name}（当前聊天）` : chat.name, images, order: isCurrent ? -1 : index });
                            updatePicker(chat.key);
                        }
                    } catch {
                        if (signal.aborted) return;
                        failed++;
                    }
                    checked++;
                    status.textContent = `已检查 ${checked} / ${chats.length} 个聊天，找到 ${albums.size} 个有出图的聊天。`;
                }
            }
            await Promise.all(Array.from({ length: Math.min(4, chats.length) }, scanChats));
            if (signal.aborted) return;
            status.textContent = (albums.size ? `找到 ${albums.size} 个聊天的历史出图。` : '没有找到可查看的历史出图。')
                + (failed ? `有 ${failed} 个聊天读取失败，可刷新重试。` : '')
                + (limited ? `已检查最近 ${HISTORY_CHAT_LIMIT} 个聊天。` : '');
        } catch {
            if (!signal.aborted) status.textContent = '无法读取聊天列表。可查看当前聊天已载入的图片，或刷新重试。';
        }
    }
    show(false);
    return { currentOutput, stop, showCurrent: () => show(false) };
}

function removeInlineComic(group) {
    const parent = group.parentNode;
    group.remove();
    parent?.normalize();
}

function insertInlineComics(body, record, pictures, frames, unit) {
    const inserted = new Set();
    const groups = [];
    if (!body || !pictures.some(page => safeImage(page.image))) return { body, groups, inserted };

    // 根据显示中的文本定位，兼容被 Markdown 拆成多个节点的段落。
    const points = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const part of node.data.matchAll(/[\p{L}\p{N}]/gu)) {
            points.push({ node, offset: part.index + part[0].length, char: part[0] });
        }
    }
    const display = points.map(point => point.char).join('');
    const plain = value => value.replace(/[^\p{L}\p{N}]/gu, '');
    const pointByOffset = new Map();
    let length = 0;
    for (const point of points) {
        length += point.char.length;
        pointByOffset.set(length, point);
    }
    const spans = segmentSource(record.source || record.original).map(({ text }) => {
        const fragment = plain(text);
        if (!fragment) return null;
        const start = display.indexOf(fragment);
        if (start < 0 || start !== display.lastIndexOf(fragment)) return null;
        return { start, end: start + fragment.length };
    });
    const anchors = new Map();
    let sourceIds = [];
    let previousEnd = 0;
    for (const [index, picture] of pictures.entries()) {
        const frame = frames[index];
        const page = frame?.page ?? record.plan.pages[index];
        if (page?.source_ids?.length) sourceIds = page.source_ids;
        const span = spans[sourceIds.at(-1) - 1];
        if (!span) continue;
        let end = span.end;
        if (frame) {
            // 同一原文段落的单格可按逐字对白落在不同语句后。
            const fragment = display.slice(span.start, span.end);
            for (const { text } of frame.panel.texts.toReversed()) {
                const line = plain(text);
                if (!line) continue;
                const at = fragment.indexOf(line);
                if (at >= 0 && at === fragment.lastIndexOf(line)) {
                    end = span.start + at + line.length;
                    break;
                }
            }
        }
        end = Math.max(previousEnd, end);
        previousEnd = end;
        if (!safeImage(picture.image)) continue;
        let group = anchors.get(end);
        if (!group) {
            group = el('span', 'twc-inline-comic');
            anchors.set(end, group);
        }
        group.append(imageNode(picture.image, `第 ${index + 1} ${unit}漫画 · ${page?.title ?? ''}`));
        inserted.add(index);
    }
    // 由后往前插入，以免前面的插入拆开后续锚点所在的文本节点。
    for (const [end, group] of [...anchors].reverse()) {
        const { node, offset } = pointByOffset.get(end);
        const punctuation = node.data.slice(offset).match(/^[。！？!?，、；;：:…．.）)】」』”’"'》〉]+/u)?.[0];
        const range = document.createRange();
        range.setStart(node, offset + (punctuation?.length ?? 0));
        range.collapse(true);
        range.insertNode(group);
        groups.push(group);
    }
    return { body, groups, inserted };
}

function renderMessages() {
    if (runtime.destroyed) return;
    const ctx = context();
    const inlineEnabled = ctx.extensionSettings[ID]?.inlineImages === true;
    for (const mes of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(mes.getAttribute('mesid'));
        const message = ctx.chat[index];
        if (!message || message.is_user || message.is_system) continue;
        const host = mes.querySelector('.mes_buttons');
        if (host && !host.querySelector('.twc-message-button')) {
            host.append(button('生成多页漫画', () => openEditor(Number(mes.getAttribute('mesid'))).catch(showError), 'twc-message-button'));
        }
        const bound = ctx.chatId ? capture(index) : null;
        const old = mes.querySelector('.twc-reader');
        const inline = old && runtime.inlineReaders.get(old);
        const body = inlineEnabled ? mes.querySelector('.mes_text') : null;
        const running = runtime.generationBound?.message === message && current(runtime.generationBound);
        let record = bound ? recordFor(bound, running ? runtime.generationMode : undefined) : null;
        if (record && !running && !recordImages(record).length) {
            const other = recordFor(bound, recordMode(record) === 'single' ? 'multi' : 'single');
            if (other && recordImages(other).length) record = other;
        }
        const key = record ? `${record.id}:${record.updated}:${running}:${inlineEnabled}` : '';
        if (old?.dataset.revision === key && (!body || (inline?.body === body && inline.groups.every(group => body.contains(group))))) continue;
        for (const group of inline?.groups ?? []) removeInlineComic(group);
        const wasOpen = old?.open;
        old?.remove();
        if (!record) continue;
        const reader = el('details', 'twc-reader'); reader.dataset.revision = key;
        reader.open = Boolean(wasOpen);
        const legacySingle = recordMode(record) === 'multi' && record.outputMode === 'single' && Array.isArray(record.singlePages);
        const single = recordMode(record) === 'single' || legacySingle;
        const pictures = legacySingle ? record.singlePages : record.pages;
        const frames = single ? singleFrames(record.plan) : [];
        const unit = single ? '格' : '页';
        const placement = insertInlineComics(body, record, pictures, frames, unit);
        runtime.inlineReaders.set(reader, placement);
        const completed = pictures.filter(p => safeImage(p.image) && !p.stale).length;
        const summary = el('summary', '', running ? `漫画生成中 · ${completed} / ${pictures.length}` : `漫画 · ${completed} / ${pictures.length} ${unit}已生成`);
        if (running) summary.addEventListener('click', event => {
            event.preventDefault();
            openEditor(Number(mes.getAttribute('mesid'))).catch(showError);
        });
        reader.append(summary);
        reader.append(button('查看分镜 / 继续生成', () => openEditor(Number(mes.getAttribute('mesid'))).catch(showError)));
        for (const [i, page] of pictures.entries()) if (safeImage(page.image) && !placement.inserted.has(i)) {
            const title = single ? frames[i]?.page.title : record.plan.pages[i]?.title;
            reader.append(el('p', 'twc-caption', `第 ${i + 1} ${unit} · ${title || ''}${page.stale ? ' · 分镜已修改，下方保留旧图供对照' : ''}`));
            reader.append(imageNode(page.image, `第 ${i + 1} ${unit}漫画`));
            if (single) appendPanelText(reader, frames[i]?.panel);
        }
        (mes.querySelector('.mes_block') || mes).append(reader);
    }
}

async function loadWorkflow({ workflow, useLegacyWorkflow }) {
    if (workflow) return workflow;
    if (!useLegacyWorkflow) throw new Error('请先在「准备 → 绘图后端」导入 ComfyUI API 工作流并保存。');
    const response = await fetch(new URL('./workflows/moss-25-api.json', import.meta.url));
    if (!response.ok) throw new Error('旧安装中的 MOSS 工作流文件已找不到。请到「绘图后端」重新导入 API 工作流。');
    return response.json();
}

function selectField(parent, label, options, value) {
    const wrap = el('label', 'twc-field');
    const select = el('select', 'text_pole');
    setOptions(select, options, value);
    wrap.append(el('span', '', label), select);
    parent.append(wrap);
    return select;
}

function setOptions(select, options, value) {
    select.replaceChildren(...options.map(([key, label]) => {
        const option = el('option', '', label);
        option.value = key;
        return option;
    }));
    select.value = options.some(([key]) => key === value) ? value : options[0][0];
}

function mountDrawingSettings(prep, config) {
    const section = el('details', 'twc-disclosure twc-drawing-settings');
    section.append(el('summary', '', '绘图后端'));
    const choices = [['off', '关闭'], ['novel', 'NovelAI'], ['webui', 'SD WebUI'], ['comfy', 'ComfyUI']];
    const backend = selectField(section, '后端类型', choices, config.drawingBackend);
    const fields = el('div');
    const comfy = el('div');
    const novel = el('div');
    const webui = el('div');
    section.append(comfy, novel, webui);
    const url = field(comfy, 'ComfyUI 服务地址', config.comfyUrl, false);
    url.type = 'url';
    url.placeholder = 'http://127.0.0.1:8188';
    comfy.append(el('p', 'twc-help', '通过酒馆后端连接。两项服务在同一台电脑时，可填上面的示例地址。'));
    const model = field(novel, 'NovelAI 模型 ID', config.novelModel, false);
    const novelKey = field(novel, 'NovelAI API 密钥', '', false);
    novelKey.type = 'password';
    novelKey.autocomplete = 'new-password';
    novelKey.spellcheck = false;
    novelKey.placeholder = '已在酒馆保存过密钥可留空';
    const keyStatus = el('p', 'twc-help twc-novel-key-status');
    keyStatus.setAttribute('role', 'status');
    const saveKey = button('保存 NovelAI 密钥', async () => {
        if (test.disabled) return;
        novelKey.disabled = saveKey.disabled = true;
        keyStatus.textContent = '';
        connection.textContent = '';
        try {
            await saveNovelKey(novelKey.value);
            novelKey.value = '';
            keyStatus.textContent = '密钥已保存，可以测试连接。';
        } catch (error) {
            keyStatus.textContent = error.message;
        } finally {
            novelKey.disabled = saveKey.disabled = false;
        }
    });
    novel.append(el('p', 'twc-help', '密钥保存到酒馆，并作为酒馆当前使用的 NovelAI 密钥。测试连接只查询订阅状态。'), saveKey, keyStatus);
    const webuiUrl = field(webui, 'SD WebUI 服务地址', config.webuiUrl, false);
    webuiUrl.type = 'url';
    webuiUrl.placeholder = 'http://127.0.0.1:7860';
    webui.append(el('p', 'twc-help', '请用 --api 启动 SD WebUI。出图使用 WebUI 当前加载的模型。'));
    const connection = el('p', 'twc-status'); connection.setAttribute('role', 'status');
    const connectionControls = el('div');
    function connectionDraft() {
        return [backend.value, backend.value === 'webui' ? webuiUrl.value : backend.value === 'comfy' ? url.value : ''];
    }
    const test = button('测试连接', async () => {
        const [type, address] = connectionDraft();
        if (type === 'off') return;
        if (type === 'novel' && saveKey.disabled) return;
        if (type === 'novel' && novelKey.value.trim()) {
            connection.textContent = '请先点击「保存 NovelAI 密钥」，再测试连接。';
            return;
        }
        test.disabled = true;
        connection.textContent = '正在从酒馆后端检查连接…';
        const matchesDraft = () => {
            const [currentType, currentAddress] = connectionDraft();
            return currentType === type && currentAddress === address;
        };
        try {
            if (type === 'novel') await testNovelConnection(context());
            else if (type === 'webui') await testWebUiConnection(context(), address);
            else await testComfyConnection(context(), address);
            if (matchesDraft()) connection.textContent = `${choices.find(([value]) => value === type)[1]} 连接成功。`;
        } catch (error) {
            if (matchesDraft()) connection.textContent = error.message;
        }
        finally { test.disabled = false; }
    });
    for (const input of [url, webuiUrl]) input.addEventListener('input', () => { connection.textContent = ''; });
    novelKey.addEventListener('input', () => { keyStatus.textContent = ''; connection.textContent = ''; });
    connectionControls.append(test, connection);
    section.append(connectionControls);

    const file = el('input', 'twc-workflow-file');
    file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    fields.append(file, button('选择 API 工作流文件', () => file.click()));
    const paste = el('details', 'twc-workflow-json');
    paste.append(el('summary', '', '粘贴或查看 API 工作流 JSON'));
    const json = field(paste, 'API 工作流 JSON', config.workflow ? JSON.stringify(config.workflow, null, 2) : '');
    json.rows = 5;
    const legacy = el('p', 'twc-help', '已沿用此安装原有的 MOSS 工作流。导入新文件即可替换。');
    const mapping = el('div', 'twc-workflow-mapping');
    const feedback = el('p', 'twc-status'); feedback.setAttribute('role', 'status');
    const inputs = Object.entries(COMFY_WORKFLOW_FIELDS).map(([key, spec]) => [
        key, spec, selectField(mapping, spec.label, [['', '请选择']], ''),
    ]);
    fields.append(legacy, paste, mapping);
    let graph = null;
    function refreshWorkflow(selections = {}) {
        graph = null;
        legacy.hidden = !config.useLegacyWorkflow || Boolean(json.value.trim());
        mapping.hidden = true;
        if (!json.value.trim()) return;
        const parsed = JSON.parse(json.value);
        const nodes = workflowNodes(parsed);
        for (const [key, { type }, select] of inputs) {
            const placeholder = `%${key}%`;
            const options = [['', key === 'prompt' ? '请选择节点输入' : '保留工作流设置']];
            for (const [id, node] of nodes) {
                for (const [input, value] of Object.entries(node.inputs)) {
                    if (value === placeholder || (typeof value === type && (type !== 'string' || !/^%[\w_]+%$/u.test(value)))) {
                        options.push([JSON.stringify([id, input]), `#${id} · ${node._meta?.title || node.class_type} · ${input}`]);
                    }
                }
            }
            const existing = nodes.some(([, node]) => Object.values(node.inputs).includes(placeholder));
            select.disabled = existing;
            setOptions(select, existing ? [['', '使用工作流中的占位符']] : options, selections[key]);
        }
        graph = parsed;
        mapping.hidden = false;
    }
    const readSelections = () => Object.fromEntries(inputs.map(([key, , select]) => [key, select.value]));
    function readDraft(selections) {
        try {
            refreshWorkflow(selections);
            feedback.textContent = graph ? `已读取 ${Object.keys(graph).length} 个节点，请核对各项输入并保存。` : '';
        } catch (error) {
            feedback.textContent = error instanceof SyntaxError ? '工作流 JSON 读不出来，请检查文件格式。' : error.message;
        }
    }
    let draftVersion = 0;
    file.addEventListener('change', async () => {
        const picked = file.files?.[0];
        if (!picked) return;
        const version = ++draftVersion;
        try {
            const content = await picked.text();
            if (version !== draftVersion) return;
            json.value = content;
            readDraft();
        } catch {
            if (version === draftVersion) feedback.textContent = '无法读取文件，请重新选择。';
        } finally {
            if (version === draftVersion) file.value = '';
        }
    });
    json.addEventListener('input', () => { draftVersion++; });
    json.addEventListener('change', () => readDraft(readSelections()));
    function showBackend() {
        comfy.hidden = fields.hidden = backend.value !== 'comfy';
        novel.hidden = backend.value !== 'novel';
        if (novel.hidden) {
            novelKey.value = '';
            keyStatus.textContent = '';
        }
        webui.hidden = backend.value !== 'webui';
        connectionControls.hidden = backend.value === 'off';
        connection.textContent = '';
        feedback.textContent = '';
    }
    backend.addEventListener('change', showBackend);
    section.append(fields, button('保存绘图设置', () => {
        try {
            if (backend.value === 'comfy') {
                const address = normalizeComfyUrl(url.value);
                refreshWorkflow(readSelections());
                if (!graph && !config.useLegacyWorkflow) throw new Error('请导入 ComfyUI 的 API 格式工作流。');
                const bindings = Object.fromEntries(inputs.filter(([, , select]) => select.value)
                    .map(([key, , select]) => [key, JSON.parse(select.value)]));
                if (graph) prepareComfyWorkflow(graph, bindings);
                Object.assign(config, { comfyUrl: address, workflow: graph, workflowBindings: bindings, useLegacyWorkflow: !graph });
            } else if (backend.value === 'webui') {
                config.webuiUrl = normalizeComfyUrl(webuiUrl.value, 'SD WebUI');
            } else if (backend.value === 'novel') {
                if (!model.value.trim()) throw new Error('请填写 NovelAI 模型 ID。');
                config.novelModel = model.value.trim();
            }
            config.drawingBackend = backend.value;
            context().saveSettingsDebounced();
            feedback.textContent = backend.value === 'off' ? '已关闭绘图后端。' : '绘图设置已保存。';
        } catch (error) {
            feedback.textContent = error instanceof SyntaxError ? '请提供有效的 API 工作流 JSON。' : error.message;
        }
    }), feedback);
    showBackend();
    readDraft(Object.fromEntries(Object.entries(config.workflowBindings).map(([key, pair]) => [key, JSON.stringify(pair)])));
    if (graph) feedback.textContent = '';
    prep.append(section);
}

function mountSettings() {
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) throw new Error('找不到酒馆扩展设置区域，未挂载漫画扩展。');
    const box = el('details', 'twc-settings'); box.id = 'twc-settings';
    box.append(el('summary', '', '漫画工作台'));
    const config = settings();
    box.append(el('h4', '', '分镜与人物资料'));
    box.append(el('p', 'twc-help', '分镜规划使用酒馆当前连接。点击规划才调用模型。'));
    const useWorldbook = toggle(box, '读取世界书资料（只读）', config.useWorldbook);
    box.append(el('p', 'twc-help', '两个开关互相独立，作为新规划的默认值。世界书读取当前角色、群组角色、聊天与全局绑定书的匹配条目；不会执行原生触发器或宏。'));
    box.append(el('p', 'twc-help', '分镜提示词、出图模板和输出上限可在工作台的「规则」页调整。'));
    const style = field(box, '默认画风', config.style);
    const appearance = field(box, '共用人物外观（可留空，或每次在预览中填写）', config.appearance);
    const result = el('p', 'twc-status'); result.setAttribute('role', 'status');
    box.append(button('保存设置', () => {
        try {
            Object.assign(config, { style: style.value, appearance: appearance.value, useWorldbook: useWorldbook.checked });
            context().saveSettingsDebounced(); result.textContent = '设置已保存。';
        } catch (error) { result.textContent = error.message; }
    }), result);
    host.append(box); runtime.nodes.add(box);
}

async function openEditor(index) {
    const owner = runtime;
    if (owner.dialog?.open) { owner.dialog.focus(); return; }
    if (owner.dialog) {
        if (owner.dialogBound.index !== index || !current(owner.dialogBound)) throw new Error('上一条漫画仍在处理。请从对应消息打开进度，或等待请求结束。');
        owner.showGeneration();
        owner.dialog.showModal();
        return;
    }
    const bound = capture(index); const config = settings();
    let record = recordFor(bound); let localBusy = false; let halted = false;
    let mode = recordMode(record);
    let legacyOutput = mode === 'multi' && record?.outputMode === 'single' && Boolean(record.singlePages?.length);
    let outputMode = legacyOutput ? 'single' : mode;
    const drafts = new Map();
    let generatingImages = false; let stopRequested = false;
    const dialog = el('dialog', 'twc-dialog'); owner.dialog = dialog; owner.dialogBound = bound; owner.nodes.add(dialog);
    const heading = el('div', 'twc-heading');
    const title = el('h2', '', '漫画工作台'); title.id = 'twc-workspace-title'; heading.append(title);
    dialog.setAttribute('aria-labelledby', title.id);
    const close = button('关闭', () => { dialog.close(); }); heading.append(close); dialog.append(heading);
    const nav = el('nav', 'twc-stages'); nav.setAttribute('aria-label', '漫画制作步骤'); dialog.append(nav);
    const main = el('div', 'twc-workspace-main'); dialog.append(main);
    const stages = ['准备', '分镜', '出图', '规则'].map((label, index) => {
        const panel = el('section', 'twc-stage'); panel.id = `twc-stage-${index}`; main.append(panel);
        const tab = button(label, () => showStage(index), 'twc-stage-tab');
        tab.setAttribute('aria-controls', panel.id); nav.append(tab);
        return { panel, tab };
    });
    const [prep, story, output, rules] = stages.map(stage => stage.panel);
    function showStage(active) {
        for (const [index, { panel, tab }] of stages.entries()) {
            panel.hidden = index !== active;
            tab.setAttribute('aria-pressed', String(index === active));
        }
        main.scrollTop = 0;
        syncControls();
    }
    owner.showGeneration = () => {
        outputHistory.showCurrent();
        const runningPage = record ? outputPictures().findIndex(page => page.status === 'generating') : -1;
        if (runningPage >= 0) { selectedOutput = runningPage; renderOutput(); }
        showStage(2);
    };
    const prepBody = el('div', 'twc-prepare-grid'); prep.append(prepBody);
    const copy = el('section', 'twc-surface'); prepBody.append(copy);
    const sources = el('section', 'twc-surface'); prepBody.append(sources);
    sources.append(el('h3', '', '人物资料'));
    const cleanOriginal = cleanStoryboardSource(bound.text);
    const source = field(copy, '待改编正文', record?.source ?? cleanOriginal); source.rows = 12;
    copy.append(el('p', 'twc-help', '这里的修改只用于漫画。规划时会自动清理已识别的推理标签和状态占位符。'));
    const appearance = field(copy, '人物外观与当前状态', record?.appearance ?? config.appearance); appearance.rows = 3;
    const inlineImages = toggle(copy, '在对应正文后插入漫画图片', config.inlineImages);
    inlineImages.className = 'twc-inline-toggle';
    inlineImages.addEventListener('change', () => {
        config.inlineImages = inlineImages.checked;
        context().saveSettingsDebounced();
        renderMessages();
    });
    const useWorldbook = toggle(sources, '读取世界书资料（本次，只读）', record?.sourceOptions?.useWorldbook ?? config.useWorldbook);
    sources.append(el('p', 'twc-help', '用酒馆当前模型提取世界书里的角色名、外貌和服装。'));
    const referenceStatus = el('p', 'twc-help twc-reference-status'); referenceStatus.setAttribute('role', 'status'); sources.append(referenceStatus);
    const referenceData = el('pre', 'twc-reference-data');
    referenceData.hidden = true;
    sources.append(referenceData);
    useWorldbook.addEventListener('change', () => {
        showPeople([]);
        referenceStatus.textContent = '来源已切换，下次读取或规划将使用当前开关。';
    });
    const prepActions = el('div', 'twc-actions'); prep.append(prepActions);
    const options = el('details', 'twc-disclosure'); options.append(el('summary', '', '画风与工具')); prep.append(options);
    const style = field(options, '本次画风', record?.style === LEGACY_STYLE ? config.style : record?.style ?? config.style); style.rows = 4;
    mountDrawingSettings(prep, config);
    const footer = el('footer', 'twc-footer'); dialog.append(footer);
    const status = el('p', 'twc-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); footer.append(status);
    const ruleBox = el('section', 'twc-surface'); rules.append(ruleBox);
    const responseLimit = field(ruleBox, 'AI 输出上限（token）', config.responseLength, false);
    responseLimit.type = 'number'; responseLimit.min = '1024'; responseLimit.max = '64000';
    ruleBox.append(el('p', 'twc-help', '用于规划分页和 AI 补写，实际可用上限取决于当前模型。'));
    const plannerRules = field(ruleBox, '多格分镜提示词', config.storyboardRules || DEFAULT_STORYBOARD_RULES); plannerRules.rows = 10;
    const singlePlannerRules = field(ruleBox, '单格分镜提示词', config.singleStoryboardRules || DEFAULT_SINGLE_STORYBOARD_RULES); singlePlannerRules.rows = 10;
    ruleBox.append(el('p', 'twc-help', '插件会自动附上对应模式的 JSON 格式、段落编号和每格最低字数要求。'));
    ruleBox.append(el('p', 'twc-help', '单格会检查正文中省略的过程，按需补成独立镜头。补充镜头可在「分镜」修改，在「出图」选择是否参与批量生成。'));
    const sceneRules = el('details', 'twc-disclosure');
    sceneRules.append(el('summary', '', '场景规则'));
    const sceneGuide = field(sceneRules, '补充分镜写法', config.sceneGuide ?? '');
    sceneGuide.rows = 5;
    const fillSceneGuide = button('填入场景示例', () => {
        sceneGuide.value = '先定这一格最值得看的动作或反应，再按焦点选景别。近景突出表情，完整互动要留出手势和接触点。只写取景内未被遮挡的站位、朝向和持物状态。光线以正文为准，缺省时按时间和地点推定。相邻格保持人物和道具状态连续。';
    });
    const saveSceneGuide = button('保存场景规则', () => {
        config.sceneGuide = sceneGuide.value.trim();
        context().saveSettingsDebounced();
        status.textContent = '场景规则已保存，下次规划时生效。';
    });
    sceneRules.append(el('p', 'twc-help', '单格和多格共用。留空时使用既有分镜规则。'), fillSceneGuide, saveSceneGuide);
    ruleBox.append(sceneRules);
    const templateSection = el('section', 'twc-surface twc-image-templates');
    rules.append(templateSection);
    templateSection.append(el('h3', '', '生图提示词模板'));
    const presetBar = el('div', 'twc-template-toolbar');
    templateSection.append(presetBar);
    const presetLabel = el('label', 'twc-field');
    const presetSelect = el('select', 'text_pole');
    presetLabel.append(el('span', '', '当前预设'), presetSelect);
    presetBar.append(presetLabel);
    const presetName = field(presetBar, '预设名称', '', false);
    const templateBoxes = {};
    for (const [mode, label, keys] of [
        ['multi', '多格生图提示词', '{{分镜}} 必填。可用 {{画风}}、{{人物}}、{{页码}}、{{总页数}}、{{标题}}、{{格数}}、{{情绪}}。'],
        ['single', '单格生图提示词', '{{画面}} 和 {{文字}} 必填。可用 {{画风}}、{{人物}}、{{标题}}、{{情绪}}。'],
    ]) {
        const fold = el('details', 'twc-disclosure');
        fold.append(el('summary', '', label));
        templateBoxes[mode] = field(fold, '模板正文', config.imageTemplates?.[mode] || DEFAULT_IMAGE_TEMPLATES[mode]);
        templateBoxes[mode].rows = 7;
        fold.append(el('p', 'twc-help', keys));
        templateSection.append(fold);
    }
    const tagRules = el('details', 'twc-disclosure');
    tagRules.append(el('summary', '', '模型 Tag 指南'));
    const tagGuide = field(tagRules, '当前预设的标签写法', config.imageTemplates?.tagGuide ?? '');
    tagGuide.rows = 5;
    const fillTagGuide = button('填入英文 Tag 示例', () => {
        tagGuide.value = '用逗号分隔的简短英文标签描述可见外貌、服装、环境和光影。顺序为主体、外貌、服装、动作与表情、环境、光影和镜头。复杂动作、接触点和多人位置用完整短句，明确角色与动作的归属。只填当前镜头可见的信息。';
    });
    tagRules.append(el('p', 'twc-help', '随生图预设保存。下次规划时指导模型组织画面描述，留空沿用原有写法。'), fillTagGuide);
    templateSection.append(tagRules);
    const presets = config.imageTemplatePresets ??= [];
    const selection = () => presets.find(preset => preset.id === config.activeImageTemplatePreset);
    const editorStatus = el('p', 'twc-help');
    editorStatus.setAttribute('role', 'status');
    function renderPresets() {
        presetSelect.replaceChildren(...[{ id: '', name: '默认预设' }, ...presets].map(preset => {
            const option = el('option', '', preset.name);
            option.value = preset.id;
            return option;
        }));
        presetSelect.value = selection()?.id ?? '';
        presetName.value = selection()?.name ?? '';
        deletePreset.disabled = !selection();
    }
    function loadPreset(templates) {
        for (const mode of Object.keys(templateBoxes)) templateBoxes[mode].value = templates?.[mode] || DEFAULT_IMAGE_TEMPLATES[mode];
        tagGuide.value = templates?.tagGuide ?? '';
    }
    function draftTemplates() {
        const templates = Object.fromEntries(Object.entries(templateBoxes).map(([mode, box]) => {
            const template = box.value.trim() || DEFAULT_IMAGE_TEMPLATES[mode];
            validateImageTemplate(template, mode);
            return [mode, template === DEFAULT_IMAGE_TEMPLATES[mode] ? '' : template];
        }));
        const guide = tagGuide.value.trim();
        return guide ? { ...templates, tagGuide: guide } : templates;
    }
    function writeTemplates(templates, create = false) {
        const preset = selection();
        if (create || preset) {
            const name = presetName.value.trim() || (create ? '' : preset.name);
            if (!name || name.length > 60) throw new Error('请输入 1～60 字的预设名称。');
            if (name === '默认预设' || presets.some(item => item.name === name && (create || item !== preset))) {
                throw new Error('该预设名称已存在。');
            }
            if (create) {
                const id = newComicId();
                presets.push({ id, name, templates });
                config.activeImageTemplatePreset = id;
            } else Object.assign(preset, { name, templates });
        }
        config.imageTemplates = templates;
        renderPresets();
    }
    presetSelect.addEventListener('change', () => {
        if (!selection()) config.defaultImageTemplates = { ...config.imageTemplates };
        config.activeImageTemplatePreset = presetSelect.value;
        config.imageTemplates = { ...(selection()?.templates ?? config.defaultImageTemplates) };
        loadPreset(config.imageTemplates);
        renderPresets();
        context().saveSettingsDebounced();
        editorStatus.textContent = '预设已切换。';
    });
    function savePreset(create) {
        try {
            writeTemplates(draftTemplates(), create);
            context().saveSettingsDebounced();
            editorStatus.textContent = '生图预设已保存。';
        } catch (error) { editorStatus.textContent = error.message; }
    }
    const newPreset = button('另存为预设', () => {
        if (!selection()) config.defaultImageTemplates = { ...config.imageTemplates };
        savePreset(true);
    });
    const saveImagePreset = button('保存当前预设', () => savePreset(false), 'twc-primary');
    const deletePreset = button('删除预设', () => {
        const preset = selection();
        if (!preset || !globalThis.confirm(`删除预设「${preset.name}」？`)) return;
        presets.splice(presets.indexOf(preset), 1);
        config.activeImageTemplatePreset = '';
        config.imageTemplates = { ...config.defaultImageTemplates };
        loadPreset(config.imageTemplates);
        renderPresets();
        context().saveSettingsDebounced();
        editorStatus.textContent = '预设已删除，已切换到默认预设。';
    });
    const resetTemplate = button('恢复内置模板', () => {
        loadPreset(DEFAULT_IMAGE_TEMPLATES);
        editorStatus.textContent = '已填入内置模板，保存后生效。';
    });
    const ruleActions = el('div', 'twc-actions'); ruleBox.append(ruleActions);
    const saveRules = button('保存规则', () => {
        try {
            const limit = Number(responseLimit.value);
            if (!Number.isInteger(limit) || limit < 1024 || limit > 64000) throw new Error('输出上限应为 1024～64000 的整数。');
            writeTemplates(draftTemplates());
            config.storyboardRules = plannerRules.value.trim() === DEFAULT_STORYBOARD_RULES ? '' : plannerRules.value.trim();
            config.singleStoryboardRules = singlePlannerRules.value.trim() === DEFAULT_SINGLE_STORYBOARD_RULES ? '' : singlePlannerRules.value.trim();
            config.responseLength = limit;
            context().saveSettingsDebounced();
            status.textContent = '规则已保存，下次规划会使用新规则。';
        } catch (error) { status.textContent = error.message; }
    }, 'twc-primary');
    const resetRules = button('恢复默认', () => {
        responseLimit.value = DEFAULT_PREFERENCES.responseLength;
        plannerRules.value = DEFAULT_STORYBOARD_RULES;
        singlePlannerRules.value = DEFAULT_SINGLE_STORYBOARD_RULES;
        loadPreset(DEFAULT_IMAGE_TEMPLATES);
        status.textContent = '已填入默认值，点击「保存规则」生效。';
    });
    const applyTemplates = button('将已保存的模板应用到当前分镜', () => withBusy(async () => {
        ensureFresh();
        if (!record || hasUnsavedPlanEdits()) throw new Error('请先保存当前分镜中的修改。');
        await savePlanEdits(record.plan, config.imageTemplates, { applyTemplate: true });
        status.textContent = '当前分镜的生图提示词已更新。';
    }));
    const templateActions = el('div', 'twc-actions');
    templateActions.append(saveImagePreset, newPreset, deletePreset, resetTemplate, applyTemplates);
    templateSection.append(templateActions, editorStatus);
    const inspect = el('details', 'twc-disclosure');
    inspect.append(el('summary', '', '请求预览与最近一次提交'));
    const refreshPreview = button('预览当前草稿', () => {
        try {
            if (!record) throw new Error('请先规划分镜，再预览生图请求。');
            const templates = draftTemplates();
            const prompts = primaryPrompts(record.plan, outputMode, style.value, appearance.value, templates);
            const index = Math.min(selectedOutput, prompts.length - 1);
            const unit = outputMode === 'single' ? '格' : '页';
            pendingPreview.textContent = `第 ${index + 1} ${unit}\n\n${prompts[index] ?? ''}`;
        } catch (error) { pendingPreview.textContent = error.message; }
    });
    const pendingPreview = el('pre', 'twc-reference-data');
    const lastPreview = el('pre', 'twc-reference-data');
    function renderRecentRequest() {
        const request = record && owner.lastImageRequests?.get(record);
        lastPreview.textContent = request ? JSON.stringify(request, null, 2) : '本次打开酒馆后，这份分镜暂无生图提交记录。';
    }
    inspect.addEventListener('toggle', renderRecentRequest);
    inspect.append(el('p', 'twc-help', '预览使用编辑中的模板。最近一次提交显示后端、种子和实际使用的提示词。'), refreshPreview, pendingPreview, el('h4', '', '最近一次提交'), lastPreview);
    templateSection.append(inspect);
    ruleActions.append(saveRules, resetRules);
    renderPresets();
    const filters = el('details', 'twc-disclosure twc-message-filters');
    filters.append(el('summary', '', '消息过滤规则'));
    rules.append(filters);
    const filterFields = el('fieldset', 'twc-filter-fields');
    filters.append(filterFields);
    const filterEnabled = toggle(filterFields, '启用消息过滤规则', config.filterStoryboardMessages);
    filterFields.append(el('p', 'twc-help', '成对标签如 <WorldState> 和 </WorldState> 可匹配大小写、属性和嵌套，未闭合的标签内容会保留。其他标记按原样匹配，留空代表消息开头或末尾。勾选「发给 AI」可将清理后的片段作为参考，图片只插在正文。'));
    const filterRows = el('div');
    filterFields.append(filterRows);
    const rowReaders = new Map();
    function addFilterRow({ start = '', end = '', send = false } = {}) {
        const row = el('div', 'twc-filter-row');
        const from = field(row, '起始标记', start, false);
        const to = field(row, '结束标记', end, false);
        const sendToModel = toggle(row, '发给 AI', send);
        const remove = button('删除此行', () => { rowReaders.delete(row); row.remove(); });
        row.append(remove);
        rowReaders.set(row, () => ({ start: from.value, end: to.value, send: sendToModel.checked }));
        filterRows.append(row);
    }
    for (const rule of config.storyboardMessageFilters ?? []) addFilterRow(rule);
    const filterActions = el('div', 'twc-actions');
    filterActions.append(
        button('添加过滤规则', () => addFilterRow()),
        button('填入常见规则', () => {
            const tags = [
                'think', 'thinking', 'system', 'meta', 'options', 'WorldState', 'state', 'UpdateVariable', 'StatusBlock', 'StatusBar',
                'dream_scene', 'dream_parallel_event', 'simple_thinking', 'dream_big_discuss',
            ];
            const pairs = tags.map(tag => [`<${tag}>`, `</${tag}>`]);
            pairs.push(['<!--', '-->']);
            const existing = [...rowReaders.values()].map(read => read());
            for (const [start, end] of pairs) {
                if (!existing.some(rule => rule.start.toLowerCase() === start.toLowerCase() && rule.end.toLowerCase() === end.toLowerCase())) addFilterRow({ start, end });
            }
        }),
        button('保存过滤规则', () => {
            config.storyboardMessageFilters = [...rowReaders.values()].map(read => read()).filter(rule => rule.start || rule.end);
            config.filterStoryboardMessages = filterEnabled.checked;
            context().saveSettingsDebounced();
            status.textContent = '过滤规则已保存，下次规划时生效。';
        }, 'twc-primary'),
    );
    filterFields.append(filterActions);
    function planningSource() {
        const activeFilters = config.filterStoryboardMessages ? config.storyboardMessageFilters ?? [] : [];
        const fromOriginal = source.value === cleanOriginal || (record?.sourceFromOriginal === true && source.value === record.source);
        const raw = fromOriginal ? bound.text : source.value;
        return { ...filterStoryboardSource(raw, activeFilters), fromOriginal };
    }
    const storyActions = el('div', 'twc-output-bar');
    const storyPlanButton = button('规划当前模式', planCurrent, 'twc-primary');
    const storyMode = addPlanControls(storyActions, storyPlanButton);
    story.append(storyActions);
    const warningBox = el('div', 'twc-warnings'); story.append(warningBox);
    const storyEmpty = el('p', 'twc-empty', '先在「准备」中规划分页。'); story.append(storyEmpty);
    const planBox = el('div', 'twc-plan'); story.append(planBox);
    const detailActions = el('div', 'twc-actions'); planBox.append(detailActions);
    const detailHint = el('p', 'twc-help');
    const detailButton = button('AI 补写动作细节', () => withBusy(async () => {
        ensureFresh();
        if (!record || hasUnsavedPlanEdits()) throw new Error('请先保存分镜和准备页中的修改。');
        const frames = shortSceneBatch(record.plan);
        if (!frames.length) return;
        status.textContent = `正在用酒馆当前模型补写 ${frames.length} 格画面描述。`;
        const result = await detailScenesWithCurrentConnection(context(), { plan: record.plan, frames, source: record.source, appearance: record.appearance, responseLength: settings().responseLength });
        ensureFresh();
        if (halted || !dialog.open) return;
        if (!result.count) throw new Error('模型没有补到 50 字，原分镜已保留。');
        await savePlanEdits(result.plan);
        const remaining = singleFrames(record.plan).filter(({ panel }) => sceneIssues(panel.scene).length).length;
        status.textContent = `已补写 ${result.count} 格。${remaining ? `还有 ${remaining} 格未达到 50 字。` : '所有画面描述已达 50 字。'}`;
    }), 'twc-primary');
    detailActions.append(detailHint, detailButton);
    const storyGrid = el('div', 'twc-story-grid'); planBox.append(storyGrid);
    const storyRail = el('div', 'twc-story-rail'); const storyPage = el('article', 'twc-story-page twc-surface'); storyGrid.append(storyRail, storyPage);
    const advanced = el('details', 'twc-disclosure'); advanced.append(el('summary', '', '高级编辑')); planBox.append(advanced);
    const planJSON = field(advanced, '分页与分镜 JSON（保存时检查段落覆盖）', ''); planJSON.rows = 12;
    const planSave = button('保存分镜修改', () => withBusy(async () => {
        ensureFresh();
        const plan = validatePlan(planJSON.value, segmentSource(source.value).length, mode);
        if (JSON.stringify(plan) === JSON.stringify(record.plan) && source.value === record.source && style.value === record.style && appearance.value === record.appearance) {
            planJSON.value = JSON.stringify(plan, null, 2);
            status.textContent = '分镜已是最新。';
            return;
        }
        await savePlanEdits(plan);
    }), 'twc-primary'); advanced.append(planSave);
    const outputHistory = mountOutputHistory(output, dialog);
    const { currentOutput } = outputHistory;
    const outputBar = el('div', 'twc-output-bar');
    const formats = el('div', 'twc-output-formats'); formats.setAttribute('role', 'group'); formats.setAttribute('aria-label', '出图方式');
    const multiFormat = button('分页多格', () => changeStoryboardMode('multi'));
    const singleFormat = button('单格·完整', () => changeStoryboardMode('single'));
    const legacyFormat = button('旧版拆格', () => changeStoryboardMode('multi', true));
    formats.append(multiFormat, singleFormat, legacyFormat); currentOutput.append(formats, outputBar);
    const progress = el('p', 'twc-progress'); outputBar.append(progress);
    const pageList = el('div', 'twc-outputs'); currentOutput.append(pageList);
    const thumbRail = el('div', 'twc-thumbnails'); const preview = el('div', 'twc-preview'); pageList.append(thumbRail, preview);
    let selectedStory = 0; let selectedOutput = 0;
    const stops = button('停止生成', () => {
        if (generatingImages) {
            stopRequested = true;
            status.textContent = '正在停止。已提交的页面会生成并保存，随后不再提交新页面。';
        } else {
            halted = true;
            status.textContent = '已停止接收本次结果。请等待已发出的请求返回。';
        }
        syncControls();
    });
    footer.append(stops);
    const controls = [];
    const sourceOptions = () => ({ useWorldbook: useWorldbook.checked === true });
    let lastExtraction;
    async function readReferences(extract = false) {
        ensureFresh(); referenceStatus.textContent = '正在只读收集人物资料，不调用模型……';
        const result = await collectReferences(context(), { floor: bound.index, source: planningSource().story, appearance: appearance.value, ...sourceOptions() });
        ensureFresh();
        if (halted) throw new Error('任务已停止，未使用本次资料。');
        const { context: references, receipt, warnings } = result;
        if (references.worldbooks.length) {
            const signature = JSON.stringify(references.worldbooks);
            if (extract) {
                const busy = await readHostGenerationState(context());
                ensureFresh();
                if (halted) throw new Error('任务已停止，未提取人物资料。');
                if (busy) throw new Error('酒馆正在处理其他生成请求，请稍后再提取。');
                status.textContent = '正在使用酒馆当前模型提取世界书人物……';
                const profiles = await extractWorldbookProfiles(context(), references.worldbooks, config.responseLength);
                ensureFresh();
                if (halted) throw new Error('任务已停止，未保存人物资料。');
                lastExtraction = { signature, profiles };
            }
            if (lastExtraction?.signature === signature) references.extractedProfiles = lastExtraction.profiles;
        }
        const cache = await reuseCharacterProfiles(context(), { floor: bound.index, ...sourceOptions() }, result);
        ensureFresh();
        if (halted) throw new Error('任务已停止，未使用本次资料。');
        receipt.extracted = references.extractedProfiles?.length ?? 0;
        receipt.characterCacheSaved = cache.saved;
        receipt.characterCacheReused = cache.reused.length;
        showPeople([...observedProfiles(references), ...cache.reused]);
        const names = { off: '关闭', unavailable: '未取得', read: '已读取' };
        const cacheStatus = `${cache.saved ? `当前角色卡已保存 ${cache.saved} 条人物缓存。` : ''}${cache.reused.length ? `本次复用 ${cache.reused.length} 条人物缓存。` : ''}`;
        const worldWarnings = warnings.filter(warning => /世界书|人物缓存/u.test(warning));
        referenceStatus.textContent = `世界书${names[receipt.worldbook]}，人物候选 ${receipt.entries} 条。${cacheStatus}${worldWarnings.length ? '\n' + worldWarnings.join('\n') : ''}`;
        return { context: references, receipt, warnings, reused: cache.reused };
    }
    const readButton = button('读取人物资料', () => withBusy(async () => {
        const { receipt } = await readReferences(true);
        status.textContent = receipt.entries
            ? `模型提取了 ${receipt.extracted} 条人物资料。`
            : '本次没有可供模型提取的世界书条目。请核对来源，也可以直接规划。';
    }));
    const planButton = button('规划分页', planCurrent, 'twc-primary');
    function addPlanControls(parent, plan) {
        const group = el('div', 'twc-plan-controls');
        const select = el('select', 'twc-storyboard-mode');
        select.setAttribute('aria-label', '分镜模式');
        for (const [value, label] of [['multi', '多格分镜'], ['single', '单格分镜']]) {
            const option = el('option', '', label);
            option.value = value;
            select.append(option);
        }
        select.addEventListener('change', () => changeStoryboardMode(select.value));
        group.append(select, plan);
        parent.append(group);
        return select;
    }
    function planCurrent() {
        return withBusy(async () => {
            ensureFresh();
            const { story, context: filteredContext, fromOriginal } = planningSource();
            if (!story.trim()) throw new Error('过滤后没有可改编的正文。');
            status.textContent = '正在读取本次选定来源的人物资料……';
            const references = await readReferences();
            const busy = await readHostGenerationState(context());
            ensureFresh();
            if (halted) throw new Error('任务已停止，未调用规划模型。');
            if (busy) throw new Error('资料已读取，但酒馆开始了其他生成请求；请等待结束后再规划。');
            status.textContent = '正在使用酒馆当前连接规划，请等待。不会发送正常角色回复。';
            const planningContext = references.reused.length ? { ...references.context, cachedCharacterProfiles: references.reused } : references.context;
            const result = await planWithCurrentConnection(context(), {
                source: story, appearance: appearance.value, style: style.value, responseLength: config.responseLength,
                references: planningContext, storyboardRules: mode === 'single' ? config.singleStoryboardRules : config.storyboardRules, mode,
                guidance: { sceneGuide: config.sceneGuide, tagGuide: config.imageTemplates?.tagGuide, filteredContext },
            });
            if (!current(bound) || halted) throw new Error('任务已停止或聊天已变化，未写入规划结果。');
            source.value = story;
            await saveNewPlan(result.plan, references, result.warnings, fromOriginal);
            const count = scenesToReview().size;
            const unit = mode === 'single' ? '格' : '页';
            status.textContent = `已规划 ${record.pages.length} ${unit}。${count ? `其中 ${count} ${unit}的画面描述需要修正，可在「分镜」中直接修改。` : '请核对分镜和对白。'}`;
        });
    }
    const generateAll = button('生成未完成页', () => generate(), 'twc-primary');
    const checkState = button('检查酒馆状态', async () => {
        try {
            const busy = await readHostGenerationState(context());
            if (!owner.destroyed && runtime === owner && dialog.open) status.textContent = busy
                ? '酒馆仍在处理生成请求，请等结束后再规划。'
                : '酒馆当前空闲，可以规划分页。检查状态未调用模型。';
        } catch (error) { if (!owner.destroyed && runtime === owner) status.textContent = error.message; }
    });
    sources.append(readButton);
    const modeHelp = el('p', 'twc-help');
    prepActions.append(modeHelp);
    const prepMode = addPlanControls(prepActions, planButton);
    controls.push(planButton, storyPlanButton, prepMode, storyMode, generateAll, planSave, checkState, readButton, useWorldbook, multiFormat, singleFormat, legacyFormat, detailButton);
    controls.push(responseLimit, plannerRules, singlePlannerRules, ...Object.values(templateBoxes), saveRules, resetRules, applyTemplates, presetSelect, presetName, newPreset, saveImagePreset, deletePreset, resetTemplate, refreshPreview, tagGuide, fillTagGuide, sceneGuide, fillSceneGuide, saveSceneGuide, filterFields);
    options.append(checkState);
    outputBar.append(generateAll);

    function ensureFresh() {
        if (owner.destroyed || runtime !== owner || !current(bound)) throw new Error('当前聊天、回复分支或原文已变化。请关闭预览，再打开对应消息。');
    }
    async function persist() {
        record.updated = Date.now();
        await saveRecord(bound, record); renderMessages();
    }
    async function saveNewPlan(plan, references, warnings, fromOriginal) {
        const referenceWarnings = references.warnings ?? [];
        const promptTemplates = { ...config.imageTemplates };
        const pages = primaryPrompts(plan, mode, style.value, appearance.value, promptTemplates).map(prompt => ({ prompt, status: 'pending' }));
        record = { id: newComicId(), original: bound.text, swipe: bound.swipe, storyboardMode: mode, source: source.value, sourceFromOriginal: fromOriginal, appearance: appearance.value, style: style.value, sourceOptions: sourceOptions(), referenceContext: references.context, referenceReceipt: references.receipt, referenceWarnings, reviewScenes: true, plan, promptTemplates, warnings: [...referenceWarnings, ...warnings], pages };
        legacyOutput = false;
        outputMode = mode;
        selectedStory = 0; selectedOutput = 0;
        await persist(); renderPlan(); showStage(1);
    }
    function hasUnsavedPlanEdits() {
        return source.value !== record.source || style.value !== record.style || appearance.value !== record.appearance || planJSON.value !== JSON.stringify(record.plan, null, 2);
    }
    function outputPictures() {
        return legacyOutput ? record.singlePages : record.pages;
    }
    function changeStoryboardMode(next, showLegacy = false) {
        if (activeTask || (next === mode && showLegacy === legacyOutput)) return;
        if (next !== mode) {
            const fields = { source: source.value, appearance: appearance.value, style: style.value, ...sourceOptions() };
            drafts.set(mode, { ...fields, json: planJSON.value });
            record = recordFor(bound, next);
            const draft = drafts.get(next);
            const values = draft ?? record ?? fields;
            const options = draft ?? record?.sourceOptions ?? fields;
            source.value = values.source ?? cleanOriginal;
            appearance.value = values.appearance ?? config.appearance;
            style.value = values.style === LEGACY_STYLE ? config.style : values.style ?? config.style;
            useWorldbook.checked = options.useWorldbook === true;
            referenceStatus.textContent = '';
            showPeople(record?.referenceContext && useWorldbook.checked ? observedProfiles(record.referenceContext) : []);
            selectedStory = 0;
        }
        mode = next;
        legacyOutput = showLegacy;
        outputMode = showLegacy ? 'single' : mode;
        selectedOutput = 0;
        renderPlan();
        if (record && drafts.has(mode)) planJSON.value = drafts.get(mode).json;
    }
    async function savePlanEdits(plan, templates = record.promptTemplates, { applyTemplate = false } = {}) {
        const previousImages = recordImages(record);
        const previousPlan = record.plan;
        const previousStyle = record.style;
        const previousAppearance = record.appearance;
        const previousTemplates = record.promptTemplates;
        if (record.source !== source.value) record.sourceFromOriginal = false;
        record.plan = plan; record.source = source.value; record.appearance = appearance.value; record.style = style.value;
        record.promptTemplates = templates ? { ...templates } : undefined;
        const previousPrompts = primaryPrompts(previousPlan, mode, previousStyle, previousAppearance, previousTemplates);
        record.pages = primaryPrompts(plan, mode, record.style, record.appearance, templates).map((prompt, i) => {
            const previous = record.pages[i];
            if (previous && (prompt === previous.prompt || (!applyTemplate && prompt === previousPrompts[i]))) return previous;
            const keepSkip = mode === 'single' && plan.pages[i].supplemental
                && previousPlan.pages[i]?.supplemental && previousPlan.pages[i].title === plan.pages[i].title && previous?.skipInBatch;
            return { image: previous?.image, stale: Boolean(previous?.image), prompt, status: 'pending', ...(keepSkip ? { skipInBatch: true } : {}) };
        });
        if (record.singlePages) {
            const previousFrames = singleFrames(previousPlan);
            record.singlePages = singleFrames(plan).map((frame, i) => {
                const previous = record.singlePages[i];
                const oldFrame = previousFrames[i];
                const prompt = buildSingleFramePrompt(plan, frame, record.style, record.appearance, templates?.single);
                if (previous && (prompt === previous.prompt || (!applyTemplate && oldFrame && prompt === buildSingleFramePrompt(previousPlan, oldFrame, previousStyle, previousAppearance, previousTemplates?.single)))) return previous;
                return { image: previous?.image, stale: Boolean(previous?.image), prompt, status: 'pending' };
            });
        }
        const retained = new Set(recordImages(record).map(item => item.image));
        archiveImages(bound.message.extra[ID], previousImages.filter(item => !retained.has(item.image)));
        record.warnings = [...dialogueWarnings(record.source, plan), ...(record.referenceWarnings ?? []), ...plan.notes.map(note => `人物资料核对：${note}`)];
        await persist(); renderPlan(); status.textContent = '分镜修改已保存。';
    }
    function scenesToReview() {
        const pages = new Map();
        if (record?.reviewScenes) {
            for (const [index, page] of record.plan.pages.entries()) {
                const panels = page.panels.flatMap((panel, i) => sceneIssues(panel.scene).map(issue => `第 ${i + 1} 格${issue}`));
                if (panels.length) pages.set(index, panels);
            }
        }
        return pages;
    }
    function outputReview() {
        if (outputMode === 'multi') return scenesToReview();
        const review = new Map();
        if (record.reviewScenes) {
            for (const [index, frame] of singleFrames(record.plan).entries()) {
                const issues = sceneIssues(frame.panel.scene);
                if (issues.length) review.set(index, issues);
            }
        }
        return review;
    }
    function syncControls() {
        const locked = Boolean(activeTask);
        for (const node of [source, appearance, style, planJSON, ...controls]) node.disabled = locked;
        generateAll.disabled = locked || !record;
        planSave.disabled = locked || !record;
        applyTemplates.disabled = locked || !record;
        deletePreset.disabled = locked || !selection();
        for (const node of preview.querySelectorAll('button, textarea')) node.disabled = locked;
        for (const node of storyPage.querySelectorAll('textarea, .twc-save-scene')) node.disabled = locked;
        stops.disabled = !localBusy || halted || stopRequested;
        stops.hidden = !localBusy && output.hidden;
    }
    async function withBusy(action, { images = false } = {}) {
        if (owner.destroyed || runtime !== owner) return;
        if (activeTask) { status.textContent = '上一项任务仍在运行，请等待返回。'; return; }
        const token = {}; activeTask = token;
        localBusy = true; halted = false; stopRequested = false; generatingImages = images; syncControls();
        if (images) { owner.generationBound = bound; owner.generationMode = mode; renderMessages(); }
        try {
            const busy = await readHostGenerationState(context());
            if (halted || owner.destroyed || runtime !== owner) return;
            if (busy) { status.textContent = '酒馆正在生成角色回复，请等回复结束后再操作。'; return; }
            await action();
        }
        catch (error) {
            status.textContent = error.message || '操作失败。请检查酒馆连接。';
            if (images && !dialog.open && current(bound)) showError(error);
        }
        finally {
            if (activeTask === token) activeTask = null;
            localBusy = false; generatingImages = false;
            if (images) {
                owner.generationBound = null;
                owner.generationMode = null;
                if (runtime === owner && !owner.destroyed) renderMessages();
            }
            if (!dialog.open) disposeDialog();
            else syncControls();
            runtime?.refreshControls?.();
        }
    }
    function showPeople(profiles) {
        const byName = new Map();
        for (const profile of profiles) {
            const key = profile.name.toLocaleLowerCase();
            const first = byName.get(key);
            if (!first) byName.set(key, { ...profile });
            else if (first.book === profile.book) {
                first.description ||= profile.description;
                first.outfit ||= profile.outfit;
            }
        }
        const compact = value => value?.replace(/\s*\r?\n\s*/gu, '；') || '未注明';
        referenceData.hidden = !byName.size;
        referenceData.textContent = [...byName.values()].map(({ name, description, outfit }) =>
            `角色名：${name}\n外貌：${compact(description)}\n服装：${compact(outfit)}`).join('\n\n');
    }
    function renderStoryboard() {
        const { scrollLeft, scrollTop } = storyRail;
        storyRail.replaceChildren(); storyPage.replaceChildren();
        const review = scenesToReview();
        for (const [i, page] of record.plan.pages.entries()) {
            const item = button(`${i + 1}. ${page.title}${page.supplemental ? ' · 补充' : ''}${review.has(i) ? ' · 待修正' : ''}`, () => { selectedStory = i; renderStoryboard(); syncControls(); storyRail.querySelectorAll('button')[i]?.focus(); }, 'twc-story-link');
            item.setAttribute('aria-pressed', String(selectedStory === i)); storyRail.append(item);
        }
        storyRail.scrollLeft = scrollLeft; storyRail.scrollTop = scrollTop;
        const page = record.plan.pages[selectedStory];
        const label = mode === 'single' ? `第 ${selectedStory + 1} 格 · 整页单格` : `第 ${selectedStory + 1} 页 · ${page.panels.length} 格`;
        storyPage.append(el('h3', '', page.title), el('p', 'twc-caption', page.supplemental ? `${label} · 补充镜头` : label));
        if (record.plan.characters) {
            const cast = el('details', 'twc-disclosure'); cast.append(el('summary', '', '人物设定'), el('p', 'twc-story-text', record.plan.characters)); storyPage.append(cast);
        }
        for (const [i, panel] of page.panels.entries()) {
            const card = el('section', 'twc-panel');
            card.append(el('h4', '', `第 ${i + 1} 格 · ${panel.layout}`));
            const issues = record.reviewScenes ? sceneIssues(panel.scene) : [];
            if (issues.length || page.supplemental) {
                if (issues.length) card.append(el('p', 'twc-warnings', issues.join('。')));
                const edit = field(card, issues.length ? '修正这一格的画面描述' : '补充镜头的画面描述', panel.scene); edit.rows = 4;
                const pageIndex = selectedStory;
                card.append(button('保存这一格', () => withBusy(async () => {
                    ensureFresh();
                    if (hasUnsavedPlanEdits()) throw new Error('请先保存正文、画风、人物或高级分镜中的修改。');
                    if (!edit.value.trim()) throw new Error('画面描述不能为空。');
                    const updated = structuredClone(record.plan);
                    updated.pages[pageIndex].panels[i].scene = edit.value;
                    await savePlanEdits(updated);
                }), 'twc-save-scene'));
            } else card.append(el('p', 'twc-story-text', panel.scene));
            appendPanelText(card, panel);
            storyPage.append(card);
        }
    }
    function isBatchSkipped(page, index) {
        return mode === 'single' && record.plan.pages[index]?.supplemental === true && page.skipInBatch === true;
    }
    function renderOutput() {
        const { scrollLeft, scrollTop } = thumbRail;
        thumbRail.replaceChildren(); preview.replaceChildren();
        const single = outputMode === 'single';
        multiFormat.setAttribute('aria-pressed', String(mode === 'multi' && !legacyOutput));
        singleFormat.setAttribute('aria-pressed', String(mode === 'single'));
        legacyFormat.setAttribute('aria-pressed', String(legacyOutput));
        legacyFormat.hidden = !recordFor(bound, 'multi')?.singlePages?.length;
        generateAll.textContent = single ? '生成未完成格' : '生成未完成页';
        if (!record) { progress.textContent = `先在「分镜」中规划${single ? '单格' : '多格'}分镜。`; return; }
        const pictures = outputPictures();
        const frames = single ? singleFrames(record.plan) : [];
        const unit = single ? '格' : '页';
        const review = outputReview();
        const included = pictures.filter((page, i) => !isBatchSkipped(page, i));
        const completed = included.filter(page => safeImage(page.image) && !page.stale).length;
        const skipped = pictures.length - included.length;
        progress.textContent = `已完成 ${completed} / ${included.length} ${unit}${single ? ` · 预计 ${included.length} 张` : ''}${skipped ? ` · 跳过 ${skipped} 格补充镜头` : ''}`;
        for (const [i, page] of pictures.entries()) {
            const thumb = button('', () => { selectedOutput = i; renderOutput(); thumbRail.querySelectorAll('button')[i]?.focus(); }, 'twc-thumb');
            const state = review.has(i) ? '待修正' : page.status === 'generating' ? '生成中' : page.status === 'failed' ? '失败' : page.stale ? '待重画' : page.image ? '已生成' : '待生成';
            thumb.dataset.state = page.status;
            thumb.setAttribute('aria-pressed', String(selectedOutput === i));
            if (safeImage(page.image)) {
                const image = el('img', ''); image.src = page.image; image.alt = ''; image.loading = 'lazy'; thumb.append(image);
            }
            const extra = frames[i]?.page.supplemental ? ' · 补充' : '';
            thumb.append(el('span', '', `第 ${i + 1} ${unit}${extra}`), el('small', '', isBatchSkipped(page, i) ? `${state} · 跳过批量` : state)); thumbRail.append(thumb);
        }
        thumbRail.scrollLeft = scrollLeft; thumbRail.scrollTop = scrollTop;
        const i = selectedOutput = Math.min(selectedOutput, pictures.length - 1);
        const page = pictures[i];
        const hasImage = safeImage(page.image);
        const imagePath = page.image;
        const pageLabel = `第 ${i + 1} ${unit}`;
        const title = single ? frames[i].page.title : record.plan.pages[i].title;
        const actions = el('div', 'twc-preview-heading');
        const pageActions = el('div', 'twc-preview-actions');
        if (hasImage) {
            const link = el('a', 'menu_button twc-button', `下载本${unit}`);
            link.href = imagePath; link.setAttribute('download', ''); pageActions.append(link);
        }
        pageActions.append(button(`${page.image ? '重画' : '生成'}这一${unit}`, () => generate(i)));
        const supplemental = frames[i]?.page.supplemental === true;
        if (supplemental) {
            const batchSkipped = isBatchSkipped(page, i);
            pageActions.append(button(batchSkipped ? '加入批量出图' : '跳过批量出图', () => withBusy(async () => {
                ensureFresh();
                if (batchSkipped) delete page.skipInBatch;
                else page.skipInBatch = true;
                await persist();
                renderOutput();
            })));
        }
        actions.append(el('h3', '', `${pageLabel} · ${title}${supplemental ? ' · 补充镜头' : ''}`), pageActions);
        preview.append(actions);
        if (review.has(i)) {
            const from = legacyOutput ? `第 ${frames[i].pageIndex + 1} 页第 ${frames[i].panelIndex + 1} 格` : single ? '本格' : '本页';
            preview.append(el('p', 'twc-warnings', `请先在「分镜」修正${from}。${review.get(i).join('。')}。`));
        }
        if (page.status === 'failed') preview.append(el('p', 'twc-warnings', page.error || '请求中断'));
        if (page.stale) preview.append(el('p', 'twc-caption', '分镜已修改，下方保留旧图供对照。'));
        preview.append(hasImage ? imageNode(imagePath, pageLabel, () => showImageViewer(dialog, imagePath, pageLabel)) : el('p', 'twc-empty', page.status === 'generating' ? `正在生成这一${unit}…` : `这一${unit}还没有图片`));
        if (single) appendPanelText(preview, frames[i].panel);
        const detail = el('details', 'twc-disclosure'); detail.append(el('summary', '', `本${unit}生图提示词`));
        const prompt = field(detail, '可修改后保存或重画', page.prompt); prompt.rows = 8;
        prompt.addEventListener('input', () => { page.prompt = prompt.value; });
        detail.append(button(`保存本${unit}提示词`, () => withBusy(async () => {
            ensureFresh(); await persist(); status.textContent = `${pageLabel}提示词已保存。`;
        })));
        preview.append(detail);
        syncControls();
    }
    function renderPlan() {
        planBox.hidden = !record; storyEmpty.hidden = Boolean(record); warningBox.replaceChildren();
        const short = record ? singleFrames(record.plan).filter(({ panel }) => sceneIssues(panel.scene).length).length : 0;
        detailActions.hidden = !short;
        detailHint.textContent = `${short} 格画面不足 50 字。补写会调用酒馆当前模型，一次最多 48 格。`;
        const single = mode === 'single';
        prepMode.value = mode;
        storyMode.value = mode;
        storyPlanButton.textContent = record ? '重新规划当前模式' : '规划当前模式';
        modeHelp.textContent = '规划会使用酒馆当前模型连接。';
        storyEmpty.textContent = `还没有${single ? '单格' : '多格'}分镜。`;
        planButton.textContent = single
            ? (record ? '重新规划单格分镜' : '规划单格分镜')
            : (record ? '重新规划（替换当前分镜）' : '规划分页');
        if (record) {
            selectedStory = Math.min(selectedStory, record.pages.length - 1);
            planJSON.value = JSON.stringify(record.plan, null, 2);
            const savedWarnings = (record.warnings ?? []).filter(warning => !warning.startsWith(DIALOGUE_WARNING_PREFIX));
            for (const warning of [...dialogueWarnings(record.source ?? bound.text, record.plan), ...savedWarnings]) warningBox.append(el('p', '', warning));
            renderStoryboard();
        } else planJSON.value = '';
        renderOutput(); syncControls();
    }
    async function generate(forceIndex = null) {
        await withBusy(async () => {
            ensureFresh();
            if (!record) throw new Error('请先规划分页。');
            if (hasUnsavedPlanEdits()) throw new Error('正文、画风、人物或分镜有未保存的修改。请重新规划或保存分镜修改，再出图。');
            const pictures = outputPictures();
            const unit = outputMode === 'single' ? '格' : '页';
            const review = outputReview();
            const pending = pictures.map((page, i) => ({ page, i })).filter(({ page, i }) =>
                forceIndex === null ? !isBatchSkipped(page, i) && (!page.image || page.stale) : i === forceIndex);
            const ready = pending.filter(({ i }) => !review.has(i));
            const blocked = pending.length - ready.length;
            if (!ready.length) {
                status.textContent = blocked ? '待生成的页面需要先在「分镜」中修正画面描述。' : '参与本次出图的画面均已生成。';
                return;
            }
            if (ready.some(({ page }) => !page.prompt?.trim())) throw new Error('生图提示词不能为空。');
            showStage(2);
            const { drawingBackend: backend, comfyUrl, webuiUrl, novelModel, workflow: savedWorkflow, workflowBindings, useLegacyWorkflow } = settings();
            if (backend === 'off') throw new Error('绘图后端已关闭。请先在「准备 → 绘图后端」选择并保存设置。');
            let address, workflow;
            if (backend === 'comfy') {
                address = normalizeComfyUrl(comfyUrl);
                workflow = prepareComfyWorkflow(await loadWorkflow({ workflow: savedWorkflow, useLegacyWorkflow }), workflowBindings);
            } else if (backend === 'webui') {
                address = normalizeComfyUrl(webuiUrl, 'SD WebUI');
            }
            record.outputMode = outputMode;
            const previousImages = new Map(recordImages(record).map(item => [item.image, item]));
            const previousPaths = pictures.map(page => page.image);
            await runPages(pictures, async (page, i) => {
                const seed = crypto.getRandomValues(new Uint32Array(1))[0]; page.seed = seed;
                const filename = `comic-${record.id}-${outputMode === 'single' ? 'single-' : ''}${i + 1}-${Date.now()}`;
                const graph = workflow && fillWorkflow(workflow, { prompt: page.prompt, seed, filename_prefix: `tw-comic/${filename}` });
                (owner.lastImageRequests ??= new WeakMap()).set(record, { backend, ...(backend === 'novel' && { model: novelModel }), seed, prompt: page.prompt });
                renderRecentRequest();
                return generateImage(context(), { backend, url: address, graph, prompt: page.prompt, seed, model: novelModel, filename });
            }, () => !halted && !owner.destroyed && runtime === owner && current(bound), {
                forceIndex, skipPage: i => review.has(i) || (forceIndex === null && isBatchSkipped(pictures[i], i)), shouldStop: () => stopRequested, onUpdate: async (page, i) => {
                    ensureFresh();
                    const previous = previousImages.get(previousPaths[i]);
                    if (previous && page.status === 'done' && page.image !== previous.image) archiveImages(bound.message.extra[ID], [previous]);
                    await persist();
                    if (!dialog.open) selectedOutput = i;
                    renderOutput();
                    if (!stopRequested) status.textContent = pictures[i].status === 'generating' ? `正在生成第 ${i + 1} / ${pictures.length} ${unit}，请等待。` : `第 ${i + 1} ${unit}状态已保存。`;
                },
            });
            status.textContent = stopRequested ? '已停止生成，完成的图片已保存到对应消息。' : blocked ? `可出图的图片已生成并保存。还有 ${blocked} ${unit}需要在「分镜」中修正。` : '本次图片生成完成，已保存到对应消息。请核对图片中的文字和情节。';
        }, { images: true });
    }
    function disposeDialog() {
        outputHistory.stop();
        dialog.querySelector('.twc-image-viewer')?.close();
        owner.nodes.delete(dialog); dialog.remove();
        if (owner.dialog === dialog) { owner.dialog = null; owner.dialogBound = null; owner.showGeneration = null; }
        if (owner.refreshControls === syncControls) owner.refreshControls = null;
    }
    dialog.addEventListener('close', () => {
        if (dialog.open) return;
        outputHistory.showCurrent();
        if (generatingImages) return;
        halted = true;
        disposeDialog();
    });
    owner.refreshControls = syncControls;
    document.body.append(dialog);
    if (record?.referenceContext && useWorldbook.checked) showPeople(observedProfiles(record.referenceContext));
    renderPlan();
    showStage(record && ([...record.pages, ...(record.singlePages ?? [])].some(page => page.image)) ? 2 : record ? 1 : 0);
    dialog.showModal();
}

function init() {
    if (runtime && !runtime.destroyed) return;
    const ctx = context(); checkHost(ctx);
    globalThis[RUNTIME]?.destroy?.();
    runtime = { destroyed: false, nodes: new Set(), subscriptions: [], dialog: null, dialogBound: null, inlineReaders: new WeakMap() };
    globalThis[RUNTIME] = { destroy: onDisable };
    mountSettings();
    for (const event of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
        const name = ctx.eventTypes[event];
        if (!name) continue;
        const callback = () => { try { renderMessages(); } catch (error) { showError(error); } };
        ctx.eventSource.on(name, callback); runtime.subscriptions.push([ctx.eventSource, name, callback]);
    }
    renderMessages();
}
export function onDisable() {
    if (!runtime || runtime.destroyed) return;
    runtime.destroyed = true;
    runtime.dialog?.querySelector('.twc-image-viewer')?.close(); runtime.dialog?.close();
    for (const [source, name, fn] of runtime.subscriptions) source.removeListener(name, fn);
    for (const node of runtime.nodes) node.remove();
    for (const group of document.querySelectorAll('.twc-inline-comic')) removeInlineComic(group);
    for (const node of document.querySelectorAll('.twc-message-button, .twc-reader')) node.remove();
    runtime.nodes.clear(); runtime.subscriptions = [];
}
export function onDelete() {
    onDisable();
    return cleanCharacterProfiles(context());
}
export function onEnable() { try { init(); } catch (error) { showError(error); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onEnable, { once: true });
else onEnable();
