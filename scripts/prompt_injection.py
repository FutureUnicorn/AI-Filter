"""Resume prompt-injection pre-filter for the manual extraction script.

This is a Python port of packages/ai/src/index.ts's INJECTION_PATTERNS /
scanForPromptInjection / quarantineForInjection, not a call into that
package: extract_evidence.py is a deliberately standalone script (see its
own module docstring) with no Node runtime available to it. Keep the two
pattern lists in sync by hand -- a bypass found against one scanner is a
bypass against both, and each has its own regression suite exercising the
same sample corpus (tests/prompt-injection-regression.test.ts here,
tests/test_prompt_injection.py there).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above)\s+instructions?", re.IGNORECASE | re.DOTALL),
    re.compile(r"disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above)\s+instructions?", re.IGNORECASE | re.DOTALL),
    re.compile(r"you\s+are\s+now\s+(a|an)\s+[\w\s]{0,30}(assistant|ai\b|model|chatbot|bot|agent)\b", re.IGNORECASE | re.DOTALL),
    re.compile(r"new\s+instructions?\s*:", re.IGNORECASE | re.DOTALL),
    re.compile(r"(ignore|disregard|override|bypass|forget)[\w\s]{0,40}system\s+prompt", re.IGNORECASE | re.DOTALL),
    re.compile(r"reveal\s+(your\s+|the\s+)?(system\s+prompt|instructions)", re.IGNORECASE | re.DOTALL),
    re.compile(r"act\s+as\s+(a|an)\b.{0,40}(instead|from\s+now)", re.IGNORECASE | re.DOTALL),
    re.compile(r"do\s+not\s+(follow|apply|use)\s+(the\s+)?(rubric|criteria|scoring)", re.IGNORECASE | re.DOTALL),
    re.compile(r"overrid(e|ing)\s+(the\s+)?(evaluation|scoring|rubric)", re.IGNORECASE | re.DOTALL),
    re.compile(r"mark\s+(this|me)\s+as\s+(qualified|supported|approved|hired|a\s+match)", re.IGNORECASE | re.DOTALL),
    re.compile(r"\[\s*system\s*\]", re.IGNORECASE | re.DOTALL),
    re.compile(r"<\|im_start\|>", re.IGNORECASE | re.DOTALL),
)


@dataclass(frozen=True)
class PromptInjectionScanResult:
    detected: bool
    matched_patterns: tuple[str, ...]


def scan_for_prompt_injection(text: str) -> PromptInjectionScanResult:
    matched = tuple(pattern.pattern for pattern in INJECTION_PATTERNS if pattern.search(text))
    return PromptInjectionScanResult(detected=len(matched) > 0, matched_patterns=matched)
