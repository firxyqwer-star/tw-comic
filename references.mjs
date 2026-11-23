// Read-only adapter. Never calls summarization, saveWorldInfo, write APIs or native WI activation.
let worldModule;
const loadWorldModule = () => worldModule ??= import('/scripts/world-info.js').catch(error => { worldModule = undefined; throw error; });

export function resolveReferenceCard(ctx, floor) {
    if (!ctx.groupId) return ctx.characters?.[ctx.characterId];
    const targetName = ctx.chat[floor]?.name;
    const members = ctx.groups?.find(group => String(group.id) === String(ctx.groupId))?.members ?? [];
    const matches = (ctx.characters ?? []).filter(card => card.name === targetName && members.includes(card.avatar));
    return matches.length === 1 ? matches[0] : undefined;
}

export async function collectReferences(ctx, options, dependencies = {}) {
    const { floor, source = '', appearance = '', useBaiBai = false, useWorldbook = false } = options;
    if (!Number.isInteger(floor) || floor < 0 || floor >= (ctx.chat?.length ?? 0)) throw new Error('人物资料读取的目标消息不存在。');
    const warnings = new Set(); let remaining = 28000;
    function take(value, limit, label) {
        if (typeof value !== 'string') return '';
        const count = Math.min(value.length, limit, remaining);
        if (count < value.length) warnings.add(`${label}超过本次资料预算，已截取；请在预览核对缺失部分。`);
        remaining -= count; return value.slice(0, count);
    }
    const previousMessages = ctx.chat.slice(0, floor).map((message, index) => ({ message, index }))
        .filter(({ message }) => !message.is_system).slice(-6).map(({ message, index }) => ({
            floor: index, name: typeof message.name === 'string' ? message.name : '',
            role: message.is_user ? 'user' : 'assistant', text: take(message.mes, 2000, '附近前文'),
        }));
    const targetName = ctx.chat[floor]?.name;
    const character = resolveReferenceCard(ctx, floor);
    if (ctx.groupId && !character) warnings.add('群聊发言者未能唯一匹配角色卡，未猜测其人物说明；请核对人物资料。');
    const cast = new Set([ctx.name1, ctx.name2, targetName, character?.name, ...previousMessages.map(x => x.name)].filter(x => typeof x === 'string' && x.trim()));
    const matchText = `${source}\n${appearance}\n${previousMessages.map(x => x.text).join('\n')}\n${[...cast].join('\n')}`.toLocaleLowerCase();
    const characterCards = character ? [{ name: character.name || ctx.name2 || '', description: take(character.description ?? character.data?.description, 4000, '角色卡说明') }] : [];
    const context = { floor, previousMessages, characterCards, baiBai: null, worldbooks: [] };
    const receipt = { floor, previousMessages: previousMessages.length, baiBai: useBaiBai ? 'unavailable' : 'off', worldbook: useWorldbook ? 'unavailable' : 'off', books: [], entries: 0 };

    function person(value) {
        if (!value || typeof value !== 'object') return {};
        const keys = ['id', 'name', 'gender', 'age', 'title', 'desc', 'outfit', 'condition'];
        return Object.fromEntries(keys.filter(key => typeof value[key] === 'string' && value[key]).map(key => [key, take(value[key], 1000, '人物资料')]));
    }
    function snapshot(value) {
        const npcs = (Array.isArray(value.npcs) ? value.npcs : []).filter(n => typeof n.name === 'string' && n.name.length > 1 && matchText.includes(n.name.toLocaleLowerCase()));
        if (npcs.length > 12) warnings.add('相关人物超过12名，已按名册顺序截取，请核对角色是否遗漏。');
        return { npcs: npcs.slice(0, 12).map(n => person(n)) };
    }
    if (useBaiBai) {
        try {
            // Access global object only when this source is explicitly enabled.
            const api = (dependencies.getBaiBai ?? (() => globalThis.STBaiBaiBook))();
            if (api?.apiVersion !== 1 || typeof api.getSnapshot !== 'function') throw new Error();
            const before = await api.getSnapshot({ floor, at: 'before' });
            const after = await api.getSnapshot({ floor, at: 'after' });
            const chatId = ctx.getCurrentChatId?.() ?? ctx.chatId;
            if (before?.chat?.id !== chatId || after?.chat?.id !== chatId
                || before?.point?.floor !== floor || before.point.at !== 'before' || after?.point?.floor !== floor || after.point.at !== 'after') {
                warnings.add('柏宝书返回的聊天或时间点不匹配，已排除该来源资料。');
            } else {
                context.baiBai = {
                    pluginVersion: typeof api.pluginVersion === 'string' ? api.pluginVersion : '',
                    before: snapshot(before), after: snapshot(after),
                    coverage: { complete: after.coverage?.complete === true, missingAiFloors: (after.coverage?.missingAiFloors ?? []).filter(Number.isInteger).slice(0, 100) },
                };
                receipt.baiBai = context.baiBai.coverage.complete ? 'complete' : 'partial';
                if (!context.baiBai.coverage.complete) warnings.add('柏宝书有摘要覆盖缺口，人物资料可能不完整；不会自动补摘或改写记忆。');
                if (!context.baiBai.before.npcs.length && !context.baiBai.after.npcs.length) warnings.add('柏宝书角色名册中未匹配到本轮人物，可在人物补充中填写姓名后重新读取。');
            }
        } catch { warnings.add('柏宝书公开只读接口尚未就绪或读取失败，本次未取得该来源资料。'); }
    }
    if (useWorldbook) {
        try {
            if (typeof ctx.loadWorldInfo !== 'function') throw new Error();
            const module = await (dependencies.loadWorldModule ?? loadWorldModule)();
            const names = new Set();
            const add = value => { if (typeof value === 'string' && value.trim()) names.add(value.trim()); };
            add(ctx.chatMetadata?.world_info);
            for (const name of module.selected_world_info ?? []) add(name);
            const members = ctx.groupId ? ctx.groups?.find(g => String(g.id) === String(ctx.groupId))?.members ?? [] : [];
            const cards = [character, ...(ctx.characters ?? []).filter(c => members.includes(c.avatar))].filter(Boolean);
            for (const card of cards) {
                add(card.data?.extensions?.world);
                const key = card.avatar?.replace(/\.[^/.]+$/u, '');
                const extras = module.world_info?.charLore?.find(row => row.name === key)?.extraBooks ?? [];
                for (const name of extras) add(name);
            }
            if (names.size > 8) warnings.add('关联世界书超过8本，本次只读取前8本，请核对来源范围。');
            receipt.books = [...names].slice(0, 8); receipt.worldbook = 'read';
            for (const book of receipt.books) {
                let data;
                try { data = await ctx.loadWorldInfo(book); }
                catch { warnings.add(`世界书“${book}”读取失败，未使用该书。`); continue; }
                if (!data?.entries) { warnings.add(`世界书“${book}”未取得条目。`); continue; }
                for (const entry of Object.values(data.entries)) {
                    if (!entry || entry.disable === true || entry.enabled === false || typeof entry.content !== 'string') continue;
                    const keys = Array.isArray(entry.key) ? entry.key : [];
                    const keyMatch = keys.some(k => typeof k === 'string' && k.trim() && !(k.startsWith('/') && k.lastIndexOf('/') > 0) && matchText.includes(k.toLocaleLowerCase()));
                    const title = typeof entry.comment === 'string' ? entry.comment : '';
                    const titleMatch = title.length >= 2 && matchText.includes(title.toLocaleLowerCase());
                    const castMatch = [...cast].some(name => name.length >= 2 && `${title}\n${entry.content}`.includes(name));
                    if (!keyMatch && !titleMatch && !castMatch) continue;
                    if (context.worldbooks.length >= 24 || remaining <= 0) { warnings.add('世界书候选超过24条或资料预算，已截取，请核对遗漏。'); break; }
                    context.worldbooks.push({ book, uid: entry.uid ?? null, title, keys: keys.filter(x => typeof x === 'string').slice(0, 16), content: take(entry.content, 3000, '世界书条目') });
                }
            }
            receipt.entries = context.worldbooks.length;
            if (!receipt.books.length) warnings.add('未找到当前角色、聊天或全局绑定的世界书；不会扫描其他未关联书。');
            else if (!receipt.entries) warnings.add('关联世界书中未找到启用且匹配人物/正文的条目。');
        } catch { warnings.add('世界书只读能力不可用，本次未取得该来源资料。'); }
    }
    return { context, warnings: [...warnings], receipt, matchText };
}
