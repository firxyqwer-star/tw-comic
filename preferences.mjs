export const LEGACY_STYLE = '日式全彩漫画，赛璐璐上色，清晰钢笔线稿。格线为不等粗黑线，页面保留白边，采用疏密有致的不规则分格。';
export const PREVIOUS_DEFAULT_STYLE = '精细二次元商业插画风的全彩漫画。纤细干净的线稿，柔和细腻的渐变上色，清晰但不过分夸张的五官，层次分明的发丝与克制的高光，细致的衣料褶皱和材质表现，柔和环境光与少量轮廓光，画面通透，色彩协调。人物的年龄感、脸型、眼型、发型、发色、身材和服装以本次人物设定为准，不从画风样图借用人物特征。同一组页面保持一致的线条粗细、面部画法、上色方式与材质质感；场景光照随剧情变化。页面保留白边与清楚格线，采用疏密有致的不规则漫画分格，构图服务于对白阅读。';
export const ICY_FANTASY_STYLE = '高细节日系幻想商业插画风的全彩漫画。用纤细清晰的轮廓线和分束发丝塑造人物，五官精细、眼睛有通透的虹膜与小而锐利的反光。柔和渐变塑造皮肤和布料体积，保留干净的明暗交界，暗部深而通透，用冷蓝轮廓光和银白高光勾出边缘。整体色彩以深海蓝、靛青和冷银为基调，肤色自然偏暖，少量高饱和色用于视觉焦点。根据场景已有的物件表现材质：金属用清晰镜面高光与细刻纹，宝石或玻璃用锐利折射，布料用细织纹与顺光褶皱。背景有景深，细节集中在人物与剧情焦点。画风仅约束线条、配色、光影与材质，人物特征、服装、道具与场景均遵循本次设定和分镜。同一组页面统一面部画法、上色方式和材质表现，场景用光随剧情变化。保留清楚的细格线和白色格间距，分格有疏密节奏，给对白留足空间。';
export const ANIMATED_FILM_STYLE = '日系二次元动画电影风的全彩漫画，融合精细幻想插画的用光。人物首先按动画人设绘制：眼睛稍大、上眼线清晰，虹膜有两三层色块与清亮高光，鼻形用短线和一小块阴影概括，嘴唇用简洁线条，脸颊到下巴的轮廓利落，保留角色应有的年龄感。发丝画成有节奏的大束，发梢用细线收形，高光成片。皮肤和衣服以干净的赛璐璐色块和清楚的阴影边界为主，仅在背光边缘与反光处加少量柔和渐变，避免照片式皮肤纹理、写实唇妆和三维渲染质感。用深海蓝、靛青、冷银构成整体色调，搭配自然暖肤色和少量亮色焦点。冷蓝轮廓光、银白高光和精致道具细节用来衬托简洁的人物画法，金属、玻璃和织物以清晰的线与色块表现质感。人物外观、服装、道具和场景遵循本次设定与分镜，同一组页面统一脸型画法、线条和上色方式。保留清楚的格线与白色格间距，给对白留足空间。';
export const MODERN_FANTASY_STYLE = '现代日系幻想手游的高精度二次元角色卡面画风，绘制成全彩漫画。人物面部采用精细的二次元比例：清秀利落的下颌，略狭长的眼型，细而锐利的上下眼睑，宝石般通透的虹膜内有渐变与小面积高光，鼻梁与嘴唇以少量笔触表现。轮廓线纤细，发束层次分明，边缘有少量细发丝和丝绸般的冷色高光。皮肤平滑、清透，阴影克制，用柔和渐变连接明暗，在眼睛、发梢、衣褶和受光边缘保留精确锐利的细节。画面的光色以深蓝、冷银和清透的局部反光为主，保留自然暖肤色。金属有利落的高亮边缘，玻璃有通透折射，布料有细致褶皱和丝绸般的反光。避免复古手绘动画、水彩纸纹、粗轮廓、大片平涂硬阴影与摄影级肤质。人物长相、服装、道具和场景以人物设定和分镜为准，各页使用同一套面部画法和材质表现。保留清楚的漫画格线、白色格间距与对白空间。';
export const DEFAULT_STYLE = "Contemporary Japanese fantasy gacha character splash-art rendering, applied to each panel of a full-color manga page. Anime-drawn proportions with a slender jaw, narrowed almond-shaped eyes, long fine upper lashes and minimal nose and lip lines. Use a polished 2D painted finish. On faces and clothing, use small closely spaced tonal steps with soft transitions and subtle blue reflected light in shadows. Thin colored contour lines fade along the lit contours. Draw fine individual strands at the ends of hair locks, with narrow silver-blue rim highlights and silky anisotropic sheen. Put the most precise detail into the eyes, hair and metal edges. Irises have clear jewel-like internal facets and pinpoint white catchlights. Keep warm-peach light on the face, cool violet-blue halftones, and a distinct silver-blue rim on the silhouette. Maintain deep midnight-blue shadows and controlled luminous highlights. Render fabric with fine woven texture and smooth folds, with tiny sharp reflections on glass and polished metal. The finish is contemporary game-key-art illustration. Keep broad facial and clothing shadows softly blended, with crisp small details and no flat TV-animation shadow blocks, vintage watercolor texture, thick black outlines or photographic skin texture. Use the specified character appearance, costume, props and location throughout. Keep white panel gutters and render only the quoted dialogue as bubble text.";
export const DEFAULT_PREFERENCES = Object.freeze({
    drawingBackend: 'off', comfyUrl: '', webuiUrl: '', novelModel: 'nai-diffusion-4-5-full',
    useLegacyWorkflow: false, responseLength: 20000, planningOutputBudgetUpdated: true, style: DEFAULT_STYLE,
    storyboardRules: '', imageTemplates: { multi: '', single: '' },
    appearance: '', workflow: null, workflowBindings: {}, useBaiBai: true, useWorldbook: true,
});
export function upgradePreferences(saved) {
    let changed = false;
    if (saved.planningOutputBudgetUpdated === undefined && saved.responseLength === 12000) {
        saved.responseLength = DEFAULT_PREFERENCES.responseLength;
        changed = true;
    }
    if (saved.drawingBackend === undefined) {
        const legacy = saved.comfyEnabled === undefined && typeof saved.comfyUrl === 'string' && Boolean(saved.comfyUrl.trim());
        saved.drawingBackend = (saved.comfyEnabled === true || legacy) ? 'comfy' : 'off';
        if (legacy) saved.useLegacyWorkflow = !saved.workflow;
        changed = true;
    }
    for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) if (saved[key] === undefined) {
        saved[key] = structuredClone(value); changed = true;
    }
    if (saved.style === LEGACY_STYLE || saved.style === PREVIOUS_DEFAULT_STYLE || saved.style === ICY_FANTASY_STYLE || saved.style === ANIMATED_FILM_STYLE || saved.style === MODERN_FANTASY_STYLE) {
        saved.style = DEFAULT_STYLE;
        changed = true;
    }
    return changed;
}
