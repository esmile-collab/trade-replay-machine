"use strict";

(globalThis => {
  const COLORS = {
    grid: "#252530", muted: "#9393a7", axis: "#30303d", up: "#45bea0", down: "#ec7e92",
    crosshair: "#777487", cursor: "#f0edf8", accent: "#b7a3fa", text: "#e9e7f3",
  };
  const axisFont = "10px SFMono-Regular, Consolas, monospace";
  const number = new Intl.NumberFormat("en-US", {maximumFractionDigits: 2});
  const shortDate = new Intl.DateTimeFormat("en-GB", {timeZone: "UTC", day: "2-digit", month: "2-digit"});
  const shortTime = new Intl.DateTimeFormat("en-GB", {timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});

  function tickStep(range) {
    const raw = range / 5;
    const unit = Math.pow(10, Math.floor(Math.log10(Math.max(.01, raw))));
    const rounded = [1, 2, 2.5, 5, 10].find(step => step * unit >= raw);
    return rounded * unit;
  }

  function line(context, x, y, endX, endY, color) {
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(Math.round(x) + .5, Math.round(y) + .5);
    context.lineTo(Math.round(endX) + .5, Math.round(endY) + .5);
    context.stroke();
  }

  function rounded(context, x, y, width, height, radius, fill, stroke) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fillStyle = fill;
    context.fill();
    if (stroke) {
      context.strokeStyle = stroke;
      context.stroke();
    }
  }

  function triangle(context, x, y, direction, color) {
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x, y - 4 * direction);
    context.lineTo(x + 4, y + 3 * direction);
    context.lineTo(x - 4, y + 3 * direction);
    context.closePath();
    context.fill();
  }

  function groupMarkers(trades, xFor, selected) {
    const groups = new Map();
    for (const trade of trades) {
      const x = xFor(trade.time);
      const side = trade.quantity > 0 ? 1 : -1;
      const key = trade.id === selected ? trade.id : Math.floor(x / 29) + ":" + side + ":" + trade.origin;
      const group = groups.get(key);
      if (group) {
        group.trades.push(trade);
        group.x += x;
        group.price += trade.price;
      } else {
        groups.set(key, {x, side, origin: trade.origin, price: trade.price, trades: [trade], selected: trade.id === selected});
      }
    }
    return Array.from(groups.values()).sort((first, second) => Number(first.selected) - Number(second.selected));
  }

  function createChart(canvas, callbacks) {
    const context = canvas.getContext("2d");
    let model = null;
    let dimensions = null;
    let hover = null;
    let drag = null;
    let hits = [];
    let queued = false;

    function queueDraw() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        draw();
      });
    }

    function scale(width, height, data) {
      const left = 15;
      const right = width - (width < 600 ? 56 : 72);
      const top = width < 490 ? 65 : 40;
      const bottom = height - 33;
      const priceBottom = bottom - 45;
      const yFor = price => top + (data.high - price) / (data.high - data.low) * (priceBottom - top);
      const xFor = time => left + (time - data.from) / (data.to - data.from) * (right - left);
      return {left, right, top, bottom, priceBottom, yFor, xFor};
    }

    function draw() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const density = Math.min(2, devicePixelRatio || 1);
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (canvas.width !== width * density || canvas.height !== height * density) {
        canvas.width = Math.round(width * density);
        canvas.height = Math.round(height * density);
      }
      context.setTransform(density, 0, 0, density, 0, 0);
      context.clearRect(0, 0, width, height);
      hits = [];
      if (!model?.bars.length) return;
      const originalBars = model.bars;
      let low = Infinity;
      let high = -Infinity;
      let maxVolume = 1;
      for (const [, , top, bottom, , volume] of originalBars) {
        low = Math.min(low, bottom);
        high = Math.max(high, top);
        maxVolume = Math.max(maxVolume, volume);
      }
      for (const trade of model.trades) {
        low = Math.min(low, trade.price);
        high = Math.max(high, trade.price);
      }
      const padding = Math.max((high - low) * .13, 2);
      const limits = {...model, high: high + padding, low: low - padding};
      const chart = scale(width, height, limits);
      dimensions = {...chart, width, height};
      const {left, right, top, bottom, priceBottom, xFor, yFor} = chart;
      const interval = model.intervalMs;
      context.lineWidth = 1;
      context.font = axisFont;
      context.textBaseline = "middle";
      context.textAlign = "left";

      const priceStep = tickStep(limits.high - limits.low);
      for (let price = Math.ceil(limits.low / priceStep) * priceStep; price <= limits.high; price += priceStep) {
        const y = yFor(price);
        line(context, left, y, right, y, COLORS.grid);
        context.fillStyle = COLORS.muted;
        context.fillText(number.format(price), right + 8, y);
      }
      const columns = width > 660 ? 7 : 4;
      const duration = model.to - model.from;
      const multiple = duration > 10 * ReplayEngine.DAY ? 2 * ReplayEngine.DAY
        : duration > 2 * ReplayEngine.DAY ? ReplayEngine.DAY
        : duration > 12 * ReplayEngine.HOUR ? 4 * ReplayEngine.HOUR
        : duration > 4 * ReplayEngine.HOUR ? ReplayEngine.HOUR
        : duration > 80 * ReplayEngine.MINUTE ? 30 * ReplayEngine.MINUTE : 10 * ReplayEngine.MINUTE;
      const spacing = Math.ceil(duration / columns / multiple) * multiple;
      const timeFormatter = duration > 2 * ReplayEngine.DAY ? shortDate : shortTime;
      context.textAlign = "center";
      for (let time = Math.ceil(model.from / spacing) * spacing; time < model.to; time += spacing) {
        const x = xFor(time);
        line(context, x, top, x, bottom, COLORS.grid);
        if (x > left + 12 && x < right - 9) {
          context.fillStyle = COLORS.muted;
          const label = timeFormatter === shortDate ? timeFormatter.format(time).split("/").reverse().join("/") : timeFormatter.format(time);
          context.fillText(label, x, bottom + 14);
        }
      }
      line(context, left, bottom, right, bottom, COLORS.axis);
      line(context, right, top, right, bottom, COLORS.axis);

      const stepWidth = (right - left) * interval / duration;
      const body = Math.min(22, Math.max(1.1, stepWidth * .66));
      context.save();
      context.beginPath();
      context.rect(left, top, right - left, bottom - top + 1);
      context.clip();

      for (const [time, open, highPrice, lowPrice, close, volume] of originalBars) {
        const center = model.progressive
          ? Math.min(time + interval / 2, model.cursor)
          : time + interval / 2;
        const x = xFor(center);
        const up = close >= open;
        const color = up ? COLORS.up : COLORS.down;
        const barTop = Math.min(yFor(open), yFor(close));
        const candleHeight = Math.max(1.2, Math.abs(yFor(close) - yFor(open)));
        const volumeHeight = Math.max(1, volume / maxVolume * 36);
        context.fillStyle = up ? "#34756875" : "#a6516673";
        context.fillRect(x - body / 2, bottom - volumeHeight, body, volumeHeight);
        line(context, x, yFor(highPrice), x, yFor(lowPrice), color);
        context.fillStyle = color;
        context.fillRect(x - body / 2, barTop, body, candleHeight);
      }

      if (model.cursor !== null && model.progressive && model.cursor < model.to) {
        const x = xFor(model.cursor);
        context.fillStyle = "#101016a8";
        context.fillRect(x, top, right - x, bottom - top);
      }

      const finalBar = originalBars.at(-1);
      const lastPrice = model.mark || finalBar[4];
      const valueY = yFor(lastPrice);
      const priceColor = finalBar[4] >= finalBar[1] ? COLORS.up : COLORS.down;
      context.setLineDash([3, 4]);
      if (valueY >= top && valueY <= priceBottom) line(context, left, valueY, right, valueY, priceColor + "68");
      context.setLineDash([]);

      for (const group of groupMarkers(model.trades, xFor, model.selected)) {
        const x = group.x / group.trades.length;
        const y = yFor(group.price / group.trades.length);
        if (x < left || x > right) continue;
        const baseline = group.origin === "benchmark";
        const color = baseline ? COLORS.accent : group.side > 0 ? COLORS.up : COLORS.down;
        const labelY = Math.max(top + 9, Math.min(priceBottom + 13, y + group.side * 17));
        const count = group.trades.length;
        const label = count > 1 ? String(count) : "";
        const labelWidth = label ? (label.length > 1 ? 28 : 22) : 15;
        const offsetY = labelY - 7;
        line(context, x, y, x, labelY, color + "9b");
        context.fillStyle = color;
        context.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
        rounded(context, x - labelWidth / 2, offsetY, labelWidth, 14, 4, baseline ? "#362944" : group.side > 0 ? "#18372f" : "#3b232d",
          group.selected ? "#f7f1ff" : color + "b0");
        triangle(context, x + (label ? -labelWidth / 2 + 6 : 0), labelY, group.side, color);
        if (label) {
          context.fillStyle = color;
          context.textAlign = "center";
          context.fillText(label, x + 4, labelY);
        }
        hits.push({x, y: labelY, targetY: y, width: labelWidth, trades: group.trades});
      }

      if (model.cursor !== null && model.cursor >= model.from && model.cursor <= model.to) {
        const cursorX = xFor(model.cursor);
        line(context, cursorX, top, cursorX, bottom, COLORS.cursor);
        rounded(context, cursorX - 2, top, 5, 5, 2, COLORS.cursor);
      }

      let activeBar = finalBar;
      if (hover && !drag && hover.x >= left && hover.x <= right && hover.y >= top && hover.y <= bottom) {
        const hoverTime = model.from + (hover.x - left) / (right - left) * duration;
        const roundedTime = ReplayEngine.bucket(hoverTime, model.interval);
        const nearest = ReplayEngine.boundary(originalBars, roundedTime, row => row[0]);
        if (originalBars[nearest]?.[0] === roundedTime) activeBar = originalBars[nearest];
        context.setLineDash([4, 4]);
        line(context, hover.x, top, hover.x, bottom, COLORS.crosshair);
        line(context, left, hover.y, right, hover.y, COLORS.crosshair);
        context.setLineDash([]);
      }
      context.restore();

      if (valueY >= top && valueY <= priceBottom) {
        const labelWidth = Math.max(45, width - right - 6);
        rounded(context, right + 1, valueY - 8, labelWidth, 16, 3, priceColor);
        context.fillStyle = "#14141b";
        context.textAlign = "center";
        context.fillText(number.format(lastPrice), right + labelWidth / 2, valueY);
      }

      if (hover && !drag && hover.x >= left && hover.x <= right && hover.y >= top && hover.y <= bottom) {
        const hoverTime = model.from + (hover.x - left) / (right - left) * duration;
        const label = (duration > 2 * ReplayEngine.DAY ? shortDate.format(hoverTime) + " " : "") + shortTime.format(hoverTime);
        const labelWidth = context.measureText(label).width + 12;
        const labelX = Math.max(left, Math.min(right - labelWidth, hover.x - labelWidth / 2));
        rounded(context, labelX, bottom + 3, labelWidth, 17, 3, "#343342");
        context.textAlign = "center";
        context.fillStyle = COLORS.text;
        context.fillText(label, labelX + labelWidth / 2, bottom + 11);
      }

      callbacks.bar(activeBar);
    }

    function pointer(event) {
      const rect = canvas.getBoundingClientRect();
      return {x: event.clientX - rect.left, y: event.clientY - rect.top};
    }

    canvas.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !model || !dimensions) return;
      hover = pointer(event);
      drag = {x: hover.x, width: dimensions.right - dimensions.left, start: model.from, end: model.to, moved: false};
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
      hover = pointer(event);
      if (drag && Math.abs(hover.x - drag.x) > 5 && model?.canPan) {
        drag.moved = true;
        canvas.classList.add("dragging");
        const shift = (drag.x - hover.x) / drag.width * (drag.end - drag.start);
        callbacks.range(drag.start + shift, drag.end + shift);
      }
      queueDraw();
    });
    canvas.addEventListener("pointerup", event => {
      const moved = drag?.moved;
      drag = null;
      canvas.classList.remove("dragging");
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (!moved) {
        const {x, y} = pointer(event);
        const selected = hits.findLast(hit =>
          Math.abs(hit.x - x) <= hit.width / 2 + 4 && (Math.abs(hit.y - y) <= 10 || Math.abs(hit.targetY - y) < 5));
        callbacks.marker(selected || null);
      }
      queueDraw();
    });
    canvas.addEventListener("pointercancel", () => {
      drag = null;
      hover = null;
      canvas.classList.remove("dragging");
      queueDraw();
    });
    canvas.addEventListener("pointerleave", () => {
      if (!drag) hover = null;
      queueDraw();
    });
    canvas.addEventListener("wheel", event => {
      if (!model?.canPan || !dimensions) return;
      event.preventDefault();
      const x = pointer(event).x;
      const anchor = Math.max(0, Math.min(1, (x - dimensions.left) / (dimensions.right - dimensions.left)));
      const width = model.to - model.from;
      if (event.shiftKey) {
        const shift = width * (event.deltaY < 0 ? -.12 : .12);
        callbacks.range(model.from + shift, model.to + shift);
      } else {
        const delta = Math.max(-1, Math.min(1, event.deltaY / 150));
        const nextWidth = width * Math.exp(delta * .32);
        const point = model.from + width * anchor;
        callbacks.range(point - anchor * nextWidth, point + (1 - anchor) * nextWidth);
      }
    }, {passive: false});
    new ResizeObserver(queueDraw).observe(canvas);
    return {setModel(next) { model = next; queueDraw(); }};
  }

  globalThis.createReplayChart = createChart;
})(globalThis);
