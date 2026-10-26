#!/usr/bin/env node
/**
 * weather_query.js —— 16 天天气预报（免 Key）
 *
 * 数据源：Open-Meteo（境外服务，免费无需 Key，最长 16 天）
 *        https://open-meteo.com
 *
 * 为什么用它而不是只靠高德：
 *   高德只给约 4 天预报，而旅行通常安排在一两周后。Open-Meteo 给 16 天，
 *   并且带「降水概率」——这比单纯的气温更能决定行程怎么排。
 *
 * 用法：
 *   node weather_query.js --city 铜陵
 *   node weather_query.js --city 铜陵 --region 安徽
 *   node weather_query.js --city 铜陵 --from 2026-11-01 --to 2026-11-03
 *   node weather_query.js --lat 30.94 --lon 117.87 --days 7
 *   node weather_query.js --city 铜陵 --json out.json
 *   node weather_query.js --search 铜陵          # 只看地理编码结果
 *
 * 参数：
 *   --city <中文名>     城市名（会自动地理编码）
 *   --region <省/州>    消歧用，如「安徽」
 *   --lat --lon         直接给坐标（跳过地理编码）
 *   --from --to <日期>  只看这段区间（YYYY-MM-DD）
 *   --days <n>          最多显示几天（默认 16）
 *   --json <path>       输出 JSON
 *   --search <名称>     只打印地理编码候选
 *
 * 已知坑：
 *   1. 地理编码有歧义（「铜陵」既在安徽也在福建），必须按 admin1 消歧。
 *   2. Open-Meteo 返回 WMO 数字码，本脚本已映射成中文。
 *   3. 超过 16 天查不到——会明确告知，不要编造。
 *   4. 境外服务，若连不上就退回高德（约 4 天）。
 */

// WMO 天气码 → 中文
const WMO = {
  0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇",
  51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
  56: "冻毛毛雨", 57: "强冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨", 67: "强冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
  80: "小阵雨", 81: "阵雨", 82: "强阵雨",
  85: "小阵雪", 86: "强阵雪",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
};

// ── 参数 ─────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    city: null, region: null, lat: null, lon: null,
    from: null, to: null, days: 16, json: null, search: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case "--city": a.city = v; i++; break;
      case "--region": a.region = v; i++; break;
      case "--lat": a.lat = Number(v); i++; break;
      case "--lon": a.lon = Number(v); i++; break;
      case "--from": a.from = v; i++; break;
      case "--to": a.to = v; i++; break;
      case "--days": a.days = Number(v); i++; break;
      case "--json": a.json = v; i++; break;
      case "--search": a.search = v; i++; break;
      case "-h": case "--help":
        console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
        process.exit(0);
      default:
        if (k.startsWith("--")) { console.error(`未知参数: ${k}`); process.exit(1); }
    }
  }
  return a;
}

// ── 工具 ─────────────────────────────────────────────
const UA = "travel-planner/1.0 (+https://github.com/Future1ove/travel-planer)";

async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(name, region) {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}` +
    `&count=10&language=zh&format=json`;
  const j = await getJSON(url);
  const list = j.results || [];
  if (!list.length) throw new Error(`找不到「${name}」的坐标`);

  if (region) {
    const hit = list.find(
      (r) => (r.admin1 || "").includes(region) || (r.admin2 || "").includes(region)
    );
    if (hit) return { ...hit, _all: list };
  }
  // 优先中国境内人口最多的匹配
  const cn = list.filter((r) => r.country_code === "CN");
  if (cn.length) {
    cn.sort((a, b) => (b.population || 0) - (a.population || 0));
    return { ...cn[0], _all: list };
  }
  return { ...list[0], _all: list };
}

// ── 主流程 ───────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.search) {
    const g = await geocode(args.search, args.region);
    console.log(`「${args.search}」的候选：`);
    for (const r of g._all) {
      console.log(
        `  ${r.name}  ${r.latitude},${r.longitude}  ` +
        `${r.country || ""}${r.admin1 ? " " + r.admin1 : ""}${r.admin2 ? " " + r.admin2 : ""}  ` +
        `人口 ${r.population ?? "-"}`
      );
    }
    return;
  }

  let lat = args.lat, lon = args.lon, label = "";

  if (lat == null || lon == null) {
    if (!args.city) {
      console.error("❌ 需要 --city 或 --lat/--lon");
      process.exit(1);
    }
    const g = await geocode(args.city, args.region);
    lat = g.latitude;
    lon = g.longitude;
    label = `${g.name}${g.admin1 ? "（" + g.admin1 + "）" : ""}`;
  } else {
    label = `${lat},${lon}`;
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weathercode` +
    `&forecast_days=16&timezone=Asia%2FShanghai`;

  let j;
  try {
    j = await getJSON(url);
  } catch (e) {
    console.error(`❌ Open-Meteo 请求失败：${e.message}`);
    console.error("   境外服务可能不稳定。可退回高德天气（约 4 天预报）：");
    console.error("   https://restapi.amap.com/v3/weather/weatherInfo?city=<adcode>&key=<KEY>&extensions=all");
    process.exit(1);
  }

  const d = j.daily;
  const rows = [];
  for (let i = 0; i < d.time.length; i++) {
    const date = d.time[i];
    if (args.from && date < args.from) continue;
    if (args.to && date > args.to) continue;
    if (rows.length >= args.days) break;
    rows.push({
      date,
      weather: WMO[d.weathercode[i]] ?? `code ${d.weathercode[i]}`,
      min: d.temperature_2m_min[i],
      max: d.temperature_2m_max[i],
      precipProb: d.precipitation_probability_max[i],
      precip: d.precipitation_sum[i],
    });
  }

  if (!rows.length) {
    console.log(
      `⚠️ 所请求日期不在预报范围内。Open-Meteo 只提供 ${d.time[0]} 至 ${d.time[d.time.length - 1]} 的预报（最多 16 天）。`
    );
    console.log("   超出范围请明确告知用户「查不到」，不要编造数字。");
    return;
  }

  console.log(`### ${label}  天气预报`);
  console.log(`数据源：Open-Meteo（境外服务，最长 16 天；预报越远越不可靠）`);
  if (args.from || args.to) console.log(`筛选区间：${args.from || rows[0].date} ~ ${args.to || rows[rows.length - 1].date}`);
  console.log("");
  console.log("| 日期 | 天气 | 最低 | 最高 | 降水概率 | 降水量 |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.date} | ${r.weather} | ${r.min}℃ | ${r.max}℃ | ${r.precipProb ?? "-"}% | ${r.precip ?? "-"}mm |`
    );
  }
  console.log("");
  console.log("⚠️ 16 天预报的后期准确度会明显下降；出发前 3 天建议再查一次。");

  if (args.json) {
    require("fs").writeFileSync(args.json, JSON.stringify({ label, lat, lon, rows }, null, 2), "utf8");
    console.log(`JSON 已写入：${args.json}`);
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
