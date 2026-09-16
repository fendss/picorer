from __future__ import annotations

import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class IsolationTests(unittest.TestCase):
    def test_adapter_has_no_project_source_imports(self):
        forbidden = ("src", "dist", "picorer")
        violations: list[str] = []
        for path in sorted((ROOT / "mab_adapter").glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    names = [node.module or ""]
                else:
                    continue
                if any(name == item or name.startswith(item + ".") for name in names for item in forbidden):
                    violations.append(f"{path.name}: {names}")
        self.assertEqual(violations, [])

    def test_pins_are_immutable_commits(self):
        import json

        pins = json.loads((ROOT / "pins.json").read_text(encoding="utf-8"))
        self.assertRegex(pins["benchmark"]["commit"], r"^[0-9a-f]{40}$")
        self.assertRegex(pins["dataset"]["revision"], r"^[0-9a-f]{40}$")
        self.assertNotIn("main", json.dumps(pins))


if __name__ == "__main__":
    unittest.main()
