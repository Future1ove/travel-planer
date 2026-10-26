#!/usr/bin/env node
/**
 * docx_gen.js —— 由 JSON 规格生成旅行攻略 Word
 *
 * 用法：
 *   node docx_gen.js --spec plan.json
 *   node docx_gen.js --spec plan.json --out "C:\\Users\\me\\Desktop\\攻略.docx"
 *   node docx_gen.js --example            # 打印一份最小示例 spec
 *
 * 依赖：
 *   需要 npm 包 docx。若未安装，在任意目录 npm i docx 后于该目录运行，
 *   或把 docx 装到 skill 根目录（本脚本会自动尝试 <skill>/node_modules）。
 *
 * spec 结构：
 * {
 *   "title":    "铜陵旅游计划",
 *   "subtitle": "武汉 → 安徽铜陵 · 3 天 2 晚 · 2026.10.24（六）— 10.26（一）",
 *   "tagline":  "住宿固定：汉庭…（可选，红色）",
 *   "footer":   "数据来源：…",              // 可选，打印在文末
 *   "output":   "C:\\\\path\\\\out.docx",    // 可被 --out 覆盖
 *   "sections": [ ... ]
 * }
 *
 * sections 支持的 type：
 *   { "type":"h1",   "text":"一、行程速览" }
 *   { "type":"h2",   "text":"…" }
 *   { "type":"p",    "text":"…", "color":"666666", "size":19, "bold":false }
 *   { "type":"pb",   "label":"⚠️ 注意：", "text":"…", "color":"C00000" }
 *   { "type":"dayHeader", "day":"DAY 1", "text":"10/24 周六｜…", "color":"1F4E79" }
 *   { "type":"table", "headers":["时间","通勤","安排"], "rows":[["…","…","…"]],
 *     "style":"normal|hot|warn", "widths":[1000,1600,6426] }
 *   { "type":"bullets",  "items":["…","…"] }
 *   { "type":"numbered", "items":["…","…"] }
 *   { "type":"pagebreak" }
 *
 * 表格单元格内可用 **粗体** 语法。
 * 遇到目标文件被 Word 占用（EBUSY），自动改写到 <原名>_最终版.docx。
 */

const fs = require("fs");
const path = require("path");

// ── 依赖解析 ─────────────────────────────────────────
let docx;
const tryPaths = [
  "docx",
  path.join(__dirname, "..", "node_modules", "docx"),
  path.join(process.cwd(), "node_modules", "docx"),
];
for (const p of tryPaths) {
  try { docx = require(p); break; } catch {}
}
if (!docx) {
  console.error(
    "❌ 缺少 docx 依赖。\n" +
      "   请先安装：npm i docx\n" +
      "   安装到当前目录或 skill 根目录（<skill>/node_modules）均可。"
  );
  process.exit(1);
}

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber, Footer, PageBreak,
} = docx;

const FONT = "微软雅黑";
const CW = 9026; // A4 内容宽度（11906 - 2×1440）

// ── 参数 ─────────────────────────────────────────────
function parseArgs(argv) {
  const a = { spec: null, out: null, example: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--spec") { a.spec = v; i++; }
    else if (k === "--out") { a.out = v; i++; }
    else if (k === "--example") a.example = true;
    else if (k === "-h" || k === "--help") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
      process.exit(0);
    }
  }
  return a;
}

// ── 文本工具 ─────────────────────────────────────────
/** 把 "**粗体**" 拆成 TextRun 数组 */
function runs(text, base = {}) {
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    out.push(new TextRun({ text: m[1], bold: true, ...base }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out.length ? out : [new TextRun({ text: "", ...base })];
}

function P(text, o = {}) {
  return new Paragraph({
    spacing: { before: o.before ?? 50, after: o.after ?? 50, line: 290 },
    alignment: o.align,
    children: runs(text, {
      size: o.size ?? 20, font: FONT,
      ...(o.color ? { color: o.color } : {}),
      ...(o.bold ? { bold: true } : {}),
    }),
  });
}

function H1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 280, after: 140 },
    children: [new TextRun({ text, bold: true, size: 26, font: FONT, color: "1F4E79" })],
  });
}
function H2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 180, after: 90 },
    children: [new TextRun({ text, bold: true, size: 21, font: FONT, color: "2E75B6" })],
  });
}

function cell(text, width, o = {}) {
  return new TableCell({
    borders: BORDERS,
    width: { size: width, type: WidthType.DXA },
    margins: { top: 55, bottom: 55, left: 100, right: 100 },
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { before: 15, after: 15 },
        children: runs(String(text), {
          size: 18, font: FONT,
          ...(o.color ? { color: o.color } : {}),
          ...(o.bold ? { bold: true } : {}),
        }),
      }),
    ],
  });
}

const bd = { style: BorderStyle.SINGLE, size: 1, color: "D0D0D0" };
const BORDERS = { top: bd, bottom: bd, left: bd, right: bd };

const TABLE_STYLES = {
  normal: { headerFill: "D5E8F0", headerColor: undefined, bodyColor: undefined },
  hot:    { headerFill: "FFE699", headerColor: "7F6000", bodyColor: "7F6000" },
  warn:   { headerFill: "FBE4E4", headerColor: "9C0006", bodyColor: "9C0006" },
};

function buildTable(spec) {
  const headers = spec.headers || [];
  const rows = spec.rows || [];
  const n = headers.length || (rows[0] ? rows[0].length : 1);
  let widths = spec.widths;
  if (!widths || widths.length !== n) {
    const each = Math.floor(CW / n);
    widths = Array(n).fill(each);
    widths[n - 1] = CW - each * (n - 1);
  }
  const st = TABLE_STYLES[spec.style] || TABLE_STYLES.normal;

  const tableRows = [];
  if (headers.length) {
    tableRows.push(new TableRow({
      tableHeader: true,
      children: headers.map((h, j) =>
        cell(h, widths[j], { fill: st.headerFill, bold: true, color: st.headerColor })
      ),
    }));
  }
  for (const r of rows) {
    tableRows.push(new TableRow({
      children: r.map((c, j) => cell(c ?? "", widths[j], { color: st.bodyColor })),
    }));
  }
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: widths, rows: tableRows });
}

function buildDayHeader(spec) {
  const text = (spec.day ? spec.day + "　" : "") + (spec.text || spec.title || "");
  return new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: [CW],
    rows: [new TableRow({
      children: [cell(text, CW, { fill: spec.color || "1F4E79", bold: true, color: "FFFFFF" })],
    })],
  });
}

function buildNumbering() {
  return {
    config: [{
      reference: "num",
      levels: [{
        level: 0, format: LevelFormat.DECIMAL, text: "%1.",
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 420, hanging: 240 } } },
      }],
    }],
  };
}

// ── 主流程 ───────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.example) {
    console.log(JSON.stringify({
      title: "示例攻略",
      subtitle: "示例副标题",
      output: "C:\\Users\\me\\Desktop\\示例.docx",
      sections: [
        { type: "h1", text: "一、行程速览" },
        { type: "p", text: "这里是一段说明，支持 **粗体**。" },
        { type: "dayHeader", day: "DAY 1", text: "10/24 周六｜主线", color: "1F4E79" },
        { type: "table", headers: ["时间", "通勤", "安排"], rows: [["08:27", "—", "**出发**"]], widths: [1000, 1600, 6426] },
        { type: "table", style: "hot", headers: ["时间", "事件"], rows: [["19:25", "打铁花"]] },
        { type: "table", style: "warn", headers: ["坑", "规避"], rows: [["白天去", "必须傍晚入园"]] },
        { type: "bullets", items: ["第一条", "第二条"] },
        { type: "numbered", items: ["第一步", "第二步"] },
        { type: "pagebreak" },
      ],
    }, null, 2));
    return;
  }

  if (!args.spec) {
    console.error("❌ 需要 --spec <path>（或先用 --example 看结构）");
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(args.spec, "utf8"));
  const outPath = args.out || spec.output;
  if (!outPath) {
    console.error("❌ spec 里没有 output，也没传 --out");
    process.exit(1);
  }

  const children = [];

  // 封面
  if (spec.title) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 40 },
      children: [new TextRun({ text: spec.title, bold: true, size: 40, font: FONT, color: "1F4E79" })],
    }));
  }
  if (spec.subtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: spec.tagline ? 30 : 200 },
      children: [new TextRun({ text: spec.subtitle, size: 19, font: FONT, color: "666666" })],
    }));
  }
  if (spec.tagline) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({ text: spec.tagline, size: 18, font: FONT, color: "C00000" })],
    }));
  }

  // 正文
  for (const s of spec.sections || []) {
    switch (s.type) {
      case "h1": children.push(H1(s.text)); break;
      case "h2": children.push(H2(s.text)); break;
      case "p":
        children.push(P(s.text, { color: s.color, size: s.size, bold: s.bold }));
        break;
      case "pb":
        children.push(new Paragraph({
          spacing: { before: 50, after: 50, line: 290 },
          children: [
            new TextRun({ text: s.label || "", bold: true, size: 20, font: FONT, color: s.color || "C00000" }),
            ...runs(s.text || "", { size: 20, font: FONT }),
          ],
        }));
        break;
      case "dayHeader": children.push(buildDayHeader(s)); break;
      case "table": children.push(buildTable(s)); break;
      case "bullets":
        for (const it of s.items || []) {
          children.push(new Paragraph({
            numbering: { reference: "bullets", level: 0 },
            spacing: { before: 30, after: 30 },
            children: runs(it, { size: 20, font: FONT }),
          }));
        }
        break;
      case "numbered":
        for (const it of s.items || []) {
          children.push(new Paragraph({
            numbering: { reference: "num", level: 0 },
            spacing: { before: 30, after: 30 },
            children: runs(it, { size: 20, font: FONT }),
          }));
        }
        break;
      case "pagebreak": children.push(new Paragraph({ children: [new PageBreak()] })); break;
      default:
        console.warn(`⚠️ 未知 section type: ${s.type}（已跳过）`);
    }
  }

  if (spec.footer) {
    children.push(new Paragraph({
      spacing: { before: 200 },
      children: [new TextRun({ text: spec.footer, size: 15, font: FONT, color: "999999" })],
    }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    numbering: {
      config: [
        ...buildNumbering().config,
        {
          reference: "bullets",
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 420, hanging: 240 } } },
          }],
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1000, right: 1150, bottom: 1000, left: 1150 },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: "第 ", size: 16, font: FONT }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, font: FONT }),
              new TextRun({ text: " 页", size: 16, font: FONT }),
            ],
          })],
        }),
      },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);

  // EBUSY 兜底：文件被 Word 占用时改名
  const dir = path.dirname(outPath);
  const base = path.basename(outPath, path.extname(outPath));
  const ext = path.extname(outPath) || ".docx";
  const candidates = [
    outPath,
    path.join(dir, `${base}_最终版${ext}`),
    path.join(dir, `${base}_${Date.now()}${ext}`),
  ];

  for (const target of candidates) {
    try {
      fs.writeFileSync(target, buf);
      console.log(`✅ 已生成：${target}（${(buf.length / 1024).toFixed(1)} KB）`);
      if (target !== outPath) {
        console.log(`   ⚠️ 原文件被占用（可能正在 Word 中打开），已改用上面的文件名。`);
      }
      return;
    } catch (e) {
      if (e.code === "EBUSY" || e.code === "EPERM") continue;
      throw e;
    }
  }
  console.error("❌ 所有候选文件名都写入失败，请关闭 Word 后重试。");
  process.exit(1);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
