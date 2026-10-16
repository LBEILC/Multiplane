# 软件内更新说明

每个版本一份 `<版本>.json`（例如 `0.3.8.json`），发版时作为 GitHub Release 的附件 `release-notes.json` 上传。桌面软件在关于页按界面语言显示它：重点条目用卡片，其余按“新增 / 改进 / 修复”分组。GitHub 发布页的正文（英文长版，含安装包、校验值、验证情况）不变，软件不再显示那份正文。

由设计负责人在发版时撰写，写给使用软件的人：只写他们能感觉到的变化，不写内部重构、测试、CI。

## 格式

```json
{
  "schema": "multiplane-release-notes/1",
  "version": "0.3.8",
  "date": "2026-10-20",
  "items": [
    {
      "kind": "new",
      "area": "app",
      "highlight": true,
      "icon": "film",
      "title": { "zh-CN": "逐帧查看成片", "en": "Frame-by-frame review" },
      "detail": { "zh-CN": "完成的视频在软件里逐帧前后走，切点标在进度条上。", "en": "Step through finished videos one frame at a time, with cuts marked on the timeline." }
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `kind` | `new`（新增）/ `improved`（改进）/ `fixed`（修复）。 |
| `area` | `renderer`（渲染器）/ `app`（软件）/ `skill`。 |
| `highlight` | 可选。最多两条，显示为卡片。 |
| `icon` | 可选，只对 `highlight` 生效。只能取软件内置的一组名字（`restart`、`film`、`shield`、`speed`、`sparkle`、`layers`、`palette`、`terminal`，分别对应 Remix Icon 的 `restart-line`、`film-line`、`shield-check-line`、`speed-up-line`、`sparkling-2-line`、`stack-line`、`palette-line`、`terminal-box-line`），其余忽略，用 `kind` 的默认图标。 |
| `title` | 必填，两种语言。纯文本，不支持任何标记；中文 16 字以内、英文 40 字符以内为宜。 |
| `detail` | 必填，两种语言。纯文本，一句话。 |

条目按想让读者看到的顺序写；软件按 `kind` 分组时保持组内顺序。
