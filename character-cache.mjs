import { resolveReferenceCard } from './references.mjs';

export const CHARACTER_CACHE_FIELD = 'tw_comic_character_cache_v1';
const MAX_PROFILES = 24;
const MAX_REUSED = 8;
const sources = { baiBai: 'useBaiBai', worldbook: 'useWorldbook' };
let pendingWrite;

const cleanText = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const nameKey = name => name.toLocaleLowerCase();

function worldProfile(entry) {
    const name = cleanText(entry.title, 100).replace(/(?:的?(?:外貌(?:特征)?|外观|人物设定|角色设定|资料)|\s+(?:appearance|profile))$/iu, '').trim();
    if (!name || !/^[\p{L}\p{M}·.' -]+$/u.test(name)) return null;

    const lines = entry.content.split(/\r?\n/u).map(line => line.trim().startsWith(`${name}的外貌`)
        ? line.trim().slice(`${name}的`.length) : line);
    const heading = /^(?:#{1,6}\s+|\[|【)?\s*(?:外貌(?:特征)?|外观|人物形象|appearance)\s*(?:\(appearance\)|（appearance）)?\s*(?:\]|】)?\s*(?:[:：]\s*(.*))?\s*$/iu;
    const start = lines.findIndex(line => heading.test(line.trim()));
    if (start < 0) return null;
    const inline = heading.exec(lines[start].trim())?.[1];
    const section = [];
    for (const line of lines.slice(start + 1)) {
        if (/^#{1,6}\s/u.test(line.trim()) || /^[【\[]/u.test(line.trim())) break;
        section.push(line);
    }
    // Select identifiable visual fields from structured entries. Simple appearance prose is also supported.
    const fields = /^(?:[-*]\s+)?(?:face_shape|skin_tone|eyes?|eye_color|hair_style|hair_color|height|build|脸型|肤色|眼[型睛]|瞳色|发[型色]|身高|体态)\s*[:：]/iu;
    const visual = section.map(line => line.trim()).filter(line => fields.test(line))
        .map(line => line.replace(/\s*[（(].*?[）)]\s*/gu, ' ').trim()).filter(line => !/[:：]\s*>-?$/u.test(line));
    const plain = section.filter(line => line.trim() && !/[:：]/u.test(line)).slice(0, 3).join('\n');
    const description = cleanText(inline || (visual.length ? visual.join('\n') : plain), 950);
    if (!description) return null;
    return { source: 'worldbook', name, description, book: entry.book, uid: entry.uid, title: entry.title };
}

export function observedProfiles(context) {
    const profiles = new Map();
    for (const person of [...(context.baiBai?.after.npcs ?? []), ...(context.baiBai?.before.npcs ?? [])]) {
        const name = cleanText(person.name, 100);
        const description = cleanText(person.desc, 950);
        if (name && description) profiles.set(nameKey(name), { source: 'baiBai', name, description });
    }
    return [...profiles.values(), ...(context.worldbooks ?? []).map(worldProfile).filter(Boolean)];
}

function profileKey(profile) {
    return profile.source === 'worldbook'
        ? JSON.stringify([profile.source, profile.book, profile.uid ?? profile.title])
        : JSON.stringify([profile.source, nameKey(profile.name)]);
}

function storedProfiles(card) {
    const value = card?.data?.extensions?.[CHARACTER_CACHE_FIELD];
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_PROFILES).filter(profile => profile && Object.hasOwn(sources, profile.source)
        && typeof profile.name === 'string' && profile.name.length > 0 && profile.name.length <= 100
        && typeof profile.description === 'string' && profile.description.length > 0 && profile.description.length <= 950
        && (profile.source === 'baiBai' || (typeof profile.book === 'string' && typeof profile.title === 'string')));
}

export async function reuseCharacterProfiles(ctx, options, references) {
    const card = resolveReferenceCard(ctx, options.floor);
    const existing = storedProfiles(card);
    const live = observedProfiles(references.context);
    const liveKeys = new Set(live.map(profileKey));
    const liveByName = new Map(live.map(profile => [JSON.stringify([profile.source, nameKey(profile.name)]), profile]));
    const reused = existing.filter(profile => options[sources[profile.source]]
        && references.matchText.includes(nameKey(profile.name))).filter(profile => {
        const current = liveByName.get(JSON.stringify([profile.source, nameKey(profile.name)]));
        return !current || (profileKey(current) === profileKey(profile) && current.description === profile.description);
    }).slice(0, MAX_REUSED);
    const result = { reused, saved: 0 };

    if (!live.length) return result;
    if (!card?.avatar || typeof ctx.writeExtensionFieldBulk !== 'function' || typeof ctx.constants?.unset !== 'string') {
        references.warnings.push('当前角色卡无法安全保存缓存，本次仍会使用刚读取的资料。');
        return result;
    }

    const next = [...live, ...existing.filter(profile => !liveKeys.has(profileKey(profile)))].slice(0, MAX_PROFILES);
    if (JSON.stringify(existing) === JSON.stringify(next)) return result;
    const write = Promise.resolve().then(() => ctx.writeExtensionFieldBulk([card.avatar], CHARACTER_CACHE_FIELD, next));
    pendingWrite = write;
    try {
        const response = await write;
        if (!response?.updated?.includes(card.avatar)) throw new Error();
        result.saved = next.length;
    } catch {
        references.warnings.push('人物缓存写入失败，本次仍会使用刚读取的资料。');
    } finally {
        if (pendingWrite === write) pendingWrite = undefined;
    }
    return result;
}

async function removeCharacterProfiles(ctx) {
    if (typeof ctx.writeExtensionFieldBulk !== 'function' || typeof ctx.constants?.unset !== 'string') {
        if (!(ctx.characters ?? []).some(card => card?.data?.extensions?.[CHARACTER_CACHE_FIELD] !== undefined)) return;
        throw new Error('酒馆缺少角色卡批量清理接口，未能清除漫画人物缓存。');
    }
    const response = await ctx.writeExtensionFieldBulk(null, CHARACTER_CACHE_FIELD, ctx.constants.unset);
    const known = (ctx.characters ?? []).some(card => card?.data?.extensions?.[CHARACTER_CACHE_FIELD] !== undefined);
    if (!Array.isArray(response?.failed) || response.failed.length || known
        || (!response.updated?.length && !response.skipped?.length && ctx.characters?.some(card => card?.avatar))) {
        throw new Error('漫画人物缓存清理未获确认，请重试。');
    }
}

export async function cleanCharacterProfiles(ctx) {
    // Fail before the host's 5-second deadline so it does not continue an unconfirmed uninstall.
    let timer;
    try {
        await Promise.race([
            (async () => {
                await pendingWrite?.catch(() => {});
                await removeCharacterProfiles(ctx);
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('角色卡缓存清理超时，请重试卸载。')), 4000); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
