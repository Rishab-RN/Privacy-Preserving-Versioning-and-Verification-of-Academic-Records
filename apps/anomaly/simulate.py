"""Deterministic, group-disjoint synthetic approved corrections."""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from random import Random
from uuid import UUID


SEEDS = (17, 29, 43)
SPLIT_SIZES = {"train": 900, "validation": 450, "test": 650}
COMMON_FAMILIES = ("grade_jump", "record_burst", "pair_concentration")
HELD_OUT = "evidence_reuse"


def simulate(seed):
    rng = Random(seed)
    at = datetime(2025, 1, 1, tzinfo=timezone.utc)
    facts, annotations = [], []

    def new_id():
        return str(UUID(int=rng.getrandbits(128), version=4))

    for split, size in SPLIT_SIZES.items():
        at += timedelta(days=35)
        courses = [new_id() for _ in range(12)]
        offerings = [new_id() for _ in courses]
        students = [new_id() for _ in range(100)]
        records = [new_id() for _ in range(150)]
        proposers = [new_id() for _ in range(16)]
        approvers = [new_id() for _ in range(14)]
        templates = [sha256(new_id().encode()).hexdigest() for _ in range(16)]
        versions = defaultdict(lambda: 1)
        grades = [rng.randint(350, 900) for _ in records]
        recent_records = []
        for _ in range(size):
            at += timedelta(seconds=max(1, int(rng.expovariate(1 / 3600))))
            anomaly = rng.random() < (0.025 if split == "train" else 0.09)
            rare_benign = not anomaly and rng.random() < 0.055
            families = COMMON_FAMILIES + ((HELD_OUT,) if split == "test" else ())
            label = rng.choice(families) if anomaly else "benign_unusual" if rare_benign else "benign"
            record = rng.randrange(len(records))
            course = record % len(courses)
            proposer = (course + rng.randrange(5)) % len(proposers)
            approver = (proposer + rng.randrange(1, 5)) % len(approvers)
            delta = int(rng.gauss(35, 80))
            digest = rng.choice(templates) if rng.random() < 0.25 else sha256(new_id().encode()).hexdigest()

            if label == "grade_jump" or rare_benign:
                delta += rng.choice((-1, 1)) * rng.randint(140, 460)
            if label == "record_burst" and recent_records:
                record = rng.choice(recent_records[-20:])
                course = record % len(courses)
            if label == "pair_concentration":
                proposer, approver = rng.choice(((2, 3), (6, 7)))
            if label == HELD_OUT:
                digest = rng.choice(templates[:2])
            if rare_benign and rng.random() < 0.25:
                # Common rubric templates can be legitimately reused.
                digest = rng.choice(templates[:2])

            before = grades[record]
            after = max(0, min(1000, before + delta))
            grades[record] = after
            record_id = records[record]
            versions[record_id] += 1
            facts.append({
                "request_id": new_id(),
                "event_id": new_id(),
                "occurred_at": at.isoformat(timespec="microseconds").replace("+00:00", "Z"),
                "record_id": record_id,
                "student_id": students[record % len(students)],
                "offering_id": offerings[course],
                "course_id": courses[course],
                "proposer_id": proposers[proposer],
                "decider_id": approvers[approver],
                "version_no": versions[record_id],
                "evidence_id": new_id(),
                "digest": digest,
                "delta_hundredths": after - before if rng.random() >= 0.02 else None,
            })
            annotations.append({"split": split, "family": label, "anomaly": anomaly})
            recent_records.append(record)
    return facts, annotations
