import { useState, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from "recharts";

// ── Config ──
const BASE_URL = "http://localhost:8000";
const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY

// ── Backend query ──
async function queryAgent(payload) {
  const res = await fetch(`${BASE_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Error ${res.status}`);
  }
  return res.json();
}

// ── OpenAI demo fallback ──
async function queryViaOpenAI(payload) {
  const prompt = `You are a clinical trials data visualization agent. The user asked: "${payload.query}"
${payload.drug_name ? `Drug: ${payload.drug_name}` : ""}
${payload.condition ? `Condition: ${payload.condition}` : ""}
${payload.start_year ? `Start year: ${payload.start_year}` : ""}

Generate a realistic mock response as if you fetched data from ClinicalTrials.gov API. Return ONLY a JSON object (no markdown) with this exact structure:
{
  "visualization": {
    "type": "bar_chart | time_series | network_graph | grouped_bar_chart",
    "title": "Chart title",
    "encoding": { "x": {"field": "fieldname"}, "y": {"field": "fieldname"} },
    "data": [ ... realistic data points with citations array containing {nct_id, excerpt, url} ... ]
  },
  "meta": {
    "filters": {},
    "source": "clinicaltrials.gov",
    "total_trials_fetched": 87,
    "query_interpretation": "...",
    "notes": "..."
  }
}

For time_series: use year field (2015-2024) and trial_count. For bar_chart: use category + trial_count. For network_graph: data should be [{"nodes": [...], "edges": [...]}] (wrapped in array). For grouped_bar_chart: include series field. Make data realistic and varied. Include 2-3 citations per data point with real-looking NCT IDs like NCT04123456.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  let text = data.choices?.[0]?.message?.content || "{}";
  text = text.replace(/^```json\s*/m, "").replace(/\s*```$/m, "").trim();
  return JSON.parse(text);
}

// ── Color palette ──
const COLORS = ["#00d4b4", "#ff6b6b", "#ffd166", "#06d6a0", "#118ab2", "#ef476f", "#8338ec", "#fb5607"];

// ── Network Graph SVG Component ──
function NetworkGraph({ data }) {
  const [hoveredNode, setHoveredNode] = useState(null);

  // Handle both wrapped array format [{nodes,edges}] and direct {nodes,edges}
  const graphData = Array.isArray(data) ? data[0] : data;
  const nodes = graphData?.nodes || [];
  const edges = graphData?.edges || [];

  const W = 600, H = 420;
  const positioned = nodes.map((n, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI;
    const r = n.type === "sponsor" ? 140 : 190;
    return { ...n, x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle) };
  });
  const posMap = Object.fromEntries(positioned.map(n => [n.id, n]));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxHeight: 420 }}>
      <defs>
        <radialGradient id="ng1" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#00d4b4" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#0a0f1e" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={W / 2} cy={H / 2} r={220} fill="url(#ng1)" />
      {edges.slice(0, 40).map((e, i) => {
        const s = posMap[e.source], t = posMap[e.target];
        if (!s || !t) return null;
        return (
          <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
            stroke="#00d4b4" strokeOpacity={0.15 + Math.min(e.weight / 20, 0.4)}
            strokeWidth={0.5 + Math.min(e.weight / 10, 2)} />
        );
      })}
      {positioned.map((n) => {
        const r = n.type === "sponsor" ? 10 : 7;
        const isHov = hoveredNode === n.id;
        return (
          <g key={n.id} onMouseEnter={() => setHoveredNode(n.id)} onMouseLeave={() => setHoveredNode(null)} style={{ cursor: "pointer" }}>
            <circle cx={n.x} cy={n.y} r={isHov ? r + 4 : r}
              fill={n.type === "sponsor" ? "#00d4b4" : "#ff6b6b"}
              stroke={isHov ? "#fff" : "transparent"} strokeWidth={1.5} />
            {(isHov || nodes.length < 12) && (
              <text x={n.x} y={n.y - r - 4} textAnchor="middle" fill="#e2e8f0" fontSize={9} fontFamily="monospace">
                {n.label?.slice(0, 18)}
              </text>
            )}
          </g>
        );
      })}
      <g transform={`translate(10,${H - 35})`}>
        <circle cx={6} cy={6} r={6} fill="#00d4b4" />
        <text x={16} y={10} fill="#94a3b8" fontSize={10}>Sponsor</text>
        <circle cx={70} cy={6} r={4} fill="#ff6b6b" />
        <text x={80} y={10} fill="#94a3b8" fontSize={10}>Drug</text>
      </g>
    </svg>
  );
}

// ── Citation Badge ──
function Citations({ citations }) {
  const [open, setOpen] = useState(false);
  if (!citations?.length) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <button onClick={() => setOpen(!open)} style={{
        fontSize: 11, color: "#00d4b4", background: "none", border: "1px solid #00d4b433",
        borderRadius: 4, padding: "2px 8px", cursor: "pointer"
      }}>
        {open ? "▲" : "▼"} {citations.length} source{citations.length > 1 ? "s" : ""}
      </button>
      {open && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {citations.map((c, i) => (
            <div key={i} style={{ background: "#0f172a", borderRadius: 6, padding: "6px 10px", borderLeft: "2px solid #00d4b4" }}>
              <a href={c.url} target="_blank" rel="noopener noreferrer"
                style={{ color: "#00d4b4", fontFamily: "monospace", fontSize: 11, textDecoration: "none" }}>
                {c.nct_id}
              </a>
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>{c.excerpt}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Custom Tooltip ──
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const item = payload[0]?.payload;
  return (
    <div style={{ background: "#0f172a", border: "1px solid #00d4b433", borderRadius: 8, padding: "10px 14px", maxWidth: 260 }}>
      <p style={{ margin: 0, color: "#e2e8f0", fontWeight: 600, fontSize: 13 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ margin: "4px 0 0", color: p.color || "#00d4b4", fontSize: 12 }}>
          {p.name}: <strong>{p.value?.toLocaleString()}</strong>
        </p>
      ))}
      {item?.citations && <Citations citations={item.citations} />}
    </div>
  );
}

// ── Visualization Renderer ──
function VisualizationPanel({ result }) {
  const { visualization, meta } = result;
  const { type, title, data, encoding } = visualization;

  const xField = encoding?.x?.field || "x";
  const yField = encoding?.y?.field || "y";
  const seriesField = encoding?.series?.field;

  const seriesKeys = seriesField ? [...new Set(data.map(d => d[seriesField]))] : null;

  // For network graph: extract nodes for table display
  const graphData = type === "network_graph"
    ? (Array.isArray(data) ? data[0] : data)
    : null;

  return (
    <div style={{ animation: "fadeIn 0.5s ease" }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#e2e8f0", fontFamily: "'Playfair Display', serif" }}>{title}</h2>
        <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 13 }}>
          {meta.query_interpretation} · <span style={{ color: "#00d4b4" }}>{meta.total_trials_fetched} trials</span>
        </p>
      </div>

      <div style={{ background: "#0a0f1e", borderRadius: 12, padding: 16, border: "1px solid #1e293b" }}>
        {["bar_chart", "phase_distribution", "status_distribution", "country_distribution", "sponsor_distribution", "intervention_types"].includes(type) && (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey={xField} tick={{ fill: "#64748b", fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey={yField} fill="#00d4b4" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}

        {type === "time_series" && (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey={xField} tick={{ fill: "#64748b", fontSize: 11 }} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey={yField} stroke="#00d4b4" strokeWidth={2.5}
                dot={{ fill: "#00d4b4", r: 4 }} activeDot={{ r: 7, fill: "#fff" }} />
            </LineChart>
          </ResponsiveContainer>
        )}

        {type === "grouped_bar_chart" && seriesKeys && (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={
              [...new Set(data.map(d => d[xField]))].map(x => {
                const entry = { [xField]: x };
                seriesKeys.forEach(s => {
                  const row = data.find(d => d[xField] === x && d[seriesField] === s);
                  entry[s] = row?.[yField] || 0;
                });
                return entry;
              })
            } margin={{ top: 10, right: 20, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey={xField} tick={{ fill: "#64748b", fontSize: 11 }} angle={-20} textAnchor="end" interval={0} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 12 }} />
              {seriesKeys.map((k, i) => (
                <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}

        {type === "network_graph" && <NetworkGraph data={data} />}
      </div>

      {/* Data Table */}
      <div style={{ marginTop: 16, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #1e293b" }}>
              {type === "network_graph"
                ? ["Node ID", "Type", "Count"].map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#64748b", fontWeight: 500 }}>{h}</th>
                  ))
                : Object.keys(data?.[0] || {}).filter(k => k !== "citations").map(h => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#64748b", fontWeight: 500 }}>{h}</th>
                  ))
              }
              <th style={{ padding: "8px 12px", textAlign: "left", color: "#64748b", fontWeight: 500 }}>Sources</th>
            </tr>
          </thead>
          <tbody>
            {(type === "network_graph"
              ? (graphData?.nodes || []).slice(0, 10)
              : (data || []).slice(0, 15)
            ).map((row, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #0f172a" }}>
                {type === "network_graph"
                  ? [row.id?.slice(0, 30), row.type, row.count].map((v, j) => (
                      <td key={j} style={{ padding: "8px 12px", color: "#e2e8f0" }}>{v}</td>
                    ))
                  : Object.entries(row).filter(([k]) => k !== "citations").map(([k, v], j) => (
                      <td key={j} style={{ padding: "8px 12px", color: "#e2e8f0" }}>{String(v)?.slice(0, 40)}</td>
                    ))
                }
                <td style={{ padding: "8px 12px" }}>
                  {row.citations?.length > 0
                    ? <Citations citations={row.citations} />
                    : <span style={{ color: "#334155", fontSize: 11 }}>—</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {type !== "network_graph" && data?.length > 15 && (
          <p style={{ color: "#334155", fontSize: 12, textAlign: "center", marginTop: 8 }}>
            Showing 15 of {data.length} rows
          </p>
        )}
      </div>

      {/* Meta */}
      <div style={{ marginTop: 16, padding: "12px 16px", background: "#0a0f1e", borderRadius: 8, border: "1px solid #1e293b" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#64748b" }}>
          <span>📡 Source: <strong style={{ color: "#94a3b8" }}>{meta.source}</strong></span>
          <span>📊 Trials fetched: <strong style={{ color: "#00d4b4" }}>{meta.total_trials_fetched}</strong></span>
          {meta.time_granularity && <span>⏱ Granularity: <strong style={{ color: "#94a3b8" }}>{meta.time_granularity}</strong></span>}
          {Object.entries(meta.filters || {}).map(([k, v]) => (
            <span key={k}>🔍 {k}: <strong style={{ color: "#ffd166" }}>{v}</strong></span>
          ))}
        </div>
        {meta.notes && <p style={{ margin: "8px 0 0", fontSize: 12, color: "#475569", fontStyle: "italic" }}>{meta.notes}</p>}
      </div>
    </div>
  );
}

// ── Example Queries ──
const EXAMPLES = [
  { query: "How has the number of trials for Pembrolizumab changed per year since 2015?", drug_name: "Pembrolizumab", start_year: 2015 },
  { query: "How are breast cancer trials distributed across phases?", condition: "breast cancer" },
  { query: "Which countries have the most recruiting trials for diabetes?", condition: "diabetes" },
  { query: "Show a network of sponsors and drugs for lung cancer trials", condition: "lung cancer" },
  { query: "Compare phase distribution for Pembrolizumab vs Nivolumab", drug_name: "Pembrolizumab" },
  { query: "What are the most common intervention types for Alzheimer's trials?", condition: "Alzheimer" },
];

// ── Main App ──
export default function App() {
  const [query, setQuery] = useState("");
  const [drugName, setDrugName] = useState("");
  const [condition, setCondition] = useState("");
  const [startYear, setStartYear] = useState("");
  const [endYear, setEndYear] = useState("");
  const [country, setCountry] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [useDemo, setUseDemo] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [history, setHistory] = useState([]);

  const submit = async (overridePayload) => {
    const payload = overridePayload || {
      query,
      drug_name: drugName || undefined,
      condition: condition || undefined,
      start_year: startYear ? parseInt(startYear) : undefined,
      end_year: endYear ? parseInt(endYear) : undefined,
      country: country || undefined,
      max_results: 100,
    };
    if (!payload.query) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = useDemo ? await queryViaOpenAI(payload) : await queryAgent(payload);
      setResult(data);
      setHistory(h => [{ query: payload.query, result: data, ts: new Date().toLocaleTimeString() }, ...h.slice(0, 4)]);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadExample = (ex) => {
    setQuery(ex.query);
    setDrugName(ex.drug_name || "");
    setCondition(ex.condition || "");
    setStartYear(ex.start_year ? String(ex.start_year) : "");
    setEndYear("");
    setCountry("");
  };

  return (
    <div style={{
      width: "100%",
      minHeight: "100vh",
      background: "linear-gradient(135deg, #020817 0%, #0a0f1e 50%, #050d1a 100%)",
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      color: "#e2e8f0",
      overflowX: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        @keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #0a0f1e; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
        input, textarea { outline: none; }
        button:focus { outline: none; }
      `}</style>

      <header style={{ borderBottom: "1px solid #1e293b", padding: "18px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #00d4b4, #0ea5e9)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚕</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, fontFamily: "'Playfair Display', serif", letterSpacing: -0.5 }}>
              TrialViz <span style={{ color: "#00d4b4" }}>Agent</span>
            </h1>
            <p style={{ margin: 0, fontSize: 11, color: "#475569" }}>ClinicalTrials.gov · Query-to-Visualization</p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#475569" }}>Demo mode</span>
          <button onClick={() => setUseDemo(!useDemo)} style={{
            width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
            background: useDemo ? "#00d4b4" : "#1e293b", position: "relative", transition: "background 0.2s"
          }}>
            <div style={{
              position: "absolute", top: 3, left: useDemo ? 22 : 3, width: 18, height: 18,
              borderRadius: 9, background: "#fff", transition: "left 0.2s"
            }} />
          </button>
          {useDemo && <span style={{ fontSize: 11, color: "#00d4b4", fontFamily: "monospace" }}>AI mock data</span>}
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ background: "#0d1829", borderRadius: 16, padding: 24, border: "1px solid #1e293b", marginBottom: 28 }}>
          <textarea
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && e.ctrlKey && submit()}
            placeholder="Ask anything about clinical trials… e.g. 'How has the number of Pembrolizumab trials changed per year since 2015?'"
            rows={3}
            style={{
              width: "100%", background: "#0a0f1e", border: "1px solid #1e293b",
              borderRadius: 10, padding: "14px 16px", color: "#e2e8f0", fontSize: 15,
              resize: "none", boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.5,
              transition: "border-color 0.2s"
            }}
            onFocus={e => e.target.style.borderColor = "#00d4b4"}
            onBlur={e => e.target.style.borderColor = "#1e293b"}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <input value={drugName} onChange={e => setDrugName(e.target.value)} placeholder="Drug name"
              style={{ flex: 1, minWidth: 140, background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13 }} />
            <input value={condition} onChange={e => setCondition(e.target.value)} placeholder="Condition / Disease"
              style={{ flex: 1, minWidth: 140, background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13 }} />
            <button onClick={() => setShowAdvanced(!showAdvanced)} style={{
              background: "none", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 14px",
              color: "#64748b", fontSize: 13, cursor: "pointer"
            }}>
              {showAdvanced ? "▲" : "▼"} Filters
            </button>
          </div>
          {showAdvanced && (
            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <input value={startYear} onChange={e => setStartYear(e.target.value)} placeholder="Start year"
                type="number" style={{ flex: 1, minWidth: 120, background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13 }} />
              <input value={endYear} onChange={e => setEndYear(e.target.value)} placeholder="End year"
                type="number" style={{ flex: 1, minWidth: 120, background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13 }} />
              <input value={country} onChange={e => setCountry(e.target.value)} placeholder="Country"
                style={{ flex: 1, minWidth: 120, background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13 }} />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-end", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#334155" }}>Ctrl+Enter to submit</span>
            <button onClick={() => submit()} disabled={loading || !query}
              style={{
                background: loading || !query ? "#1e293b" : "linear-gradient(135deg, #00d4b4, #0ea5e9)",
                color: loading || !query ? "#475569" : "#020817",
                border: "none", borderRadius: 10, padding: "10px 24px", fontSize: 14,
                fontWeight: 600, cursor: loading || !query ? "not-allowed" : "pointer",
                transition: "all 0.2s", fontFamily: "inherit"
              }}>
              {loading ? "⟳ Analyzing…" : "→ Visualize"}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 28 }}>
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>Example Queries</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {EXAMPLES.map((ex, i) => (
              <button key={i} onClick={() => loadExample(ex)}
                style={{
                  background: "#0d1829", border: "1px solid #1e293b", borderRadius: 20,
                  padding: "6px 14px", fontSize: 12, color: "#94a3b8", cursor: "pointer",
                  transition: "all 0.15s", whiteSpace: "nowrap"
                }}
                onMouseEnter={e => { e.target.style.borderColor = "#00d4b4"; e.target.style.color = "#00d4b4"; }}
                onMouseLeave={e => { e.target.style.borderColor = "#1e293b"; e.target.style.color = "#94a3b8"; }}>
                {ex.query.slice(0, 52)}…
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div style={{ textAlign: "center", padding: "60px 0", animation: "pulse 1.5s infinite" }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🧬</div>
            <p style={{ color: "#00d4b4", fontFamily: "monospace", fontSize: 14 }}>Querying ClinicalTrials.gov · Analyzing data…</p>
            <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 12 }}>
              {["Interpret query", "Fetch trials", "Build viz"].map((step, i) => (
                <span key={i} style={{ background: "#0d1829", border: "1px solid #1e293b", borderRadius: 12, padding: "4px 10px", fontSize: 11, color: "#475569" }}>{step}</span>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{ background: "#1a0000", border: "1px solid #ff6b6b33", borderRadius: 12, padding: "16px 20px", marginBottom: 20, animation: "fadeIn 0.3s ease" }}>
            <p style={{ margin: 0, color: "#ff6b6b", fontSize: 14 }}>⚠ {error}</p>
            {!useDemo && <p style={{ margin: "6px 0 0", color: "#475569", fontSize: 12 }}>Backend not running? Enable Demo mode (top-right) to use AI mock data.</p>}
          </div>
        )}

        {result && !loading && (
          <div style={{ background: "#0d1829", borderRadius: 16, padding: 24, border: "1px solid #1e293b", animation: "fadeIn 0.4s ease" }}>
            <VisualizationPanel result={result} />
          </div>
        )}

        {history.length > 1 && (
          <div style={{ marginTop: 32 }}>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>Recent Queries</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {history.slice(1).map((h, i) => (
                <button key={i} onClick={() => setResult(h.result)}
                  style={{ background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 10, padding: "10px 16px", textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#94a3b8", fontSize: 13 }}>{h.query.slice(0, 70)}…</span>
                  <span style={{ color: "#334155", fontSize: 11, fontFamily: "monospace" }}>{h.ts}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 24 }}>
            <details>
              <summary style={{ cursor: "pointer", color: "#475569", fontSize: 13, padding: "8px 0" }}>
                View raw JSON response
              </summary>
              <pre style={{
                marginTop: 8, background: "#0a0f1e", borderRadius: 10, padding: 16,
                fontSize: 11, color: "#64748b", overflow: "auto", maxHeight: 400,
                border: "1px solid #1e293b", fontFamily: "'JetBrains Mono', monospace"
              }}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </main>
    </div>
  );
}