# 第三方声明

Multiplane 使用以下依赖；它们保留各自的版权和许可，不因本项目的 Apache-2.0 许可而改变。

| 组件 | 本次锁定版本 | 许可与原文 | 用途 |
|---|---|---|---|
| [Playwright](https://github.com/microsoft/playwright) / playwright-core | 1.63.0 | Apache-2.0：[LICENSE](licenses/playwright-LICENSE)、[NOTICE](licenses/playwright-NOTICE)、[Playwright 第三方声明](licenses/playwright-ThirdPartyNotices.txt)、[core 第三方声明](licenses/playwright-core-ThirdPartyNotices.txt) | 安装和控制 Chromium |
| [sharp](https://github.com/lovell/sharp) | 0.35.5 | Apache-2.0：[LICENSE](licenses/sharp-LICENSE) | PNG 解码和缩放 |
| sharp Windows x64 原生依赖 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later：[包许可](licenses/sharp-win32-x64-LICENSE)、[上游第三方组件声明](licenses/sharp-win32-x64-NOTICES.md)、[LGPLv3](licenses/LGPL-3.0.txt)、[GPLv3](licenses/GPL-3.0.txt) | 原生图像处理，包含 libvips 等组件 |
| [three.js](https://github.com/mrdoob/three.js) | 0.180.0 | MIT：[LICENSE](licenses/three-LICENSE) | 可选三维层 |
| @img/colour | 随 lockfile 固定 | MIT：[LICENSE](licenses/colour-LICENSE.md) | sharp 间接依赖 |
| detect-libc | 随 lockfile 固定 | Apache-2.0：[LICENSE](licenses/detect-libc-LICENSE) | sharp 平台检测 |
| semver | 随 lockfile 固定 | ISC：[LICENSE](licenses/semver-LICENSE) | 版本解析 |
| Roboto 可变字体 | Google Fonts 原始 TTF | SIL OFL 1.1：[OFL 原文](examples/assets/OFL.txt) | 文字示例 |
| [Acorn](https://github.com/acornjs/acorn) | 8.15.0 | MIT：[LICENSE](licenses/acorn-LICENSE) | JavaScript 静态语法与位置解析 |
| [parse5](https://github.com/inikulin/parse5) | 7.3.0 | MIT：[LICENSE](licenses/parse5-LICENSE) | HTML 元素、属性和内联源码位置解析 |
| [PostCSS](https://github.com/postcss/postcss) | 8.5.28 | MIT：[LICENSE](licenses/postcss-LICENSE) | CSS 规则与声明解析；禁用 source map 读取 |
| [postcss-value-parser](https://github.com/TrySound/postcss-value-parser) | 4.2.0 | MIT：[LICENSE](licenses/postcss-value-parser-LICENSE) | CSS 资源 URL 与字符串解析 |
| entities | 6.0.1 | BSD-2-Clause：[LICENSE](licenses/entities-LICENSE) | parse5 间接依赖，HTML 实体解码 |
| nanoid | 3.3.19 | MIT：[LICENSE](licenses/nanoid-LICENSE) | PostCSS 间接依赖 |
| picocolors | 1.1.1 | ISC：[LICENSE](licenses/picocolors-LICENSE) | PostCSS 间接依赖，诊断颜色工具 |
| source-map-js | 1.2.2 | BSD-3-Clause：[LICENSE](licenses/source-map-js-LICENSE) | PostCSS 间接依赖，source map 工具 |

Roboto 文件从 [Google Fonts 的 Roboto 目录](https://github.com/google/fonts/tree/main/ofl/roboto) 获取，文件名为 `Roboto[wdth,wght].ttf`，本仓库仅将文件名改为 `Roboto-Variable.ttf`，未修改字体内容。Copyright 2011 The Roboto Project Authors。许可原文随字体保存。

`examples/assets/card.svg` 为本项目自行绘制的几何图形，采用本项目 Apache-2.0 许可。

Chromium 由 Playwright 安装或复用本机已安装的对应版本，不放入 Multiplane 包。其自身声明随浏览器发行物提供。不同平台的 sharp 原生依赖由 npm 按平台安装，不重打包进 Multiplane；应保留对应包内的许可和声明。上表原生依赖副本对应当前验收的 Windows x64 平台；其第三方库清单和使用许可详见上游声明，源码与构建信息见 [sharp-libvips](https://github.com/lovell/sharp-libvips)。Playwright 的内嵌依赖另在其安装包内 `*.js.LICENSE` 文件中声明。

本包不包含 FFmpeg 二进制，也不依赖 `ffmpeg-static`。使用方通过命令行、环境变量或 PATH 提供 FFmpeg；其具体构建的许可与功能以该发行物为准。
