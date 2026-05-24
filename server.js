const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 5000;

// ==================== HTTP服务器 ====================
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('服务器内部错误');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('未找到');
  }
});

// ==================== WebSocket服务器 ====================
const wss = new WebSocket.Server({ server, maxPayload: 1024 });

// ==================== 游戏状态 ====================
const game = {
  players: new Map(),      // 活跃玩家 id -> { ws, name, score, lastClick }
  pool: new Map(),         // 等待池 id -> { ws, name }
  stage: 'waiting',        // waiting | normal | frenzy | over
  timeLeft: 180,
  event: null,             // { type, endTime, duration, clickedPlayers }
  nextId: 1,
  countdown: 0,            // 下一轮倒计时秒数
  countdownTimer: null,

  gameTickTimer: null,
  eventTimer: null,
  broadcastTimer: null,
  resetTimer: null,
};

const GAME_DURATION = 180;
const FRENZY_THRESHOLD = 30;
const EVENT_INTERVAL_NORMAL = 5000;
const EVENT_INTERVAL_FRENZY = 2500;
const EVENT_DURATION_NORMAL = 1000;
const EVENT_DURATION_FRENZY = 1000;
const BROADCAST_INTERVAL = 200;
const MIN_PLAYERS = 2;
const CLICK_COOLDOWN = 50;
const COUNTDOWN_SECONDS = 15;
const OVER_DISPLAY_DELAY = 5000;

// ==================== 连接处理 ====================
wss.on('connection', (ws) => {
  if (wss.clients.size > 100) {
    ws.close(1013, '服务器已满');
    return;
  }
  const playerId = 'p' + game.nextId++;
  ws.playerId = playerId;
  ws.playerName = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(ws, playerId, msg);
    } catch (e) {
      console.error('消息解析错误:', e.message);
    }
  });

  ws.on('close', () => {
    handleDisconnect(playerId);
  });

  ws.on('error', (err) => {
    console.error('WebSocket错误:', err.message);
    handleDisconnect(playerId);
  });

  sendToClient(ws, {
    type: 'welcome',
    playerId,
    state: buildStatePayload(playerId),
  });
});

// ==================== 心跳检测 ====================
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

// ==================== 消息处理 ====================
function handleMessage(ws, playerId, msg) {
  switch (msg.type) {
    case 'join':
      handleJoin(ws, playerId, msg);
      break;
    case 'click':
      handleClick(playerId, msg.target);
      break;
    default:
      sendToClient(ws, { type: 'error', message: '未知消息类型' });
  }
}

function handleJoin(ws, playerId, msg) {
  const name = (msg.name || '').replace(/[<>&"'\x00-\x1F\x7F]/g,'').trim().substring(0, 12) || '无名氏';

  // 如果已经在活跃玩家或池中，先移除旧记录
  if (game.players.has(playerId)) {
    game.players.delete(playerId);
  }
  if (game.pool.has(playerId)) {
    game.pool.delete(playerId);
  }

  ws.playerName = name;

  if (game.stage === 'normal' || game.stage === 'frenzy') {
    // 游戏进行中 → 加入池，作为观战者
    game.pool.set(playerId, { ws, name });
    console.log(`[加入] ${name} (${playerId}) 加入等待池（观战），当前池: ${game.pool.size}`);
    sendToClient(ws, {
      type: 'joined',
      playerId,
      name,
      spectator: true,
    });
    broadcastState();
    return;
  }

  // 游戏未进行 → 加入池
  game.pool.set(playerId, { ws, name });
  console.log(`[加入] ${name} (${playerId}) 加入等待池，当前池: ${game.pool.size}`);

  sendToClient(ws, {
    type: 'joined',
    playerId,
    name,
    spectator: false,
  });

  // 人数足够且没有在倒计时 → 开始倒计时
  if (game.pool.size >= MIN_PLAYERS && !game.countdownTimer) {
    startCountdown();
  }

  broadcastState();
}

function handleClick(playerId, target) {
  if (game.stage !== 'normal' && game.stage !== 'frenzy') return;

  // 池玩家不能点击
  if (game.pool.has(playerId)) return;

  const player = game.players.get(playerId);
  if (!player) return;

  const now = Date.now();
  if (now - player.lastClick < CLICK_COOLDOWN) return;
  player.lastClick = now;

  if (target === 'normal') {
    const points = game.stage === 'frenzy' ? 2 : 1;
    player.score += points;
  } else if (target === 'special') {
    handleSpecialClick(playerId);
  }
}

function handleSpecialClick(playerId) {
  if (!game.event) return;

  const now = Date.now();
  if (now >= game.event.endTime) return;

  if (game.event.clickedPlayers.has(playerId)) return;

  const player = game.players.get(playerId);
  if (!player) return;

  game.event.clickedPlayers.add(playerId);

  switch (game.event.type) {
    case 'super':
      player.score += 2;
      console.log(`[超级] ${player.name} 获得超级加分，当前: ${player.score}`);
      broadcastToAll({
        type: 'event-notify',
        notify: 'super',
        name: player.name,
      });
      break;

    case 'trap':
      player.score -= 10;
      console.log(`[陷阱] ${player.name} 踩到陷阱，当前: ${player.score}`);
      break;

    case 'swap': {
      const others = [...game.players.entries()].filter(([id]) => id !== playerId);
      if (others.length > 0) {
        const [otherId, otherPlayer] = others[Math.floor(Math.random() * others.length)];
        const temp = player.score;
        player.score = otherPlayer.score;
        otherPlayer.score = temp;
        console.log(`[交换] ${player.name} ↔ ${otherPlayer.name} 交换分数`);
        broadcastToAll({
          type: 'event-notify',
          notify: 'swap',
          name1: player.name,
          name2: otherPlayer.name,
        });
      }
      break;
    }
  }
}

function handleDisconnect(playerId) {
  const wasPlayer = game.players.has(playerId);
  const wasPool = game.pool.has(playerId);
  if (!wasPlayer && !wasPool) return;

  if (wasPlayer) {
    const player = game.players.get(playerId);
    console.log(`[离开] ${player.name} (${playerId}) 离开游戏`);
    game.players.delete(playerId);

    if ((game.stage === 'normal' || game.stage === 'frenzy') && game.players.size < MIN_PLAYERS) {
      endGame();
      return;
    }
  }

  if (wasPool) {
    const pooler = game.pool.get(playerId);
    console.log(`[离开] ${pooler.name} (${playerId}) 离开等待池`);
    game.pool.delete(playerId);

    // 倒计时中人数不足 → 取消倒计时
    if (game.stage === 'waiting' && game.pool.size < MIN_PLAYERS && game.countdownTimer) {
      clearInterval(game.countdownTimer);
      game.countdownTimer = null;
      game.countdown = 0;
    }
  }

  if (wasPlayer || wasPool) {
    broadcastState();
  }
}

// ==================== 游戏流程控制 ====================
function startCountdown() {
  game.countdown = COUNTDOWN_SECONDS;
  broadcastState();

  game.countdownTimer = setInterval(() => {
    game.countdown--;
    broadcastState();
    if (game.countdown <= 0) {
      clearInterval(game.countdownTimer);
      game.countdownTimer = null;
      promotePool();
      startGame();
    }
  }, 1000);
}

function promotePool() {
  for (const [id, p] of game.pool) {
    game.players.set(id, { ws: p.ws, name: p.name, score: 0, lastClick: 0 });
  }
  game.pool.clear();
  console.log(`[开局] ${game.players.size} 名玩家加入游戏`);
}

function startGame() {
  if (game.stage !== 'waiting') return;

  console.log('[游戏] 游戏开始！');
  game.stage = 'normal';
  game.timeLeft = GAME_DURATION;
  game.event = null;
  game.countdown = 0;

  for (const [, player] of game.players) {
    player.score = 0;
  }

  game.gameTickTimer = setInterval(() => {
    game.timeLeft--;

    if (game.stage === 'normal' && game.timeLeft <= FRENZY_THRESHOLD) {
      console.log('[游戏] 进入狂暴模式！');
      game.stage = 'frenzy';
      restartEventTimer();
    }

    if (game.timeLeft <= 0) {
      endGame();
    }
  }, 1000);

  startEventTimer();

  game.broadcastTimer = setInterval(() => {
    broadcastState();
  }, BROADCAST_INTERVAL);

  broadcastState();
}

function endGame() {
  if (game.stage === 'over') return;
  console.log('[游戏] 游戏结束！');

  game.stage = 'over';
  game.timeLeft = 0;
  game.event = null;

  clearAllTimers();

  const ranking = [...game.players.entries()]
    .map(([id, p]) => ({ id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  broadcastToAll({
    type: 'gameover',
    ranking,
    state: buildStatePayload(null),
  });

  game.resetTimer = setTimeout(() => {
    for (const [id, p] of game.players) {
      if (p.ws.readyState === WebSocket.OPEN) {
        game.pool.set(id, { ws: p.ws, name: p.name });
      }
    }
    game.players.clear();
    resetGame();

    if (game.pool.size >= MIN_PLAYERS) {
      startCountdown();
    }
  }, OVER_DISPLAY_DELAY);
}

function resetGame() {
  console.log('[游戏] 重置游戏');

  clearAllTimers();

  game.stage = 'waiting';
  game.timeLeft = GAME_DURATION;
  game.event = null;
  game.countdown = 0;

  broadcastState();
}

// ==================== 特殊事件 ====================
function startEventTimer() {
  const interval = game.stage === 'frenzy' ? EVENT_INTERVAL_FRENZY : EVENT_INTERVAL_NORMAL;
  game.eventTimer = setInterval(generateEvent, interval);
}

function restartEventTimer() {
  if (game.eventTimer) {
    clearInterval(game.eventTimer);
    game.eventTimer = null;
  }
  startEventTimer();
  generateEvent();
}

function generateEvent() {
  if (game.stage !== 'normal' && game.stage !== 'frenzy') return;

  const rand = Math.random();
  let type;
  if (rand < 0.2) {
    type = 'super';
  } else if (rand < 0.7) {
    type = 'trap';
  } else {
    type = 'swap';
  }

  const duration = game.stage === 'frenzy' ? EVENT_DURATION_FRENZY : EVENT_DURATION_NORMAL;

  game.event = {
    type,
    endTime: Date.now() + duration,
    duration,
    clickedPlayers: new Set(),
  };

  console.log(`[事件] 生成${type === 'super' ? '超级' : type === 'trap' ? '陷阱' : '交换'}按钮`);
}

// ==================== 状态广播 ====================
function buildStatePayload(requesterId) {
  const players = {};
  for (const [id, p] of game.players) {
    players[id] = { name: p.name, score: p.score };
  }

  const pool = {};
  for (const [id, p] of game.pool) {
    pool[id] = { name: p.name };
  }

  let event = null;
  if (game.event && Date.now() < game.event.endTime) {
    event = {
      type: game.event.type,
      endTime: game.event.endTime,
      duration: game.event.duration,
    };
  }

  return {
    stage: game.stage,
    timeLeft: game.timeLeft,
    countdown: game.countdown,
    players,
    pool,
    event,
    inPool: requesterId ? game.pool.has(requesterId) : false,
  };
}

function broadcastState() {
  const base = buildStatePayload(null);
  const playerState = Object.assign({}, base, { inPool: false });
  const poolState = Object.assign({}, base, { inPool: true });
  for (const [id, player] of game.players) {
    if (player.ws.readyState === WebSocket.OPEN) {
      sendToClient(player.ws, {
        type: 'state',
        myId: id,
        state: playerState,
      });
    }
  }
  for (const [id, pooler] of game.pool) {
    if (pooler.ws.readyState === WebSocket.OPEN) {
      sendToClient(pooler.ws, {
        type: 'state',
        myId: id,
        state: poolState,
      });
    }
  }
}

function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  for (const [, player] of game.players) {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(msg);
    }
  }
  for (const [, pooler] of game.pool) {
    if (pooler.ws.readyState === WebSocket.OPEN) {
      pooler.ws.send(msg);
    }
  }
}

function sendToClient(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ==================== 工具函数 ====================
function clearAllTimers() {
  if (game.gameTickTimer) { clearInterval(game.gameTickTimer); game.gameTickTimer = null; }
  if (game.eventTimer) { clearInterval(game.eventTimer); game.eventTimer = null; }
  if (game.broadcastTimer) { clearInterval(game.broadcastTimer); game.broadcastTimer = null; }
  if (game.resetTimer) { clearTimeout(game.resetTimer); game.resetTimer = null; }
  if (game.countdownTimer) { clearInterval(game.countdownTimer); game.countdownTimer = null; }
}

// ==================== 启动服务器 ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  按钮大乱斗 服务器已启动！');
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  局域网: http://${getLocalIP()}:${PORT}`);
  console.log('========================================');
});

function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
