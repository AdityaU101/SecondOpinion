"""
Pydantic schemas — the single source of truth for every
data shape in ClearChart. All layers speak these types.
"""
from __future__ import annotations
from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel, Field


# ── ENUMS ─────────────────────────────────────────────────

class UrgencyLevel(str, Enum):
    URGENT  = "urgent"   # needs prompt medical attention
    WATCH   = "watch"    # worth discussing at next appointment
    ROUTINE = "routine"  # nothing actionable detected


class FindingStatus(str, Enum):
    HIGH     = "high"
    LOW      = "low"
    ABNORMAL = "abnormal"
    NORMAL   = "normal"


class Severity(str, Enum):
    CRITICAL = "critical"
    MODERATE = "moderate"
    MILD     = "mild"
    NORMAL   = "normal"


class JobStatus(str, Enum):
    PENDING    = "pending"
    PROCESSING = "processing"
    COMPLETED  = "completed"
    FAILED     = "failed"


# ── REPORT COMPONENTS ─────────────────────────────────────

class Finding(BaseModel):
    """A single abnormal (or normal) value from the document."""
    parameter:       str            = Field(..., description="Lab test or metric name")
    value:           str            = Field(..., description="Patient's actual value with units")
    reference_range: Optional[str] = Field(None, description="Normal reference range e.g. '70–99 mg/dL'")
    status:          FindingStatus
    severity:        Severity
    explanation:     str            = Field(..., description="Plain-English explanation for a non-medical reader")
    # Numeric fields powering the "healthy vs you" comparison chart in the UI.
    # ref_high uses a large sentinel (e.g. 9999) for open-ended "greater-than" ranges.
    numeric_value:   Optional[float] = Field(None, description="Parsed patient value as a number")
    ref_low:         Optional[float] = Field(None, description="Lower bound of the healthy range")
    ref_high:        Optional[float] = Field(None, description="Upper bound of the healthy range")
    unit:            Optional[str]   = Field(None, description="Measurement unit, e.g. 'mg/dL'")


class DoctorQuestion(BaseModel):
    """A specific, cited question for the patient to bring to their doctor."""
    question: str
    context:  str = Field(..., description="Why this question is relevant, in plain language")
    citation: Optional[str] = None


class Citation(BaseModel):
    """A reference to a clinical guideline used in this report."""
    source:  str            = Field(..., description="Guideline name and publisher")
    passage: str            = Field(..., description="Exact passage from the guideline")
    url:     Optional[str] = None


class HealthDomain(BaseModel):
    """One body-system score for the visual health snapshot chart."""
    area:   str            = Field(..., description="Body system, e.g. 'Blood Sugar', 'Cholesterol / Heart'")
    score:  int            = Field(..., ge=0, le=100, description="0–100 wellness score (100 = fully healthy)")
    status: str            = Field("watch", description="good | watch | concern")
    note:   Optional[str] = Field(None, description="One-line plain-language note")


# ── FULL REPORT ───────────────────────────────────────────

class AnalysisReport(BaseModel):
    """
    The complete output of ClearChart's analysis pipeline.
    This is what the frontend renders and what gets exported as PDF.
    """
    urgency:              UrgencyLevel
    summary:              str         = Field(..., description="150-word plain-language summary")
    patient_context:      Optional[str] = Field(None, description="What document type was detected and what was found")
    findings:             list[Finding]
    questions_for_doctor: list[DoctorQuestion]
    citations:            list[Citation]
    health_snapshot:      list[HealthDomain] = Field(default_factory=list, description="Per-system scores for the visual chart")
    confidence_score:     float       = Field(..., ge=0.0, le=1.0, description="0–1 model confidence")
    disclaimer:           str


# ── API REQUEST / RESPONSE SHAPES ─────────────────────────

class TextAnalysisRequest(BaseModel):
    """Body for POST /analyze/text"""
    text: str = Field(..., min_length=50, description="Medical text to analyze (min 50 chars)")


class JobCreatedResponse(BaseModel):
    """Returned immediately when a job is submitted."""
    job_id:  str
    status:  str
    message: str


class JobStatusResponse(BaseModel):
    """Returned when polling GET /jobs/{job_id}"""
    job_id:   str
    status:   JobStatus
    progress: int             = Field(default=0, ge=0, le=100, description="Completion percentage 0–100")
    result:   Optional[AnalysisReport] = None
    error:    Optional[str]   = None


# ── INTERNAL INGESTION TYPES ──────────────────────────────

class DocumentChunk(BaseModel):
    """A single chunk of the parsed document, ready for embedding."""
    chunk_id:    str
    source_name: str
    text:        str
    char_start:  int
    char_end:    int
    page:        Optional[int] = None


class EmbeddedChunk(BaseModel):
    """A chunk with its embedding vector attached."""
    chunk:     DocumentChunk
    embedding: list[float]


class RetrievedPassage(BaseModel):
    """A guideline passage retrieved by the RAG system."""
    source:    str
    passage:   str
    url:       Optional[str]
    score:     float          = Field(..., description="Relevance score 0–1")
