"""Train the lab profile and publish an advisory snapshot for scoped review."""

import argparse
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
from statistics import mean, stdev
import subprocess
from tempfile import NamedTemporaryFile
from uuid import UUID

import numpy as np
import sklearn

from model import (
    BUDGET, FEATURE_SCHEMA, FOREST, GRAPH, PROFILE, RULES, TABULAR, budget_order,
    explanations, fit, measure, ml_scores, rule_scores, validation_threshold,
)
from simulate import HELD_OUT, SEEDS, SPLIT_SIZES, simulate


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / ".runtime" / "anomaly"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def collect(mode, scope=None, facts=None):
    command = ["node", "--env-file-if-exists=.env", "--env-file-if-exists=.env.worker",
               "--env-file-if-exists=.env.graph", "--import", "tsx",
               "apps/api/scripts/anomaly/collect.ts", mode]
    if scope:
        command.append(scope)
    return json.loads(subprocess.run(command, cwd=ROOT, input=json.dumps(facts), text=True,
                                     encoding="utf8", stdout=subprocess.PIPE, check=True,
                                     timeout=120).stdout)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf8", dir=path.parent, delete=False) as out:
        pending = Path(out.name)
        try:
            json.dump(value, out, allow_nan=False, indent=2)
            out.write("\n")
            out.close()
            os.replace(pending, path)
        finally:
            out.close()
            pending.unlink(missing_ok=True)


@contextmanager
def publication_lock(scope):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    lock = OUTPUT / f"{scope}.lock"
    try:
        with lock.open("x", encoding="utf8") as file:
            file.write(str(os.getpid()))
    except FileExistsError as error:
        raise RuntimeError(f"Scoring is locked by {lock.name}") from error
    try:
        yield
    finally:
        lock.unlink()


def model_id(profile):
    prefix = sha256(json.dumps(profile, sort_keys=True, separators=(",", ":"),
                               allow_nan=False).encode()).hexdigest()[:16]
    return f"{PROFILE}-{prefix}"


def check_synthetic_graph(facts, rows):
    """Independent replay verifies all observed graph counts in the experiment."""
    pairs, evidence = defaultdict(list), defaultdict(list)
    for fact, row in zip(facts, rows, strict=True):
        at = datetime.fromisoformat(fact["occurred_at"])
        lower = at - timedelta(days=30)
        pair_history = pairs[(fact["proposer_id"], fact["decider_id"])]
        digest_history = evidence[fact["digest"]]
        for key, history in (("pair30d", pair_history), ("evidence30d", digest_history)):
            if row["features"][key] != sum(lower <= time < at for time in history):
                raise ValueError("Neo4j disagrees with independent decision-time replay")
            history.append(at)


def experiment(seed):
    facts, annotations = simulate(seed)
    rows = collect("synthetic", facts=facts)["rows"]
    if [row["requestId"] for row in rows] != [fact["request_id"] for fact in facts]:
        raise ValueError("The feature stream no longer matches the synthetic event order")
    check_synthetic_graph(facts, rows)
    train, validation, _ = SPLIT_SIZES.values()
    validation_end = train + validation
    results = {}
    profile = {
        "schema": FEATURE_SCHEMA, "seed": seed, "features": GRAPH, "settings": FOREST,
        "sklearn": sklearn.__version__, "numpy": np.__version__,
        "train": [row["features"] for row in rows[:train]],
    }
    for name, keys in (("rules", ()), ("tabular", TABULAR), ("graph", GRAPH)):
        if keys:
            model, _ = fit(rows[:train], keys, seed)
            scores = ml_scores(model, rows, keys)
        else:
            scores = rule_scores(rows)
        threshold = validation_threshold(scores[train:validation_end])
        results[name] = measure(rows[validation_end:], annotations[validation_end:],
                                scores[validation_end:], threshold)
        if name == "graph":
            profile["threshold"] = threshold
    return results, profile


def evaluate():
    runs = []
    profile = None
    for seed in SEEDS:
        results, learned = experiment(seed)
        version = model_id(learned)
        runs.append({"seed": seed, "modelVersion": version, "results": results})
        if profile is None:
            profile = {"modelVersion": version, "profile": learned}
    metrics = ("averagePrecision", "precisionAtBudget", "recallAtBudget", "falsePositiveRateAtBudget")
    summary = {}
    for name in ("rules", "tabular", "graph"):
        summary[name] = {}
        for metric in metrics:
            values = [run["results"][name][metric] for run in runs]
            summary[name][metric] = {"mean": mean(values), "sampleStdDev": stdev(values)}
    write_json(OUTPUT / "evaluation.json", {
        "featureSchema": FEATURE_SCHEMA, "reviewBudget": BUDGET, "splitSizes": SPLIT_SIZES,
        "testOnlyFamily": HELD_OUT, "rules": RULES, "forest": FOREST, "graphFeatureSource": "Neo4j",
        "sklearn": sklearn.__version__, "runs": runs, "summary": summary,
    })
    write_json(OUTPUT / "profile.json", profile)
    print(json.dumps(summary, indent=2))


def publish(scope):
    scope = str(UUID(scope))
    with publication_lock(scope):
        artifact = json.loads((OUTPUT / "profile.json").read_text(encoding="utf8"))
        profile = artifact["profile"]
        if (artifact["modelVersion"] != model_id(profile) or profile["schema"] != FEATURE_SCHEMA
                or profile["features"] != list(GRAPH) or profile["settings"] != FOREST
                or profile["sklearn"] != sklearn.__version__ or profile["numpy"] != np.__version__):
            raise ValueError("Profile version mismatch. Run the pinned evaluation first.")
        snapshot = collect("live", scope=scope)
        rows = snapshot["rows"]
        model, baseline = fit([{"features": row} for row in profile["train"]], GRAPH, profile["seed"])
        scores = ml_scores(model, rows, GRAPH)
        reasons = explanations(model, baseline, rows, scores)
        order = budget_order(rows, scores)
        threshold = profile["threshold"]
        ranked = [
            {**{key: rows[index][key] for key in ("requestId", "recordId", "version", "occurredAt")},
             "score": round(float(scores[index]), 8), "rank": rank,
             "flagged": bool(scores[index] >= threshold), **reasons[index]}
            for rank, index in enumerate(order, 1)
        ]
        write_json(OUTPUT / f"{scope}.json", {
            "scope": scope, "featureSchema": FEATURE_SCHEMA, "modelVersion": artifact["modelVersion"],
            "trainedOn": "synthetic", "threshold": threshold, "generatedAt": now(),
            "through": snapshot["through"], "syncedAt": snapshot["syncedAt"], "rows": ranked,
        })
        print(f"Published {len(ranked)} advisory ranks through committed position count {snapshot['through']}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("evaluate")
    score = modes.add_parser("publish")
    score.add_argument("institution")
    args = parser.parse_args()
    try:
        if args.mode == "evaluate":
            evaluate()
        else:
            publish(args.institution)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Anomaly run failed. {error}\n")
