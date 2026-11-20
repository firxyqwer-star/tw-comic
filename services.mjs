import { segmentSource, plannerRequest, validatePlan, dialogueWarnings, normalizeImagePath } from './core.mjs';

let hostStateModule;
const loadHostStateModule = () => hostStateModule ??= import('/script.js').catch(error => {
    hostStateModule = undefined;
    throw error;
});

// TauriTavern 2.1.0 固定源码 script.js:780 导出实时 isGenerating。
// 缓存的是模块，不是忙碌值；GENER­ATION_STARTED 也会用于 dryRun，不能当持续状态。
export async function readHostGenerationState(ctx, loadModule = loadHostStateModule) {
    try {
        const probe = typeof ctx.isGenerating === 'function' ? ctx.isGenerating : (await loadModule()).isGenerating;
        if (typeof probe !== 'function') throw new Error();
        const value = probe();
        if (typeof value !== 'boolean') throw new Error();
        return value;
    } catch {
        throw new Error('无法读取酒馆实时生成状态，请检查客户端版本并重载扩展。');
    }
}

export function checkHost(ctx) {
    const missing = ['generateRaw', 'getRequestHeaders', 'saveChat', 'saveSettingsDebounced'].filter(key => typeof ctx?.[key] !== 'function');
    if (!ctx?.eventSource || !ctx?.eventTypes || !ctx?.extensionSettings) missing.push('事件或扩展设置');
    if (missing.length) throw new Error(`当前酒馆缺少所需接口：${missing.join('、')}。请核对 TauriTavern 版本。`);
}

export async function planWithCurrentConnection(ctx, { source, appearance = '', style = '', responseLength = 12000, references = null }) {
    if (typeof ctx.generateRaw !== 'function') throw new Error('当前酒馆未提供 generateRaw 规划接口。');
    const segments = segmentSource(source);
    const raw = await ctx.generateRaw(plannerRequest(segments, appearance, style, responseLength, references));
    const plan = validatePlan(raw, segments.length);
    return { plan, warnings: [...dialogueWarnings(source, plan), ...plan.notes.map(note => `人物资料核对：${note}`)], segments };
}

async function post(ctx, path, body, request, signal) {
    return request(path, { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body), signal });
}

export function normalizeComfyUrl(url, provider = 'ComfyUI') {
    try {
        const address = new URL(url);
        if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error();
        return address.href.replace(/\/+$/u, '');
    } catch { throw new Error(`请填写 ${provider} 的 HTTP 或 HTTPS 服务地址，地址中无需填账号、密码或参数。`); }
}

async function checkConnection(ctx, path, body, provider, request) {
    let result;
    try {
        result = await post(ctx, path, body, request, AbortSignal.timeout(10000));
    } catch {
        throw new Error(`${provider} 测试连接失败或超时，请检查酒馆后端的网络连接。`);
    }
    if (!result.ok) throw new Error(`${provider} 测试连接失败（HTTP ${result.status}）。请检查服务配置和酒馆版本。`);
    return result;
}

export async function testComfyConnection(ctx, url, request = globalThis.fetch) {
    await checkConnection(ctx, '/api/sd/comfy/ping', { url: normalizeComfyUrl(url) }, 'ComfyUI', request);
}

export async function testWebUiConnection(ctx, url, request = globalThis.fetch) {
    await checkConnection(ctx, '/api/sd/ping', { url: normalizeComfyUrl(url, 'SD WebUI') }, 'SD WebUI', request);
}

export async function saveNovelKey(value, loadSecrets = () => import('/scripts/secrets.js')) {
    const key = value.trim();
    if (!key) throw new Error('请输入 NovelAI API 密钥。');
    const host = await loadSecrets().catch(() => null);
    if (typeof host?.writeSecret !== 'function' || !host.SECRET_KEYS?.NOVEL) {
        throw new Error('当前酒馆无法从工作台保存密钥。请在「API 连接」里保存 NovelAI 密钥。');
    }
    try {
        if (!await host.writeSecret(host.SECRET_KEYS.NOVEL, key, '漫画工作台')) throw new Error();
    } catch {
        throw new Error('NovelAI 密钥保存失败，请稍后重试。');
    }
}

export async function testNovelConnection(ctx, request = globalThis.fetch) {
    const result = await checkConnection(ctx, '/api/novelai/status', {}, 'NovelAI', request);
    const status = await result.json().catch(() => null);
    if (!status || typeof status !== 'object' || Array.isArray(status) || !Object.keys(status).length || status.error) {
        throw new Error('NovelAI 未返回有效的订阅状态，请检查已保存的 NovelAI 密钥。');
    }
}

const imageFormats = [['iVBORw0KGgo', 'png'], ['/9j/', 'jpeg'], ['UklGR', 'webp']];

export async function generateImage(ctx, { backend = 'comfy', url, graph, prompt, seed, model, filename }, request = globalThis.fetch) {
    let path, body, provider;
    switch (backend) {
        case 'comfy':
            provider = 'ComfyUI';
            path = '/api/sd/comfy/generate';
            body = { url: normalizeComfyUrl(url), prompt: JSON.stringify({ prompt: graph }) };
            break;
        case 'novel':
            provider = 'NovelAI';
            path = '/api/novelai/generate-image';
            body = { model, prompt, seed, width: 832, height: 1216, steps: 28, scale: 5, upscale_ratio: 1 };
            break;
        case 'webui':
            provider = 'SD WebUI';
            path = '/api/sd/generate';
            body = { url: normalizeComfyUrl(url, provider), prompt, seed, width: 768, height: 1344, steps: 25, cfg_scale: 7, batch_size: 1, n_iter: 1, save_images: false };
            break;
        default:
            throw new Error('请选择漫画绘图后端。');
    }
    const result = await post(ctx, path, body, request);
    if (!result.ok) throw new Error(`${provider} 生成失败（HTTP ${result.status}）。请检查对应服务的连接和模型设置。`);
    let image;
    if (backend === 'comfy') {
        image = await result.json().catch(() => null);
    } else {
        const data = backend === 'novel' ? (await result.text()).trim() : (await result.json().catch(() => null))?.images?.[0];
        const format = typeof data === 'string' && imageFormats.find(([prefix]) => data.startsWith(prefix))?.[1];
        image = { data, format };
    }
    if (typeof image?.data !== 'string' || !image.data || !['png', 'jpg', 'jpeg', 'webp'].includes(image.format)) throw new Error(`${provider} 没有返回有效图片。`);
    const saved = await post(ctx, '/api/images/upload', {
        image: image.data, format: image.format, ch_name: 'tw-comic', filename,
    }, request);
    if (!saved.ok) throw new Error(`图片已生成，但保存失败（HTTP ${saved.status}）。请检查酒馆磁盘空间。`);
    const data = await saved.json();
    return normalizeImagePath(data.path);
}
