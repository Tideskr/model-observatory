from __future__ import annotations

import unittest

from model_observatory_runner.probability_model import (
    ProbabilityModel,
    empirical_fingerprint_reliability,
    load_baseline,
)
from model_observatory_runner.release import release_file


class FingerprintReliabilityTests(unittest.TestCase):
    def test_formal_medium_sol_reliability_is_available(self) -> None:
        reliability = empirical_fingerprint_reliability(
            baseline_sha256="f4df50f1601c7ac4a81635c24032756a235f5c7cb2695d046cee30d2b482ed90",
            tier="medium",
            predicted_model="gpt-5.6-sol",
            strong_match=True,
        )
        self.assertTrue(reliability["calibration_available"])
        self.assertEqual(reliability["selected"], 48)
        self.assertEqual(reliability["correct"], 48)
        self.assertEqual(reliability["wilson95_interval"], [0.9258998703338824, 0.9999999999999999])

    def test_high_terra_reliability_is_explicitly_unavailable(self) -> None:
        reliability = empirical_fingerprint_reliability(
            baseline_sha256="f4df50f1601c7ac4a81635c24032756a235f5c7cb2695d046cee30d2b482ed90",
            tier="high",
            predicted_model="gpt-5.6-terra",
            strong_match=True,
        )
        self.assertFalse(reliability["calibration_available"])
        self.assertEqual(reliability["unavailable_reason"], "calibration_not_available")

    def test_no_weighted_family_has_no_winner(self) -> None:
        artifact = load_baseline(release_file("fingerprint_baseline"))
        contract = next(
            item
            for item in artifact["runtime_contracts"].values()
            if item["decision_level"] == "medium" and item["runtime_name"].startswith("single:")
        )
        runtime_spec = {
            "name": contract["runtime_name"],
            "cells": contract["required_samples"],
            "contracts": contract["exact_contracts"],
        }
        result = ProbabilityModel(artifact).score([], runtime_spec=runtime_spec, claimed_model="gpt-5.6-sol")
        self.assertIsNone(result["winner"])
        self.assertIsNone(result["runner_up"])
        self.assertEqual(result["fingerprint_status"], "unclear")
        self.assertEqual(result["empirical_reliability"]["unavailable_reason"], "fingerprint_not_strong")


if __name__ == "__main__":
    unittest.main()
