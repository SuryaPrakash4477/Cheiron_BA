# ClinicalTrials.gov Query-to-Visualization Agent

An AI-enabled backend service that converts natural language questions about clinical trials into structured visualization outputs backed by live **ClinicalTrials.gov API** data. Includes an optional React frontend demo.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Setup & Installation](#setup--installation)
4. [Configuration (.env)](#configuration-env)
5. [Running the Service](#running-the-service)
6. [Request / Response Schema](#request--response-schema)
7. [Supported Visualization Types](#supported-visualization-types)
8. [Example Queries & Outputs](#example-queries--outputs)
9. [API Endpoints](#api-endpoints)
10. [Key Design Decisions & Tradeoffs](#key-design-decisions--tradeoffs)
11. [Limitations & Future Improvements](#limitations--future-improvements)
12. [AI Tools Used](#ai-tools-used)
13. [Assessment Requirements Checklist](#assessment-requirements-checklist)

---

## Project Overview

**Primary goal:** Accept a natural language clinical-trials query, fetch live data from ClinicalTrials.gov, classify the best visualization type with GPT-4o-mini, build the chart data, and return a fully structured JSON visualization spec a frontend can render without further guessing.

**Stack:**
- **Backend:** Python 3.11 · FastAPI · OpenAI SDK · `httpx` / `curl`
- **Frontend (optional demo):** React (Vite) · Recharts · vanilla inline styles

---

## Architecture

```
User Query (NL)
      │
      ▼
┌─────────────────────────────────────────────────┐
│              FastAPI  /query  endpoint           │
│                                                  │
│  1. classify_query()  ──► GPT-4o-mini            │
│     → visualization_type, query_interpretation  │
│                                                  │
│  2. fetch_trials_for_query()                     │
│     → build ClinicalTrials.gov v2 API params    │
│     → paginate via curl subprocess              │
│                                                  │
│  3. extract_study_fields()  (per study)          │
│     → normalise NCT fields into flat dict       │
│                                                  │
│  4. VIZ_BUILDERS[viz_type](studies, request)    │
│     → build typed visualization spec + citations│
│                                                  │
│  5. Return QueryResponse JSON                    │
└─────────────────────────────────────────────────┘
      │
      ▼
Structured JSON  ──► React Frontend (optional)
```

### AI / Agent Design

The AI layer is deliberately narrow and deterministic:

- **GPT-4o-mini** is only used to _classify_ the query (choose a visualization type and extract the primary entity). It is **not** used to generate numbers, filter logic, or data—those all come from live API calls.
- The system prompt constrains the model to return a strict JSON object with a fixed schema, with `response_format: json_object` enforced.
- A fallback value (`bar_chart`) is used if classification fails, so the service always returns usable output.
- All data aggregation and citation extraction is deterministic Python code.

---

## Setup & Installation

### Prerequisites

- Python 3.10+
- Node.js 18+ (only for the optional frontend)
- `curl` available on PATH (used internally to call the ClinicalTrials.gov API)
- An OpenAI API key

### Backend

```bash
# 1. Clone / unzip the project
cd clinical-trials-agent

# 2. Create and activate a virtual environment
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Create your .env file (see section below)
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

### Frontend (optional)

```bash
cd frontend          # or wherever App.jsx / main.jsx live
npm install
npm run dev          # starts at http://localhost:5173
```

---

## Configuration (.env)

Create a `.env` file in the project root. **Do not commit this file.**

```env
OPENAI_API_KEY=sk-...your-key-here...
```

A `.env.example` file is provided as a template:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

> **Security note:** The `.env` file is listed in `.gitignore` and must never be committed. The backend reads the key via `python-dotenv` (`load_dotenv()`). The frontend uses a `VITE_` prefixed variable read at build time — see `App.jsx` for details.

---

## Running the Service

```bash
# Make sure venv is active and .env exists
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`.

Interactive docs: `http://localhost:8000/docs`

---

## Request / Response Schema

### POST `/query`

#### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | ✅ Yes | Natural language question about clinical trials |
| `drug_name` | `string` | No | Drug / intervention name filter |
| `condition` | `string` | No | Disease / condition filter |
| `trial_phase` | `string` | No | Phase filter: `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`, `EARLY_PHASE1`, `NA` |
| `sponsor` | `string` | No | Sponsor organization filter |
| `country` | `string` | No | Country / location filter |
| `start_year` | `integer` | No | Include trials starting from this year |
| `end_year` | `integer` | No | Include trials ending by this year |
| `max_results` | `integer` | No | Max trials to fetch (default: 100) |

**Example request:**

```json
{
  "query": "How has the number of trials for Pembrolizumab changed per year since 2015?",
  "drug_name": "Pembrolizumab",
  "start_year": 2015
}
```

#### Response Body

```json
{
  "visualization": {
    "type": "time_series",
    "title": "Trials Per Year for Pembrolizumab",
    "encoding": {
      "x": { "field": "year", "type": "temporal" },
      "y": { "field": "trial_count", "type": "quantitative" }
    },
    "data": [
      {
        "year": "2015",
        "trial_count": 32,
        "citations": [
          {
            "nct_id": "NCT02407405",
            "excerpt": "A Phase 3 randomized study evaluating pembrolizumab...",
            "url": "https://clinicaltrials.gov/study/NCT02407405"
          }
        ]
      }
    ]
  },
  "meta": {
    "filters": { "drug_name": "Pembrolizumab", "start_year": 2015 },
    "source": "clinicaltrials.gov",
    "total_trials_fetched": 100,
    "query_interpretation": "Trend of Pembrolizumab trial starts per year from 2015 onward",
    "notes": "Based on study start dates. 100 trials analyzed.",
    "time_granularity": "yearly",
    "sort_order": null,
    "units": null
  }
}
```

#### Response Field Reference

| Field | Type | Description |
|---|---|---|
| `visualization.type` | `string` | Visualization type (see supported types below) |
| `visualization.title` | `string` | Human-readable chart title |
| `visualization.encoding` | `object` | Maps data fields to visual channels (`x`, `y`, `series`, `nodes`, `edges`, `color`, `size`) |
| `visualization.data` | `array` | Data points. Each may include a `citations` array |
| `visualization.data[].citations[].nct_id` | `string` | ClinicalTrials.gov trial ID |
| `visualization.data[].citations[].excerpt` | `string` | Relevant text excerpt from the trial record |
| `visualization.data[].citations[].url` | `string` | Direct link to the trial on ClinicalTrials.gov |
| `meta.filters` | `object` | Filters that were applied to the API query |
| `meta.source` | `string` | Always `"clinicaltrials.gov"` |
| `meta.total_trials_fetched` | `integer` | Number of trials retrieved from the API |
| `meta.query_interpretation` | `string` | AI's one-sentence reading of the query |
| `meta.notes` | `string` | Assumptions, filter notes, or caveats |
| `meta.time_granularity` | `string \| null` | `"yearly"` for time series, otherwise null |
| `meta.sort_order` | `string \| null` | Sorting description if applicable |
| `meta.units` | `string \| null` | Unit descriptor if applicable |

---

## Supported Visualization Types

| Type | Description | Triggered by queries about… |
|---|---|---|
| `time_series` | Line chart of trial counts over time | Trends, per year, historically |
| `bar_chart` | Simple bar chart | Phase distributions, generic counts |
| `grouped_bar_chart` | Multi-series bar chart | Comparisons between drugs or conditions |
| `network_graph` | Node/edge graph | Sponsor ↔ drug relationships, co-occurrence |
| `phase_distribution` | Bar chart by phase | Phase breakdown |
| `status_distribution` | Bar chart by status | Recruiting / completed / terminated counts |
| `country_distribution` | Bar chart by country (top 20) | Geographic patterns |
| `sponsor_distribution` | Bar chart by sponsor class | Sponsor type breakdown |
| `intervention_types` | Bar chart by intervention type | Drug vs device vs biological etc. |

### Network Graph Data Format

For `network_graph`, `visualization.data` is a single-element array wrapping a `{nodes, edges}` object:

```json
"data": [
  {
    "nodes": [
      { "id": "Pfizer", "label": "Pfizer", "type": "sponsor", "count": 12 }
    ],
    "edges": [
      {
        "source": "Pfizer", "target": "Nivolumab", "weight": 5,
        "citations": [ { "nct_id": "NCT...", "excerpt": "...", "url": "..." } ]
      }
    ]
  }
]
```

---

## Example Queries & Outputs

### 1. Time Trend

```json
{
  "query": "How has the number of Pembrolizumab trials changed per year since 2015?",
  "drug_name": "Pembrolizumab",
  "start_year": 2015
}
```

**Output type:** `time_series` — yearly trial counts from 2015 to present with up to 3 citations per year bucket.

---

### 2. Phase Distribution

```json
{
  "query": "How are breast cancer trials distributed across phases?",
  "condition": "breast cancer"
}
```

**Output type:** `bar_chart` — trial counts grouped by phase (PHASE1, PHASE2, PHASE3…), sorted descending.

---

### 3. Geographic Patterns

```json
{
  "query": "Which countries have the most recruiting trials for diabetes?",
  "condition": "diabetes"
}
```

**Output type:** `bar_chart` — top 20 countries by number of trials, with citations linking to representative trials.

---

### 4. Sponsor–Drug Network

```json
{
  "query": "Show a network of sponsors and drugs for lung cancer trials",
  "condition": "lung cancer"
}
```

**Output type:** `network_graph` — top 30 nodes (sponsors teal, drugs red), edges weighted by co-occurrence count.

---

### 5. Intervention Types

```json
{
  "query": "What are the most common intervention types for Alzheimer's trials?",
  "condition": "Alzheimer"
}
```

**Output type:** `bar_chart` — DRUG / BIOLOGICAL / DEVICE / BEHAVIORAL counts with citations.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/query` | Main endpoint — accepts NL query, returns visualization spec |
| `GET` | `/health` | Health check — returns `{"status": "ok"}` |
| `GET` | `/schema` | Returns documented request + response schemas as JSON |
| `GET` | `/test-ct-api` | Debug: verifies live connectivity to ClinicalTrials.gov API |
| `GET` | `/docs` | Swagger UI (auto-generated by FastAPI) |

---

## Key Design Decisions & Tradeoffs

### 1. Narrow AI scope (avoid hallucination)
The LLM (GPT-4o-mini) is only responsible for _intent classification_ — it picks a chart type and extracts the primary entity. All data aggregation, filtering, and citation generation is deterministic Python. This keeps the LLM in a role it cannot hallucinate numbers in.

### 2. curl subprocess for ClinicalTrials.gov
The ClinicalTrials.gov v2 API intermittently blocks `httpx` requests with a 406/403 response due to user-agent checks. Using `subprocess.run(["curl", ...])` with a browser-like User-Agent header and a Referer header resolves this reliably. Tradeoff: slightly less clean than pure-Python async, but far more robust in practice.

### 3. Structured JSON output enforced
`response_format: {"type": "json_object"}` is passed to the OpenAI call, plus a strict system prompt and a JSON fallback on parse error, ensuring the classification step never crashes the pipeline.

### 4. Deep citations on every data point
Every aggregated data point includes up to 3 `{nct_id, excerpt, url}` citations drawn directly from the raw API response. This satisfies the bonus requirement and also makes the output auditable — a frontend can show exactly which trials back each bar or line point.

### 5. Single coherent pipeline
The same `fetch → extract → classify → build` pipeline handles all 9 visualization types. Adding a new type only requires registering a builder function in `VIZ_BUILDERS`. This avoids one-off hacks for specific query classes.

### 6. Frontend as a demo layer only
The React frontend (`App.jsx`) is a convenience demo. The backend is the deliverable; the frontend simply renders whatever the `/query` endpoint returns, with no business logic of its own.

---

## Limitations & Future Improvements

- **Pagination depth:** Max 100 trials fetched by default. For very broad queries (e.g., all diabetes trials) this is a sample. Increasing `max_results` raises latency proportionally.
- **Date filtering is post-fetch:** `start_year` / `end_year` are applied client-side after fetching because ClinicalTrials.gov v2 does not expose a clean year-range filter. A future improvement would use `filter.advanced` with date range expressions.
- **Comparison chart is single-filter:** The `grouped_bar_chart` builder uses the _first_ drug or condition per study. A richer implementation would accept two explicit drug/condition parameters for true A vs B comparison.
- **Network graph layout is circular:** Nodes are positioned on concentric circles. A force-directed layout (e.g., D3 force) would produce more meaningful spatial groupings.
- **No caching:** Every request fetches fresh data. A Redis / TTL cache layer would dramatically reduce latency for repeated queries.
- **OpenAI key in frontend:** The demo `App.jsx` requires a `VITE_OPENAI_API_KEY` environment variable for the fallback demo mode. This key is only used client-side for the AI mock fallback, not for real data queries.

---

## AI Tools Used

- **Claude (Anthropic):** Used for iterative code generation, architecture review, and README drafting.
- **GPT-4o-mini (OpenAI):** Used at runtime for query classification (intent → visualization type).
- **Design reasoning:** The pipeline architecture (narrow AI + deterministic data layer), the curl workaround for ClinicalTrials.gov, and the citation extraction logic were deliberately designed and validated, not generated wholesale.
- **Validation approach:** Each visualization type was tested manually with 2–3 queries against the live API. The `/test-ct-api` endpoint was used to verify connectivity independently of the main pipeline.

---

## Assessment Requirements Checklist

| Requirement | Status | Notes |
|---|---|---|
| Accept `query` (string) input | ✅ | Required field in `QueryRequest` |
| Optional structured input fields | ✅ | `drug_name`, `condition`, `trial_phase`, `sponsor`, `country`, `start_year`, `end_year`, `max_results` |
| Interpret the natural language query | ✅ | GPT-4o-mini classifies intent → viz type |
| Fetch data from ClinicalTrials.gov API | ✅ | Live v2 API, paginated, via curl |
| Return structured visualization spec | ✅ | `visualization.{type, title, encoding, data}` |
| `type` field in visualization | ✅ | 9 supported types |
| `title` field | ✅ | Auto-generated, human-readable |
| `encoding` field (x/y/series/nodes/edges) | ✅ | Per-type field mappings |
| `data` array | ✅ | Populated from live API |
| Response metadata (`meta`) | ✅ | `filters`, `source`, `total_trials_fetched`, `query_interpretation`, `notes`, `time_granularity`, `sort_order`, `units` |
| Document request schema | ✅ | This README + `/schema` endpoint |
| Document response schema | ✅ | This README + `/schema` endpoint |
| Multiple visualization types | ✅ | 9 types: bar, grouped bar, time series, network graph, status, country, sponsor, phase, intervention |
| Network graph support | ✅ | `build_network_graph()` — sponsor ↔ drug edges |
| Time-series / trend support | ✅ | `build_time_series()` |
| Geographic / country support | ✅ | `build_country_distribution()` |
| Comparison / grouped bar | ✅ | `build_comparison_chart()` |
| Single coherent approach (no one-off hacks) | ✅ | Unified `VIZ_BUILDERS` dispatch table |
| **Bonus: Deep citations** | ✅ | Every data point includes `citations: [{nct_id, excerpt, url}]` |
| Frontend demo | ✅ | React app with bar, line, grouped bar, network graph renderers |
| README with install/run instructions | ✅ | This document |
| README with design decisions & tradeoffs | ✅ | See section above |
| README with limitations | ✅ | See section above |
| 3–5 example queries with JSON outputs | ✅ | See [Example Queries](#example-queries--outputs) section |
| Code quality — readability / documentation | ✅ | Inline comments, section headers, type hints throughout |
| `.env` not committed | ✅ | `.env` in `.gitignore`; `.env.example` provided |