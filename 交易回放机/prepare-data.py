"""Build the offline bundle from public exchange data and the verified XBTUSD export."""
import argparse
import base64
import csv
import gzip
import io
import json
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from zipfile import ZipFile

MINUTE = 60_000
DAY = 24 * 60 * MINUTE
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def epoch_ms(iso):
    moment = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        raise ValueError("Timestamp requires a time zone: " + iso)
    delta = moment - EPOCH
    return delta.days * DAY + delta.seconds * 1000 + delta.microseconds // 1000


def read_binance(source, start, end):
    bars = []
    first_month = datetime.fromtimestamp(start / 1000, timezone.utc).strftime("%Y-%m")
    last_month = datetime.fromtimestamp(end / 1000, timezone.utc).strftime("%Y-%m")
    for path in sorted(source.glob("BTCUSDT-1m-*.zip")):
        if not first_month <= path.stem[-7:] <= last_month:
            continue
        with ZipFile(path) as archive, archive.open(archive.namelist()[0]) as file:
            for row in csv.reader(io.TextIOWrapper(file, encoding="utf-8")):
                if not row[0].isdigit():
                    continue
                timestamp = int(row[0])
                if timestamp >= 100_000_000_000_000:
                    timestamp //= 1000
                if timestamp < start:
                    continue
                if timestamp > end:
                    break
                open_price, high, low, close, volume = map(float, row[1:6])
                bars.append([timestamp, open_price, high, low, close, round(volume, 3)])
    if not bars:
        raise ValueError("No Binance candles available")
    if any(previous[0] >= current[0] for previous, current in zip(bars, bars[1:])):
        raise ValueError("Duplicate or unordered Binance candles")
    if bars[0][0] != start or bars[-1][0] != end - end % MINUTE:
        raise ValueError("Binance data does not cover the requested endpoints")
    return bars


def read_executions(path):
    fills, funding = [], []
    seen = set()
    with path.open(newline="", encoding="utf-8-sig") as file:
        for row in csv.DictReader(file):
            if row["symbol"] != "XBTUSD" or row["execID"] in seen:
                continue
            seen.add(row["execID"])
            timestamp = epoch_ms(row["timestamp"])
            fee = int(float(row["execComm"] or 0))
            if row["execType"] == "Funding":
                funding.append([timestamp, fee])
            if row["execType"] == "Trade":
                if row["side"] not in {"Buy", "Sell"}:
                    raise ValueError("Unsupported execution side")
                quantity = int(float(row["lastQty"]))
                signed = quantity if row["side"] == "Buy" else -quantity
                fills.append([timestamp, signed, float(row["lastPx"]), fee, row["ordType"], row["execID"]])
    return sorted(fills, key=lambda row: row[0]), sorted(funding)


def position_before(fills, start):
    balance = 0
    entry = Decimal(0)
    for timestamp, quantity, price, *_ in fills:
        if timestamp >= start:
            break
        next_balance = balance + quantity
        if not next_balance:
            entry = Decimal(0)
        elif not balance or (next_balance > 0) != (balance > 0):
            entry = Decimal(str(price))
        elif (balance > 0) == (quantity > 0):
            entry = abs(next_balance) / (abs(balance) / entry + abs(quantity) / Decimal(str(price)))
        balance = next_balance
    return {"quantity": balance, "entry": float(entry)}


def read_wallet(path, day, before):
    with path.open(newline="", encoding="utf-8-sig") as file:
        snapshots = [
            [epoch_ms(row["timestamp"]), int(row["walletBalance"])]
            for row in csv.DictReader(file)
            if row["timestamp"].startswith(day)
            and epoch_ms(row["timestamp"]) <= before
            and row["currency"] == "XBt"
            and row["transactStatus"] == "Completed"
            and row["walletBalance"]
        ]
    if not snapshots:
        raise ValueError("No XBT wallet anchor for " + day)
    return max(snapshots)


def read_bitmex(path, anchor):
    if not path.is_file():
        raise FileNotFoundError(path)
    candles = OrderedDict()
    ticks = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as file:
        for row in csv.DictReader(file):
            if row["symbol"] != "XBTUSD":
                continue
            # The source timestamps are Unix microseconds.
            timestamp = int(row["timestamp"]) // 1000
            price = float(row["price"])
            quantity = int(float(row["amount"]))
            minute = timestamp - timestamp % MINUTE
            if minute not in candles:
                candles[minute] = [minute, price, price, price, price, quantity]
            else:
                bar = candles[minute]
                bar[2] = max(bar[2], price)
                bar[3] = min(bar[3], price)
                bar[4] = price
                bar[5] += quantity
            if timestamp >= anchor:
                ticks.append([timestamp, price])
    return list(candles.values()), sorted(ticks, key=lambda tick: tick[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--executions", type=Path, required=True)
    parser.add_argument("--wallet", type=Path, required=True)
    parser.add_argument("--from", dest="first", default="2024-11-17T00:00:00+08:00")
    parser.add_argument("--to", dest="last", default="2026-07-23T12:56:05.357Z")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("market-data.js"))
    args = parser.parse_args()
    first = epoch_ms(args.first)
    last = epoch_ms(args.last)
    all_fills, funding = read_executions(args.executions)
    fills = [fill for fill in all_fills if first <= fill[0] <= last]
    if not fills:
        raise ValueError("No BitMEX trades found")
    bars = read_binance(args.source, first, last)
    day = "2026-02-01"
    sim_start = epoch_ms(day + "T00:00:00Z")
    starts = [sim_start + m * MINUTE for m in (1265, 1283, 1300, 1310, 1320, 1337)]
    sim_end = sim_start + DAY - 2 * MINUTE
    if not (first <= sim_start and sim_end <= last):
        raise ValueError("The simulation sample must be inside the history range")
    anchor = read_wallet(args.wallet, day, min(starts))
    sim_bars, ticks = read_bitmex(args.source / "XBTUSD-2026-02-01.csv.gz", anchor[0])
    if not ticks or not sim_bars or ticks[-1][0] < sim_end:
        raise ValueError("Missing the same-exchange simulation interval")
    payload = {
        "bars": bars,
        "fills": fills,
        "opening": position_before(all_fills, first),
        "funding": [row for row in funding if first <= row[0] <= last],
        "simulation": {
            "anchor": anchor,
            "bars": sim_bars,
            "ticks": ticks,
            "source": "BitMEX",
            "starts": starts,
            "end": sim_end,
        },
        "coverage": [bars[0][0], last],
    }
    buffer = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    zipped = base64.b64encode(gzip.compress(buffer, compresslevel=5, mtime=0)).decode("ascii")
    args.output.write_text("window.REPLAY_DATA = " + json.dumps(zipped) + ";\n", encoding="utf-8")
    print(f"{len(bars):,} candles · {len(fills):,} historical executions · {len(ticks):,} simulation ticks")
    print(f"Simulation source: {payload['simulation']['source']}")


if __name__ == "__main__":
    main()
