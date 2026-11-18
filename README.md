# 交易回放机

在 BTC K 线上查看魏神（Paul Wei）的历史成交，回放操作过程，并从历史账户状态开始模拟交易。

## 打开使用

下载或克隆仓库后，用浏览器打开 [交易回放机/index.html](交易回放机/index.html)。页面与样本数据均在本地加载，撮合和结算在浏览器中完成。

## 当前功能

- 历史查看默认打开，支持分钟、小时、日、周 K 线，以及日期定位、缩放和拖动。
- Buy / Sell 使用不同颜色，密集成交可展开逐笔查看，成交可引用到右侧助手。
- 回放从主图下方进入，白线随时间推进，同步显示成交与仓位。
- 模拟从六个已核验起点中随机抽取，支持市价、限价和撤单，主动结算后比较收益、回撤与魏神的真实成交。
- 退出回放或模拟后恢复之前的历史视图。

右侧助手目前根据本地可见数据提供规则解读。模拟使用整单成交假设，双方统一按 0.075% 手续费复算。历史挂单和部分历史权益缺少可核验记录，界面显示未知。

## 数据

历史成交自台北时间 2024-11-17 起筛选，共 11,130 笔 BitMEX XBTUSD 成交，最后一笔为 2026-07-23 09:46:54.726 UTC。历史 K 线内置 883,977 根 Binance BTCUSDT 永续分钟线。图上成交价保留 BitMEX 原始价格。模拟使用 2026-02-01 的 BitMEX 同场逐笔行情与账户样本。

- [魏神公开账本的固定归档](https://github.com/bwjoke/BTC-Trading-Since-2020/releases/tag/data-2026-09-11)
- [Binance Data Vision 数据说明](https://github.com/binance/binance-public-data)
- [Tardis BitMEX 行情归档](https://docs.tardis.dev/historical-data-details/bitmex)
- [筛选后的逐笔成交 CSV](魏神_XBTUSD_近两年逐笔成交.csv)

数据准备脚本 [prepare-data.py](交易回放机/prepare-data.py) 从原始成交、钱包记录和行情文件生成页面使用的数据包，保留区间开始前的仓位与成本。现有数据包可直接使用。

## 项目文件

| 文件 | 用途 |
| --- | --- |
| [index.html](交易回放机/index.html) | 页面入口 |
| [app.js](交易回放机/app.js) | 页面交互、回放、成交引用与报告 |
| [chart.js](交易回放机/chart.js) | Canvas K 线与成交标记 |
| [engine.js](交易回放机/engine.js) | 数据解包、仓位、撮合与结算 |
| [style.css](交易回放机/style.css) | 页面样式 |
| [market-data.js](交易回放机/market-data.js) | 内置行情与成交数据 |

## 文档

- [需求策划](交易回放机_需求策划.md)
- [工程技术规范](交易回放机_工程技术规范.md)
- [数据调研与早期方案](交易回放机_首版功能概况.md)

当前实现使用 HTML、CSS、JavaScript 和 Canvas。工程文档中已标明后续拟采用的框架与服务端方案。
