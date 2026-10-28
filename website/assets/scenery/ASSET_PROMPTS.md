# Aulos Dig 场景资产生成提示词 + 清单

> 用法：把「总风格 Prompt」+ 清单里某一项的「单项 Prompt」拼在一起发给
> ChatGPT（图片生成）。拿到 PNG 后交给 Claude，负责抠图/平铺校验/接入
> 游戏（`BK_DEFS` 背景带、精灵表等）。
>
> 教训约束（本仓库踩过的坑，不可省略）：
> 1. 背景带**禁止烤入天空/云**——天空由游戏内的昼夜渐变实时渲染，
>    贴图里出现天色就会在黄昏/夜晚形成分割线或残影。
> 2. 背景/装饰带必须**水平无缝平铺**（左右边缘完全衔接）。
> 3. 像素风、**原生分辨率**交付，禁止输出放大图（缩放会糊）。
> 4. 不透明背景生成即可（纯色 #FF00FF 洋红底），抠图交给工具
>    （tools/key_yuanjing_sky.py 同款流程）。

---

## 一、总风格 Prompt（每张图都带上）

中文版：

> 像素风游戏场景贴图，16-bit 复古质感，色彩沉稳偏灰（aerial
> perspective 空气透视：越远越淡越灰蓝），无描边、无文字、无水印。
> 参考 Terraria 的背景层画法。水平方向左右无缝平铺（tileable）。
> 构图要素贴边：山体/植被必须延伸到图片底边，不得悬空。

英文版（图片模型对英文响应更好，推荐用这段）：

> Pixel art game background asset, 16-bit retro style, muted desaturated
> palette with aerial perspective (distant objects fade into pale
> gray-blue haze). No outlines, no text, no watermark. Horizontally
> seamless / tileable left-to-right. Landforms must extend all the way
> to the bottom edge of the image — nothing floating.

---

## 二、资产清单

### P0 —— 直接解决"场景单调"（优先做）

| # | 资产 | 尺寸 | 说明 | 接入点 |
|---|------|------|------|--------|
| 1 | 中景丘陵带 | 1536×512 | 比远景更近的起伏丘陵+稀疏树影，色深比远景重一档，比地表草色浅一档 | `BK_DEFS` 新层，depth −3.8 |
| 2 | 近景树线带 | 1536×384 | 密集树冠剪影带，最接近地表的一层，颜色接近地表草但更暗 | `BK_DEFS` 新层，depth −3.7 |
| 3 | 雪原远景变体 | 1536×1024 | 同现版远景构图，山体积雪、针叶挂雪、底部草基换成雪地 | 雪原 biome 用 |
| 4 | 沙漠远景变体 | 1536×1024 | 沙岩台地+仙人掌剪影+暖沙色草基 | 沙漠 biome 用 |
| 5 | 沼泽远景变体 | 1536×1024 | 郁郁葱葱低丘+垂柳/芦苇剪影+暗绿草基 | 沼泽 biome 用 |

单项 Prompt 示例（#1 中景丘陵带，其它替换主体描述即可）：

> [总风格 Prompt] + Generate ONE parallax layer: rolling mid-distance
> hills with sparse dark tree silhouettes on the ridges. Bottom 15% is a
> solid dark-green grass base that touches the bottom edge. Mountains
> occupy the upper half as a clean silhouette against a FLAT SOLID
> #FF00FF magenta background (this background will be keyed out — no
> gradients, no clouds, no sky, no sun, no birds in the sky area).
> Canvas exactly 1536×512.

### P1 —— 氛围与细节

| # | 资产 | 尺寸 | 说明 | 接入点 |
|---|------|------|------|--------|
| 6 | 天空云带 | 1536×384 | 散碎积云，云间大量空隙（≥70% 透明），边缘蓬松 | 世界云精灵素材 |
| 7 | 地表小装饰表 | 512×512（16 格） | 4×4 网格：圆石×3、碎石堆×2、树桩、蘑菇丛、蕨丛、断木、骨堆、水晶簇露头、蚁丘、苔石、野花丛 | 世界装饰 sprite |
| 8 | 洞穴背景带 | 1536×512 | 洞穴远壁剪影：石笋/石钟乳/藤蔓/远处的发光真菌微光 | 洞穴区背景层 |
| 9 | 鸟群精灵表 | 512×256（8 帧） | 2 种鸟 × 4 帧扇翅剪影，深色剪影即可 | 天空动态精灵 |
| 10 | 萤火虫/孢子 | 64×64（4 帧） | 4×4~6×6 px 发光点，绿/黄/蓝三色，呼吸明暗 | 夜晚/洞穴粒子 |

### P2 —— 锦上添花

| # | 资产 | 尺寸 | 说明 | 接入点 |
|---|------|------|------|--------|
| 11 | 雨天覆盖纹理 | 1024×1024 | 斜细雨线条，90% 透明，可平铺 | 天气系统 |
| 12 | 雪天粒子 | 512×512（4 帧） | 不同大小的雪花点 | 天气系统 |
| 13 | 地表遗迹装饰 | 512×512（4 格） | 断柱、塌门、石圈、苔痕碑——低矮贴地，不挡人 | 稀有地表结构 |
| 14 | 蒸汽/雾气带 | 1536×256 | 底部贴地薄雾，向上渐透明 | 沼泽/清晨氛围 |

---

## 三、给 ChatGPT 的统一技术要求（附在每次请求后）

1. Exact canvas size as specified, PNG, pixel art, no upscaling.
2. Flat solid #FF00FF background where the sky/empty area would be
   (it will be keyed out). Never paint sky gradients or clouds into it.
3. Horizontally seamless: the left edge must continue perfectly into
   the right edge.
4. Silhouettes must touch the bottom edge (no floating land).
5. For sprite sheets: frames on a strict grid, equal cell size, first
   cell at top-left, no padding between cells.


