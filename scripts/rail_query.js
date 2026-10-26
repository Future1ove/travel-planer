#!/usr/bin/env node
/**
 * rail_query.js —— 12306 余票/票价查询（只读）
 *
 * 用法：
 *   node rail_query.js --from 武汉 --to 铜陵 --date 2026-10-24
 *   node rail_query.js --from 武汉 --to 南昌 --date 2026-10-23 --after 22:00 --before 03:00 --max-hours 8 --price
 *   node rail_query.js --from 武汉 --to 长沙 --date 2026-10-24 --json out.json
 *   node rail_query.js --list 铜陵            # 查车站电报码
 *
 * 参数：
 *   --from <城市/车站>   必填
 *   --to <城市/车站>     必填
 *   --date <YYYY-MM-DD>  必填
 *   --after <HH:MM>      发车时间下限（默认 00:00）
 *   --before <HH:MM>     发车时间上限（默认 23:59）
 *                        若 before < after，视为跨夜窗口，会同时查 date 与 date+1
 *   --max-hours <n>      历时上限（小时，默认 99）
 *   --price              额外查询精确票价（较慢，每趟一次请求）
 *   --json <path>        同时输出 JSON
 *   --list <关键词>      只打印匹配的车站码后退出
 *   --all-seats          输出所有座位类型（默认只输出有票的）
 *
 * 重要说明（这些是本脚本存在的理由）：
 *  1. 余票接口 query 会被重定向到 queryG，用 queryG。
 *  2. 必须先请求 /otn/leftTicket/init 拿 Cookie。
 *  3. 必须剔除 canBuy=IS_TIME_NOT_BUY 的假记录（表现为发时 24:00 / 历时 99:59）。
 *  4. 12306 查询按【城市】聚合：查 WHN→NCG 会返回武汉/汉口/武昌/武汉东 与 南昌/南昌西。
 *  5. 票价接口 queryTicketPrice 需要 train_no + 上下车站序号 + seat_types。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = "https://kyfw.12306.cn";
const STATION_URL = `${BASE}/otn/resources/js/framework/station_name.js`;
const CACHE = path.join(os.tmpdir(), "travel-planner-station_name.js");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ── 参数 ─────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    from: null, to: null, date: null, after: "00:00", before: "23:59",
    maxHours: 99, price: false, json: null, list: null, allSeats: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--from": a.from = v; i++; break;
      case "--to": a.to = v; i++; break;
      case "--date": a.date = v; i++; break;
      case "--after": a.after = v; i++; break;
      case "--before": a.before = v; i++; break;
      case "--max-hours": a.maxHours = Number(v); i++; break;
      case "--price": a.price = true; break;
      case "--json": a.json = v; i++; break;
      case "--list": a.list = v; i++; break;
      case "--all-seats": a.allSeats = true; break;
      case "-h": case "--help": printHelp(); process.exit(0);
      default:
        if (k.startsWith("--")) { console.error(`未知参数: ${k}`); process.exit(1); }
    }
  }
  return a;
}
function printHelp() {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
}

// ── 车站码表 ─────────────────────────────────────────
async function loadStations(force = false) {
  let raw;
  if (!force && fs.existsSync(CACHE)) {
    raw = fs.readFileSync(CACHE, "utf8");
  } else {
    const res = await fetch(STATION_URL, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`下载车站码表失败: HTTP ${res.status}`);
    raw = await res.text();
    fs.writeFileSync(CACHE, raw, "utf8");
  }
  const list = [];
  // 格式: @bjb|北京北|VAP|beijingbei|bjb|0
  for (const m of raw.matchAll(/@[a-z]+\|([^|]+)\|([A-Z]+)\|([^|]*)\|([^|]*)\|/g)) {
    list.push({ name: m[1], code: m[2], pinyin: m[3], abbr: m[4] });
  }
  return list;
}

function matchStations(list, q) {
  const exact = list.filter((s) => s.name === q);
  if (exact.length) return exact;
  // 城市级兜底：武汉东/武汉 都归到「武汉」，让接口按城市聚合
  const fuzzy = list.filter((s) => s.name.includes(q) || q.includes(s.name));
  return fuzzy;
}

// ── 12306 ────────────────────────────────────────────
async function getCookie() {
  const res = await fetch(`${BASE}/otn/leftTicket/init`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

/**
 * 查询余票。
 * 12306 在请求过密时会返回一个 1903 字节的 HTML 兜底页
 * （标题「铁路客户服务中心」，正文「网络可能存在问题，请您重试一下！」），
 * 而不是 JSON。这不是接口改版，是软限流，退避重试通常能恢复。
 */
async function queryLeft(date, fromCode, toCode, cookieGetter, retries = 3) {
  const url =
    `${BASE}/otn/leftTicket/queryG?leftTicketDTO.train_date=${date}` +
    `&leftTicketDTO.from_station=${fromCode}&leftTicketDTO.to_station=${toCode}` +
    `&purpose_codes=ADULT`;
  const backoff = [2500, 6000, 12000, 20000];
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 每次重试都重新拿 Cookie，限流时旧 Cookie 往往一起失效
      const cookie = await cookieGetter(attempt > 0);
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Cookie: cookie,
          Referer: `${BASE}/otn/leftTicket/init`,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const text = await res.text();

      if (!text.trim()) throw new Error("空响应（疑似限流）");
      if (text.trim().startsWith("<")) {
        const title = (/<title>([^<]*)<\/title>/.exec(text) || [])[1] || "未知页面";
        const body = text
          .replace(/<script[\s\S]*?<\/script>/g, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        throw new Error(
          `12306 返回 HTML 而非 JSON（${title}）：${body.slice(0, 60)} —— 通常是请求过密被软限流`
        );
      }

      const json = JSON.parse(text);
      if (!json.data || !json.data.result) {
        const hint = json.c_url ? `（接口提示应使用 ${json.c_url}）` : "";
        throw new Error(`无 result 字段${hint}: ${JSON.stringify(json).slice(0, 160)}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const wait = backoff[attempt] ?? 20000;
      console.warn(`   第 ${attempt + 1} 次失败，${wait / 1000}s 后重试…`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function queryPrice(trainNo, fromNo, toNo, seatTypes, date, cookie) {
  const url =
    `${BASE}/otn/leftTicket/queryTicketPrice?train_no=${trainNo}` +
    `&from_station_no=${fromNo}&to_station_no=${toNo}` +
    `&seat_types=${seatTypes}&train_date=${date}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA, Cookie: cookie,
        Referer: `${BASE}/otn/leftTicket/init`,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const json = JSON.parse(await res.text());
    return json.data || {};
  } catch {
    return {};
  }
}

// ── 工具 ─────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isFalseRecord = (f) => {
  const dep = f[8] || "", dur = f[10] || "";
  // 时刻未定：24:00 发车 / 99:59 历时
  return dep.startsWith("24") || dur.startsWith("99") || f[11] === "IS_TIME_NOT_BUY";
};
const durHours = (dur) => {
  const m = /^(\d+):(\d+)$/.exec(dur || "");
  return m ? Number(m[1]) + Number(m[2]) / 60 : NaN;
};
const hasTicket = (f) =>
  [f[30], f[31], f[32], f[29], f[28], f[23], f[26]].some(
    (v) => v && v !== "无" && v !== "*"
  );
const seatText = (f) => {
  const parts = [];
  if (f[30]) parts.push(`二等${f[30]}`);
  if (f[31]) parts.push(`一等${f[31]}`);
  if (f[32]) parts.push(`商务${f[32]}`);
  if (f[29]) parts.push(`硬座${f[29]}`);
  if (f[28]) parts.push(`硬卧${f[28]}`);
  if (f[23]) parts.push(`软卧${f[23]}`);
  return parts.join(" / ") || "—";
};

// ── 主流程 ───────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  console.log("正在加载车站码表…");
  let stations;
  try {
    stations = await loadStations();
  } catch (e) {
    console.error("❌", e.message);
    process.exit(1);
  }

  if (args.list) {
    const hits = matchStations(stations, args.list);
    if (!hits.length) { console.log(`未找到「${args.list}」`); return; }
    hits.forEach((s) => console.log(`${s.name}\t${s.code}\t${s.pinyin}`));
    return;
  }

  if (!args.from || !args.to || !args.date) {
    console.error("❌ 需要 --from --to --date");
    printHelp();
    process.exit(1);
  }

  const fromHits = matchStations(stations, args.from);
  const toHits = matchStations(stations, args.to);
  if (!fromHits.length) { console.error(`❌ 找不到出发站「${args.from}」，试 --list ${args.from}`); process.exit(1); }
  if (!toHits.length) { console.error(`❌ 找不到到达站「${args.to}」，试 --list ${args.to}`); process.exit(1); }
  // 城市聚合：取第一个精确匹配即可
  const fromCode = fromHits[0].code;
  const toCode = toHits[0].code;

  console.log(`出发：${fromHits[0].name}(${fromCode})  到达：${toHits[0].name}(${toCode})`);

  // 跨夜窗口
  const crossNight = args.before < args.after;
  const dates = crossNight ? [args.date, addDays(args.date, 1)] : [args.date];

  // Cookie 惰性获取 + 可强制刷新（限流时旧 Cookie 往往一起失效）
  let _cookie = null;
  const cookieGetter = async (refresh) => {
    if (!_cookie || refresh) _cookie = await getCookie();
    if (!_cookie) console.warn("⚠️ 未拿到 Cookie，接口可能拒绝请求");
    return _cookie || "";
  };

  const rows = [];
  const noTicket = [];

  for (const date of dates) {
    const lo = date === args.date ? args.after : "00:00";
    const hi = date === args.date ? (crossNight ? "23:59" : args.before) : args.before;
    if (crossNight && date !== args.date && args.before === "00:00") continue;

    let json;
    try {
      json = await queryLeft(date, fromCode, toCode, cookieGetter);
    } catch (e) {
      console.error(`❌ ${date} 查询失败：${e.message}`);
      console.error("   若是限流：等 3–5 分钟再试，或改用 12306 MCP / 官方 App 查。不要反复硬刷。");
      continue;
    }

    const map = json.data.map || {};
    for (const s of json.data.result) {
      const f = s.split("|");
      const no = f[3], dep = f[8];
      if (!no || !dep) continue;
      if (isFalseRecord(f)) continue;              // ← 关键：剔除假记录
      if (dep < lo || dep > hi) continue;

      const h = durHours(f[10]);
      if (!Number.isFinite(h) || h > args.maxHours) continue;

      const rec = {
        date, train: no,
        from: map[f[6]] || f[6], to: map[f[7]] || f[7],
        dep, arr: f[9], dur: f[10], hours: +h.toFixed(2),
        seats: seatText(f),
        _trainNo: f[2], _fromNo: f[16], _toNo: f[17], _seatTypes: f[35],
      };
      (args.allSeats || hasTicket(f) ? rows : noTicket).push(rec);
    }
  }

  rows.sort((a, b) => (a.date + a.dep < b.date + b.dep ? -1 : 1));

  // 精确票价
  if (args.price && rows.length) {
    console.log(`正在查询 ${rows.length} 趟的票价…`);
    for (const r of rows) {
      const p = await queryPrice(r._trainNo, r._fromNo, r._toNo, r._seatTypes, r.date, cookie);
      const parts = [];
      if (p.O) parts.push(`二等¥${p.O}`);
      if (p.M) parts.push(`一等¥${p.M}`);
      if (p.A9) parts.push(`商务¥${p.A9}`);
      if (p.A1) parts.push(`硬座¥${p.A1}`);
      if (p.A3) parts.push(`硬卧¥${p.A3}`);
      if (p.A4) parts.push(`软卧¥${p.A4}`);
      r.price = parts.join(" / ") || "—";
      await sleep(350);
    }
  }

  // 输出
  console.log(`\n### 查询结果（${args.date}，发车 ${args.after}–${args.before}，历时 ≤ ${args.maxHours}h）\n`);
  if (!rows.length) {
    console.log("没有符合条件的车次。");
  } else {
    const head = args.price
      ? "| 发车日 | 车次 | 出发站 | 出发 | 到达站 | 到达 | 历时 | 座位 | 票价 |"
      : "| 发车日 | 车次 | 出发站 | 出发 | 到达站 | 到达 | 历时 | 座位 |";
    const sep = args.price ? "|---|---|---|---|---|---|---|---|---|" : "|---|---|---|---|---|---|---|---|";
    console.log(head);
    console.log(sep);
    for (const r of rows) {
      const cells = [
        r.date.slice(5), r.train, r.from, r.dep, r.to, r.arr, r.dur, r.seats,
      ];
      if (args.price) cells.push(r.price);
      console.log(`| ${cells.join(" | ")} |`);
    }
  }

  if (noTicket.length) {
    console.log(`\n### 符合时段但无票（${noTicket.length} 趟）\n`);
    noTicket.forEach((r) =>
      console.log(`- ${r.date.slice(5)} ${r.train} ${r.from} ${r.dep} → ${r.to} ${r.arr} (${r.dur})`)
    );
  }

  if (args.json) {
    const clean = rows.map(({ _trainNo, _fromNo, _toNo, _seatTypes, ...rest }) => rest);
    fs.writeFileSync(args.json, JSON.stringify({ rows: clean, noTicket }, null, 2), "utf8");
    console.log(`\nJSON 已写入：${args.json}`);
  }

  console.log("\n⚠️ 数据来自 12306 官方接口，可能随铁路调图变化；购票前请以 12306 实时为准。");
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
