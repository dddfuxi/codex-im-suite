#!/usr/bin/env python3
import argparse
import hashlib
import json
import secrets


def parse_modifier(raw_modifier):
    if "=" not in raw_modifier:
        raise argparse.ArgumentTypeError("modifier must use LABEL=VALUE")
    label, raw_value = raw_modifier.rsplit("=", 1)
    label = label.strip()
    if not label:
        raise argparse.ArgumentTypeError("modifier label cannot be empty")
    try:
        value = float(raw_value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("modifier value must be numeric") from error
    return {"label": label, "value": value}


def clamp(value, lower, upper):
    return max(lower, min(upper, value))


def seeded_roll(seed, nonce):
    digest = hashlib.sha256(f"{seed}:{nonce}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % 10000 + 1


def main():
    parser = argparse.ArgumentParser(description="Resolve an auditable roguelike probability check.")
    parser.add_argument("--base", type=float, required=True)
    parser.add_argument("--modifier", action="append", default=[], type=parse_modifier)
    parser.add_argument("--minimum", type=float, default=1.0)
    parser.add_argument("--maximum", type=float, default=99.0)
    parser.add_argument("--critical-success", type=float, default=5.0)
    parser.add_argument("--critical-failure", type=float, default=5.0)
    parser.add_argument("--seed")
    parser.add_argument("--nonce", default="0")
    parser.add_argument("--roll", type=int)
    args = parser.parse_args()

    if args.minimum < 0 or args.maximum > 100 or args.minimum > args.maximum:
        parser.error("minimum and maximum must satisfy 0 <= minimum <= maximum <= 100")
    if args.critical_success < 0 or args.critical_failure < 0:
        parser.error("critical thresholds cannot be negative")
    if args.roll is not None and not 1 <= args.roll <= 10000:
        parser.error("roll must be between 1 and 10000")

    modifier_total = sum(modifier["value"] for modifier in args.modifier)
    final_chance = clamp(args.base + modifier_total, args.minimum, args.maximum)
    roll = args.roll or (seeded_roll(args.seed, args.nonce) if args.seed else secrets.randbelow(10000) + 1)
    roll_percent = roll / 100
    success = roll_percent <= final_chance
    critical_success_limit = min(final_chance, args.critical_success)
    critical_failure_limit = max(final_chance, 100 - args.critical_failure)

    if success and roll_percent <= critical_success_limit:
        outcome = "critical_success"
    elif success:
        outcome = "success"
    elif roll_percent > critical_failure_limit:
        outcome = "critical_failure"
    else:
        outcome = "failure"

    print(json.dumps({
        "base_chance": args.base,
        "modifiers": args.modifier,
        "modifier_total": modifier_total,
        "final_chance": final_chance,
        "roll": roll,
        "roll_percent": roll_percent,
        "outcome": outcome,
        "success": success,
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
