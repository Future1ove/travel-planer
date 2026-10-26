# 高德地图 API SOP

用来拿：景点坐标与评分、**驾车耗时与距离**、连锁酒店门店与电话、天气。

通勤时间是整个行程可行性的基础——判断「21:00 下课能不能赶上车」「住哪最划算」全靠它。

---

## 0. Key 的读取顺序

1. 环境变量 `AMAP_WEBSERVICE_KEY`
2. skill 目录下 `config.json` 的 `webServiceKey`
3. 都没有 → 提示用户去 https://lbs.amap.com 申请，**不要编造数据**

所有请求都要带 `appname=amap-lbs-skill`。

```bash
K="${AMAP_WEBSERVICE_KEY:-$(node -e "try{console.log(require('./config.json').webServiceKey||'')}catch(e){console.log('')}")}"
```

⚠️ 不要把 key 写进 SKILL.md 或提交到版本库。

---

## 1. 地理编码（地址 → 坐标）

```bash
curl -s "https://restapi.amap.com/v3/geocode/geo?address=铜陵站&city=铜陵&output=JSON&key=$K&appname=amap-lbs-skill"
```

返回 `geocodes[0].location`，格式是 **`经度,纬度`**（经度在前，容易搞反）。

中文地址需要 URL 编码：

```bash
enc() { printf %s "$1" | od -An -tx1 | tr -d ' \n' | sed 's/../%&/g'; }
```

---

## 2. POI 搜索（景点 / 酒店 / 餐厅）

```bash
curl -s "https://restapi.amap.com/v3/place/text?keywords=$(enc 景点)&city=$(enc 铜陵)&types=110000&offset=20&key=$K&appname=amap-lbs-skill"
```

返回字段：

- `name` 名称
- `address` 地址
- `tel` 电话（连锁酒店订房必用）
- `location` 坐标
- `biz_ext.rating` 评分（不一定有）
- `biz_ext.cost` 人均/门票（经常为空，**空就是没查到，不要猜**）
- `biz_ext.open_time` / `opentime_week` 营业时间

常见 `types`：

| 类型码 | 含义 |
|---|---|
| 110000 | 风景名胜 |
| 100000 | 住宿服务 |
| 050000 | 餐饮服务 |
| 060000 | 购物服务 |

**技巧**：搜连锁酒店直接用品牌名（`汉庭`、`全季`、`如家`），一次能拿到该城市所有门店 + 电话。选店时按到各景点的通勤距离排，而不是只看品牌。

---

## 3. 路径规划（最重要）

### 3.1 驾车

```bash
curl -s "https://restapi.amap.com/v3/direction/driving?origin=117.86,30.91&destination=118.02,30.96&key=$K&appname=amap-lbs-skill"
```

取 `route.paths[0].duration`（秒）和 `.distance`（米）。

### 3.2 公交/地铁

```bash
curl -s "https://restapi.amap.com/v3/direction/transit/integrated?origin=...&destination=...&city=武汉&key=$K&appname=amap-lbs-skill"
```

取 `route.transits[0]`（duration / distance / walking_distance / cost / segments）。

### 3.3 步行

```bash
curl -s "https://restapi.amap.com/v3/direction/walking?origin=...&destination=...&key=$K&appname=amap-lbs-skill"
```

### 怎么用这些数据做决策

- **判断能不能赶上车**：住处 → 车站的**打车时间** + 进站缓冲 20–30 分钟，倒推最晚出发时刻
- **判断住哪**：把候选酒店到当天所有景点的耗时加起来比较，而不是只看单程
- **判断要不要去**：单程超过 1 小时且不是核心景点的，直接降级为「备选」
- **注意城市尺度差异**：同样是「20 分钟」，在一线城市和小城市的意义完全不同

> 真实案例：从某校区坐地铁到火车站要 91 分钟，但打车只要 36 分钟。这个差值直接决定了整个周五晚的可行性——只看「有没有车」会得出错误结论。

---

## 4. 天气

> 首选其实是 Open-Meteo（16 天 + 降水概率，免 Key），用 `node scripts/weather_query.js --city 铜陵`。
> 本节的高德天气作为**兜底**：Open-Meteo 连不上、或需要更符合国内习惯的中文天气词时使用。

### 实况

```bash
curl -s "https://restapi.amap.com/v3/weather/weatherInfo?city=430600&key=$K&appname=amap-lbs-skill"
```

返回 `lives[0]`：`weather / temperature / humidity / winddirection / windpower / reporttime`。

### 预报（约 4 天）

```bash
curl -s "https://restapi.amap.com/v3/weather/weatherInfo?city=430600&key=$K&extensions=all&appname=amap-lbs-skill"
```

返回 `forecasts[0].casts[]`，每条含 `date / dayweather / daytemp / nightweather / nighttemp / daywind / daypower`。

`city` 用 **adcode**（如岳阳市 430600），不是城市名。

### 重要限制

**高德只给约 4 天预报。** 旅行通常在 1–3 周后，那时是查不到的。

正确做法：

- 明确写「天气预报目前查不到（距今 N 天，超出预报范围）」
- 可以补一句该季节的**常年值**，但必须标注「常年值，不是预报」
- 建议用户出发前 3 天再查一次

**绝对不要编一个「晴 22℃」填进去。** 用户会据此决定带不带外套。

---

## 5. 输出要求

写进 Word 前，把结果整理成：

- **通勤表**：路段 / 方式 / 耗时 / 距离 / 说明
- **景点表**：名称 / 评分 / 地址 / 电话 / 营业时间
- **酒店表**：名称 / 地址 / 电话

并在「数据来源」里标注 `高德地图 Web 服务 API 实测`。

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `status: "0"` | 请求失败 | 看 `info` 字段，多半是 key 或参数问题 |
| `geocodes: []` | 地址太笼统 | 换更完整的地址，加城市限定 |
| `INVALID_USER_KEY` | key 错误/过期 | 提示用户重新配置 |
| `CUQPS_HAS_EXCEEDED_THE_LIMIT` | 频率超限 | 降低并发，加 sleep |
| 通勤时间明显不合理 | 起终点坐标搞反了 | 检查 `经度,纬度` 顺序 |
