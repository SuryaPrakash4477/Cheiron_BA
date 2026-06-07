"""
ClinicalTrials.gov Query-to-Visualization Agent
FastAPI Backend Service
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
import httpx
import json
import re
import os
from openai import OpenAI
from dotenv import load_dotenv
load_dotenv()

app = FastAPI(
    title="ClinicalTrials.gov Query-to-Visualization Agent",
    description="AI-enabled backend that converts natural language queries into structured visualization outputs backed by ClinicalTrials.gov API data.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
CT_API_BASE = "https://clinicaltrials.gov/api/v2"


# ─────────────────────────── Pydantic Models ────────────────────────────

class QueryRequest(BaseModel):
    query: str = Field(..., description="Natural language question about clinical trials")
    drug_name: Optional[str] = Field(None, description="Drug/intervention name filter")
    condition: Optional[str] = Field(None, description="Disease/condition filter")
    trial_phase: Optional[str] = Field(None, description="Trial phase (e.g. PHASE1, PHASE2, PHASE3, PHASE4)")
    sponsor: Optional[str] = Field(None, description="Sponsor organization filter")
    country: Optional[str] = Field(None, description="Country/location filter")
    start_year: Optional[int] = Field(None, description="Filter trials starting from this year")
    end_year: Optional[int] = Field(None, description="Filter trials ending by this year")
    max_results: Optional[int] = Field(100, description="Maximum number of trials to fetch (default: 100)")


class Citation(BaseModel):
    nct_id: str
    excerpt: str
    url: str


class VisualizationEncoding(BaseModel):
    x: Optional[Dict[str, Any]] = None
    y: Optional[Dict[str, Any]] = None
    series: Optional[Dict[str, Any]] = None
    nodes: Optional[Dict[str, Any]] = None
    edges: Optional[Dict[str, Any]] = None
    color: Optional[Dict[str, Any]] = None
    size: Optional[Dict[str, Any]] = None


class VisualizationSpec(BaseModel):
    type: str
    title: str
    encoding: VisualizationEncoding
    data: List[Dict[str, Any]]


class ResponseMeta(BaseModel):
    filters: Dict[str, Any]
    source: str = "clinicaltrials.gov"
    total_trials_fetched: int
    query_interpretation: str
    notes: Optional[str] = None
    time_granularity: Optional[str] = None
    sort_order: Optional[str] = None
    units: Optional[str] = None


class QueryResponse(BaseModel):
    visualization: VisualizationSpec
    meta: ResponseMeta


# ─────────────────────────── ClinicalTrials API Client ──────────────────

async def fetch_trials(params: dict, max_results: int = 100) -> List[Dict]:
    """Fetch trials using subprocess curl to bypass httpx blocking."""
    import subprocess
    import urllib.parse
    
    all_studies = []
    next_page_token = None
    page_size = min(max_results, 100)

    while len(all_studies) < max_results:
        request_params = {**params, "pageSize": page_size, "format": "json"}
        if next_page_token:
            request_params["pageToken"] = next_page_token

        url = f"{CT_API_BASE}/studies?" + urllib.parse.urlencode(request_params)

        result = subprocess.run(
            ["curl", "-s", "-A",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "-H", "Accept: application/json",
            "-H", "Referer: https://clinicaltrials.gov/",
            url],
            capture_output=True, timeout=30  # no text=True
        )

        if result.returncode != 0:
            raise httpx.HTTPError(f"curl failed: {result.stderr.decode('utf-8', errors='replace')}")

        try:
            data = json.loads(result.stdout.decode("utf-8"))
        except json.JSONDecodeError:
            raise httpx.HTTPError(f"Invalid response: {result.stdout[:200].decode('utf-8', errors='replace')}")

        studies = data.get("studies", [])
        all_studies.extend(studies)

        next_page_token = data.get("nextPageToken")
        if not next_page_token or len(studies) == 0:
            break

    return all_studies[:max_results]


async def fetch_trials_for_query(request: QueryRequest) -> tuple[List[Dict], Dict]:
    """Build CT API params from request and fetch data."""
    params = {}
    filters_applied = {}

    query_parts = []
    if request.drug_name:
        query_parts.append(request.drug_name)
        filters_applied["drug_name"] = request.drug_name
    if request.condition:
        query_parts.append(request.condition)
        filters_applied["condition"] = request.condition
    if request.sponsor:
        filters_applied["sponsor"] = request.sponsor

    if query_parts:
        params["query.term"] = " ".join(query_parts)

    if request.condition:
        params["query.cond"] = request.condition
    if request.drug_name:
        params["query.intr"] = request.drug_name
    if request.sponsor:
        params["query.spons"] = request.sponsor
    if request.country:
        params["query.locn"] = request.country
        filters_applied["country"] = request.country

    if request.trial_phase:
        phase_map = {
            "phase1": "PHASE1", "phase2": "PHASE2",
            "phase3": "PHASE3", "phase4": "PHASE4",
            "early_phase1": "EARLY_PHASE1", "na": "NA"
        }
        normalized = phase_map.get(request.trial_phase.lower().replace(" ", ""), request.trial_phase.upper())
        params["filter.phase"] = normalized
        filters_applied["trial_phase"] = normalized

    if request.start_year:
        filters_applied["start_year"] = request.start_year
    if request.end_year:
        filters_applied["end_year"] = request.end_year

    studies = await fetch_trials(params, request.max_results or 100)
    return studies, filters_applied


# ─────────────────────────── Data Processing Helpers ──────────────────

def extract_year(date_str: Optional[str]) -> Optional[int]:
    if not date_str:
        return None
    m = re.search(r'\b(19|20)\d{2}\b', str(date_str))
    return int(m.group()) if m else None


def get_nested(obj: dict, *keys, default=None):
    for key in keys:
        if not isinstance(obj, dict):
            return default
        obj = obj.get(key, default)
        if obj is None:
            return default
    return obj


def extract_study_fields(study: dict) -> dict:
    proto = study.get("protocolSection", {})
    id_mod = proto.get("identificationModule", {})
    status_mod = proto.get("statusModule", {})
    design_mod = proto.get("designModule", {})
    sponsors_mod = proto.get("sponsorCollaboratorsModule", {})
    conditions_mod = proto.get("conditionsModule", {})
    interventions_mod = proto.get("armsInterventionsModule", {})
    contacts_mod = proto.get("contactsLocationsModule", {})
    desc_mod = proto.get("descriptionModule", {})

    phases = design_mod.get("phases", [])
    phase = phases[0] if phases else "N/A"

    interventions = interventions_mod.get("interventions", [])
    drug_names = [i.get("name", "") for i in interventions if i.get("type") in ("DRUG", "BIOLOGICAL", "COMBINATION_PRODUCT")]

    locations = contacts_mod.get("locations", [])
    countries = list({loc.get("country", "") for loc in locations if loc.get("country")})

    sponsor_name = get_nested(sponsors_mod, "leadSponsor", "name", default="")
    sponsor_class = get_nested(sponsors_mod, "leadSponsor", "class", default="")

    start_date = get_nested(status_mod, "startDateStruct", "date", default="")
    completion_date = get_nested(status_mod, "completionDateStruct", "date", default="")

    return {
        "nct_id": id_mod.get("nctId", ""),
        "title": id_mod.get("briefTitle", ""),
        "status": status_mod.get("overallStatus", ""),
        "phase": phase,
        "start_date": start_date,
        "start_year": extract_year(start_date),
        "completion_date": completion_date,
        "completion_year": extract_year(completion_date),
        "conditions": conditions_mod.get("conditions", []),
        "interventions": drug_names,
        "intervention_types": list({i.get("type", "") for i in interventions}),
        "sponsor": sponsor_name,
        "sponsor_class": sponsor_class,
        "countries": countries,
        "brief_summary": desc_mod.get("briefSummary", "")[:300],
    }


# ─────────────────────────── Visualization Builders ─────────────────────

def build_time_series(studies: List[dict], request: QueryRequest) -> Dict:
    from collections import Counter
    years = [s["start_year"] for s in studies if s["start_year"]]
    if request.start_year:
        years = [y for y in years if y >= request.start_year]
    if request.end_year:
        years = [y for y in years if y <= request.end_year]
    counts = Counter(years)
    data = [{"year": str(y), "trial_count": counts[y]} for y in sorted(counts)]

    # add citations
    for item in data:
        item["citations"] = [
            {"nct_id": s["nct_id"], "excerpt": s["brief_summary"][:120] or s["title"],
             "url": f"https://clinicaltrials.gov/study/{s['nct_id']}"}
            for s in studies if str(s["start_year"]) == item["year"]
        ][:3]

    return {
        "visualization": {
            "type": "time_series",
            "title": f"Trials Per Year{' for ' + request.drug_name if request.drug_name else ''}{' in ' + request.condition if request.condition else ''}",
            "encoding": {"x": {"field": "year", "type": "temporal"}, "y": {"field": "trial_count", "type": "quantitative"}},
            "data": data
        },
        "time_granularity": "yearly",
        "notes": f"Based on study start dates. {len(studies)} trials analyzed."
    }


def build_phase_distribution(studies: List[dict], request: QueryRequest) -> Dict:
    from collections import Counter
    phases = [s["phase"] for s in studies if s["phase"] and s["phase"] != "N/A"]
    counts = Counter(phases)
    data = [{"phase": p, "trial_count": c} for p, c in sorted(counts.items(), key=lambda x: -x[1])]

    for item in data:
        item["citations"] = [
            {"nct_id": s["nct_id"], "excerpt": s["brief_summary"][:120] or s["title"],
             "url": f"https://clinicaltrials.gov/study/{s['nct_id']}"}
            for s in studies if s["phase"] == item["phase"]
        ][:3]

    return {
        "visualization": {
            "type": "bar_chart",
            "title": f"Trial Phase Distribution{' for ' + request.drug_name if request.drug_name else ''}{' – ' + request.condition if request.condition else ''}",
            "encoding": {"x": {"field": "phase", "type": "nominal"}, "y": {"field": "trial_count", "type": "quantitative"}},
            "data": data
        },
        "sort_order": "descending by count",
        "notes": f"{len(studies)} trials analyzed."
    }


def build_status_distribution(studies: List[dict], request: QueryRequest) -> Dict:
    from collections import Counter
    statuses = [s["status"] for s in studies if s["status"]]
    counts = Counter(statuses)
    data = [{"status": k, "trial_count": v} for k, v in sorted(counts.items(), key=lambda x: -x[1])]

    for item in data:
        item["citations"] = [
            {"nct_id": s["nct_id"], "excerpt": s["brief_summary"][:120] or s["title"],
             "url": f"https://clinicaltrials.gov/study/{s['nct_id']}"}
            for s in studies if s["status"] == item["status"]
        ][:3]

    return {
        "visualization": {
            "type": "bar_chart",
            "title": "Trial Status Distribution",
            "encoding": {"x": {"field": "status", "type": "nominal"}, "y": {"field": "trial_count", "type": "quantitative"}},
            "data": data
        },
        "notes": f"{len(studies)} trials analyzed."
    }


def build_country_distribution(studies: List[dict], request: QueryRequest) -> Dict:
    from collections import Counter
    all_countries = []
    for s in studies:
        all_countries.extend(s["countries"])
    counts = Counter(all_countries)
    top = counts.most_common(20)
    data = [{"country": c, "trial_count": n} for c, n in top]

    for item in data:
        item["citations"] = [
            {"nct_id": s["nct_id"], "excerpt": s["brief_summary"][:120] or s["title"],
             "url": f"https://clinicaltrials.gov/study/{s['nct_id']}"}
            for s in studies if item["country"] in s["countries"]
        ][:3]

    return {
        "visualization": {
            "type": "bar_chart",
            "title": f"Top Countries by Trial Count{' for ' + request.condition if request.condition else ''}",
            "encoding": {"x": {"field": "country", "type": "nominal"}, "y": {"field": "trial_count", "type": "quantitative"}},
            "data": data
        },
        "notes": "Top 20 countries shown."
    }


def build_sponsor_distribution(studies: List[dict], request: QueryRequest) -> Dict:
    from collections import Counter
    sponsor_classes = [s["sponsor_class"] for s in studies if s["sponsor_class"]]
    counts = Counter(sponsor_classes)
    data = [{"sponsor_type": k, "trial_count": v} for k, v in sorted(counts.items(), key=lambda x: -x[1])]

    for item in data:
        item["citations"] = [
            {"nct_id": s["nct_id"], "excerpt": s["brief_summary"][:120] or s["title"],
             "url": f"https://clinicaltrials.gov/study/{s['nct_id']}"}
            for s in studies if s["sponsor_class"] == item["sponsor_type"]
        ][:3]

    return {
        "visualization": {
            "type": "bar_chart",
            "title": "Trial Distribution by Sponsor Type",
            "encoding": {"x": {"field": "sponsor_type", "type": "nominal"}, "y": {"field": "trial_count", "type": "quantitative"}},
            "data": data
        },
        "notes": "Grouped by sponsor class (NIH, INDUSTRY, OTHER, FED, etc.)"
    }


def build_comparison_chart(studies: List[dict], request: QueryRequest) -> Dict:
    """Grouped bar chart comparing two drugs/conditions across phases."""
    from collections import defaultdict, Counter

    groups = defaultdict(Counter)
    label_field = "drug" if request.drug_name else "condition"

    for s in studies:
        if s["interventions"]:
            for drug in s["interventions"][:1]:
                groups[drug][s["phase"]] += 1
        elif s["conditions"]:
            for cond in s["conditions"][:1]:
                groups[cond][s["phase"]] += 1

    all_phases = sorted({phase for g in groups.values() for phase in g})
    data = []
    for label, phase_counts in list(groups.items())[:10]:
        for phase in all_phases:
            data.append({label_field: label[:30], "phase": phase, "trial_count": phase_counts.get(phase, 0)})

    return {
        "visualization": {
            "type": "grouped_bar_chart",
            "title": "Phase Comparison Across Drugs/Conditions",
            "encoding": {
                "x": {"field": "phase", "type": "nominal"},
                "y": {"field": "trial_count", "type": "quantitative"},
                "series": {"field": label_field, "type": "nominal"}
            },
            "data": data
        },
        "notes": "Top 10 entities shown."
    }


def build_network_graph(studies: List[dict], request: QueryRequest) -> Dict:
    """Build sponsor ↔ drug or drug ↔ drug co-occurrence network."""
    from collections import defaultdict, Counter

    nodes = {}
    edges_counter = Counter()

    for s in studies:
        sponsor = s["sponsor"]
        drugs = s["interventions"]

        if not drugs and not sponsor:
            continue

        # Add sponsor node
        if sponsor:
            if sponsor not in nodes:
                nodes[sponsor] = {"id": sponsor, "label": sponsor[:40], "type": "sponsor", "count": 0}
            nodes[sponsor]["count"] += 1

        # Add drug nodes and edges
        for drug in drugs[:3]:
            if drug:
                if drug not in nodes:
                    nodes[drug] = {"id": drug, "label": drug[:40], "type": "drug", "count": 0}
                nodes[drug]["count"] += 1

                if sponsor:
                    key = tuple(sorted([sponsor, drug]))
                    edges_counter[key] += 1

    # Top 30 nodes by count
    top_nodes = sorted(nodes.values(), key=lambda x: -x["count"])[:30]
    top_node_ids = {n["id"] for n in top_nodes}

    edges = [
        {"source": a, "target": b, "weight": w, "citations": [
            {"nct_id": s["nct_id"], "excerpt": s["title"][:100],
             "url": f"https://clinicaltrials.gov/study/{s['nct_id']}"}
            for s in studies if s["sponsor"] == a and b in s["interventions"]
        ][:2]}
        for (a, b), w in edges_counter.most_common(60)
        if a in top_node_ids and b in top_node_ids
    ]

    return {
        "visualization": {
            "type": "network_graph",
            "title": f"Sponsor ↔ Drug Network{' for ' + request.condition if request.condition else ''}",
            "encoding": {
                "nodes": {"field": "id", "label": "label", "color_by": "type", "size_by": "count"},
                "edges": {"source": "source", "target": "target", "weight": "weight"}
            },
            "data": {"nodes": top_nodes, "edges": edges}
        },
        "notes": "Top 30 nodes by trial count. Edge weight = number of co-occurring trials."
    }


def build_intervention_types(studies: List[dict], request: QueryRequest) -> Dict:
    from collections import Counter
    all_types = []
    for s in studies:
        all_types.extend(s["intervention_types"])
    counts = Counter(all_types)
    data = [{"intervention_type": k, "trial_count": v} for k, v in sorted(counts.items(), key=lambda x: -x[1]) if k]

    for item in data:
        item["citations"] = [
            {"nct_id": s["nct_id"], "excerpt": s["brief_summary"][:120] or s["title"],
             "url": f"https://clinicaltrials.gov/study/{s['nct_id']}"}
            for s in studies if item["intervention_type"] in s["intervention_types"]
        ][:3]

    return {
        "visualization": {
            "type": "bar_chart",
            "title": "Most Common Intervention Types",
            "encoding": {"x": {"field": "intervention_type", "type": "nominal"}, "y": {"field": "trial_count", "type": "quantitative"}},
            "data": data
        },
        "notes": "Based on intervention type classification in ClinicalTrials.gov"
    }


# ─────────────────────────── AI Agent Logic ──────────────────────────────

SYSTEM_PROMPT = """You are an expert clinical trials data analyst. Your job is to:
1. Analyze a natural language query about clinical trials
2. Determine the best visualization type to answer it
3. Return ONLY a JSON object (no markdown, no explanation) with this structure:

{
  "visualization_type": "<one of: time_series, bar_chart, grouped_bar_chart, network_graph, phase_distribution, status_distribution, country_distribution, sponsor_distribution, intervention_types, comparison>",
  "query_interpretation": "<one sentence explaining what the query is asking>",
  "notes": "<any assumptions or filters applied>",
  "needs_time_filter": <true/false>,
  "primary_entity": "<drug name or condition extracted from query, or null>"
}

Visualization type selection guide:
- time_series: queries about trends over time, per year, historically
- phase_distribution / bar_chart: queries about phase breakdown, distribution
- status_distribution: queries about trial status (recruiting, completed, etc.)
- country_distribution / geographic: queries about countries, locations
- sponsor_distribution: queries about sponsor types
- network_graph: queries about relationships, networks, co-occurrence
- grouped_bar_chart / comparison: queries comparing two or more entities
- intervention_types: queries about intervention/treatment types

Return ONLY the JSON object. No explanation, no markdown fences."""


async def classify_query(request: QueryRequest) -> dict:
    """Use OpenAI GPT-4o to classify the query and pick visualization type."""
    context_parts = [f"Query: {request.query}"]
    if request.drug_name:
        context_parts.append(f"Drug: {request.drug_name}")
    if request.condition:
        context_parts.append(f"Condition: {request.condition}")
    if request.start_year or request.end_year:
        context_parts.append(f"Year range: {request.start_year or 'unspecified'} - {request.end_year or 'unspecified'}")

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=500,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "\n".join(context_parts)}
        ]
    )

    raw = response.choices[0].message.content.strip()
    # Strip markdown fences if present
    raw = re.sub(r'^```json\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {
            "visualization_type": "bar_chart",
            "query_interpretation": request.query,
            "notes": "Defaulted to bar chart due to classification error.",
            "needs_time_filter": False,
            "primary_entity": request.drug_name or request.condition
        }


VIZ_BUILDERS = {
    "time_series": build_time_series,
    "phase_distribution": build_phase_distribution,
    "bar_chart": build_phase_distribution,
    "status_distribution": build_status_distribution,
    "country_distribution": build_country_distribution,
    "geographic": build_country_distribution,
    "sponsor_distribution": build_sponsor_distribution,
    "network_graph": build_network_graph,
    "grouped_bar_chart": build_comparison_chart,
    "comparison": build_comparison_chart,
    "intervention_types": build_intervention_types,
}


# ─────────────────────────── API Endpoints ──────────────────────────────

@app.post("/query", response_model=QueryResponse)
async def process_query(request: QueryRequest):
    """
    Main endpoint: accepts a natural language query + optional filters,
    returns a structured visualization specification backed by real ClinicalTrials.gov data.
    """
    # Step 1: AI classifies the query
    classification = await classify_query(request)
    viz_type = classification.get("visualization_type", "bar_chart")

    # Step 2: Fetch real data from ClinicalTrials.gov
    try:
        raw_studies, filters_applied = await fetch_trials_for_query(request)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"ClinicalTrials.gov API error: {str(e)}")

    if not raw_studies:
        raise HTTPException(status_code=404, detail="No trials found matching the given criteria.")

    # Step 3: Extract structured fields from raw API response
    studies = [extract_study_fields(s) for s in raw_studies]

    # Step 4: Build visualization
    builder = VIZ_BUILDERS.get(viz_type, build_phase_distribution)
    result = builder(studies, request)

    # Step 5: Normalize network graph data (dict → list wrapper)
    viz = result["visualization"]
    if viz["type"] == "network_graph" and isinstance(viz["data"], dict):
        viz["data"] = [viz["data"]]


    # Step 6: Assemble response
    return {
        "visualization": viz,
        "meta": {
            "filters": filters_applied,
            "source": "clinicaltrials.gov",
            "total_trials_fetched": len(studies),
            "query_interpretation": classification.get("query_interpretation", request.query),
            "notes": result.get("notes") or classification.get("notes"),
            "time_granularity": result.get("time_granularity"),
            "sort_order": result.get("sort_order"),
            "units": result.get("units"),
        }
    }


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "ClinicalTrials Query-to-Visualization Agent"}


@app.get("/schema")
async def get_schema():
    """Returns documented request/response schema."""
    return {
        "request_schema": {
            "query": {"type": "string", "required": True, "description": "Natural language question about clinical trials"},
            "drug_name": {"type": "string", "required": False, "description": "Drug/intervention name filter"},
            "condition": {"type": "string", "required": False, "description": "Disease/condition filter"},
            "trial_phase": {"type": "string", "required": False, "description": "Phase filter: PHASE1, PHASE2, PHASE3, PHASE4"},
            "sponsor": {"type": "string", "required": False, "description": "Sponsor name filter"},
            "country": {"type": "string", "required": False, "description": "Country/location filter"},
            "start_year": {"type": "integer", "required": False, "description": "Filter trials starting from this year"},
            "end_year": {"type": "integer", "required": False, "description": "Filter trials ending by this year"},
            "max_results": {"type": "integer", "required": False, "default": 100, "description": "Max trials to fetch"}
        },
        "response_schema": {
            "visualization": {
                "type": "string (bar_chart | time_series | grouped_bar_chart | network_graph | ...)",
                "title": "string",
                "encoding": {"x": "field mapping", "y": "field mapping", "series": "optional for grouped", "nodes/edges": "for network graphs"},
                "data": "array of data point objects with optional citations array"
            },
            "meta": {
                "filters": "object of applied filters",
                "source": "clinicaltrials.gov",
                "total_trials_fetched": "integer",
                "query_interpretation": "string - AI interpretation of the query",
                "notes": "string - assumptions and filter notes",
                "time_granularity": "string (yearly/monthly) if applicable",
                "sort_order": "string if applicable",
                "units": "string if applicable"
            }
        },
        "supported_visualization_types": [
            "bar_chart", "grouped_bar_chart", "time_series",
            "network_graph", "phase_distribution", "status_distribution",
            "country_distribution", "sponsor_distribution", "intervention_types"
        ]
    }


@app.get("/test-ct-api")
async def test_ct_api():
    import subprocess
    result = subprocess.run(
        ["curl", "-s", "-A",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
         "-H", "Accept: application/json",
         "-H", "Referer: https://clinicaltrials.gov/",
         "https://clinicaltrials.gov/api/v2/studies?query.intr=Pembrolizumab&pageSize=5&format=json"],
        capture_output=True, timeout=30  # no text=True — get raw bytes
    )
    try:
        data = json.loads(result.stdout.decode("utf-8"))
        return {"status": 200, "ok": True, "count": len(data.get("studies", []))}
    except Exception as e:
        return {"status": "failed", "error": str(e), "stdout": result.stdout[:300].decode("utf-8", errors="replace")}