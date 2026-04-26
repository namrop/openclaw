#!/usr/bin/env python3
"""
Regression tests for quick skill validation.
"""

import tempfile
from pathlib import Path
from unittest import TestCase, main

import quick_validate


class TestQuickValidate(TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_quick_validate_"))

    def tearDown(self):
        import shutil

        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def test_accepts_crlf_frontmatter(self):
        skill_dir = self.temp_dir / "crlf-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\r\nname: crlf-skill\r\ndescription: ok\r\n---\r\n# Skill\r\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertTrue(valid, message)

    def test_rejects_missing_frontmatter_closing_fence(self):
        skill_dir = self.temp_dir / "bad-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\nname: bad-skill\ndescription: missing end\n# no closing fence\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "Invalid frontmatter format")

    def test_fallback_parser_handles_multiline_frontmatter_without_pyyaml(self):
        skill_dir = self.temp_dir / "multiline-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: multiline-skill
description: Works without pyyaml
allowed-tools:
  - gh
metadata: |
  {
    "owners": ["team-openclaw"]
  }
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        previous_yaml = quick_validate.yaml
        quick_validate.yaml = None
        try:
            valid, message = quick_validate.validate_skill(skill_dir)
        finally:
            quick_validate.yaml = previous_yaml

        self.assertTrue(valid, message)

    def test_rejects_external_ingestion_without_wrapper(self):
        skill_dir = self.temp_dir / "reddit-like-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            """---
name: reddit-like-skill
description: Fetch Reddit comments
---
# Skill
Use .venv/bin/python.
""",
            encoding="utf-8",
        )
        (skill_dir / "fetch.py").write_text(
            """import urllib.request
urlopen = urllib.request.urlopen
print('download transcript comments')
""",
            encoding="utf-8",
        )

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertIn("External-content ingestion skills must wrap", message)

    def test_accepts_external_ingestion_with_wrapper_and_env_loader(self):
        skill_dir = self.temp_dir / "wrapped-social-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            """---
name: wrapped-social-skill
description: Fetch Instagram captions
---
# Skill
Use .venv/bin/python and load .env.
""",
            encoding="utf-8",
        )
        (skill_dir / "fetch.py").write_text(
            """import os, urllib.request
from external_content import load_skill_env, wrap_external_content
load_skill_env('.')
print(wrap_external_content('caption transcript'))
print(os.getenv('TOKEN'))
""",
            encoding="utf-8",
        )

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertTrue(valid, message)


if __name__ == "__main__":
    main()
