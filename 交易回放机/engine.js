"use strict";

(globalThis => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const SATOSHIS = 100_000_000;
  const PRACTICE_FEE = 0.00075;
  const MAX_LEVERAGE = 12;
  const INTERVALS = {"1m": MINUTE, "1h": HOUR, "1d": DAY, "1w": 7 * DAY};
  const emptyAccount = () => ({quantity: 0, entry: 0, realised: 0, fees: 0, wallet: null});
  const byTime = item => item.time;
  const barTime = bar => bar[0];

  async function loadBundle(encoded) {
    if (!encoded) throw new Error("缺少行情文件");
    let bytes;
    if (Uint8Array.fromBase64) {
      bytes = Uint8Array.fromBase64(encoded);
    } else {
      const binary = atob(encoded);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).json();
  }

  function boundary(items, time, getTime, inclusive = false) {
    let start = 0;
    let end = items.length;
    while (start < end) {
      const mid = Math.floor((start + end) / 2);
      const value = getTime(items[mid]);
      if (value < time || (inclusive && value === time)) start = mid + 1;
      else end = mid;
    }
    return start;
  }

  function span(items, from, to, getTime = byTime) {
    return items.slice(boundary(items, from, getTime), boundary(items, to, getTime, true));
  }

  function bucket(timestamp, interval) {
    const step = INTERVALS[interval];
    const offset = interval === "1w" ? 3 * DAY : 0;
    return Math.floor((timestamp + offset) / step) * step - offset;
  }

  function aggregate(minutes, interval) {
    if (interval === "1m") return minutes;
    const bars = [];
    for (const [time, open, high, low, close, volume] of minutes) {
      const key = bucket(time, interval);
      const current = bars.at(-1);
      if (current?.[0] === key) {
        current[2] = Math.max(current[2], high);
        current[3] = Math.min(current[3], low);
        current[4] = close;
        current[5] += volume;
      } else {
        bars.push([key, open, high, low, close, volume]);
      }
    }
    return bars;
  }

  function actionFor(before, after) {
    if (!before) return "开仓";
    if (!after) return "平仓";
    if (Math.sign(before) !== Math.sign(after)) return "反手";
    return Math.abs(after) > Math.abs(before) ? "加仓" : "减仓";
  }

  function applyFill(account, trade) {
    const {quantity, entry} = account;
    const next = quantity + trade.quantity;
    const direction = Math.sign(trade.quantity);
    const opposing = quantity && Math.sign(quantity) !== direction;
    const closing = opposing ? Math.min(Math.abs(quantity), Math.abs(trade.quantity)) : 0;
    const gross = closing ? Math.sign(quantity) * closing * (1 / entry - 1 / trade.price) : 0;
    const fee = trade.fee;
    let nextEntry = entry;
    if (!next) nextEntry = 0;
    else if (!quantity || Math.sign(next) !== Math.sign(quantity)) nextEntry = trade.price;
    else if (!opposing) nextEntry = Math.abs(next) / (Math.abs(quantity) / entry + Math.abs(trade.quantity) / trade.price);

    return {
      quantity: next, entry: nextEntry, realised: account.realised + gross - fee,
      fees: account.fees + fee, wallet: account.wallet === null ? null : account.wallet + gross - fee,
    };
  }

  function metrics(account, mark) {
    const unrealised = account.entry && mark ? account.quantity * (1 / account.entry - 1 / mark) : 0;
    const equity = account.wallet === null ? null : account.wallet + unrealised;
    const leverage = equity > 0 && mark ? Math.abs(account.quantity) / mark / equity : null;
    return {...account, mark, unrealised, equity, leverage};
  }

  function createMarket(raw) {
    const opening = {...emptyAccount(), ...raw.opening};
    let account = opening;
    const fills = raw.fills.map(([time, quantity, price, satoshis, orderType, id]) => {
      const before = account;
      const fill = {id, time, quantity, price, fee: satoshis / SATOSHIS, orderType, origin: "history"};
      account = applyFill(before, fill);
      return {...fill, before, account, action: actionFor(before.quantity, account.quantity)};
    });
    const series = Object.fromEntries(Object.keys(INTERVALS).map(interval => [interval, aggregate(raw.bars, interval)]));
    return {...raw, opening, fills, series, tradeById: new Map(fills.map(fill => [fill.id, fill]))};
  }

  function historicalAt(market, time, trade = null) {
    const index = boundary(market.fills, time, byTime, true) - 1;
    return trade?.account || market.fills[index]?.account || market.opening;
  }

  function lastClosedPrice(bars, time) {
    return bars[boundary(bars, time - MINUTE, barTime, true) - 1]?.[4] || 0;
  }

  function simulationPrice(source, time) {
    const tick = source.ticks[boundary(source.ticks, time, barTime, true) - 1];
    return tick?.[1] || lastClosedPrice(source.bars, time);
  }

  function startSimulation(market, previousStart) {
    const source = market.simulation;
    const options = source.starts.filter(time => time !== previousStart);
    const time = options[Math.floor(Math.random() * options.length)];
    const end = Math.min(time + 145 * MINUTE, source.end ?? Infinity);
    const [anchorTime, anchorSatoshis] = source.anchor;
    const anchor = historicalAt(market, anchorTime);
    const observed = historicalAt(market, time);
    const funding = span(market.funding, anchorTime + 1, time, barTime)
      .reduce((sum, row) => sum + row[1] / SATOSHIS, 0);
    const wallet = anchorSatoshis / SATOSHIS + observed.realised - anchor.realised - funding;
    const account = {...observed, wallet, realised: 0, fees: 0};
    const mark = simulationPrice(source, time);
    const opening = metrics(account, mark);
    if (!mark || !Number.isFinite(opening.equity) || opening.equity <= 0) {
      throw new Error("这个练习窗口的期初账户信息不完整");
    }
    return {
      start: time, end, time, mark, source, opening, account, orders: [], fills: [], nextOrder: 1,
      points: [{time, price: mark, equity: opening.equity}], report: null, halted: false,
    };
  }

  function addOrder(sim, side, type, quantity, price) {
    if (sim.report || sim.halted || sim.time >= sim.end) return "当前练习已结束";
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) return "请输入 1 至 1,000,000 张的整数数量";
    if (type === "limit" && (!Number.isFinite(price) || price <= 0 || price > 1_000_000)) return "请输入有效的限价";
    if (sim.orders.filter(order => order.status === "open").length >= 30) return "当前有 30 笔待成交订单，请先撤单";
    const signed = side === "buy" ? quantity : -quantity;
    sim.orders.push({
      id: "order-" + sim.nextOrder++, time: sim.time, quantity: signed,
      type, price: type === "limit" ? price : null, status: "open",
    });
    return null;
  }

  function cancelOrder(sim, id) {
    const order = sim.orders.find(candidate => candidate.id === id && candidate.status === "open");
    if (order) order.status = "cancelled";
    return Boolean(order);
  }

  function placeFill(sim, order, time, price, messages) {
    const fill = {
      id: "practice-" + order.id, time, price, quantity: order.quantity,
      fee: Math.abs(order.quantity) / price * PRACTICE_FEE,
      orderType: order.type === "limit" ? "Limit" : "Market", origin: "practice",
    };
    const before = sim.account;
    const after = applyFill(before, fill);
    const increasing = Math.abs(after.quantity) > Math.abs(before.quantity)
      || (after.quantity && before.quantity && Math.sign(after.quantity) !== Math.sign(before.quantity));
    const status = metrics(after, price);
    if (increasing && (status.equity <= 0 || status.leverage > MAX_LEVERAGE)) {
      order.status = "rejected";
      messages.push("订单超过 " + MAX_LEVERAGE + "× 练习仓位上限，已拒绝");
      return;
    }
    order.status = "filled";
    sim.account = after;
    sim.fills.push({...fill, before, account: after, action: actionFor(before.quantity, after.quantity)});
  }

  function advanceSimulation(sim) {
    if (sim.report || sim.time >= sim.end || sim.halted) return [];
    const end = Math.min(sim.time + MINUTE, sim.end);
    const messages = [];
    const pending = sim.orders.filter(order => order.status === "open");
    if (sim.source.ticks.length) {
      const first = boundary(sim.source.ticks, sim.time, barTime, true);
      const last = boundary(sim.source.ticks, end, barTime, true);
      for (let index = first; index < last && pending.some(order => order.status === "open"); index++) {
        const [time, price] = sim.source.ticks[index];
        for (const order of pending) {
          if (order.status !== "open" || time <= order.time) continue;
          const crossed = order.quantity > 0 ? price < order.price : price > order.price;
          if (order.type === "market" || crossed) placeFill(sim, order, time, order.price ?? price, messages);
        }
      }
    } else {
      const bar = sim.source.bars[boundary(sim.source.bars, sim.time, barTime)];
      if (bar && bar[0] + MINUTE <= end) {
        for (const order of pending) {
          const crossed = order.quantity > 0 ? bar[3] < order.price : bar[2] > order.price;
          if (order.type === "market") placeFill(sim, order, bar[0] + 1, bar[1], messages);
          else if (crossed) placeFill(sim, order, end, order.price, messages);
        }
      }
    }
    sim.time = end;
    sim.mark = simulationPrice(sim.source, end) || sim.mark;
    const state = metrics(sim.account, sim.mark);
    sim.points.push({time: end, price: sim.mark, equity: state.equity});
    if (state.equity <= 0) {
      sim.halted = true;
      messages.push("练习权益触及下限，已暂停");
    }
    return messages;
  }

  function summarise(points, trades, opening) {
    let peak = opening;
    let drawdown = 0;
    for (const point of points) {
      peak = Math.max(peak, point.equity);
      drawdown = Math.max(drawdown, (peak - point.equity) / peak);
    }
    const equity = points.at(-1).equity;
    return {
      equity, gain: equity - opening, returnRate: (equity - opening) / opening,
      drawdown, trades: trades.length,
    };
  }

  function settleSimulation(market, sim) {
    if (sim.report) return sim.report;
    sim.orders.filter(order => order.status === "open").forEach(order => { order.status = "cancelled"; });
    let baseline = {...sim.opening};
    const originalFills = span(market.fills, sim.start + 1, sim.time).map(trade => ({...trade, origin: "benchmark"}));
    const points = [];
    let index = 0;
    for (const point of sim.points) {
      while (index < originalFills.length && originalFills[index].time <= point.time) {
        const trade = originalFills[index++];
        baseline = applyFill(baseline, {...trade, fee: Math.abs(trade.quantity) / trade.price * PRACTICE_FEE});
      }
      points.push({time: point.time, price: point.price, equity: metrics(baseline, point.price).equity});
    }
    sim.report = {
      time: sim.time, price: sim.mark, opening: sim.opening.equity,
      practice: summarise(sim.points, sim.fills, sim.opening.equity),
      benchmark: summarise(points, originalFills, sim.opening.equity), originalFills,
    };
    return sim.report;
  }

  globalThis.ReplayEngine = {
    MINUTE, HOUR, DAY, INTERVALS, PRACTICE_FEE, MAX_LEVERAGE, loadBundle, boundary, span,
    bucket, aggregate, createMarket, historicalAt, lastClosedPrice, metrics,
    startSimulation, addOrder, cancelOrder, advanceSimulation, settleSimulation,
  };
})(globalThis);
