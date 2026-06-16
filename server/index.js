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

/**
 * メインスクレイピング関数
 * @param {string} slug  ana-slo.com/<slug>/ のパス部分
 * @param {number} maxDays  取得する最大日数（デフォルト30）
 */
async function scrapeAnaSlo(slug, maxDays = 30) {
  const listingUrl = `https://ana-slo.com/${slug}/`;
  console.log(`[scrape] Listing: ${listingUrl}  maxDays=${maxDays}`);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // ── Step 1: インデックスページ訪問 (CFクッキー取得) ──
    await setupPage(page);
    await page.goto(listingUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await waitForCF(page);
    console.log("[scrape] Index loaded. Title:", await page.title());

    // ── Step 2: 日付リンク収集 ──
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

    console.log(`[scrape] Days with data: ${dayLinks.length} → scraping ${Math.min(dayLinks.length, maxDays)} days`);
    if (dayLinks.length === 0) {
      console.warn("[scrape] No day links found. Check slug.");
      return [];
    }

    // ── Step 3: 各日付ページを巡回 ──
    const allRecords = [];
    for (const day of dayLinks.slice(0, maxDays)) {
      // 日付をURLから取得 (例: 2026-06-14)
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
          // #all_data_table tbody tr → theadのヘッダー行は自動的に含まれない
          const rows = Array.from(document.querySelectorAll("#all_data_table tbody tr"));
          if (rows.length === 0) return [];

          return rows
            .map((row) => {
              // 確認済みセレクタで各フィールドを取得
              const machineName = row.querySelector("td.fixed01")?.textContent?.trim();
              const machineId   = row.querySelector("td.table_cells:nth-child(2)")?.textContent?.trim();
              const gamesRaw    = row.querySelector("td.table_cells:nth-child(3)")?.textContent?.trim();
              const diffRaw     = row.querySelector("td.table_cells:nth-child(4)")?.textContent?.trim();
              const bbRaw       = row.querySelector("td.table_cells:nth-child(5)")?.textContent?.trim();
              const rbRaw       = row.querySelector("td.table_cells:nth-child(6)")?.textContent?.trim();

              if (!machineName || !machineId) return null;

              // G数: カンマ除去して整数化
              const games = parseInt(gamesRaw?.replace(/[,，]/g, ""), 10) || 0;

              // 差枚: + とカンマを除去（マイナス記号はそのまま残す）
              const diff = parseInt(diffRaw?.replace(/[+,，]/g, ""), 10);
              if (isNaN(diff)) return null;

              const bb = parseInt(bbRaw, 10) || 0;
              const rb = parseInt(rbRaw, 10) || 0;

              return { date, dayOfMonth, machineId, machineName, diff, games, bb, rb };
            })
            .filter(Boolean);
        },
        date,
        dayOfMonth
      );

      console.log(`[scrape]   ${date}  ${records.length} records`);
      allRecords.push(...records);
    }

    console.log(`[scrape] Done. Total: ${allRecords.length} records`);
    return allRecords;
  } finally {
    await page.close();
  }
}

// ── API エンドポイント ──────────────────────────────────────────

/**
 * GET /api/scrape?slug=<slug>[&days=<n>]
 *
 * slug: ana-slo.com/<slug>/ の URL パス（日本語可）
 * days: 取得日数 (1–180, デフォルト30)
 */
app.get("/api/scrape", async (req, res) => {
  const { slug, days } = req.query;
  if (!slug) return res.status(400).json({ error: "slug パラメータが必要です" });

  const maxDays = Math.min(Math.max(parseInt(days, 10) || 365, 1), 365);

  try {
    const data = await scrapeAnaSlo(slug, maxDays);
    res.json(data);
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
  console.log(`   GET /api/scrape?slug=<path>[&days=365]`);
  console.log(`   例: /api/scrape?slug=%E3%83%9B%E3%83%BC%E3%83%AB%E3%83%87%E3%83%BC%E3%82%BF%2F%E6%9D%B1%E4%BA%AC%E9%83%BD%2F%E6%A5%BD%E5%9C%92%E3%82%A2%E3%83%A1%E6%A8%AA%E5%BA%97-%E3%83%87%E3%83%BC%E3%82%BF%E4%B8%80%E8%A6%A7`);
});
