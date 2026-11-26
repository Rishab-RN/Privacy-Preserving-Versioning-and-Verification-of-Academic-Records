"""Isolate rare correction patterns and measure a fixed review budget."""

from math import ceil

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score


TABULAR = ("delta", "missingDelta", "record30d", "course30d", "proposer30d")
GRAPH = TABULAR + ("pair30d", "evidence30d")
PROFILE = "isolation-forest-graph-v1"
FEATURE_SCHEMA = "decision-features-v1"
BUDGET = 0.10
FOREST = {"n_estimators": 128, "max_samples": 256, "n_jobs": 1, "contamination": "auto"}
RULES = {
    "delta": 250,
    "record30d": 10,
    "proposer30d": 65,
    "pair30d": 22,
    "evidence30d": 20,
}


def matrix(rows, keys):
    return np.array([[row["features"][key] for key in keys] for row in rows], dtype=np.float32)


def rule_signals(features):
    return [(key, abs(features[key]) / limit) for key, limit in RULES.items()]


def rule_scores(rows):
    return np.asarray([sum(max(0, ratio - 1) for _, ratio in rule_signals(row["features"])) for row in rows])


def fit(rows, keys, seed):
    data = matrix(rows, keys)
    return IsolationForest(random_state=seed, **FOREST).fit(data), np.median(data, axis=0)


def ml_scores(model, rows, keys):
    return -model.score_samples(matrix(rows, keys)) if rows else np.array([])


def budget_order(rows, scores):
    return sorted(range(len(rows)), key=lambda index: (-scores[index], rows[index]["occurredAt"],
                                                        rows[index]["requestId"]))


def validation_threshold(scores):
    ordered = sorted(map(float, scores), reverse=True)
    return ordered[ceil(len(ordered) * BUDGET) - 1]


def measure(rows, annotations, scores, threshold):
    labels = np.asarray([item["anomaly"] for item in annotations], dtype=bool)
    order = budget_order(rows, scores)
    budget = ceil(BUDGET * len(order))
    selected = np.zeros(len(order), dtype=bool)
    selected[order[:budget]] = True
    flagged = scores >= threshold
    true_positive = int(sum(labels & selected))
    unusual = np.asarray([item["family"] == "benign_unusual" for item in annotations], dtype=bool)
    families = {}
    for family in sorted(set(item["family"] for item in annotations)):
        population = np.asarray([item["family"] == family for item in annotations], dtype=bool)
        families[family] = {
            "total": int(sum(population)),
            "reviewedAtBudget": int(sum(population & selected)),
            "aboveValidationCutoff": int(sum(population & flagged)),
        }
    return {
        "averagePrecision": float(average_precision_score(labels, scores)),
        "reviewBudgetCount": budget,
        "precisionAtBudget": true_positive / budget,
        "recallAtBudget": true_positive / int(sum(labels)),
        "falsePositiveRateAtBudget": int(sum(~labels & selected)) / int(sum(~labels)),
        "unusualBenignReviewedAtBudget": int(sum(unusual & selected)),
        "validationCutoff": threshold,
        "reviewedAtCutoff": int(sum(flagged)),
        "falsePositiveRateAtCutoff": int(sum(~labels & flagged)) / int(sum(~labels)),
        "family": families,
    }


def explanations(model, baseline, rows, scores):
    if not rows:
        return []
    data = matrix(rows, GRAPH)
    effects = np.empty((len(rows), len(GRAPH)))
    for index, median in enumerate(baseline):
        perturbed = data.copy()
        perturbed[:, index] = median
        effects[:, index] = scores + model.score_samples(perturbed)
    return [
        {
            "signals": [
                {"feature": GRAPH[index], "value": row["features"][GRAPH[index]],
                 "effect": round(float(effect[index]), 6)}
                for index in np.argsort(-effect, kind="stable")[:3] if effect[index] > 0.000001
            ],
            "rules": [key for key, ratio in rule_signals(row["features"]) if ratio > 1],
        }
        for row, effect in zip(rows, effects, strict=True)
    ]
