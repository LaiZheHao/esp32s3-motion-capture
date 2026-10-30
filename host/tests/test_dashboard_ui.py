import re
from pathlib import Path
import unittest


WEB = Path(__file__).resolve().parents[1] / "web"


class DashboardUiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (WEB / "index.html").read_text(encoding="utf-8")
        cls.css = (WEB / "style.css").read_text(encoding="utf-8")
        cls.javascript = "\n".join(
            (WEB / name).read_text(encoding="utf-8")
            for name in ("app.js", "body_app.js", "direction_app.js")
        )

    def test_interactive_element_ids_are_unique_and_resolvable(self):
        ids = re.findall(r'\bid=["\']([^"\']+)', self.html)
        self.assertEqual(len(ids), len(set(ids)))
        referenced = set(re.findall(r'(?:byId|\$)\(["\']([^"\']+)', self.javascript))
        referenced -= {"map", "sign"}  # prefixes used by the dynamic XYZ controls
        self.assertFalse(referenced - set(ids), f"missing DOM ids: {sorted(referenced - set(ids))}")

    def test_daily_workflows_remain_available(self):
        required = {
            "transport", "connect", "bodySlots", "zero", "calibrate",
            "bodyInitBegin", "directionNeutralStart", "bodyRecord", "bodySessions",
            "loadReplay", "bodyFixed", "accChart", "gyroChart", "magChart",
            "advanced", "bodyDiagnosticLayers",
        }
        ids = set(re.findall(r'\bid=["\']([^"\']+)', self.html))
        self.assertFalse(required - ids)

    def test_reference_art_is_not_used_as_dashboard_content(self):
        combined = self.html + self.css
        self.assertNotIn("dashboard-glass-v1.png", combined)
        self.assertNotIn("calibration-glass-v1.png", combined)

    def test_layout_has_explicit_narrow_screen_overflow_protection(self):
        compact = re.sub(r"\s+", "", self.css)
        self.assertIn("overflow-x:hidden", compact)
        self.assertIn("@media(max-width:780px)", compact)
        self.assertIn("minmax(0,1fr)", compact)


if __name__ == "__main__":
    unittest.main()
