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
    re.compile(r"ignore (all |any )?(the )?(previous|prior|above) instructions?", re.IGNORECASE),
    re.compile(r"disregard (all |any )?(the )?(previous|prior|above) instructions?", re.IGNORECASE),
    re.compile(r"you are now (a|an) [\w\s]{0,30}(assistant|ai\b|model|chatbot|bot|agent)\b", re.IGNORECASE),
    re.compile(r"new instructions?:", re.IGNORECASE),
    re.compile(r"(ignore|disregard|override|bypass|forget)[\w\s]{0,40}system prompt", re.IGNORECASE),
    re.compile(r"reveal (your |the )?(system prompt|instructions)", re.IGNORECASE),
    re.compile(r"act as (a|an)\b.{0,40}(instead|from now)", re.IGNORECASE),
    re.compile(r"do not (follow|apply|use) (the )?(rubric|criteria|scoring)", re.IGNORECASE),
    re.compile(r"overrid(e|ing) (the )?(evaluation|scoring|rubric)", re.IGNORECASE),
    re.compile(r"mark (this|me) as (qualified|supported|approved|hired|a match)", re.IGNORECASE),
    re.compile(r"\[\s*system\s*\]", re.IGNORECASE),
    re.compile(r"<\|im_start\|>", re.IGNORECASE),
)


@dataclass(frozen=True)
class PromptInjectionScanResult:
    detected: bool
    matched_patterns: tuple[str, ...]


def scan_for_prompt_injection(text: str) -> PromptInjectionScanResult:
    matched = tuple(pattern.pattern for pattern in INJECTION_PATTERNS if pattern.search(text))
    return PromptInjectionScanResult(detected=len(matched) > 0, matched_patterns=matched)
