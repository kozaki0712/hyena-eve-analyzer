/**
 * EVE ANALYZER - ana-slo.com スクレイピングサーバー
 *
 * 【構造メモ（2026-06確認）】
 * ・インデックスページ: https://ana-slo.com/<slug>/
 *     .date-table > .table-row × N (各行 = 日付 + サマリー)
 *     .table-data-cell a → 日付リンク (平均差枚が"–"の日はデータなし)
 *
 * ・日付ページ: https://ana-slo.com/YYYY-MM-DD-<hall>-data/
 *     #all_data_table tbody tr  → 全台データ行（theadは自動除外）
 *       td.fixed01              → 機種名（sticky左固定カラム）
 *       td.table_cells:nth-child(2) → 台番号
 *       td.table_cells:nth-child(3) → G数（カンマ区切り）
 *       td.table_cells:nth-child(4) → 差枚（+/-付き、カンマあり）
 *       td.table_cells:nth-child(5) → BB
 *       td.table_cells:nth-child(6) → RB
 *
 * 【Cloudflare対策】
 *   インデックスページを先に訪問してCFクッキーを取得した後、
 *   Refererヘッダーを付けて日付ページへ goto する。
 */

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3001;

// CORS許可
app.use(cors({ origin: ["http://localhost:5173", "http://localhost:3000"] }));
app.use(express.json());

// ブラウザをキャッシュ（起動コスト削減）
let _browser = null;

async function getBrowser() {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,800",
      ],
    });
    const cleanup = async () => {
      if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
    process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });
  }
  return _browser;
}

/** Cloudflareチャレンジが通過するまで待機 */
async function waitForCF(page, timeoutMs = 12000) {
  await page
    .waitForFunction(() => !document.title.includes("Just a moment"), { timeout: timeoutMs })
    .catch(() => console.warn("[CF] Challenge may not have passed — proceeding anyway"));
}

/** ページにUser-Agent等を設定 */
async function setupPage(page, referer = null) {
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  const headers = { "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8" };
  if (referer) headers["Referer"] = referer;
  await page.setExtraHTTPHeaders(headers);
}

/** 指定ミリ秒待機 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * メインスクレイピング関数（差分更新対応）
 *
 * @param {string} slug          ana-slo.com/<slug>/ のパス部分
 * @param {Set<string>} existingDates  取得済み日付の Set（YYYY-MM-DD）。この日付はスキップ。
 * @returns {{ newRecords: object[], stoppedEarly: boolean, reason: string }}
 */
async function scrapeAnaSlo(slug, existingDates = new Set()) {
  const listingUrl = `https://ana-slo.com/${slug}/`;
  console.log(`[scrape] Listing: ${listingUrl}  existingDates=${existingDates.size}`);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // ── Step 1: インデックスページ訪問 (CFクッキー取得) ──
    await setupPage(page);
    await page.goto(listingUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await waitForCF(page);
    console.log("[scrape] Index loaded. Title:", await page.title());

    // ── Step 2: ページ正常ロード確認 ──
    const pageTitle = await page.title();
    const pageHtmlLen = (await page.content()).length;
    console.log(`[scrape] title="${pageTitle}" html=${pageHtmlLen}bytes`);

    // CF ブロック判定: タイトルが空 or HTML が 1KB 未満 → ブロックされている
    if (!pageTitle || pageHtmlLen < 1000) {
      console.warn("[scrape] CF block detected (empty page). Returning cf_blocked.");
      return { newRecords: [], stoppedEarly: false, reason: "cf_blocked" };
    }

    // ── Step 2b: 日付リンク収集 ──
    const dayLinks = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".date-table .table-row"));
      return rows
        .map((row) => {
          const cells = row.querySelectorAll(".table-data-cell");
          if (cells.length < 3) return null;
          const link = cells[0].querySelector("a");
          if (!link) return null;
          // 平均差枚が"–"の日はデータなし
          const avgDiff = cells[2]?.textContent?.trim();
          const hasData = avgDiff && avgDiff !== "–" && avgDiff !== "-";
          return { href: link.href, text: link.innerText.trim(), hasData };
        })
        .filter((d) => d && d.hasData);
    });

    // ── Step 2c: 取得済み日付をスキップ ──
    const newDayLinks = dayLinks.filter((d) => {
      const m = d.href.match(/(\d{4}-\d{2}-\d{2})/);
      return m && !existingDates.has(m[1]);
    });

    console.log(
      `[scrape] Days with data: ${dayLinks.length} | already fetched: ${existingDates.size} | new: ${newDayLinks.length}`
    );

    if (dayLinks.length === 0) {
      console.warn("[scrape] No day links found on listing page (selector mismatch?).");
      return { newRecords: [], stoppedEarly: false, reason: "no_data_on_listing" };
    }

    if (newDayLinks.length === 0) {
      console.log("[scrape] No new days to scrape.");
      return { newRecords: [], stoppedEarly: false, reason: "up_to_date" };
    }

    // ── Step 3: 各日付ページを巡回（差分のみ）──
    const newRecords = [];
    let consecutiveZero = 0;
    const CONSECUTIVE_ZERO_LIMIT = 3; // 連続0件でCFブロックとみなし中断

    for (let i = 0; i < newDayLinks.length; i++) {
      const day = newDayLinks[i];

      // 2回目以降は 1〜2 秒待機
      if (i > 0) await sleep(1000 + Math.random() * 1000);

      const dateMatch = day.href.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];
      const dayOfMonth = parseInt(date.split("-")[2], 10);

      // Refererを付けてgoto（同一セッション）
      await setupPage(page, listingUrl);
      await page.goto(day.href, { waitUntil: "networkidle2", timeout: 30000 });
      await waitForCF(page, 8000);

      // 台別データをパース
      const records = await page.evaluate(
        (date, dayOfMonth) => {
          const rows = Array.from(document.querySelectorAll("#all_data_table tbody tr"));
          if (rows.length === 0) return [];
          return rows
            .map((row) => {
              const machineName = row.querySelector("td.fixed01")?.textContent?.trim();
              const machineId   = row.querySelector("td.table_cells:nth-child(2)")?.textContent?.trim();
              const gamesRaw    = row.querySelector("td.table_cells:nth-child(3)")?.textContent?.trim();
              const diffRaw     = row.querySelector("td.table_cells:nth-child(4)")?.textContent?.trim();
              const bbRaw       = row.querySelector("td.table_cells:nth-child(5)")?.textContent?.trim();
              const rbRaw       = row.querySelector("td.table_cells:nth-child(6)")?.textContent?.trim();
              if (!machineName || !machineId) return null;
              const games = parseInt(gamesRaw?.replace(/[,，]/g, ""), 10) || 0;
              const diff  = parseInt(diffRaw?.replace(/[+,，]/g, ""), 10);
              if (isNaN(diff)) return null;
              return { date, dayOfMonth, machineId, machineName, diff, games,
                       bb: parseInt(bbRaw, 10) || 0, rb: parseInt(rbRaw, 10) || 0 };
            })
            .filter(Boolean);
        },
        date,
        dayOfMonth
      );

      console.log(`[scrape]   ${date}  ${records.length} records`);

      if (records.length === 0) {
        consecutiveZero++;
        console.warn(`[scrape]   → 0件連続 ${consecutiveZero}/${CONSECUTIVE_ZERO_LIMIT}`);
        if (consecutiveZero >= CONSECUTIVE_ZERO_LIMIT) {
          console.warn("[scrape] CF ブロックの可能性あり。ここで中断します。");
          return { newRecords, stoppedEarly: true, reason: "consecutive_zero" };
        }
      } else {
        consecutiveZero = 0;
        newRecords.push(...records);
      }
    }

    console.log(`[scrape] Done. New records: ${newRecords.length}`);
    return { newRecords, stoppedEarly: false, reason: "completed" };
  } finally {
    await page.close();
  }
}

// ── API エンドポイント ──────────────────────────────────────────

/**
 * POST /api/scrape
 * body: { slug: string, existingDates?: string[] }
 *
 * slug: ana-slo.com/<slug>/ の URL パス（日本語可）
 * existingDates: 取得済み日付の配列（YYYY-MM-DD）。この日付はスキップされる。
 *
 * response: { newRecords: object[], stoppedEarly: boolean, reason: string }
 */
app.post("/api/scrape", async (req, res) => {
  const { slug, existingDates = [] } = req.body;
  if (!slug) return res.status(400).json({ error: "slug が必要です" });

  const existingDateSet = new Set(existingDates);

  try {
    const result = await scrapeAnaSlo(slug, existingDateSet);
    res.json(result);
  } catch (err) {
    console.error("[error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/debug-dates?slug=<slug>[&days=<n>]
 * 取得データに含まれる日付・dayOfMonth の一覧を返す（デバッグ用）
 */
app.get("/api/debug-dates", async (req, res) => {
  const { slug, days } = req.query;
  if (!slug) return res.status(400).json({ error: "slug パラメータが必要です" });

  const maxDays = Math.min(Math.max(parseInt(days, 10) || 365, 1), 365);

  try {
    const data = await scrapeAnaSlo(slug, maxDays);

    // dayOfMonth の集計
    const dayCount = {};
    data.forEach(r => {
      dayCount[r.dayOfMonth] = (dayCount[r.dayOfMonth] || 0) + 1;
    });

    // date（YYYY-MM-DD）ごとのレコード数
    const dateCount = {};
    data.forEach(r => {
      dateCount[r.date] = (dateCount[r.date] || 0) + 1;
    });

    res.json({
      totalRecords: data.length,
      scrapedDays: maxDays,
      uniqueDates: Object.keys(dateCount).sort(),
      dateRecordCounts: dateCount,
      dayOfMonthList: Object.keys(dayCount).map(Number).sort((a, b) => a - b),
      dayOfMonthCounts: dayCount,
    });
  } catch (err) {
    console.error("[debug-dates error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ヘルスチェック
app.get("/api/health", (_req, res) => res.json({ status: "ok", port: PORT }));

app.listen(PORT, () => {
  console.log(`✅  EVE ANALYZER server  →  http://localhost:${PORT}`);
  console.log(`   POST /api/scrape  body: { slug, existingDates?: string[] }`);
  console.log(`   GET  /api/debug-dates?slug=<path>`);
});
