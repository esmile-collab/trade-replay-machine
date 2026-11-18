"use strict";

(() => {
  const E = ReplayEngine;
  const $ = id => document.getElementById(id);
  const dollars = new Intl.NumberFormat("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const integers = new Intl.NumberFormat("en-US", {maximumFractionDigits: 0});
  const byTime = trade => trade.time;
  const barTime = bar => bar[0];
  const defaultDurations = {"1m": 6 * E.HOUR, "1h": 13 * E.DAY, "1d": 110 * E.DAY, "1w": 161 * E.DAY};
  const state = {
    market: null, mode: "history", interval: "1h", view: null, ledger: "fills", selected: null,
    history: null, replay: null, sim: null, lastPracticeStart: null, playing: false, timer: null,
    messages: [], refs: [], reportTab: "assistant", compare: "both",
    order: {type: "market", quantity: "10000", price: ""}, toast: null,
  };

  const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
  const iso = time => new Date(time).toISOString();
  const shortDate = time => iso(time).slice(5, 10).replace("-", "/");
  const fullDate = time => iso(time).slice(0, 10).replaceAll("-", "/");
  const clock = (time, seconds = false) => iso(time).slice(11, seconds ? 19 : 16);
  const timestamp = (time, seconds = false) => fullDate(time) + " " + clock(time, seconds);
  const side = trade => trade.quantity > 0 ? "Buy" : "Sell";
  const sideClass = trade => trade.quantity > 0 ? "positive" : "negative";
  const price = value => value > 0 ? dollars.format(value) : "—";
  const amount = value => integers.format(Math.abs(value));
  const signed = (value, digits) => (value > 0 ? "+" : value < 0 ? "−" : "") + Math.abs(value).toFixed(digits);
  const btc = value => signed(value, 5) + " BTC";
  const percent = value => signed(value * 100, 2) + "%";
  const colorClass = value => value > 0 ? "positive" : value < 0 ? "negative" : "";
  const positionText = value => value ? (value > 0 ? "多 " : "空 ") + amount(value) + " 张" : "空仓";
  const typeText = type => ({"Market": "市价", "Limit": "限价", "StopLimit": "止损限价"})[type] || "—";

  const chart = createReplayChart($("chart"), {
    marker(hit) {
      if (!hit) {
        closePopover();
        return;
      }
      if (hit.trades.length === 1) selectTrade(hit.trades[0].id);
      showMarkerList(hit);
    },
    bar(bar) {
      $("ohlc").innerHTML = [["开", 1], ["高", 2], ["低", 3], ["收", 4]].map(([label, index]) =>
        "<span>" + label + "<b>" + price(bar[index]) + "</b></span>").join("");
    },
    range(from, to) { setHistoryRange(from, to); },
  });

  function limits(interval = state.interval) {
    const [first, last] = state.market.coverage;
    return {from: E.bucket(first, interval), to: E.bucket(last, interval) + E.INTERVALS[interval]};
  }

  function clampRange(from, to, interval = state.interval) {
    const bounds = limits(interval);
    const width = Math.max(E.INTERVALS[interval] * 12, Math.min(to - from, bounds.to - bounds.from));
    const start = Math.max(bounds.from, Math.min(from, bounds.to - width));
    return {from: start, to: Math.min(start + width, bounds.to)};
  }

  function historyWindow(anchor, ending = false) {
    const width = defaultDurations[state.interval];
    const from = anchor - width * (ending ? 1 : .56);
    return clampRange(from, from + width);
  }

  function currentTime() {
    if (state.mode === "replay") return state.replay.time;
    if (state.mode === "simulation") return state.sim.time;
    return Math.min(state.view.to - 1, state.market.coverage[1]);
  }

  function tradesInView() {
    const {from, to} = state.view;
    if (state.mode === "simulation") {
      const sim = state.sim;
      const earlier = E.span(state.market.fills, from, Math.min(to - 1, sim.start));
      const own = state.compare === "benchmark" && sim.report ? [] : E.span(sim.fills, from, to - 1);
      const benchmark = sim.report && state.compare !== "practice"
        ? E.span(sim.report.originalFills, from, to - 1) : [];
      return [...earlier, ...own, ...benchmark].sort((a, b) => a.time - b.time);
    }
    const start = state.mode === "replay" ? Math.max(from, state.replay.start) : from;
    return E.span(state.market.fills, start, Math.min(to - 1, currentTime()));
  }

  function getTrade(id) {
    if (!id) return null;
    if (state.mode === "simulation") {
      const sim = state.sim;
      return sim.fills.find(trade => trade.id === id)
        || sim.report?.originalFills.find(trade => trade.id === id)
        || (state.market.tradeById.get(id)?.time <= sim.start ? state.market.tradeById.get(id) : null);
    }
    const trade = state.market.tradeById.get(id);
    if (!trade) return null;
    if (state.mode === "replay" && (trade.time < state.replay.start || trade.time > state.replay.time)) return null;
    return trade;
  }

  function practiceBars() {
    const sim = state.sim;
    const index = E.boundary(sim.source.bars, sim.time - E.MINUTE, barTime, true);
    return E.aggregate(sim.source.bars.slice(0, index), state.interval);
  }

  function frame() {
    const {from, to} = state.view;
    const source = state.mode === "simulation" ? practiceBars() : state.market.series[state.interval];
    const bars = E.span(source, E.bucket(from, state.interval), to - 1, barTime);
    const trades = tradesInView();
    const progressive = state.mode === "simulation";
    const cursor = state.mode === "history" ? null : currentTime();
    const mark = progressive ? state.sim.mark
      : cursor === null ? bars.at(-1)?.[4] : E.lastClosedPrice(state.market.bars, cursor);
    return {
      from, to, bars, trades, progressive, cursor, mark, selected: state.selected,
      interval: state.interval, intervalMs: E.INTERVALS[state.interval], canPan: state.mode === "history",
    };
  }

  function setHistoryRange(from, to) {
    if (state.mode !== "history") return;
    const bar = E.INTERVALS[state.interval];
    const mid = (from + to) / 2;
    const width = Math.min(to - from, bar * 800);
    state.view = clampRange(mid - width / 2, mid + width / 2);
    closePopover();
    const selected = getTrade(state.selected);
    if (selected && (selected.time < state.view.from || selected.time >= state.view.to)) state.selected = null;
    renderFrame();
    renderLedger();
    updateControls();
  }

  function changeInterval(interval) {
    if (!state.market || !E.INTERVALS[interval] || state.interval === interval) return;
    const trade = getTrade(state.selected);
    const priorEnd = state.view.to;
    state.interval = interval;
    if (state.mode === "history") state.view = historyWindow(trade?.time ?? priorEnd, !trade);
    if (state.mode === "replay") setReplayView();
    if (state.mode === "simulation") setPracticeView();
    render();
  }

  function setReplayView() {
    const {start, end, time} = state.replay;
    const step = E.INTERVALS[state.interval];
    const bounds = limits();
    const context = Math.max(2 * E.HOUR, 7 * step);
    const from = Math.max(bounds.from, E.bucket(start - context, state.interval));
    const to = Math.min(bounds.to, E.bucket(end, state.interval) + step);
    if (state.interval === "1m" && to - from > 6 * E.HOUR) {
      const windowStart = Math.min(to - 6 * E.HOUR, Math.max(from, time - 2 * E.HOUR));
      state.view = {from: windowStart, to: windowStart + 6 * E.HOUR};
    } else {
      state.view = {from, to};
    }
  }

  function setPracticeView() {
    const {start, end, source} = state.sim;
    const step = E.INTERVALS[state.interval];
    const from = state.interval === "1m"
      ? Math.max(source.bars[0][0], start - 75 * E.MINUTE)
      : E.bucket(source.bars[0][0], state.interval);
    const to = state.interval === "1m" ? end + E.MINUTE : E.bucket(end, state.interval) + step;
    state.view = {from, to};
  }

  function renderFrame() {
    const model = frame();
    chart.setModel(model);
    $("chart-notice").hidden = model.bars.length > 0;
    $("chart-notice").textContent = "这段时间暂无已收录的行情";
    $("main-price").textContent = price(model.mark);
    const opening = model.bars[0]?.[1];
    const change = opening && model.mark ? model.mark / opening - 1 : 0;
    $("market-change").textContent = opening ? percent(change) : "";
    $("market-change").className = "market-change mono " + colorClass(change);
    $("market-change").title = "当前图表区间涨跌幅";
    $("range-label").textContent = shortDate(model.from) + " — " + shortDate(model.to - 1);
    const bounds = limits();
    $("previous-range").disabled = state.mode !== "history" || model.from <= bounds.from;
    $("next-range").disabled = state.mode !== "history" || model.to >= bounds.to;
    $("date-label").hidden = state.mode !== "history";
    $("fit-range").disabled = state.mode !== "history";
    $("market-source").textContent = state.mode === "simulation"
      ? (state.sim.source.source === "BitMEX" ? "BitMEX XBTUSD · 同场行情" : "Binance BTCUSDT · 练习参考行情")
      : "Binance BTCUSDT 行情";
    $("legend-extra").hidden = !state.sim?.report || state.mode !== "simulation";
    $("legend-extra").innerHTML = "<i class='benchmark'></i>魏神";
    for (const button of document.querySelectorAll("[data-timeframe]")) {
      button.setAttribute("aria-pressed", String(button.dataset.timeframe === state.interval));
    }
  }

  function button(label, attributes = "", extraClass = "") {
    return "<button type='button' class='button " + extraClass + "' " + attributes + ">" + label + "</button>";
  }

  function renderControls() {
    let content;
    if (state.mode === "history") {
      content = "<div class='mode-controls'><div class='control-start'>"
        + button("<span class='symbol' aria-hidden='true'>▷</span>回放", "id='enter-replay'")
        + button("<span class='symbol' aria-hidden='true'>⇄</span>模拟交易", "id='enter-simulation'", "accent")
        + "</div><div class='control-end'><span class='control-count' id='range-count'></span></div></div>";
    } else if (state.mode === "replay") {
      content = "<div class='mode-controls'><div class='play-controls'>"
        + button("播放", "id='toggle-play'", "primary")
        + button("‹", "id='prev-trade' aria-label='上一笔成交' title='上一笔成交'")
        + button("›", "id='next-trade' aria-label='下一笔成交' title='下一笔成交'")
        + "<input id='seek' type='range' min='0' max='10000' aria-label='回放进度'>"
        + "<time id='play-time' class='control-time mono'></time>"
        + "<select id='speed' class='select' aria-label='回放速度'><option value='1'>1×</option><option value='4'>4×</option><option value='12'>12×</option></select>"
        + "</div><div class='control-end'>" + button("退出回放", "id='leave-replay'") + "</div></div>";
    } else {
      const settled = Boolean(state.sim.report);
      const label = settled ? "练习已结算" : "模拟进度";
      const actions = settled
        ? "<select id='compare-mode' class='select' aria-label='成交对比'><option value='both'>同时显示</option><option value='practice'>我的成交</option><option value='benchmark'>魏神成交</option></select>"
        : button("播放", "id='toggle-play'", "primary")
          + button("下一分钟", "id='advance-minute'");
      content = "<div class='mode-controls'><div class='play-controls'>" + actions
        + "<time id='play-time' class='control-time mono' title='" + label + "'></time></div><div class='control-end'>"
        + (settled ? button("看报告", "id='show-report'", "accent") : button("结算", "id='settle'", "accent"))
        + button("退出模拟", "id='leave-simulation'") + "</div></div>";
      if (!settled) {
        content += "<form id='trade-ticket' class='trade-ticket'>"
          + "<label>订单 <select id='order-type' class='select'><option value='market'>市价</option><option value='limit'>限价</option></select></label>"
          + "<label>数量 <input id='order-quantity' class='trade-field' type='number' min='1' max='1000000' step='1' aria-label='数量（张）' required> 张</label>"
          + "<label id='limit-field' hidden>报价 <input id='order-price' class='trade-field' type='number' min='0.01' max='1000000' step='any' aria-label='限价'></label>"
          + "<button type='submit' class='button order-buy' name='side' value='buy'>买入</button><button type='submit' class='button order-sell' name='side' value='sell'>卖出</button>"
          + "<p>练习订单 · " + E.MAX_LEVERAGE + "× 上限</p></form>";
      }
    }
    $("mode-controls").innerHTML = content;
    if ($("speed")) $("speed").value = String(state.replay.speed);
    if ($("compare-mode")) $("compare-mode").value = state.compare;
    if ($("order-type")) {
      $("order-type").value = state.order.type;
      $("order-quantity").value = state.order.quantity;
      $("order-price").value = state.order.price;
      $("limit-field").hidden = state.order.type !== "limit";
    }
    updateControls();
  }

  function updateControls() {
    if (state.mode === "history") {
      const label = $("range-count");
      const count = tradesInView().length;
      if (label) label.textContent = "区间内 " + amount(count) + " 笔成交";
      return;
    }
    const play = $("toggle-play");
    if (play) play.textContent = state.playing ? "暂停" : "播放";
    $("play-time").textContent = timestamp(currentTime(), state.mode === "replay") + " UTC";
    if ($("seek")) {
      const {start, end, time} = state.replay;
      $("seek").value = String(Math.round((time - start) / (end - start) * 10000));
    }
    if (state.mode === "simulation" && !state.sim.report) {
      const disabled = state.sim.halted || state.sim.time >= state.sim.end;
      $("advance-minute").disabled = disabled;
      $("toggle-play").disabled = disabled;
      for (const input of $("trade-ticket").elements) input.disabled = disabled;
    }
  }

  function accountContext() {
    if (state.mode === "simulation") {
      return {time: currentTime(), report: state.sim.report,
        snapshot: E.metrics(state.sim.account, state.sim.mark), source: "我的模拟账户"};
    }
    const selected = getTrade(state.selected);
    const time = state.mode === "history" && selected ? selected.time : currentTime();
    const record = state.mode === "history" ? selected : null;
    const mark = record?.price || E.lastClosedPrice(state.market.bars, time);
    const historical = E.historicalAt(state.market, time, record);
    const sameDay = time >= state.market.simulation.anchor[0]
      && time < E.bucket(state.market.simulation.anchor[0], "1d") + E.DAY;
    if (!sameDay || !mark) {
      return {time, snapshot: E.metrics(historical, mark), source: record ? "成交后" : "参考估值"};
    }
    const [anchorTime, openingWallet] = state.market.simulation.anchor;
    const anchor = E.historicalAt(state.market, anchorTime);
    const funding = E.span(state.market.funding, anchorTime + 1, time, barTime)
      .reduce((sum, row) => sum + row[1] / 1e8, 0);
    const wallet = openingWallet / 1e8 + historical.realised - anchor.realised - funding;
    return {time, snapshot: E.metrics({...historical, wallet}, mark), source: record ? "成交后" : "参考估值"};
  }

  function renderLedger() {
    for (const tab of document.querySelectorAll("[data-ledger]")) {
      tab.setAttribute("aria-pressed", String(tab.dataset.ledger === state.ledger));
    }
    const {time, snapshot, source} = accountContext();
    $("snapshot-time").textContent = source + " · " + shortDate(time) + " " + clock(time) + " UTC";
    const headers = [
      ["当前持仓", positionText(snapshot.quantity), snapshot.quantity ? colorClass(snapshot.quantity) : ""],
      ["入场均价", price(snapshot.entry), ""],
      ["未实现盈亏" + (state.mode === "simulation" ? "" : " · 估算"), btc(snapshot.unrealised), colorClass(snapshot.unrealised)],
      ["有效杠杆", snapshot.leverage === null ? "未知" : snapshot.leverage.toFixed(2) + "×", ""],
    ];
    $("account-summary").innerHTML = headers.map(([label, value, tone]) =>
      "<div><dt>" + label + "</dt><dd class='mono " + tone + "'>" + value + "</dd></div>").join("");
    if (state.ledger === "position") {
      writeTable(["合约", "估值价", "已实现（成交净额）", "当前权益", "有效杠杆"],
        [["XBTUSD", price(snapshot.mark), "<span class='" + colorClass(snapshot.realised) + "'>" + btc(snapshot.realised) + "</span>",
          snapshot.equity === null ? "未知" : snapshot.equity.toFixed(5) + " BTC", snapshot.leverage === null ? "未知" : snapshot.leverage.toFixed(2) + "×"]]);
      return;
    }
    if (state.ledger === "orders") {
      if (state.mode !== "simulation") {
        writeEmpty("历史挂单未知。样本中的订单终态无法确认所选时刻仍在场的委托。");
        return;
      }
      const open = state.sim.orders.filter(order => order.status === "open");
      if (!open.length) {
        writeEmpty("暂无模拟挂单 · 起点的历史挂单状态未知。");
        return;
      }
      writeTable(["时间（UTC）", "方向", "类型", "价格", "数量", "操作"], open.map(order => [
        clock(order.time, true), tradeBadge(order), order.type === "limit" ? "限价" : "市价",
        order.price ? price(order.price) : "下一次撮合", amount(order.quantity) + " 张",
        "<button class='table-action' type='button' data-cancel='" + order.id + "'>撤单</button>",
      ]));
      return;
    }
    const visible = state.mode === "simulation"
      ? (state.sim.report && state.compare !== "practice"
        ? [...(state.compare === "benchmark" ? [] : state.sim.fills), ...state.sim.report.originalFills].sort((a, b) => a.time - b.time)
        : state.sim.fills)
      : tradesInView();
    if (!visible.length) {
      writeEmpty(state.mode === "simulation" ? "暂无练习成交。" : "当前区间暂无已显示的成交。");
      return;
    }
    const latest = visible.slice(-80).reverse();
    const chosen = getTrade(state.selected);
    if (chosen && visible.some(trade => trade.id === chosen.id) && !latest.some(trade => trade.id === chosen.id)) latest.unshift(chosen);
    writeTable(["时间（UTC）", "方向", "成交价", "数量", "仓位动作", "操作"], latest.map(trade => [
      "<button type='button' class='table-time' data-select='" + trade.id + "'>" + shortDate(trade.time) + " " + clock(trade.time, true) + "</button>",
      tradeBadge(trade) + (state.sim?.report ? " " + (trade.origin === "benchmark" ? "魏神" : "我") : ""),
      price(trade.price), amount(trade.quantity) + " 张", trade.action + " · " + typeText(trade.orderType),
      "<button class='table-action' type='button' data-ref='" + trade.id + "'>引用 ↗</button>",
    ]), latest);
  }

  function tradeBadge(trade) {
    return "<span class='data-pill " + sideClass(trade) + "'>" + side(trade) + "</span>";
  }

  function writeEmpty(message) {
    $("account-content").innerHTML = "<p class='empty-row'>" + escape(message) + "</p>";
  }

  function writeTable(columns, rows, trades = []) {
    const head = columns.map(title => "<th scope='col'>" + title + "</th>").join("");
    const body = rows.map((row, index) => {
      const trade = trades[index];
      const attributes = trade
        ? " data-trade='" + trade.id + "' class='" + (trade.id === state.selected ? "is-selected" : "") + "'" : "";
      return "<tr" + attributes + ">" + row.map(cell => "<td>" + cell + "</td>").join("") + "</tr>";
    }).join("");
    $("account-content").innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
  }

  function closePopover() {
    $("marker-popover").hidden = true;
  }

  function showMarkerList(hit) {
    const popover = $("marker-popover");
    const chartWindow = $("chart-window");
    const trades = hit.trades;
    const detail = trades.length === 1
      ? "<div class='marker-list'><button type='button' data-ref='" + trades[0].id + "'>引用这笔成交 <span aria-hidden='true'>↗</span></button></div>"
      : "<div class='marker-list'>" + trades.slice().reverse().map(trade =>
        "<button type='button' data-select='" + trade.id + "'><span class='" + sideClass(trade) + "'>"
        + side(trade) + " · " + clock(trade.time, true) + "</span><span class='mono'>" + price(trade.price) + "</span></button>").join("") + "</div>";
    const label = trades.length === 1
      ? side(trades[0]) + " · " + price(trades[0].price) + " · " + amount(trades[0].quantity) + " 张"
      : amount(trades.length) + " 笔成交";
    popover.innerHTML = "<header><span>" + label + "</span>"
      + "<button class='button square' type='button' data-move='close-popover' aria-label='关闭成交详情'>×</button></header>" + detail;
    popover.hidden = false;
    const left = Math.max(8, Math.min(chartWindow.clientWidth - popover.offsetWidth - 8, hit.x + 10));
    const top = Math.max(35, Math.min(chartWindow.clientHeight - popover.offsetHeight - 10, hit.y + 12));
    popover.style.left = left + "px";
    popover.style.top = top + "px";
  }

  function selectTrade(id, keepPopover = false) {
    const trade = getTrade(id);
    if (!trade) {
      toast("这笔成交当前不可查看");
      return;
    }
    state.selected = id;
    if (state.mode === "history" && (trade.time < state.view.from || trade.time >= state.view.to)) {
      state.view = historyWindow(trade.time);
    }
    if (!keepPopover) closePopover();
    renderFrame();
    renderLedger();
    updateControls();
  }

  function referenceTrade(id) {
    if (!getTrade(id)) return;
    selectTrade(id);
    if (!state.refs.includes(id)) {
      if (state.refs.length >= 5) {
        toast("一次最多引用 5 笔成交");
        return;
      }
      state.refs.push(id);
    }
    state.reportTab = "assistant";
    renderInspector();
    $("question").focus({preventScroll: true});
  }

  function visibleReferences(ids) {
    return ids.map(getTrade).filter(Boolean);
  }

  function referenceLabel(trade) {
    return side(trade) + " " + price(trade.price) + " · " + clock(trade.time);
  }

  function renderInspector() {
    const settled = Boolean(state.sim?.report && state.mode === "simulation");
    const showReport = settled && state.reportTab === "report";
    $("inspector-tabs").hidden = !settled;
    $("inspector-tabs").innerHTML = settled
      ? "<button type='button' data-inspector='assistant' aria-pressed='" + String(!showReport) + "'>交易助手</button>"
        + "<button type='button' data-inspector='report' aria-pressed='" + String(showReport) + "'>结算报告</button>"
      : "";
    $("inspector-body").hidden = showReport;
    $("report").hidden = !showReport;
    if (showReport) renderReport();
    else {
      renderMessages();
      renderReferenceChips();
    }
  }

  function renderReferenceChips() {
    const references = visibleReferences(state.refs);
    $("references").hidden = !references.length;
    $("references").innerHTML = references.map(trade =>
      "<button type='button' data-remove-reference='" + trade.id + "' aria-label='移除引用 " + escape(referenceLabel(trade)) + "'>"
      + escape(referenceLabel(trade)) + " ×</button>").join("");
  }

  function renderMessages() {
    const conversation = $("conversation");
    if (!state.messages.length) {
      const prompts = state.mode === "simulation"
        ? ["我现在持有什么仓位？", "这个练习的成交怎么算？", "现在的盈亏是多少？"]
        : ["这笔成交怎么改变了仓位？", "这段行情里主要做了什么？", "当时的仓位风险有多大？"];
      conversation.innerHTML = "<div class='chat-start'><h3>从一笔成交看起</h3>"
        + "<p>点图上的买卖标记，或在成交历史中引用一笔成交。</p><div class='quick-actions'>"
        + prompts.map(prompt => "<button type='button' data-prompt='" + escape(prompt) + "'>" + escape(prompt)
          + "<span aria-hidden='true'>↗</span></button>").join("") + "</div></div>";
      return;
    }
    const nodes = state.messages.map(message => {
      const box = document.createElement("article");
      box.className = "message " + message.role;
      if (message.time) {
        const time = document.createElement("time");
        time.textContent = timestamp(message.time) + " UTC";
        box.append(time);
      }
      box.append(document.createTextNode(message.text));
      const citations = visibleReferences(message.citations || []);
      if (citations.length) {
        const list = document.createElement("div");
        list.className = "message-citations";
        for (const trade of citations) {
          const citation = document.createElement("button");
          citation.type = "button";
          citation.dataset.select = trade.id;
          citation.textContent = referenceLabel(trade);
          list.append(citation);
        }
        box.append(list);
      }
      return box;
    });
    conversation.replaceChildren(...nodes);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function dataAnswer(question, references) {
    const {snapshot, time} = accountContext();
    if (state.mode === "simulation" && !state.sim.report && /魏神.*(之后|后续|下一|结局|以后)|后续.*魏神|结算结果/.test(question)) {
      return {text: "本轮结算后，可以查看同一段时间魏神的真实成交，并对比两条路径。", citations: []};
    }
    if (state.mode === "simulation" && /成交怎么算|手续费|撮合/.test(question)) {
      const execution = state.sim.source.source === "BitMEX" ? "市价按下一笔公开成交价。" : "市价按下一根可见分钟线开盘价。";
      return {text: execution + " 限价在行情穿过报价后按限价成交。练习和对照统一按 0.075% 手续费计算。", citations: []};
    }
    if (references.length) {
      const lines = references.map(trade =>
        shortDate(trade.time) + " " + clock(trade.time, true) + "，" + side(trade) + " " + amount(trade.quantity)
        + " 张，成交价 " + price(trade.price) + "。\n持仓由" + positionText(trade.before.quantity)
        + "变为" + positionText(trade.account.quantity) + "，属于" + trade.action + "。");
      return {
        text: lines.join("\n\n") + (state.mode === "simulation" ? "" : "\n\n成交记录能确认这些变化，当时的交易动机未知。"),
        citations: references.map(trade => trade.id),
      };
    }
    if (/区间|这段|主要|统计/.test(question)) {
      const visible = tradesInView();
      const buys = visible.filter(trade => trade.quantity > 0);
      const sells = visible.filter(trade => trade.quantity < 0);
      if (!visible.length) return {text: "当前图表区间没有已显示的成交，可以换一个日期查看。", citations: []};
      return {
        text: "图上当前显示 " + amount(visible.length) + " 笔成交，其中 Buy " + amount(buys.length)
          + " 笔、Sell " + amount(sells.length) + " 笔。按张数看，买入 " + amount(buys.reduce((sum, trade) => sum + trade.quantity, 0))
          + " 张、卖出 " + amount(sells.reduce((sum, trade) => sum - trade.quantity, 0)) + " 张。",
        citations: [buys.at(-1), sells.at(-1)].filter(Boolean).map(trade => trade.id),
      };
    }
    if (/风险|杠杆|持仓|仓位|盈亏|收益|这笔/.test(question)) {
      const markLabel = state.mode === "simulation" ? "回放估值价" : "参考估值价";
      return {
        text: timestamp(time) + " UTC，当前" + positionText(snapshot.quantity)
          + (snapshot.entry ? "，入场均价 " + price(snapshot.entry) : "") + "。\n"
          + markLabel + " " + price(snapshot.mark) + "，未实现盈亏 " + btc(snapshot.unrealised) + "。"
          + (snapshot.leverage === null ? "本时点缺少可核验的完整权益，有效杠杆显示未知。" : "有效杠杆 " + snapshot.leverage.toFixed(2) + "×。"),
        citations: [],
      };
    }
    return {
      text: "可以用当前数据回答成交方向、仓位变化和盈亏。想看某笔成交时，请从图上或成交表引用它。",
      citations: [],
    };
  }

  function sendQuestion(question) {
    if (!state.market) return;
    const text = question.trim();
    const refs = visibleReferences(state.refs);
    const selected = getTrade(state.selected);
    if (!text && !refs.length) {
      $("question").focus();
      return;
    }
    const prompt = text || "这笔成交怎么改变了仓位？";
    const relevant = refs.length ? refs : (selected && /这笔|这几笔|改变/.test(prompt) ? [selected] : []);
    const explanation = dataAnswer(prompt, relevant);
    state.messages.push({
      role: "user", text: prompt, citations: relevant.map(trade => trade.id),
    }, {
      role: "assistant", text: explanation.text, time: currentTime(), citations: explanation.citations,
    });
    state.refs = [];
    $("question").value = "";
    renderInspector();
  }

  function renderReport() {
    const sim = state.sim;
    const report = sim.report;
    const {practice, benchmark} = report;
    const stats = [
      ["净盈亏", btc(practice.gain), btc(benchmark.gain)],
      ["收益率", percent(practice.returnRate), percent(benchmark.returnRate)],
      ["最大回撤", (practice.drawdown * 100).toFixed(2) + "%", (benchmark.drawdown * 100).toFixed(2) + "%"],
      ["期末权益", practice.equity.toFixed(5), benchmark.equity.toFixed(5)],
      ["成交笔数", amount(practice.trades), amount(benchmark.trades)],
    ];
    const keyTrades = [sim.fills, report.originalFills].map(fills => fills.reduce((biggest, trade) =>
      !biggest || Math.abs(biggest.quantity) < Math.abs(trade.quantity) ? trade : biggest, null));
    const actions = keyTrades.map((trade, index) => {
      const person = index ? "魏神" : "我的";
      return trade
        ? "<button type='button' class='button' data-select='" + trade.id + "'>" + person + " · " + trade.action + " " + amount(trade.quantity) + " 张 ↗</button>"
        : "";
    }).join("");
    const mechanism = sim.source.source === "BitMEX" ? "BitMEX 同场逐笔估值" : "Binance 分钟线参考估值";
    $("report").innerHTML = "<h3>模拟结算</h3><p class='report-time mono'>" + timestamp(sim.start) + " — " + clock(report.time) + " UTC</p>"
      + "<p class='report-note'>起始权益 " + report.opening.toFixed(5) + " BTC · 结算价 " + price(report.price) + "</p>"
      + "<table><thead><tr><th scope='col'>指标</th><th scope='col'>我</th><th scope='col'>魏神对照</th></tr></thead><tbody>"
      + stats.map(([name, mine, theirs], i) => "<tr><th scope='row'>" + name + "</th><td class='mono "
        + (i < 2 ? colorClass(practice.gain) : "") + "'>" + mine + "</td><td class='mono "
        + (i < 2 ? colorClass(benchmark.gain) : "") + "'>" + theirs + "</td></tr>").join("")
      + "</tbody></table><p class='report-note'>" + mechanism + "。双方同一起点和同一结算价，手续费统一为 0.075%，按整单成交估算。</p>"
      + (actions ? "<h4 class='report-section'>本轮较大的仓位动作</h4><div class='report-actions'>" + actions + "</div>" : "");
  }

  function toast(message) {
    clearTimeout(state.toast);
    $("notice").textContent = message;
    $("notice").hidden = false;
    state.toast = setTimeout(() => { $("notice").hidden = true; }, 3200);
  }

  function render() {
    closePopover();
    $("mode-label").innerHTML = "<i></i>" + ({history: "历史交易", replay: "回放", simulation: "模拟交易"})[state.mode];
    renderFrame();
    renderControls();
    renderLedger();
    renderInspector();
  }

  function saveHistory() {
    state.history = {
      view: {...state.view}, interval: state.interval, selected: state.selected, ledger: state.ledger,
      messages: state.messages, refs: state.refs, question: $("question").value,
    };
    state.selected = null;
    state.ledger = "fills";
    state.messages = [];
    state.refs = [];
    state.reportTab = "assistant";
    $("question").value = "";
  }

  function enterReplay() {
    const selected = getTrade(state.selected);
    const trade = selected || tradesInView().at(-1);
    const date = trade?.time ?? currentTime();
    // Keep the initial section short enough to reach the first trade quickly.
    const dayStart = E.bucket(date, "1d");
    const dayEnd = Math.min(dayStart + E.DAY - 1, state.market.coverage[1]);
    const dayTrades = E.span(state.market.fills, dayStart, dayEnd);
    const first = selected || dayTrades[0];
    if (!first) {
      toast("这天没有已收录成交，请换个日期");
      return;
    }
    saveHistory();
    state.mode = "replay";
    state.interval = "1m";
    const start = Math.max(dayStart, first.time - 28 * E.MINUTE);
    const end = Math.max(start + 1000, dayEnd);
    state.replay = {start, end, time: start, speed: 1, trades: E.span(state.market.fills, start, end)};
    setReplayView();
    render();
  }

  function enterSimulation() {
    try {
      const sim = E.startSimulation(state.market, state.lastPracticeStart);
      saveHistory();
      state.mode = "simulation";
      state.interval = "1m";
      state.ledger = "position";
      state.compare = "both";
      state.sim = sim;
      state.order = {type: "market", quantity: "10000", price: price(sim.mark).replaceAll(",", "")};
      state.lastPracticeStart = sim.start;
      setPracticeView();
      render();
    } catch (error) {
      toast(error.message);
    }
  }

  function stopTimer() {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    state.playing = false;
  }

  function leaveActiveMode() {
    stopTimer();
    const saved = state.history;
    const mode = state.mode;
    if (!saved) return;
    Object.assign(state, saved);
    state.mode = "history";
    state.history = null;
    state.replay = null;
    state.sim = null;
    $("question").value = saved.question;
    render();
    $(mode === "replay" ? "enter-replay" : "enter-simulation").focus({preventScroll: true});
  }

  function refreshActive() {
    renderFrame();
    renderLedger();
    updateControls();
  }

  function seekReplay(time) {
    const replay = state.replay;
    replay.time = Math.max(replay.start, Math.min(time, replay.end));
    if (replay.time >= replay.end) stopTimer();
    if (getTrade(state.selected) === null) state.selected = null;
    closePopover();
    setReplayView();
    refreshActive();
    renderReferenceChips();
  }

  function jumpTrade(direction) {
    stopTimer();
    const {trades, time} = state.replay;
    const selected = trades.findIndex(trade => trade.id === state.selected && trade.time === time);
    const index = selected >= 0 ? selected + direction
      : E.boundary(trades, time, byTime, direction > 0) + (direction > 0 ? 0 : -1);
    const trade = trades[index];
    if (trade) {
      seekReplay(trade.time);
      selectTrade(trade.id);
    } else {
      updateControls();
      toast(direction > 0 ? "已到最后一笔成交" : "已到第一笔成交");
    }
  }

  function advancePractice() {
    const sim = state.sim;
    const before = sim.fills.length;
    const notes = E.advanceSimulation(sim);
    if (notes.length) toast(notes.at(-1));
    if (sim.fills.length > before) {
      state.ledger = "fills";
      state.selected = sim.fills.at(-1).id;
    }
    if (sim.time >= sim.end || sim.halted) stopTimer();
    refreshActive();
  }

  function togglePlay() {
    if (state.playing) {
      stopTimer();
      updateControls();
      return;
    }
    if (state.mode === "replay") {
      const replay = state.replay;
      if (replay.time >= replay.end) seekReplay(replay.start);
      state.playing = true;
      state.timer = setInterval(() => seekReplay(replay.time + 38 * 20 * 60 * replay.speed), 38);
    } else if (!state.sim.halted && !state.sim.report && state.sim.time < state.sim.end) {
      state.playing = true;
      state.timer = setInterval(advancePractice, 470);
    }
    updateControls();
  }

  function settle() {
    stopTimer();
    clearTimeout(state.toast);
    $("notice").hidden = true;
    E.settleSimulation(state.market, state.sim);
    state.reportTab = "report";
    state.ledger = "fills";
    render();
  }

  function changeDate(date) {
    if (!date || state.mode !== "history") return;
    const start = Date.parse(date + "T00:00:00Z");
    if (!Number.isFinite(start)) return;
    const dayTrades = E.span(state.market.fills, start, start + E.DAY - 1);
    const anchor = state.interval === "1m" ? dayTrades[0]?.time ?? start + 2 * E.HOUR : start + E.DAY / 2;
    const view = historyWindow(anchor);
    setHistoryRange(view.from, view.to);
  }

  $("source-button").addEventListener("click", () => $("source-dialog").showModal());
  $("compose").addEventListener("submit", event => {
    event.preventDefault();
    sendQuestion($("question").value);
  });
  $("question").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendQuestion(event.currentTarget.value);
    }
  });

  document.addEventListener("click", event => {
    const target = event.target.closest("button, [data-trade]");
    if (!target) return;
    if (target.dataset.closeDialog) {
      $(target.dataset.closeDialog).close();
      return;
    }
    if (!state.market) return;
    if (target.dataset.timeframe) changeInterval(target.dataset.timeframe);
    if (target.dataset.ledger) {
      state.ledger = target.dataset.ledger;
      renderLedger();
    }
    if (target.dataset.select) selectTrade(target.dataset.select);
    if (target.dataset.trade) selectTrade(target.dataset.trade);
    if (target.dataset.ref) referenceTrade(target.dataset.ref);
    if (target.dataset.removeReference) {
      state.refs = state.refs.filter(id => id !== target.dataset.removeReference);
      renderReferenceChips();
    }
    if (target.dataset.move === "close-popover") closePopover();
    if (target.dataset.prompt) sendQuestion(target.dataset.prompt);
    if (target.dataset.inspector) {
      state.reportTab = target.dataset.inspector;
      renderInspector();
    }
    if (target.dataset.cancel && state.mode === "simulation") {
      if (E.cancelOrder(state.sim, target.dataset.cancel)) toast("已撤销练习订单");
      renderLedger();
    }
    switch (target.id) {
    case "enter-replay": enterReplay(); break;
    case "enter-simulation": enterSimulation(); break;
    case "toggle-play": togglePlay(); break;
    case "advance-minute": advancePractice(); break;
    case "next-trade": jumpTrade(1); break;
    case "prev-trade": jumpTrade(-1); break;
    case "leave-replay": leaveActiveMode(); break;
    case "leave-simulation":
      if (state.sim.report) leaveActiveMode();
      else {
        stopTimer();
        updateControls();
        $("exit-dialog").showModal();
      }
      break;
    case "confirm-exit": $("exit-dialog").close(); leaveActiveMode(); break;
    case "settle": settle(); break;
    case "show-report": state.reportTab = "report"; renderInspector(); break;
    case "previous-range":
    case "next-range": {
      const delta = (state.view.to - state.view.from) * (target.id === "previous-range" ? -.8 : .8);
      setHistoryRange(state.view.from + delta, state.view.to + delta);
      break;
    }
    case "fit-range": {
      const view = historyWindow(getTrade(state.selected)?.time ?? currentTime(), !state.selected);
      setHistoryRange(view.from, view.to);
      break;
    }
    }
  });

  $("go-date").addEventListener("change", event => changeDate(event.target.value));

  $("mode-controls").addEventListener("input", event => {
    const target = event.target;
    if (target.id === "seek") {
      stopTimer();
      const {start, end} = state.replay;
      seekReplay(start + Number(target.value) / 10000 * (end - start));
    }
    if (target.id === "order-quantity") state.order.quantity = target.value;
    if (target.id === "order-price") state.order.price = target.value;
  });

  $("mode-controls").addEventListener("change", event => {
    const target = event.target;
    if (target.id === "speed") state.replay.speed = Number(target.value);
    if (target.id === "order-type") {
      state.order.type = target.value;
      $("limit-field").hidden = target.value !== "limit";
      $("order-price").required = target.value === "limit";
    }
    if (target.id === "compare-mode") {
      state.compare = target.value;
      refreshActive();
    }
  });

  $("mode-controls").addEventListener("submit", event => {
    if (event.target.id !== "trade-ticket") return;
    event.preventDefault();
    const direction = event.submitter?.value || "buy";
    const error = E.addOrder(state.sim, direction, state.order.type, Number(state.order.quantity), Number(state.order.price));
    if (error) toast(error);
    else {
      toast(state.order.type === "market" ? "市价单已提交，推进时间后撮合" : "限价单已挂出");
      state.ledger = "orders";
      renderLedger();
    }
  });

  function describeSources(market) {
    const [from, to] = market.coverage;
    const firstTrade = market.fills[0].time;
    const lastTrade = market.fills.at(-1).time;
    const mechanism = market.simulation.source === "BitMEX"
      ? "模拟用 Tardis 的 BitMEX XBTUSD 逐笔行情。"
      : "模拟用 Binance BTCUSDT 分钟线作参考。市价按下一分钟开盘价，历史成交仍取 BitMEX。";
    $("source-details").innerHTML = "<p>收录 " + amount(market.fills.length) + " 笔魏神 BitMEX XBTUSD 成交。第一笔 "
      + timestamp(firstTrade, true) + "，最后一笔 " + timestamp(lastTrade, true) + "（UTC）。<a href='https://github.com/bwjoke/BTC-Trading-Since-2020/releases/tag/data-2026-09-11' target='_blank' rel='noreferrer'>魏神公开账本 ↗</a></p>"
      + "<p>历史查看和回放的 K 线来自 <a href='https://github.com/binance/binance-public-data' target='_blank' rel='noreferrer'>Binance Data Vision ↗</a>"
      + "，取 " + timestamp(from) + " 至账本最后一次账户事件 " + timestamp(to) + "（UTC）。买卖标记使用 BitMEX 原始成交价。</p>"
      + "<p>" + mechanism + " 练习起点取 " + fullDate(market.simulation.anchor[0]) + " 账户样本，仓位与盈亏按币本位合约计算。</p>";
    $("data-period").textContent = fullDate(firstTrade) + " — " + fullDate(lastTrade) + " UTC";
  }

  (async () => {
    try {
      const raw = await E.loadBundle(window.REPLAY_DATA);
      window.REPLAY_DATA = null;
      state.market = E.createMarket(raw);
      if (!state.market.bars.length || !state.market.fills.length) throw new Error("归档样本为空");
      describeSources(state.market);
      const [from, to] = state.market.coverage;
      $("go-date").min = iso(from).slice(0, 10);
      $("go-date").max = iso(to).slice(0, 10);
      state.view = historyWindow(limits().to, true);
      render();
    } catch (error) {
      $("chart-notice").hidden = false;
      $("chart-notice").textContent = "历史数据载入失败 · " + error.message;
    }
  })();
})();
