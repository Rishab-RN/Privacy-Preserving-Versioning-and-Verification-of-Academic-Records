import unittest

from model import budget_order, validation_threshold
from simulate import HELD_OUT, SEEDS, SPLIT_SIZES, simulate


class SimulationTest(unittest.TestCase):
    def test_streams_are_reproducible_and_chronological(self):
        first = simulate(SEEDS[0])
        self.assertEqual(first, simulate(SEEDS[0]))
        self.assertNotEqual(first, simulate(SEEDS[1]))
        facts, annotations = first
        times = [fact["occurred_at"] for fact in facts]
        self.assertEqual(len(facts), sum(SPLIT_SIZES.values()))
        self.assertEqual(times, sorted(set(times)))
        for fact in facts:
            self.assertNotEqual(fact["proposer_id"], fact["decider_id"])
            if fact["delta_hundredths"] is not None:
                self.assertLessEqual(abs(fact["delta_hundredths"]), 1000)
        self.assertTrue(any(item["family"] == "benign_unusual" for item in annotations))

    def test_actor_chain_and_family_holdouts(self):
        facts, annotations = simulate(SEEDS[0])
        used = set()
        offset = 0
        for split, size in SPLIT_SIZES.items():
            cohort = facts[offset:offset + size]
            labels = annotations[offset:offset + size]
            groups = {fact[key] for fact in cohort
                      for key in ("record_id", "proposer_id", "decider_id", "student_id", "digest")}
            self.assertFalse(used.intersection(groups))
            used.update(groups)
            self.assertTrue(all(item["split"] == split for item in labels))
            self.assertEqual(any(item["family"] == HELD_OUT for item in labels), split == "test")
            offset += size

    def test_review_budget_is_independent_of_labels(self):
        rows = [
            {"occurredAt": "2025-01-01", "requestId": "b"},
            {"occurredAt": "2025-01-01", "requestId": "a"},
            {"occurredAt": "2025-01-02", "requestId": "c"},
        ]
        self.assertEqual(budget_order(rows, [0.8, 0.8, 0.6]), [1, 0, 2])
        self.assertEqual(validation_threshold([0.8, 0.6] + [0.5] * 9), 0.6)


if __name__ == "__main__":
    unittest.main()
