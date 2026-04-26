#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import re
import sys
from pathlib import Path
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

MAX_SKILL_NAME_LENGTH = 64

SKIP_DIR_NAMES = {".venv", "venv", "node_modules", "__pycache__", ".git"}
EXTERNAL_INGESTION_RE = re.compile(
    r"\b(YouTube|Instagram|Reddit|TikTok|Twitter|X\.com|web\s*page|article|email|sms|transcript|caption|comments?|download(?:er|ed)?|scrap(?:e|er|ing))\b",
    re.I,
)
NETWORK_OR_DOWNLOADER_RE = re.compile(
    r"\b(urlopen|requests\.(?:get|post)|httpx\.|aiohttp\.|curl\b|yt-dlp\b|instaloader\b|praw\b|BeautifulSoup|subprocess\.(?:run|check_output))",
    re.I,
)
EXTERNAL_WRAPPER_RE = re.compile(
    r"\b(wrap_external_content|wrap_external_fields|wrapExternalContent|buildSafeExternalPrompt|EXTERNAL_UNTRUSTED_CONTENT)\b|_shared/external_content\.py",
    re.I,
)
ENV_READ_RE = re.compile(r"\b(os\.environ(?:\.get)?|os\.getenv)\b")


def _iter_relevant_files(skill_path: Path):
    for path in skill_path.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIR_NAMES for part in path.parts):
            continue
        if path.suffix.lower() in {".md", ".py", ".sh", ".js", ".ts"} or path.name in {"setup.sh", "requirements.txt"}:
            yield path


def _read_joined_skill_text(skill_path: Path) -> str:
    chunks: list[str] = []
    for path in _iter_relevant_files(skill_path):
        try:
            chunks.append(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
    return "\n".join(chunks)


def _has_python_scripts(skill_path: Path) -> bool:
    return any(path.suffix == ".py" for path in _iter_relevant_files(skill_path))


def _validate_runtime_hygiene(skill_path: Path, joined_text: str) -> Optional[str]:
    if not _has_python_scripts(skill_path):
        return None
    if ".venv" not in joined_text and "python3 -m venv" not in joined_text:
        return (
            "Python-based skills must document/use a skill-local .venv runtime "
            "(for example setup.sh with `python3 -m venv .venv` and `.venv/bin/python`)."
        )
    if ENV_READ_RE.search(joined_text) and not re.search(r"\b(load_skill_env|dotenv|\.env)\b", joined_text):
        return (
            "Skills that read environment variables must document/load a skill-local .env "
            "or call a shared env loader before reading os.environ/os.getenv."
        )
    return None


def _validate_external_content_wrapping(joined_text: str) -> Optional[str]:
    appears_to_ingest_external_content = (
        EXTERNAL_INGESTION_RE.search(joined_text) is not None
        and NETWORK_OR_DOWNLOADER_RE.search(joined_text) is not None
    )
    if appears_to_ingest_external_content and EXTERNAL_WRAPPER_RE.search(joined_text) is None:
        return (
            "External-content ingestion skills must wrap agent-facing source text with "
            "the shared external-content wrapper (EXTERNAL_UNTRUSTED_CONTENT / wrap_external_content) "
            "before returning, saving, or instructing agents to read transcripts, captions, comments, articles, emails, or similar untrusted text."
        )
    return None


def _extract_frontmatter(content: str) -> Optional[str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i])
    return None


def _parse_simple_frontmatter(frontmatter_text: str) -> Optional[dict[str, str]]:
    """
    Minimal fallback parser used when PyYAML is unavailable.
    Supports simple `key: value` mappings used by SKILL.md frontmatter.
    """
    parsed: dict[str, str] = {}
    current_key: Optional[str] = None
    for raw_line in frontmatter_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        is_indented = raw_line[:1].isspace()
        if is_indented:
            if current_key is None:
                return None
            current_value = parsed[current_key]
            parsed[current_key] = (
                f"{current_value}\n{stripped}" if current_value else stripped
            )
            continue

        if ":" not in stripped:
            return None
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            return None
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        parsed[key] = value
        current_key = key
    return parsed


def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"Could not read SKILL.md: {e}"

    frontmatter_text = _extract_frontmatter(content)
    if frontmatter_text is None:
        return False, "Invalid frontmatter format"
    if yaml is not None:
        try:
            frontmatter = yaml.safe_load(frontmatter_text)
            if not isinstance(frontmatter, dict):
                return False, "Frontmatter must be a YAML dictionary"
        except yaml.YAMLError as e:
            return False, f"Invalid YAML in frontmatter: {e}"
    else:
        frontmatter = _parse_simple_frontmatter(frontmatter_text)
        if frontmatter is None:
            return (
                False,
                "Invalid YAML in frontmatter: unsupported syntax without PyYAML installed",
            )

    allowed_properties = {"uid", "name", "description", "license", "allowed-tools", "metadata"}

    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if unexpected_keys:
        allowed = ", ".join(sorted(allowed_properties))
        unexpected = ", ".join(sorted(unexpected_keys))
        return (
            False,
            f"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}",
        )

    if "name" not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if "description" not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    name = frontmatter.get("name", "")
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        if not re.match(r"^[a-z0-9-]+$", name):
            return (
                False,
                f"Name '{name}' should be hyphen-case (lowercase letters, digits, and hyphens only)",
            )
        if name.startswith("-") or name.endswith("-") or "--" in name:
            return (
                False,
                f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens",
            )
        if len(name) > MAX_SKILL_NAME_LENGTH:
            return (
                False,
                f"Name is too long ({len(name)} characters). "
                f"Maximum is {MAX_SKILL_NAME_LENGTH} characters.",
            )

    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if description:
        if "<" in description or ">" in description:
            return False, "Description cannot contain angle brackets (< or >)"
        if len(description) > 1024:
            return (
                False,
                f"Description is too long ({len(description)} characters). Maximum is 1024 characters.",
            )

    joined_text = _read_joined_skill_text(skill_path)
    runtime_hygiene_error = _validate_runtime_hygiene(skill_path, joined_text)
    if runtime_hygiene_error:
        return False, runtime_hygiene_error

    external_content_error = _validate_external_content_wrapping(joined_text)
    if external_content_error:
        return False, external_content_error

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
