import { useState, useCallback } from "react";

const HIGH_DIFF_THRESHOLD = 1500;
const STORAGE_KEY_HALLS = "eve_halls";
const STORAGE_KEY_EVE_DAYS = "eve_days";
const STORAGE_KEY_DATA = "eve_data";

/** "1,11,21,31" → [1,11,21,31] */
function parseEventDayStr(str) {
  return str.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 1 && n <= 31);
}


function calcStats(records, eventDays) {
  const eveDayRecords = records.filter((r) => eventDays.includes(r.dayOfMonth));
  const nonEveDayRecords = records.filter((r) => !eventDays.includes(r.dayOfMonth));
  const bySeat = {};
  eveDayRecords.forEach((r) => {
    if (!bySeat[r.machineId]) bySeat[r.machineId] = { id: r.machineId, name: r.machineName, diffs: [], highCount: 0, total: 0 };
    bySeat[r.machineId].diffs.push(r.diff);
    bySeat[r.machineId].total++;
    if (r.diff >= HIGH_DIFF_THRESHOLD) bySeat[r.machineId].highCount++;
  });
  const seatStats = Object.values(bySeat).map((s) => ({
    ...s,
    avgDiff: Math.round(s.diffs.reduce((a, b) => a + b, 0) / s.diffs.length),
    highRate: Math.round((s.highCount / s.total) * 100),
    maxDiff: Math.max(...s.diffs),
  })).sort((a, b) => b.avgDiff - a.avgDiff);
  const byMachine = {};
  eveDayRecords.forEach((r) => {
    if (!byMachine[r.machineName]) byMachine[r.machineName] = { name: r.machineName, diffs: [], highCount: 0, total: 0, seats: new Set() };
    byMachine[r.machineName].diffs.push(r.diff);
    byMachine[r.machineName].total++;
    byMachine[r.machineName].seats.add(r.machineId);
    if (r.diff >= HIGH_DIFF_THRESHOLD) byMachine[r.machineName].highCount++;
  });
  const machineStats = Object.values(byMachine).map((m) => ({
    name: m.name,
    avgDiff: Math.round(m.diffs.reduce((a, b) => a + b, 0) / m.diffs.length),
    highRate: Math.round((m.highCount / m.total) * 100),
    highCount: m.highCount, total: m.total, seatCount: m.seats.size,
    maxDiff: Math.max(...m.diffs),
  })).sort((a, b) => b.avgDiff - a.avgDiff);
  return { seatStats, machineStats, eveDayRecords, nonEveDayRecords };
}

async function fetchAIComment(hallName, eventDays, seatStats, machineStats) {
  const top5seats = seatStats.slice(0, 5).map(s => `台${s.id}(${s.name}): 平均差枚${s.avgDiff}枚, 高設定率${s.highRate}%, イベ日${s.total}回`).join("\n");
  const top5machines = machineStats.slice(0, 5).map(m => `${m.name}: 平均差枚${m.avgDiff}枚, 高設定率${m.highRate}%, 対象台数${m.seatCount}台`).join("\n");
  const prompt = `あなたはパチスロのプロ攻略ライターです。以下は「${hallName}」のイベント日（毎月${eventDays.join("・")}日）における過去データの集計結果です。\n\n【台番ランキング】\n${top5seats}\n\n【機種ランキング】\n${top5machines}\n\nこの店のイベント日の傾向を以下の観点で分析してください：\n1. 設定を入れる傾向がある台番・ゾーン（200字以内）\n2. 力を入れている機種とその根拠（200字以内）\n3. 来店時の狙い目アドバイス（100字以内）\n\n箇条書きではなく自然な文章で。`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await response.json();
  return data.content?.[0]?.text || "分析コメントを取得できませんでした。";
}

function DiffBadge({ diff }) {
  const color = diff >= 2000 ? "#00e5a0" : diff >= HIGH_DIFF_THRESHOLD ? "#7eefc7" : diff >= 0 ? "#94a3b8" : "#f87171";
  return <span style={{ color, fontWeight: diff >= HIGH_DIFF_THRESHOLD ? 700 : 400, fontVariantNumeric: "tabular-nums" }}>{diff >= 0 ? "+" : ""}{diff.toLocaleString()}</span>;
}

function HeatCell({ value, max }) {
  const ratio = Math.max(0, value) / Math.max(max, 1);
  const bg = value >= HIGH_DIFF_THRESHOLD ? `rgba(0,229,160,${0.15 + ratio * 0.5})` : value >= 0 ? `rgba(100,116,139,0.12)` : `rgba(248,113,113,0.1)`;
  return <td style={{ background: bg, textAlign: "right", padding: "6px 10px", fontVariantNumeric: "tabular-nums", fontSize: 13 }}><DiffBadge diff={value} /></td>;
}

export default function App() {
  const [tab, setTab] = useState("analysis");
  const [halls, setHalls] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_HALLS) || "[]"); } catch { return []; } });
  const [eventDays, setEventDays] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_EVE_DAYS) || "[1,11,21,31]"); } catch { return [1,11,21,31]; } });
  const [allData, setAllData] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_DATA) || "{}"); } catch { return {}; } });
  const [selectedHall, setSelectedHall] = useState(null);
  const [loading, setLoading] = useState(false);
  const [aiComment, setAiComment] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [newHallName, setNewHallName] = useState("");
  const [newHallSlug, setNewHallSlug] = useState("");
  const [newHallEventDayInput, setNewHallEventDayInput] = useState("1,11,21,31");
  const [eventDayInput, setEventDayInput] = useState(eventDays.join(","));
  const [viewMode, setViewMode] = useState("seat");

const hallData = selectedHall ? (allData[selectedHall.slug] || []) : [];
  // 店舗固有のeventDaysがあればそちら、なければグローバル設定にフォールバック
  const activeEventDays = selectedHall?.eventDays ?? eventDays;
  const stats = hallData.length > 0 ? calcStats(hallData, activeEventDays) : null;

  const addHall = () => {
    if (!newHallName || !newHallSlug) return;
    const hallEventDays = parseEventDayStr(newHallEventDayInput);
    const hall = {
      name: newHallName,
      slug: newHallSlug,
      eventDays: hallEventDays.length > 0 ? hallEventDays : null,
      addedAt: new Date().toISOString(),
    };
    const updated = [...halls, hall];
    setHalls(updated);
    localStorage.setItem(STORAGE_KEY_HALLS, JSON.stringify(updated));
    setNewHallName(""); setNewHallSlug(""); setNewHallEventDayInput("1,11,21,31");
  };

  const fetchData = async (hall) => {
    setLoading(true); setAiComment("");
    try {
      // 取得済みデータと日付一覧を準備
      const existing = allData[hall.slug] || [];
      const existingDates = [...new Set(existing.map(r => r.date))];

      const res = await fetch("http://localhost:3001/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: hall.slug, existingDates }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const { newRecords, stoppedEarly, reason } = await res.json();

      if (reason === "up_to_date") {
        alert("✅ 新しいデータはありませんでした（すべて取得済みです）。");
        setSelectedHall(hall);
        return;
      }

      // 日付単位でマージ（新データで上書き、既存は保持）
      const newDates = new Set(newRecords.map(r => r.date));
      const merged = [
        ...existing.filter(r => !newDates.has(r.date)),
        ...newRecords,
      ];

      const updated = { ...allData, [hall.slug]: merged };
      setAllData(updated);
      localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(updated));
      setSelectedHall(hall);

      if (stoppedEarly) {
        alert(
          `⚠ 連続して0件が続いたため途中で停止しました（Cloudflareブロックの可能性）。\n` +
          `今回取得: ${newRecords.length}件 → 合計: ${merged.length}件\n` +
          `続きは次回「データ取得」を押すと再開できます。`
        );
      }
    } catch (err) {
      alert(`データ取得エラー: ${err.message}`);
    } finally { setLoading(false); }
  };

  const runAI = async () => {
    if (!stats) return;
    setAiLoading(true);
    try { setAiComment(await fetchAIComment(selectedHall.name, activeEventDays, stats.seatStats, stats.machineStats)); }
    catch { setAiComment("AI分析中にエラーが発生しました。"); }
    finally { setAiLoading(false); }
  };

  const saveEventDays = () => {
    const days = parseEventDayStr(eventDayInput);
    setEventDays(days);
    localStorage.setItem(STORAGE_KEY_EVE_DAYS, JSON.stringify(days));
    setAiComment("");
  };

  const heatmapData = useCallback(() => {
    if (!hallData.length) return { dates: [], seats: [], grid: {} };
    const eveDates = [...new Set(hallData.filter(r => activeEventDays.includes(r.dayOfMonth)).map(r => r.date))].sort();
    const seats = [...new Set(hallData.map(r => r.machineId))].sort((a,b) => parseInt(a)-parseInt(b));
    const grid = {};
    hallData.forEach(r => { if (activeEventDays.includes(r.dayOfMonth)) { if (!grid[r.machineId]) grid[r.machineId] = {}; grid[r.machineId][r.date] = r.diff; } });
    return { dates: eveDates, seats, grid };
  }, [hallData, activeEventDays]);

  const hm = heatmapData();
  const maxDiff = hallData.length ? Math.max(...hallData.map(r => r.diff)) : 1;

  const S = {
    app: { background: "#0d1117", minHeight: "100vh", color: "#e2e8f0", fontFamily: "'JetBrains Mono', 'Courier New', monospace" },
    header: { borderBottom: "1px solid #1e293b", padding: "0 20px", display: "flex", alignItems: "center", gap: 16, height: 52 },
    logo: { color: "#00e5a0", fontWeight: 800, fontSize: 16, letterSpacing: "0.05em" },
    badge: { background: "#0f2a20", color: "#00e5a0", fontSize: 10, padding: "2px 7px", borderRadius: 3, border: "1px solid #00e5a040" },
    nav: { display: "flex", gap: 0, marginLeft: "auto" },
    navBtn: (active) => ({ background: "none", border: "none", color: active ? "#00e5a0" : "#64748b", padding: "0 16px", height: 52, cursor: "pointer", fontSize: 12, fontFamily: "inherit", borderBottom: active ? "2px solid #00e5a0" : "2px solid transparent" }),
    body: { maxWidth: 1100, margin: "0 auto", padding: "24px 16px" },
    section: { background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: "20px 24px", marginBottom: 16 },
    label: { fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 },
    h2: { fontSize: 13, fontWeight: 700, color: "#94a3b8", marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.08em" },
    row: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" },
    input: { background: "#0d1117", border: "1px solid #1e293b", color: "#e2e8f0", borderRadius: 4, padding: "7px 12px", fontSize: 12, fontFamily: "inherit", outline: "none" },
    btn: (v = "default") => ({ background: v === "primary" ? "#00e5a0" : v === "danger" ? "#ef444410" : "#1e293b", color: v === "primary" ? "#0d1117" : v === "danger" ? "#f87171" : "#94a3b8", border: v === "danger" ? "1px solid #f8717130" : "none", borderRadius: 4, padding: "7px 14px", fontSize: 12, fontFamily: "inherit", cursor: "pointer", fontWeight: v === "primary" ? 700 : 400 }),
    table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
    th: { textAlign: "left", padding: "8px 10px", fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.1em", borderBottom: "1px solid #1e293b" },
    td: { padding: "7px 10px", borderBottom: "1px solid #0f172a" },
    tabs: { display: "flex", gap: 8, marginBottom: 16 },
    tabBtn: (active) => ({ background: active ? "#1e293b" : "none", color: active ? "#e2e8f0" : "#475569", border: "1px solid " + (active ? "#334155" : "transparent"), borderRadius: 4, padding: "5px 14px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }),
    aiBox: { background: "#0a1a12", border: "1px solid #00e5a030", borderRadius: 6, padding: "16px 20px", fontSize: 13, lineHeight: 1.8, color: "#a7f3d0", whiteSpace: "pre-wrap" },
    hallCard: { background: "#0d1117", border: "1px solid #1e293b", borderRadius: 6, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 },
    chip: (active) => ({ background: active ? "#00e5a0" : "#1e293b", color: active ? "#0d1117" : "#64748b", border: "none", borderRadius: 20, padding: "3px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }),
    stat: { display: "flex", flexDirection: "column", gap: 2 },
    statNum: { fontSize: 22, fontWeight: 800, color: "#00e5a0", fontVariantNumeric: "tabular-nums" },
    statLabel: { fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.1em" },
  };

  return (
    <div style={S.app}>
      <div style={S.header}>
        <span style={S.logo}>HYENA</span>
        <span style={S.badge}>EVE ANALYZER</span>
        <nav style={S.nav}>
          {[["analysis","分析"],["halls","店舗管理"],["settings","設定"]].map(([k,l]) => (
            <button key={k} style={S.navBtn(tab===k)} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
      </div>
      <div style={S.body}>
        {tab === "analysis" && (
          <>
            <div style={S.section}>
              <div style={S.label}>店舗を選択</div>
              {halls.length === 0 ? <p style={{ color: "#475569", fontSize: 13 }}>「店舗管理」タブでホールを追加してください。</p> : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {halls.map(h => <button key={h.slug} style={S.chip(selectedHall?.slug === h.slug)} onClick={() => { setSelectedHall(h); setAiComment(""); }}>{h.name}</button>)}
                </div>
              )}
              {selectedHall && (
                <div style={{ ...S.row, marginTop: 14 }}>
                  <button style={S.btn("primary")} onClick={() => fetchData(selectedHall)} disabled={loading}>{loading ? "取得中…" : "▶ データ取得"}</button>
                  <span style={{ fontSize: 11, color: "#475569" }}>{hallData.length > 0 ? `${[...new Set(hallData.map(r=>r.date))].length}日分・${hallData.length}件 | イベ日: ${stats?.eveDayRecords?.length || 0}件` : "未取得"}</span>
                </div>
              )}
            </div>
            {stats && (
              <>
                <div style={{ ...S.section, display: "flex", gap: 32, flexWrap: "wrap" }}>
                  {[{ num: activeEventDays.join("・")+"日", label: "イベント日" }, { num: stats.eveDayRecords.length, label: "イベ日データ数" }, { num: stats.seatStats.length, label: "対象台数" }, { num: stats.seatStats.filter(s=>s.highRate>=50).length, label: "高率台（50%↑）" }, { num: stats.machineStats[0]?.name, label: "最強機種" }].map((s,i) => (
                    <div key={i} style={S.stat}><span style={S.statNum}>{s.num}</span><span style={S.statLabel}>{s.label}</span></div>
                  ))}
                </div>
                <div style={S.tabs}>
                  {[["seat","台番別"],["machine","機種別"],["heatmap","ヒートマップ"]].map(([k,l]) => <button key={k} style={S.tabBtn(viewMode===k)} onClick={() => setViewMode(k)}>{l}</button>)}
                </div>
                {viewMode === "seat" && (
                  <div style={S.section}>
                    <div style={S.h2}>台番別 イベ日実績</div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={S.table}>
                        <thead><tr>{["台番","機種名","平均差枚","最高差枚","高設定率","イベ日回数"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                        <tbody>{stats.seatStats.map((s,i) => (
                          <tr key={s.id} style={{ background: i%2===0?"transparent":"#0a0f1a" }}>
                            <td style={{ ...S.td, color: "#00e5a0", fontWeight: 700 }}>#{s.id}</td>
                            <td style={S.td}>{s.name}</td>
                            <td style={{ ...S.td, textAlign: "right" }}><DiffBadge diff={s.avgDiff} /></td>
                            <td style={{ ...S.td, textAlign: "right" }}><DiffBadge diff={s.maxDiff} /></td>
                            <td style={{ ...S.td, textAlign: "right" }}><span style={{ color: s.highRate>=50?"#00e5a0":s.highRate>=30?"#7eefc7":"#64748b" }}>{s.highRate}%</span></td>
                            <td style={{ ...S.td, textAlign: "right", color: "#64748b" }}>{s.total}回</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </div>
                )}
                {viewMode === "machine" && (
                  <div style={S.section}>
                    <div style={S.h2}>機種別 イベ日実績</div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={S.table}>
                        <thead><tr>{["機種名","平均差枚","最高差枚","高設定率","高設定回数","台数"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                        <tbody>{stats.machineStats.map((m,i) => (
                          <tr key={m.name} style={{ background: i%2===0?"transparent":"#0a0f1a" }}>
                            <td style={{ ...S.td, fontWeight: 700 }}>{m.name}</td>
                            <td style={{ ...S.td, textAlign: "right" }}><DiffBadge diff={m.avgDiff} /></td>
                            <td style={{ ...S.td, textAlign: "right" }}><DiffBadge diff={m.maxDiff} /></td>
                            <td style={{ ...S.td, textAlign: "right" }}><span style={{ color: m.highRate>=50?"#00e5a0":m.highRate>=30?"#7eefc7":"#64748b" }}>{m.highRate}%</span></td>
                            <td style={{ ...S.td, textAlign: "right", color: "#94a3b8" }}>{m.highCount}/{m.total}回</td>
                            <td style={{ ...S.td, textAlign: "right", color: "#64748b" }}>{m.seatCount}台</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </div>
                )}
                {viewMode === "heatmap" && (
                  <div style={S.section}>
                    <div style={S.h2}>ヒートマップ（台番 × イベ日）</div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ ...S.table, fontSize: 11 }}>
                        <thead><tr><th style={{ ...S.th, minWidth: 80 }}>台番</th>{hm.dates.slice(-12).map(d => <th key={d} style={{ ...S.th, minWidth: 60, textAlign: "right" }}>{d.slice(5).replace("-","/")}</th>)}</tr></thead>
                        <tbody>{hm.seats.map(seat => (
                          <tr key={seat}>
                            <td style={{ ...S.td, color: "#00e5a0", fontWeight: 700 }}>#{seat}</td>
                            {hm.dates.slice(-12).map(date => { const v = hm.grid[seat]?.[date]; return v !== undefined ? <HeatCell key={date} value={v} max={maxDiff} /> : <td key={date} style={{ ...S.td, textAlign: "right", color: "#1e293b" }}>—</td>; })}
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                    <div style={{ marginTop: 10, display: "flex", gap: 16, fontSize: 11, color: "#475569" }}>
                      <span><span style={{ color: "#00e5a0" }}>■</span> +2000枚以上</span>
                      <span><span style={{ color: "#7eefc7" }}>■</span> +{HIGH_DIFF_THRESHOLD}枚以上</span>
                      <span><span style={{ color: "#475569" }}>■</span> ±0前後</span>
                      <span><span style={{ color: "#f87171" }}>■</span> マイナス</span>
                    </div>
                  </div>
                )}
                <div style={S.section}>
                  <div style={{ ...S.row, marginBottom: 14 }}>
                    <div style={S.h2}>AI 傾向分析</div>
                    <button style={{ ...S.btn("primary"), marginLeft: "auto" }} onClick={runAI} disabled={aiLoading}>{aiLoading ? "分析中…" : "✦ AI分析を実行"}</button>
                  </div>
                  {aiComment ? <div style={S.aiBox}>{aiComment}</div> : <p style={{ color: "#334155", fontSize: 12 }}>「AI分析を実行」で傾向コメントを生成します。</p>}
                </div>
              </>
            )}
          </>
        )}
        {tab === "halls" && (
          <div style={S.section}>
            <div style={S.h2}>店舗登録</div>
            <div style={{ ...S.row, marginBottom: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div><div style={S.label}>店舗名</div><input style={{ ...S.input, width: 180 }} value={newHallName} onChange={e => setNewHallName(e.target.value)} placeholder="例: マルハン渋谷" /></div>
              <div><div style={S.label}>アナスロURL slug</div><div style={{ ...S.row, gap: 4 }}><span style={{ color: "#475569", fontSize: 12 }}>ana-slo.com/</span><input style={{ ...S.input, width: 220 }} value={newHallSlug} onChange={e => setNewHallSlug(e.target.value)} placeholder="例: ホールデータ/東京都/..." /></div></div>
              <div>
                <div style={S.label}>イベント日 <span style={{ color: "#334155", textTransform: "none", letterSpacing: 0 }}>（空欄=グローバル設定）</span></div>
                <input style={{ ...S.input, width: 140 }} value={newHallEventDayInput} onChange={e => setNewHallEventDayInput(e.target.value)} placeholder="例: 1,11,21,31" />
              </div>
              <button style={S.btn("primary")} onClick={addHall} disabled={!newHallName || !newHallSlug}>追加</button>
            </div>
            <div style={S.h2}>登録済み店舗</div>
            {halls.length === 0 ? <p style={{ color: "#475569", fontSize: 13 }}>まだ登録されていません。</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {halls.map((h,i) => (
                  <div key={h.slug} style={S.hallCard}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{h.name}</div>
                      <div style={{ color: "#475569", fontSize: 11 }}>ana-slo.com/{h.slug}</div>
                      <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                        {h.eventDays
                          ? h.eventDays.map(d => <span key={d} style={{ background: "#0f2a20", color: "#00e5a0", border: "1px solid #00e5a040", borderRadius: 3, padding: "1px 6px", fontSize: 10 }}>{d}日</span>)
                          : <span style={{ background: "#1e293b", color: "#475569", borderRadius: 3, padding: "1px 6px", fontSize: 10 }}>グローバル設定</span>
                        }
                      </div>
                    </div>
                    <div style={{ color: "#475569", fontSize: 11 }}>{allData[h.slug] ? `${allData[h.slug].length}件` : "未取得"}</div>
                    <button style={S.btn("danger")} onClick={() => { const updated = halls.filter((_,j)=>j!==i); setHalls(updated); localStorage.setItem(STORAGE_KEY_HALLS, JSON.stringify(updated)); if(selectedHall?.slug===h.slug) setSelectedHall(null); }}>削除</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "settings" && (
          <div style={S.section}>
            <div style={S.h2}>イベント日設定</div>
            <p style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>毎月何日をイベント日とするか、カンマ区切りで入力（例: 1,11,21,31）</p>
            <div style={S.row}>
              <input style={{ ...S.input, width: 220 }} value={eventDayInput} onChange={e => setEventDayInput(e.target.value)} placeholder="1,11,21,31" />
              <button style={S.btn("primary")} onClick={saveEventDays}>保存</button>
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {eventDays.map(d => <span key={d} style={{ background: "#0f2a20", color: "#00e5a0", border: "1px solid #00e5a040", borderRadius: 4, padding: "3px 10px", fontSize: 12 }}>毎月{d}日</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
