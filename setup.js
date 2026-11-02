#!/usr/bin/env node
/**
 * setup.js —— travel-planner 一键安装 / 环境自检
 *
 * 用法：
 *   node setup.js              自检，缺失的自动装（docx）
 *   node setup.js --no-install 只检查，不动手
 *   node setup.js --full       额外跑联网测试（12306 / 天气）
 *   node setup.js --json       机器可读输出
 *
 * 设计原则：能自动修的就自动修；不能自动修的（如申请 API Key）
 * 明确告诉用户去哪里拿、怎么配，而不是只说「缺失」。
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SKILL_DIR = __dirname;
const ARGS = process.argv.slice(2);
const NO_INSTALL = ARGS.includes("--no-install");
const FULL = ARGS.includes("--full");
const JSON_OUT = ARGS.includes("--json");

const rows = [];
const actions = [];

function add(name, status, detail, fix) {
  rows.push({ name, status, detail });
  if ((status === "fail" || status === "warn") && fix) actions.push({ name, fix });
}
const ok = (n, d) => add(n, "ok", d);
const warn = (n, d, fix) => add(n, "warn", d, fix);
const fail = (n, d, fix) => add(n, "fail", d, fix);
const getRow = (n) => rows.find((r) => r.name === n);

// 不继承死代理，避免 localhost / 国内站点被拦
const CLEAN_ENV = { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "CC_HAHA_SYSTEM_PROXY_URL"]) {
  delete CLEAN_ENV[k];
}

/** 用命令字符串调用，避免 shell+args 的 deprecation 警告 */
function run(cmd, args = [], opts = {}) {
  const quote = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
  const full = [cmd, ...args.map(quote)].join(" ");
  return spawnSync(full, {
    shell: true,
    encoding: "utf8",
    timeout: opts.timeout ?? 20000,
    env: CLEAN_ENV,
    cwd: opts.cwd ?? SKILL_DIR,
  });
}

const firstLine = (s) => (s || "").trim().split(/\r?\n/)[0].trim();

// ── 基础检查（同步）────────────────────────────────────
function basicChecks() {
  // Node
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) ok("Node.js", `v${process.versions.node}`);
  else fail("Node.js", `v${process.versions.node}（需要 ≥ 18）`,
    "升级 Node：https://nodejs.org\nWindows 也可：winget install OpenJS.NodeJS.LTS");

  // npm
  const npmV = run("npm", ["-v"]);
  if (npmV.status === 0) ok("npm", firstLine(npmV.stdout));
  else warn("npm", "未找到", "随 Node 一起安装：https://nodejs.org");

  // docx
  if (hasDocx()) {
    ok("docx", `已安装 ${docxVersion()}`);
  } else if (NO_INSTALL) {
    fail("docx", "未安装", `在 skill 目录运行：npm i docx\n目录：${SKILL_DIR}`);
  } else {
    console.log("  docx              ⏳ 未安装，正在执行 npm i docx…");
    const r = run("npm", ["i", "docx", "--no-audit", "--no-fund"], { timeout: 180000 });
    if (hasDocx()) ok("docx", `已安装 ${docxVersion()}`);
    else fail("docx", "自动安装失败",
      `手动安装：cd "${SKILL_DIR}" && npm i docx\n` +
      `原因：${firstLine(r.stderr) || firstLine(r.stdout) || "网络或权限问题"}`);
  }

  // opencli（可选）
  const ocli = run("opencli", ["--version"], { timeout: 20000 });
  if (ocli.status === 0 && firstLine(ocli.stdout)) ok("opencli", firstLine(ocli.stdout));
  else warn("opencli", "未安装（只影响小红书抓取）",
    "安装：npm i -g @jackwener/opencli\n" +
    "然后在 Chrome/Edge 加载 OpenCLI 扩展：https://github.com/jackwener/opencli/releases\n" +
    "验证：opencli doctor");

  // git（可选）
  const gitV = run("git", ["--version"]);
  if (gitV.status === 0) ok("git", firstLine(gitV.stdout).replace("git version ", ""));
  else warn("git", "未安装（只影响 clone/push）", "https://git-scm.com/downloads");

  // Python（可选）
  const isWin = process.platform === "win32";
  const pyV = isWin ? run("py", ["-3", "--version"]) : run("python3", ["--version"]);
  if (pyV.status === 0) ok("Python", firstLine(pyV.stdout || pyV.stderr));
  else warn("Python", "未安装（可选，只用于校验 docx）", "https://www.python.org/downloads/");

  // 脚本完整性
  const scripts = ["rail_query.js", "weather_query.js", "docx_gen.js"];
  let bad = null;
  for (const s of scripts) {
    const p = path.join(SKILL_DIR, "scripts", s);
    if (!fs.existsSync(p)) { bad = `${s} 缺失`; break; }
    if (run("node", ["--check", p]).status !== 0) { bad = `${s} 语法错误`; break; }
  }
  if (!bad) ok("脚本完整性", "3 个脚本语法检查通过");
  else fail("脚本完整性", bad, "重新获取：git clone https://github.com/Future1ove/travel-planer.git");
}

function hasDocx() {
  for (const p of ["docx", path.join(SKILL_DIR, "node_modules", "docx")]) {
    try { require.resolve(p); return true; } catch {}
  }
  return false;
}
function docxVersion() {
  try {
    const p = path.join(SKILL_DIR, "node_modules", "docx", "package.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).version;
  } catch { return "?"; }
}

// ── 高德 Key（异步验证）────────────────────────────────
function resolveAmapKey() {
  if (process.env.AMAP_WEBSERVICE_KEY) {
    return { key: process.env.AMAP_WEBSERVICE_KEY, src: "环境变量" };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "config.json"), "utf8"));
    if (cfg.webServiceKey && !String(cfg.webServiceKey).includes("在这里填")) {
      return { key: cfg.webServiceKey, src: "config.json" };
    }
  } catch {}
  return null;
}

async function checkAmap() {
  const found = resolveAmapKey();
  if (!found) {
    fail("高德 Key", "未配置",
      "1) 申请（免费的 Web 服务 Key）：\n" +
      "   https://lbs.amap.com/api/webservice/create-project-and-key\n" +
      "2) 配置（二选一）：\n" +
      "   Windows:      setx AMAP_WEBSERVICE_KEY \"你的key\"   然后重开终端\n" +
      "   macOS/Linux:  export AMAP_WEBSERVICE_KEY=\"你的key\"\n" +
      "   或者：把 config.example.json 复制成 config.json，填入 webServiceKey\n" +
      "3) 重新运行：node setup.js");
    return;
  }
  try {
    const url =
      `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent("北京")}` +
      `&output=JSON&key=${encodeURIComponent(found.key)}&appname=amap-lbs-skill`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    if (j.status === "1") ok("高德 Key", `${found.src}，接口验证通过`);
    else fail("高德 Key", `${found.src}，接口返回：${j.info || "未知错误"}`,
      "检查 Key 类型是否为「Web 服务」，以及配额：https://console.amap.com");
  } catch (e) {
    warn("高德 Key", `${found.src}，验证请求失败：${e.message}`,
      "网络问题或 Key 无效。稍后重试，或到 https://console.amap.com 检查");
  }
}

// ── 联网自测（--full）──────────────────────────────────
async function liveTests() {
  console.log("\n  正在跑联网自测（约 1 分钟）…");

  const rail = run("node", [path.join(SKILL_DIR, "scripts", "rail_query.js"), "--list", "铜陵"], { timeout: 90000 });
  if (rail.status === 0 && /TJH/.test(rail.stdout)) ok("自测：12306 车站码", "通过");
  else warn("自测：12306 车站码", "未通过（可能被限流）", "等 3–5 分钟再试；或改用 12306 MCP / 官方 App");

  const wx = run("node", [path.join(SKILL_DIR, "scripts", "weather_query.js"), "--city", "北京", "--days", "1"], { timeout: 60000 });
  if (wx.status === 0 && /天气预报/.test(wx.stdout)) ok("自测：天气", "通过");
  else warn("自测：天气", "未通过", "Open-Meteo 是境外服务，可能不稳定；可用高德天气兜底");
}

// ── 功能可用性（在所有检查之后计算）──────────────────────
function computeFeatures() {
  const isOk = (n) => getRow(n)?.status === "ok";
  return [
    { name: "12306 查票", ok: isOk("Node.js") && isOk("脚本完整性") },
    { name: "天气（Open-Meteo）", ok: isOk("Node.js") && isOk("脚本完整性") },
    { name: "生成 Word", ok: isOk("Node.js") && isOk("docx") },
    { name: "高德 POI / 通勤", ok: isOk("高德 Key"), hint: isOk("高德 Key") ? "" : "缺 Key" },
    { name: "小红书抓取", ok: isOk("opencli") && isOk("Node.js"), hint: isOk("opencli") ? "" : "缺 opencli" },
  ];
}

// ── 输出 ───────────────────────────────────────────────
const ICON = { ok: "✅", warn: "⚠️ ", fail: "❌" };

(async () => {
  basicChecks();
  await checkAmap();
  if (FULL) await liveTests();

  const features = computeFeatures();

  if (JSON_OUT) {
    console.log(JSON.stringify({ rows, features, actions }, null, 2));
    return;
  }

  const line = "─".repeat(56);
  console.log("\n🛠  travel-planner 环境自检\n" + line);

  // 中文名宽度按 2 计算，简单对齐
  const width = (s) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  for (const r of rows) {
    const pad = " ".repeat(Math.max(1, 18 - width(r.name)));
    console.log(`  ${r.name}${pad}${ICON[r.status]} ${r.detail}`);
  }

  console.log("\n📋 功能可用性");
  for (const f of features) {
    console.log(`  ${f.ok ? "✅" : "❌"} ${f.name}${f.ok || !f.hint ? "" : `　（${f.hint}）`}`);
  }

  if (actions.length) {
    console.log("\n🔧 需要你处理的事项");
    actions.forEach((a, i) => {
      console.log(`\n  ${i + 1}. ${a.name}`);
      a.fix.split("\n").forEach((l) => console.log(`     ${l}`));
    });
  } else {
    console.log("\n🎉 全部就绪，可以直接用了。");
  }

  console.log("\n" + line);
  console.log("提示：--full 跑联网自测；--no-install 只检查不安装；--json 机器可读。\n");
})().catch((e) => {
  console.error("❌ 自检异常：", e.message);
  process.exit(1);
});
