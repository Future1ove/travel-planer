# 小红书抓取 SOP

小红书是这个 skill 里**主观信息**的主力来源：必去榜单、机位、最佳时段、门票实价、踩雷名单、本地人小店。官方数据源给不了这些。

但它的风控也是全流程里最容易卡住的地方。下面是踩过坑之后总结的可用路径。

---

## 0. 前置：命令与环境

依赖 `opencli`（全局 npm 安装）+ 浏览器扩展（Chrome/Edge）。

**每次调用前必须清代理**，否则连不上本地 daemon：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u CC_HAHA_SYSTEM_PROXY_URL \
    NO_PROXY=127.0.0.1,localhost \
    opencli <子命令>
```

先确认扩展在线：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u CC_HAHA_SYSTEM_PROXY_URL \
    NO_PROXY=127.0.0.1,localhost opencli doctor
```

期望看到 `[OK] Extension: connected`。若未连接，让用户打开浏览器并启用扩展，不要继续。

---

## 1. 搜索（稳定可用）

```bash
opencli xiaohongshu search "铜陵必去" --limit 10
```

返回 YAML 风格列表，含 `title / author / likes / url / published_at`。

**多角度搜**，不要只搜一个词。有效关键词组合：

- `<目的地>旅游攻略`
- `<目的地>必去`
- `<目的地>值得去的地方`
- `<目的地>避雷` / `<目的地>红黑榜`
- `<目的地>美食推荐`
- `<目的地>拍照` / `<目的地>出片`
- `<景点名>拍照`
- `<目的地>两日游` / `三日游`

按 `likes` 排序挑出 10–15 篇高价值笔记再精读。

---

## 2. 笔记详情：接口会挂，走浏览器

`opencli xiaohongshu note <url>` 走的是接口，**大概率返回**：

```
ok: false
error:
  code: SECURITY_BLOCK
  message: 'Xiaohongshu security block: the note detail page was blocked by risk control.'
```

**不要反复重试这个接口**，换风控冷却也没用。改用浏览器点击路径——它走的是正常用户行为。

### 2.1 打开搜索页

```bash
U="https://www.xiaohongshu.com/search_result?keyword=$(python_urlencode 关键词)&source=web_search_result_notes"
opencli browser xhs open "$U"
```

（`keyword` 需要 URL 编码。中文可用 `od` 转百分号编码，或直接传中文让浏览器处理。）

### 2.2 点击笔记卡片

```bash
opencli browser xhs click --text "笔记标题的一段唯一子串"
```

返回 `{"clicked": true, "matches_n": 1}` 表示点中。

⚠️ 标题里有 emoji 或特殊符号时，`--text` 可能匹配失败。用**中间一段纯中文**做子串，不要带 emoji。

点击后 SPA 会导航到详情页。用 `tab list` 确认 URL 变成了 `/explore/<id>`：

```bash
opencli browser xhs tab list
```

### 2.3 读正文

```bash
opencli browser xhs eval "((document.querySelector('#detail-desc')||document.querySelector('.note-content')||{}).innerText||'[未取到]').slice(0,1500)"
```

**关键选择器**：`#detail-desc`（正文）、`.note-content`（含标题的容器）。

⚠️ 不要用 `document.body.innerText`——小红书详情是覆盖层，`body` 里可能仍是搜索结果页的内容，会拿到一屏无关文字。

### 2.4 返回

```bash
opencli browser xhs back
```

然后在同一页继续点下一篇。**一次打开搜索页，可以连续点 3–5 篇**，比每篇重新搜索快得多。

---

## 3. 已知错误与处理

| 现象 | 含义 | 处理 |
|---|---|---|
| `SECURITY_BLOCK` | 接口风控 | 改浏览器点击路径 |
| 页面显示 `访问链接异常 300017` | 用 `/search_result/` 路径直接导航 | 改用 `/explore/<id>?xsec_token=...`，或从搜索页点击进入 |
| 页面显示 `当前笔记暂时无法浏览 300031` | 单篇被限 / 需要 App 扫码 | 换另一篇 |
| `[未取到]` | 正文是图片型笔记 | 该笔记内容在图里，抓不到文字；换一篇，或只取标题信息 |
| 点击 `matches_n: 0` | 标题子串不匹配（emoji/换行） | 改用更短的纯中文片段 |

**图片型笔记很常见**：攻略类笔记常把路线做成截图。遇到就跳过，别硬解析。搜索页标题本身也能提供不少信息（比如「不要住岳阳的桔子酒店」这种标题直接就是结论）。

---

## 4. 抓完之后怎么用

从中提取并分类记录：

- **必去榜单**：按赞数排序，记下每个地方的一句话卖点
- **机位**：具体到「站在哪、朝哪拍、什么时段」
- **时间点**：演出/烟花/打烊的精确时刻（这类信息只有小红书有）
- **门票**：优先记多篇交叉印证的价；有冲突就并列
- **踩雷**：全量保留，不要因为多数笔记在夸就过滤掉
- **本地人推荐**：小店名、人均、招牌菜

**必须记录来源**（标题 + 赞数），写进 Word 的「数据来源」章节。

---

## 5. 频率与礼貌

- 不要短时间内狂点几十篇，会触发风控
- 每篇之间 `sleep 3–5` 秒
- 一次会话控制在 15–20 篇以内
- 抓到足够信息就停，不要为了「全」而刷

---

## 6. 如果浏览器路径也走不通

降级顺序：

1. 只用搜索结果的**标题**（标题往往已包含结论）
2. 换关键词再搜，从标题里拼信息
3. 明确告诉用户「小红书正文被风控拦截，只拿到了标题」，**不要编造正文内容**
