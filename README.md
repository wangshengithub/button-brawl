# 按钮大乱斗 (Button Brawl)

局域网多人实时 WebSocket 点击对决游戏。

## 玩法

1. 所有玩家进入房间，疯狂点击**普通按钮「摸鱼！」**，每点一次 +1 分
2. 每隔数秒服务器随机生成一个**特殊事件按钮**（外观与普通按钮完全一致，考验你的判断力）：
   - **超级按钮**（20%）：+2 分
   - **陷阱按钮**（50%）：-10 分
   - **交换按钮**（30%）：你的分数与随机一名玩家互换
3. 游戏总时长 **3 分钟**，最后 **30 秒**进入**狂暴模式**：普通点击 +2 分，特殊事件出现频率翻倍
4. 时间到按分数排名，展示冠军

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) 18+

### 启动

**Windows**：双击 `start.bat`

**Linux / macOS**：

```bash
npm install
npm start
```

服务器启动后，同一局域网内的设备用浏览器访问终端显示的地址即可加入游戏。

## 游戏流程

```
加入等待池 → 15秒倒计时（≥2人自动开始）→ 正常模式 150s → 狂暴模式 30s → 结束排名 → 自动下一轮
```

- 游戏进行中新玩家可加入等待池，观战当前排行榜，等待下一轮参战
- 每轮结束自动进入下一轮倒计时，无需手动操作

## 技术架构

- **后端**：Node.js + [ws](https://github.com/websockets/ws) 库，单文件 `server.js`
- **前端**：单 HTML 文件 (`public/index.html`)，原生 JS，零外部依赖
- **通信**：WebSocket JSON 消息协议
- **防作弊**：服务端权威计分，客户端仅发送点击指令
- **特性**：Canvas 粒子背景、Web Audio API 音效、自动重连、隐藏管理接口

## 项目结构

```
按钮大乱斗/
├── server.js          # 服务端（HTTP + WebSocket）
├── public/
│   └── index.html     # 前端（单文件，含 HTML/CSS/JS）
├── start.bat          # Windows 一键启动脚本
├── package.json       # 依赖声明
└── README.md          # 本文件
```

## 配置

修改 `server.js` 顶部的常量即可调整游戏参数：

| 常量                  | 默认值  | 说明         |
| ------------------- | ---- | ---------- |
| `PORT`              | 5000 | 服务端口       |
| `GAME_DURATION`     | 180  | 游戏总时长（秒）   |
| `FRENZY_THRESHOLD`  | 30   | 狂暴模式倒计时（秒） |
| `COUNTDOWN_SECONDS` | 15   | 等待池倒计时（秒）  |
| `CLICK_COOLDOWN`    | 50   | 点击冷却（毫秒）   |

## 关于本项目

本项目由世界顶级 AI 模型 **Claude Opus 4.7** (Anthropic) 生成。从产品需求文档到完整可运行代码，全部由 AI 中完成，包括游戏逻辑、实时通信、UI 设计、音效系统和安全防护。

---

Made by [wangshengithub](https://github.com/wangshengithub)
