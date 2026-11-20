import { segmentSource, validatePlan, dialogueWarnings, buildPagePrompt, fillWorkflow, workflowNodes, prepareComfyWorkflow, COMFY_WORKFLOW_FIELDS, bindingMatches, runPages } from './core.mjs';
import { checkHost, planWithCurrentConnection, generateImage, normalizeComfyUrl, testComfyConnection, testNovelConnection, testWebUiConnection, readHostGenerationState, saveNovelKey } from './services.mjs';
import { collectReferences } from './references.mjs';
import { cleanCharacterProfiles, observedProfiles, reuseCharacterProfiles } from './character-cache.mjs';
import { LEGACY_STYLE, upgradePreferences } from './preferences.mjs';

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
function recordFor(bound) {
    return bound.message.extra?.[ID]?.variants?.findLast(r => r.original === bound.text && r.swipe === bound.swipe);
}
async function saveRecord(bound, record) {
    if (!current(bound)) throw new Error('聊天或原消息已变化，结果未写回。');
    bound.message.extra ??= {};
    const store = bound.message.extra[ID] ??= { version: 1, variants: [] };
    if (!Array.isArray(store.variants)) throw new Error('漫画记录格式不兼容，请先导出备份。');
    const at = store.variants.findIndex(r => r.original === bound.text && r.swipe === bound.swipe);
    if (at < 0) store.variants.push(record); else store.variants[at] = record;
    await context().saveChat();
}
function safeImage(path) { return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\u0000-\u0020\\]/u.test(path); }
function download(record) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = `comic-${record.id}.json`; link.click();
    // 浏览器已同步接收下载操作后释放临时 URL。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function imageNode(path, label) {
    const link = el('a', 'twc-image-link'); link.href = path; link.target = '_blank'; link.rel = 'noopener';
    const image = el('img', 'twc-image'); image.src = path; image.alt = label; image.loading = 'lazy';
    link.append(image); return link;
}

function renderMessages() {
    if (runtime.destroyed) return;
    const ctx = context();
    for (const mes of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(mes.getAttribute('mesid'));
        const message = ctx.chat[index];
        if (!message || message.is_user || message.is_system) continue;
        const host = mes.querySelector('.mes_buttons');
        if (host && !host.querySelector('.twc-message-button')) {
            host.append(button('生成多页漫画', () => openEditor(Number(mes.getAttribute('mesid'))).catch(showError), 'twc-message-button'));
        }
        const bound = ctx.chatId ? capture(index) : null;
        const record = bound ? recordFor(bound) : null;
        const old = mes.querySelector('.twc-reader');
        const running = runtime.generationBound?.message === message && current(runtime.generationBound);
        const key = record ? `${record.id}:${record.updated}:${running}` : '';
        if (old?.dataset.revision === key) continue;
        const wasOpen = old?.open;
        old?.remove();
        if (!record) continue;
        const reader = el('details', 'twc-reader'); reader.dataset.revision = key;
        reader.open = Boolean(wasOpen);
        const completed = record.pages.filter(p => safeImage(p.image) && !p.stale).length;
        const summary = el('summary', '', running ? `漫画生成中 · ${completed} / ${record.pages.length}` : `漫画 · ${completed} / ${record.pages.length} 页已生成`);
        if (running) summary.addEventListener('click', event => {
            event.preventDefault();
            openEditor(Number(mes.getAttribute('mesid'))).catch(showError);
        });
        reader.append(summary);
        reader.append(button('查看分镜 / 继续生成', () => openEditor(Number(mes.getAttribute('mesid'))).catch(showError)));
        for (const [i, page] of record.pages.entries()) if (safeImage(page.image)) {
            reader.append(el('p', 'twc-caption', `第 ${i + 1} 页 · ${record.plan.pages[i]?.title || ''}${page.stale ? ' · 分镜已修改，下方保留旧图供对照' : ''}`));
            reader.append(imageNode(page.image, `第 ${i + 1} 页漫画`));
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
    const useBaiBai = toggle(box, '读取柏宝书资料（只读）', config.useBaiBai);
    const useWorldbook = toggle(box, '读取世界书资料（只读）', config.useWorldbook);
    box.append(el('p', 'twc-help', '两个开关互相独立，作为新规划的默认值。世界书读取当前角色、群组角色、聊天与全局绑定书的匹配条目；不会执行原生触发器或宏。'));
    const length = field(box, '规划输出上限（token）', config.responseLength, false); length.type = 'number'; length.min = '1024'; length.max = '64000';
    const style = field(box, '默认画风', config.style);
    const appearance = field(box, '共用人物外观（可留空，或每次在预览中填写）', config.appearance);
    const result = el('p', 'twc-status'); result.setAttribute('role', 'status');
    box.append(button('保存设置', () => {
        try {
            const limit = Number(length.value);
            if (!Number.isInteger(limit) || limit < 1024 || limit > 64000) throw new Error('输出上限应为 1024～64000 的整数，并受当前模型实际支持范围限制。');
            Object.assign(config, { responseLength: limit, style: style.value, appearance: appearance.value, useBaiBai: useBaiBai.checked, useWorldbook: useWorldbook.checked });
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
    let generatingImages = false; let stopRequested = false;
    const dialog = el('dialog', 'twc-dialog'); owner.dialog = dialog; owner.dialogBound = bound; owner.nodes.add(dialog);
    const heading = el('div', 'twc-heading');
    const title = el('h2', '', '漫画工作台'); title.id = 'twc-workspace-title'; heading.append(title);
    dialog.setAttribute('aria-labelledby', title.id);
    const close = button('关闭', () => { dialog.close(); }); heading.append(close); dialog.append(heading);
    const nav = el('nav', 'twc-stages'); nav.setAttribute('aria-label', '漫画制作步骤'); dialog.append(nav);
    const main = el('div', 'twc-workspace-main'); dialog.append(main);
    const stages = ['准备', '分镜', '出图'].map((label, index) => {
        const panel = el('section', 'twc-stage'); panel.id = `twc-stage-${index}`; main.append(panel);
        const tab = button(label, () => showStage(index), 'twc-stage-tab');
        tab.setAttribute('aria-controls', panel.id); nav.append(tab);
        return { panel, tab };
    });
    const [prep, story, output] = stages.map(stage => stage.panel);
    function showStage(active) {
        for (const [index, { panel, tab }] of stages.entries()) {
            panel.hidden = index !== active;
            tab.setAttribute('aria-pressed', String(index === active));
        }
        main.scrollTop = 0;
        syncControls();
    }
    owner.showGeneration = () => {
        const runningPage = record?.pages.findIndex(page => page.status === 'generating') ?? -1;
        if (runningPage >= 0) { selectedOutput = runningPage; renderOutput(); }
        showStage(2);
    };
    const prepBody = el('div', 'twc-prepare-grid'); prep.append(prepBody);
    const copy = el('section', 'twc-surface'); prepBody.append(copy);
    const sources = el('section', 'twc-surface'); prepBody.append(sources);
    sources.append(el('h3', '', '人物资料'));
    const source = field(copy, '待改编正文', record?.source ?? bound.text); source.rows = 12;
    copy.append(el('p', 'twc-help', '这里的修改只用于漫画。状态栏或脚本可以从待改编正文中删掉。'));
    const appearance = field(copy, '人物外观与当前状态', record?.appearance ?? config.appearance); appearance.rows = 3;
    const useBaiBai = toggle(sources, '读取柏宝书资料（本次，只读）', record?.sourceOptions?.useBaiBai ?? config.useBaiBai);
    const useWorldbook = toggle(sources, '读取世界书资料（本次，只读）', record?.sourceOptions?.useWorldbook ?? config.useWorldbook);
    sources.append(el('p', 'twc-help', '人物外观按角色卡缓存。关闭来源时也跳过它的缓存。'));
    const people = el('div', 'twc-people'); sources.append(people);
    const referenceStatus = el('p', 'twc-help twc-reference-status'); referenceStatus.setAttribute('role', 'status'); sources.append(referenceStatus);
    const referenceDetails = el('details', 'twc-references'); referenceDetails.hidden = true;
    referenceDetails.append(el('summary', '', '已读取的人物资料与来源'));
    const referenceData = el('pre', 'twc-reference-data'); referenceDetails.append(referenceData); sources.append(referenceDetails);
    for (const input of [useBaiBai, useWorldbook]) input.addEventListener('change', () => {
        referenceData.textContent = ''; referenceDetails.hidden = true; people.replaceChildren();
        referenceStatus.textContent = '来源已切换，下次读取或规划将使用当前开关。';
    });
    const prepActions = el('div', 'twc-actions'); prep.append(prepActions);
    const options = el('details', 'twc-disclosure'); options.append(el('summary', '', '画风与工具')); prep.append(options);
    const style = field(options, '本次画风', record?.style === LEGACY_STYLE ? config.style : record?.style ?? config.style); style.rows = 4;
    mountDrawingSettings(prep, config);
    const footer = el('footer', 'twc-footer'); dialog.append(footer);
    const status = el('p', 'twc-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); footer.append(status);
    const warningBox = el('div', 'twc-warnings'); story.append(warningBox);
    const storyEmpty = el('p', 'twc-empty', '先在「准备」中规划分页。'); story.append(storyEmpty);
    const planBox = el('div', 'twc-plan'); story.append(planBox);
    const storyGrid = el('div', 'twc-story-grid'); planBox.append(storyGrid);
    const storyRail = el('div', 'twc-story-rail'); const storyPage = el('article', 'twc-story-page twc-surface'); storyGrid.append(storyRail, storyPage);
    const advanced = el('details', 'twc-disclosure'); advanced.append(el('summary', '', '高级编辑')); planBox.append(advanced);
    const planJSON = field(advanced, '分页与分镜 JSON（保存时检查段落覆盖）', ''); planJSON.rows = 12;
    const planSave = button('保存分镜修改', () => withBusy(async () => {
        ensureFresh();
        const plan = validatePlan(planJSON.value, segmentSource(source.value).length);
        if (JSON.stringify(plan) === JSON.stringify(record.plan) && source.value === record.source && style.value === record.style && appearance.value === record.appearance) {
            planJSON.value = JSON.stringify(plan, null, 2);
            status.textContent = '分镜已是最新。';
            return;
        }
        // 修改分镜后旧图片继续显示，但标记为待重画，避免把旧图视为新分镜结果。
        record.plan = plan; record.source = source.value; record.appearance = appearance.value; record.style = style.value;
        record.pages = plan.pages.map((_, i) => ({ image: record.pages[i]?.image, stale: Boolean(record.pages[i]?.image), prompt: buildPagePrompt(plan, i, style.value, appearance.value), status: 'pending' }));
        record.warnings = [...dialogueWarnings(record.source, plan), ...(record.referenceWarnings ?? []), ...plan.notes.map(note => `人物资料核对：${note}`)];
        await persist(); renderPlan(); status.textContent = '分镜已保存，旧图保留供对照。点击生成未完成页，会按新分镜重画。';
    }), 'twc-primary'); advanced.append(planSave);
    const outputBar = el('div', 'twc-output-bar'); output.append(outputBar);
    const progress = el('p', 'twc-progress'); outputBar.append(progress);
    const pageList = el('div', 'twc-outputs'); output.append(pageList);
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
    const sourceOptions = () => ({ useBaiBai: useBaiBai.checked === true, useWorldbook: useWorldbook.checked === true });
    async function readReferences() {
        ensureFresh(); referenceStatus.textContent = '正在只读收集人物资料，不调用模型……';
        const result = await collectReferences(context(), { floor: bound.index, source: source.value, appearance: appearance.value, ...sourceOptions() });
        ensureFresh();
        if (halted) throw new Error('任务已停止，未使用本次资料。');
        const cache = await reuseCharacterProfiles(context(), { floor: bound.index, ...sourceOptions() }, result);
        ensureFresh();
        if (halted) throw new Error('任务已停止，未使用本次资料。');
        const { context: references, receipt, warnings } = result;
        receipt.characterCacheSaved = cache.saved;
        receipt.characterCacheReused = cache.reused.length;
        referenceDetails.hidden = false;
        showPeople([...observedProfiles(references), ...cache.reused]);
        referenceData.textContent = JSON.stringify({ context: references, receipt, warnings, reusedCharacterProfiles: cache.reused }, null, 2);
        const names = { off: '关闭', unavailable: '未取得', partial: '有缺口', complete: '已读取', read: '已读取' };
        const cacheStatus = `${cache.saved ? `当前角色卡已保存 ${cache.saved} 条人物缓存。` : ''}${cache.reused.length ? `本次复用 ${cache.reused.length} 条人物缓存。` : ''}`;
        referenceStatus.textContent = `柏宝书：${names[receipt.baiBai]}；世界书：${names[receipt.worldbook]}（${receipt.entries} 条）；前文 ${receipt.previousMessages} 条。${cacheStatus}${warnings.length ? '\n' + warnings.join('\n') : ''}`;
        return { context: references, receipt, warnings, reused: cache.reused };
    }
    const readButton = button('读取人物资料', () => withBusy(async () => {
        await readReferences(); status.textContent = '人物资料已读取，未调用模型。请查看来源和缺口，再规划分页。';
    }));
    const planButton = button(record ? '重新规划（替换当前分镜）' : '规划分页', () => withBusy(async () => {
        ensureFresh(); status.textContent = '正在读取本次选定来源的人物资料……';
        const references = await readReferences();
        const busy = await readHostGenerationState(context());
        ensureFresh();
        if (halted) throw new Error('任务已停止，未调用规划模型。');
        if (busy) throw new Error('资料已读取，但酒馆开始了其他生成请求；请等待结束后再规划。');
        status.textContent = '正在使用酒馆当前连接规划，请等待。不会发送正常角色回复。';
        const planningContext = references.reused.length ? { ...references.context, cachedCharacterProfiles: references.reused } : references.context;
        const result = await planWithCurrentConnection(context(), { source: source.value, appearance: appearance.value, style: style.value, responseLength: settings().responseLength, references: planningContext });
        if (!current(bound) || halted) throw new Error('任务已停止或聊天已变化，未写入规划结果。');
        record = { id: newComicId(), original: bound.text, swipe: bound.swipe, source: source.value, appearance: appearance.value, style: style.value, sourceOptions: sourceOptions(), referenceContext: references.context, referenceReceipt: references.receipt, referenceWarnings: references.warnings, plan: result.plan, warnings: [...references.warnings, ...result.warnings], pages: result.plan.pages.map((_, i) => ({ prompt: buildPagePrompt(result.plan, i, style.value, appearance.value), status: 'pending' })) };
        selectedStory = 0; selectedOutput = 0;
        await persist(); renderPlan(); showStage(1);
        status.textContent = `已规划 ${record.pages.length} 页。请核对分镜和对白。`;
    }), 'twc-primary');
    const generateAll = button('生成未完成页', () => generate(), 'twc-primary');
    const exportButton = button('下载分镜备份', () => { if (record) download(record); });
    const checkState = button('检查酒馆状态', async () => {
        try {
            const busy = await readHostGenerationState(context());
            if (!owner.destroyed && runtime === owner && dialog.open) status.textContent = busy
                ? '酒馆仍在处理生成请求，请等结束后再规划。'
                : '酒馆当前空闲，可以规划分页。检查状态未调用模型。';
        } catch (error) { if (!owner.destroyed && runtime === owner) status.textContent = error.message; }
    });
    controls.push(planButton, generateAll, exportButton, planSave, checkState, readButton, useBaiBai, useWorldbook);
    sources.append(readButton);
    prepActions.append(el('p', 'twc-help', '规划会使用酒馆当前模型连接。'), planButton);
    options.append(exportButton, checkState);
    outputBar.append(generateAll);

    function ensureFresh() {
        if (owner.destroyed || runtime !== owner || !current(bound)) throw new Error('当前聊天、回复分支或原文已变化。请关闭预览，再打开对应消息。');
    }
    async function persist() {
        record.updated = Date.now();
        await saveRecord(bound, record); renderMessages();
    }
    function syncControls() {
        const locked = Boolean(activeTask);
        for (const node of [source, appearance, style, planJSON, ...controls]) node.disabled = locked;
        generateAll.disabled = locked || !record;
        planSave.disabled = locked || !record;
        exportButton.disabled = locked || !record;
        for (const node of preview.querySelectorAll('button, textarea')) node.disabled = locked;
        stops.disabled = !localBusy || halted || stopRequested;
        stops.hidden = !localBusy && output.hidden;
    }
    async function withBusy(action, { images = false } = {}) {
        if (owner.destroyed || runtime !== owner) return;
        if (activeTask) { status.textContent = '上一项任务仍在运行，请等待返回。'; return; }
        const token = {}; activeTask = token;
        localBusy = true; halted = false; stopRequested = false; generatingImages = images; syncControls();
        if (images) { owner.generationBound = bound; renderMessages(); }
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
                if (runtime === owner && !owner.destroyed) renderMessages();
            }
            if (!dialog.open) disposeDialog();
            else syncControls();
            runtime?.refreshControls?.();
        }
    }
    function showPeople(profiles) {
        people.replaceChildren();
        for (const name of new Set(profiles.map(profile => profile.name))) people.append(el('span', 'twc-person', name));
    }
    function renderStoryboard() {
        const { scrollLeft, scrollTop } = storyRail;
        storyRail.replaceChildren(); storyPage.replaceChildren();
        for (const [i, page] of record.plan.pages.entries()) {
            const item = button(`${i + 1}. ${page.title}`, () => { selectedStory = i; renderStoryboard(); storyRail.querySelectorAll('button')[i]?.focus(); }, 'twc-story-link');
            item.setAttribute('aria-pressed', String(selectedStory === i)); storyRail.append(item);
        }
        storyRail.scrollLeft = scrollLeft; storyRail.scrollTop = scrollTop;
        const page = record.plan.pages[selectedStory];
        storyPage.append(el('h3', '', page.title), el('p', 'twc-caption', `第 ${selectedStory + 1} 页 · ${page.panels.length} 格`));
        if (record.plan.characters) {
            const cast = el('details', 'twc-disclosure'); cast.append(el('summary', '', '人物设定'), el('p', 'twc-story-text', record.plan.characters)); storyPage.append(cast);
        }
        for (const [i, panel] of page.panels.entries()) {
            const card = el('section', 'twc-panel');
            card.append(el('h4', '', `第 ${i + 1} 格 · ${panel.layout}`), el('p', 'twc-story-text', panel.scene));
            if (panel.texts.length) {
                const lines = el('ul', 'twc-dialogue');
                for (const line of panel.texts) lines.append(el('li', '', `${line.speaker || (line.kind === 'sfx' ? '拟声' : line.kind === 'narration' ? '旁白' : '对白')}　${line.text}`));
                card.append(lines);
            }
            storyPage.append(card);
        }
    }
    function renderOutput() {
        const { scrollLeft, scrollTop } = thumbRail;
        thumbRail.replaceChildren(); preview.replaceChildren();
        if (!record) { progress.textContent = '先在「准备」中规划分页。'; return; }
        const completed = record.pages.filter(page => safeImage(page.image) && !page.stale).length;
        progress.textContent = `已完成 ${completed} / ${record.pages.length} 页`;
        for (const [i, page] of record.pages.entries()) {
            const thumb = button('', () => { selectedOutput = i; renderOutput(); thumbRail.querySelectorAll('button')[i]?.focus(); }, 'twc-thumb');
            const state = page.status === 'generating' ? '生成中' : page.status === 'failed' ? '失败' : page.stale ? '待重画' : page.image ? '已生成' : '待生成';
            thumb.dataset.state = page.status;
            thumb.setAttribute('aria-pressed', String(selectedOutput === i));
            if (safeImage(page.image)) {
                const image = el('img', ''); image.src = page.image; image.alt = ''; image.loading = 'lazy'; thumb.append(image);
            }
            thumb.append(el('span', '', `第 ${i + 1} 页`), el('small', '', state)); thumbRail.append(thumb);
        }
        thumbRail.scrollLeft = scrollLeft; thumbRail.scrollTop = scrollTop;
        const i = selectedOutput;
        const page = record.pages[i];
        const actions = el('div', 'twc-preview-heading');
        actions.append(el('h3', '', `第 ${i + 1} 页 · ${record.plan.pages[i].title}`), button(page.image ? '重画这一页' : '生成这一页', () => generate(i)));
        preview.append(actions);
        if (page.status === 'failed') preview.append(el('p', 'twc-warnings', page.error || '请求中断'));
        if (page.stale) preview.append(el('p', 'twc-caption', '分镜已修改，下方保留旧图供对照。'));
        preview.append(safeImage(page.image) ? imageNode(page.image, `第 ${i + 1} 页`) : el('p', 'twc-empty', page.status === 'generating' ? '正在生成这一页…' : '这一页还没有图片'));
        const detail = el('details', 'twc-disclosure'); detail.append(el('summary', '', '本页生图提示词'));
        const prompt = field(detail, '可修改后保存或重画', page.prompt); prompt.rows = 8;
        prompt.addEventListener('input', () => { page.prompt = prompt.value; });
        detail.append(button('保存本页提示词', () => withBusy(async () => {
            ensureFresh(); await persist(); status.textContent = `第 ${i + 1} 页提示词已保存。`;
        })));
        preview.append(detail);
        syncControls();
    }
    function renderPlan() {
        planBox.hidden = !record; storyEmpty.hidden = Boolean(record); warningBox.replaceChildren();
        planButton.textContent = record ? '重新规划（替换当前分镜）' : '规划分页';
        if (record) {
            selectedStory = Math.min(selectedStory, record.pages.length - 1);
            selectedOutput = Math.min(selectedOutput, record.pages.length - 1);
            planJSON.value = JSON.stringify(record.plan, null, 2);
            for (const warning of record.warnings ?? []) warningBox.append(el('p', '', warning));
            renderStoryboard();
        }
        renderOutput(); syncControls();
    }
    async function generate(forceIndex = null) {
        await withBusy(async () => {
            ensureFresh();
            if (!record) throw new Error('请先规划分页。');
            if (source.value !== record.source || style.value !== record.style || appearance.value !== record.appearance || planJSON.value !== JSON.stringify(record.plan, null, 2)) throw new Error('正文、画风、人物或分镜有未保存的修改。请重新规划或保存分镜修改，再出图。');
            if (record.pages.some(p => !p.prompt?.trim())) throw new Error('生图提示词不能为空。');
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
            await runPages(record.pages, async (page, i) => {
                const seed = crypto.getRandomValues(new Uint32Array(1))[0]; page.seed = seed;
                const filename = `comic-${record.id}-${i + 1}-${Date.now()}`;
                const graph = workflow && fillWorkflow(workflow, { prompt: page.prompt, seed, filename_prefix: `tw-comic/${filename}` });
                return generateImage(context(), { backend, url: address, graph, prompt: page.prompt, seed, model: novelModel, filename });
            }, () => !halted && !owner.destroyed && runtime === owner && current(bound), {
                forceIndex, shouldStop: () => stopRequested, onUpdate: async (_, i) => {
                    ensureFresh(); await persist();
                    if (!dialog.open) selectedOutput = i;
                    renderOutput();
                    if (!stopRequested) status.textContent = record.pages[i].status === 'generating' ? `正在生成第 ${i + 1} / ${record.pages.length} 页，请等待。` : `第 ${i + 1} 页状态已保存。`;
                },
            });
            status.textContent = stopRequested ? '已停止生成，完成的图片已保存到对应消息。' : '本次图片生成完成，已保存到对应消息。请核对图片中的文字和情节。';
        }, { images: true });
    }
    function disposeDialog() {
        owner.nodes.delete(dialog); dialog.remove();
        if (owner.dialog === dialog) { owner.dialog = null; owner.dialogBound = null; owner.showGeneration = null; }
        if (owner.refreshControls === syncControls) owner.refreshControls = null;
    }
    dialog.addEventListener('close', () => {
        if (dialog.open || generatingImages) return;
        halted = true;
        disposeDialog();
    });
    owner.refreshControls = syncControls;
    document.body.append(dialog);
    if (record?.referenceContext) showPeople(observedProfiles(record.referenceContext));
    renderPlan();
    showStage(record?.pages.some(page => page.image) ? 2 : record ? 1 : 0);
    dialog.showModal();
}

function init() {
    if (runtime && !runtime.destroyed) return;
    const ctx = context(); checkHost(ctx);
    globalThis[RUNTIME]?.destroy?.();
    runtime = { destroyed: false, nodes: new Set(), subscriptions: [], dialog: null, dialogBound: null };
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
    runtime.destroyed = true; runtime.dialog?.close();
    for (const [source, name, fn] of runtime.subscriptions) source.removeListener(name, fn);
    for (const node of runtime.nodes) node.remove();
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
