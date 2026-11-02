# travel-planner

一个 Claude Code Skill：把「随口一句想出去玩」变成一份可直接照着走的旅行攻略 Word。

默认**出片优先**——追光影、找机位、给穿搭建议；除非你明说不拍照。

---

## 它能做什么

- 核实日期与车票（12306 官方接口）
- 抓取小红书的攻略、机位、美食、避雷（绕开风控的浏览器路径）
- 用高德 API 算真实通勤时间、查 POI
- 用 Open-Meteo 查 16 天天气预报（含降水概率，免 Key）
- 把冲突的约束理清，排成可执行的逐日行程
- 生成固定 13 章的 Word 计划表

它不负责替你拍板，负责把信息摆到你能拍板的位置，并且**标清楚哪些是查证的、哪些是没查到的**。

---

## 安装

```bash
git clone https://github.com/Future1ove/travel-planer.git \
  ~/.claude/skills/travel-planner
```

目录名必须是 `travel-planner`（skill 名），仓库名是 `travel-planer`，注意区分。

---

## 一键安装（推荐）

克隆后进目录跑一条命令：

```bash
cd ~/.claude/skills/travel-planner
node setup.js
```

它会自动完成：

- 检查 Node / npm / git / Python
- **缺 `docx` 就直接 `npm i docx`**
- 验证高德 Key（缺了会告诉你去哪申请、怎么配）
- 检查 opencli 和小红书依赖
- 打印「哪些功能可用、还缺什么」

常用参数：

```bash
node setup.js --no-install   # 只检查，不安装任何东西
node setup.js --full         # 额外跑联网自测（12306 / 天气）
node setup.js --json         # 机器可读输出
```

---

## 配置

### 高德 Web 服务 Key（必需）

优先级：环境变量 > 本地 config.json

```bash
# 方式一
export AMAP_WEBSERVICE_KEY="你的key"     # Windows: setx AMAP_WEBSERVICE_KEY "..."

# 方式二
cp config.example.json config.json
# 编辑 config.json 填入 webServiceKey
```

Key 申请：https://lbs.amap.com

### docx 依赖

生成 Word 需要 npm 包 `docx`：

```bash
npm i docx
```

装在当前目录或 skill 根目录均可（脚本会自动尝试两处）。

### 小红书抓取

依赖 `opencli` + 浏览器扩展（Chrome/Edge）。详见
[references/xiaohongshu-sop.md](references/xiaohongshu-sop.md)。

---

## 触发方式

明确说这些话才会触发：

```
帮我做个攻略
旅游计划
行程规划
周末去哪玩
帮我查车票和攻略
规划一下
```

触发后会先回一行：

```
🚩 gogogo —— travel-planner 已触发
已识别：出发地=X ｜ 目的地=X ｜ 日期=X ｜ 人数=X ｜ 出片=优先/否
```

如果识别错了（尤其日期），当场纠正。

---

## 目录结构

```
.
├── SKILL.md                    主文件：工作流与硬规则
├── setup.js                    一键安装 / 环境自检
├── package.json                依赖声明（docx）
├── config.example.json         高德 Key 模板
├── scripts/
│   ├── rail_query.js           12306 查票
│   ├── weather_query.js        16 天天气预报（Open-Meteo）
│   └── docx_gen.js             Word 生成
└── references/
    ├── xiaohongshu-sop.md      小红书抓取 SOP
    ├── amap-sop.md             高德接口用法
    └── template-sections.md    13 章模板说明
```

---

## 直接使用脚本

### 查票

```bash
node scripts/rail_query.js \
  --from 武汉 --to 岳阳 --date 2026-10-23 \
  --after 22:00 --before 03:00 --max-hours 8 --price
```

- `--after` 晚于 `--before` 时自动按跨夜窗口查两天
- 自动剔除 12306 的「时刻未定」假记录（24:00 发车 / 99:59 历时）
- 被限流时会自动退避重试，并提示等几分钟

### 查天气

```bash
node scripts/weather_query.js --city 铜陵
node scripts/weather_query.js --city 铜陵 --from 2026-11-01 --to 2026-11-03
node scripts/weather_query.js --search 铜陵        # 看地理编码候选
```

基于 Open-Meteo，**免 Key、最长 16 天、带降水概率**。自带中文地理编码消歧（「铜陵」会选中安徽那个）和 WMO 天气码翻译。超出 16 天会明确说查不到。

### 生成 Word

```bash
node scripts/docx_gen.js --example          # 看 spec 结构
node scripts/docx_gen.js --spec plan.json   # 生成
```

文件被 Word 占用时会自动改写到 `_最终版.docx`。

---

## 已知限制

- **12306 会软限流**：查得太密会返回 HTML 兜底页，需等 3–5 分钟
- **小红书笔记详情常有风控**：走浏览器点击路径，图片型笔记抓不到正文
- **天气**：Open-Meteo 给 16 天，但它是境外服务，连不上时退回高德（约 4 天）；超出范围会明确写「查不到」，不编造
- 门票价格可能随季节调整，以景区官方为准

---

## 更新

改 `SKILL.md` 或脚本后直接 commit + push。skill 会被立刻重新加载，不需要重启。
