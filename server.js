const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: false },
  transports: ["websocket", "polling"]
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const FIELD_LIMIT = 7;
const INITIAL_LIFE = 2;
const RECONNECT_MS = 60_000;

const CARD_DEFS = [
  {id:"01", min:1000, max:4000, effect:"none", attack:true, defend:false, weight:15},
  {id:"02", min:1000, max:4000, effect:"none", attack:false, defend:true, weight:15},
  {id:"03", min:1000, max:3000, effect:"destroy_enemy_one", attack:true, defend:false, weight:5},
  {id:"04", min:1000, max:3000, effect:"destroy_enemy_one", attack:false, defend:true, weight:5},
  {id:"05", min:1000, max:3000, effect:"draw_one", attack:true, defend:false, weight:2.5},
  {id:"06", min:1000, max:3000, effect:"draw_one", attack:false, defend:true, weight:2.5},
  {id:"07", min:1000, max:3000, effect:"discard_each_enemy", attack:true, defend:false, weight:2.5},
  {id:"08", min:1000, max:3000, effect:"discard_each_enemy", attack:false, defend:true, weight:2.5},
  {id:"09", min:1000, max:3000, effect:"heal_one", attack:true, defend:false, weight:1},
  {id:"10", min:1000, max:3000, effect:"heal_one", attack:false, defend:true, weight:1},
  {id:"11", min:1000, max:4000, effect:"lose_life_one", attack:true, defend:false, weight:4},
  {id:"12", min:1000, max:4000, effect:"lose_life_one", attack:false, defend:true, weight:4},
  {id:"13", min:1000, max:4000, effect:"discard_self_random", attack:true, defend:false, weight:4},
  {id:"14", min:1000, max:4000, effect:"discard_self_random", attack:false, defend:true, weight:4},
  {id:"15", min:1000, max:4000, effect:"destroy_self_field_one", attack:true, defend:false, weight:4},
  {id:"16", min:1000, max:4000, effect:"destroy_self_field_one", attack:false, defend:true, weight:4},
  {id:"17", min:1000, max:3000, effect:"rush", attack:true, defend:false, weight:6},
  {id:"18", min:1000, max:3000, effect:"double_attack", attack:true, defend:false, weight:6},
  {id:"19", min:1000, max:3000, effect:"none", attack:true, defend:true, weight:6},
  {id:"20", min:1000, max:3000, effect:"effect_immune", attack:false, defend:true, weight:6}
];

const TURN_EVENTS = [
  {id:"auto_summon", weight:70},
  {id:"double_summon", weight:7},
  {id:"destroy_all", weight:3},
  {id:"destroy_self_one", weight:5},
  {id:"discard_self_one", weight:10},
  {id:"no_attack", weight:5}
];

const ZERO_LIFE_EVENTS = [
  {id:"destroy_attacker", weight:20},
  {id:"destroy_all", weight:3},
  {id:"auto_summon", weight:50},
  {id:"miss", weight:27}
];

const rooms = new Map();
const socketToRoom = new Map();

function weightedPick(items) {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

function randomPower(def) {
  const count = Math.floor((def.max - def.min) / 1000) + 1;
  return def.min + Math.floor(Math.random() * count) * 1000;
}

function cardDef(id) {
  return CARD_DEFS.find(c => c.id === id);
}

function newCard(id = null, source = "hand") {
  const def = id ? cardDef(id) : weightedPick(CARD_DEFS);
  return {
    uid: crypto.randomUUID(),
    id: def.id,
    power: randomPower(def),
    source,
    summonedTurn: null,
    attacksThisTurn: 0
  };
}

function newPlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId,
    connected: true,
    reconnectToken: crypto.randomUUID(),
    disconnectedAt: null,
    life: INITIAL_LIFE,
    hand: [],
    field: [],
    eliminated: false
  };
}

function newRoom(code, hostId) {
  return {
    code,
    hostId,
    players: [],
    status: "waiting",
    turnIndex: 0,
    turnNumber: 0,
    phase: "waiting",
    turnSummonsUsed: 0,
    maxSummons: 1,
    attacksAllowed: true,
    pendingDefense: null,
    pendingAbility: null,
    pendingAttack: null,
    winnerOrder: [],
    log: [],
    createdAt: Date.now(),
    invalidReason: null
  };
}

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 80) room.log.shift();
}

function alivePlayers(room) {
  return room.players.filter(p => !p.eliminated);
}

function currentPlayer(room) {
  return room.players[room.turnIndex] || null;
}

function nextAliveIndex(room, fromIndex) {
  for (let i = 1; i <= room.players.length; i++) {
    const idx = (fromIndex + i) % room.players.length;
    if (room.players[idx] && !room.players[idx].eliminated) return idx;
  }
  return -1;
}

function publicCard(c) {
  return {
    uid: c.uid,
    id: c.id,
    power: c.power,
    attack: cardDef(c.id).attack,
    defend: cardDef(c.id).defend,
    effect: cardDef(c.id).effect,
    summonedTurn: c.summonedTurn,
    attacksThisTurn: c.attacksThisTurn
  };
}

function publicState(room, viewerId) {
  const viewer = room.players.find(p => p.id === viewerId);
  return {
    room: {
      code: room.code,
      status: room.status,
      phase: room.phase,
      turnNumber: room.turnNumber,
      currentPlayerId: currentPlayer(room)?.id || null,
      turnSummonsUsed: room.turnSummonsUsed,
      maxSummons: room.maxSummons,
      attacksAllowed: room.attacksAllowed,
      log: room.log.slice(-30),
      winnerOrder: room.winnerOrder.slice(),
      invalidReason: room.invalidReason
    },
    me: viewer ? {
      id: viewer.id,
      name: viewer.name,
      life: viewer.life,
      connected: viewer.connected,
      eliminated: viewer.eliminated,
      hand: viewer.hand.map(publicCard),
      field: viewer.field.map(publicCard),
      reconnectToken: viewer.reconnectToken
    } : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      life: p.life,
      connected: p.connected,
      eliminated: p.eliminated,
      field: p.field.map(publicCard)
    }))
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit("state", publicState(room, p.id));
  }
}

function randomOtherPlayer(room, playerId) {
  const others = alivePlayers(room).filter(p => p.id !== playerId);
  if (others.length === 1) return others[0];
  return others[Math.floor(Math.random() * others.length)];
}

function drawToPlayer(room, player) {
  const c = newCard(null, "draw");
  player.hand.push(c);
  return c;
}

function enforceFieldLimit(player) {
  if (player.field.length <= FIELD_LIMIT) return [];
  const removed = [];
  while (player.field.length > FIELD_LIMIT) {
    const idx = Math.floor(Math.random() * player.field.length);
    removed.push(player.field.splice(idx, 1)[0]);
  }
  return removed;
}

function destroyCard(player, uid) {
  const idx = player.field.findIndex(c => c.uid === uid);
  if (idx < 0) return null;
  return player.field.splice(idx, 1)[0];
}

function destroyRandomField(player) {
  if (!player.field.length) return null;
  const idx = Math.floor(Math.random() * player.field.length);
  return player.field.splice(idx, 1)[0];
}

function destroyAllFields(room, except = null) {
  for (const p of room.players) {
    p.field = p.field.filter(c => {
      const def = cardDef(c.id);
      if (c.uid === except) return true;
      if (def.effect === "effect_immune") return true;
      return false;
    });
  }
}

function discardRandomHand(player) {
  if (!player.hand.length) return null;
  const idx = Math.floor(Math.random() * player.hand.length);
  return player.hand.splice(idx, 1)[0];
}

function canEffectDestroy(card) {
  return cardDef(card.id).effect !== "effect_immune";
}

function finishEliminated(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    if (alive.length === 1) {
      const p = alive[0];
      if (!room.winnerOrder.includes(p.id)) room.winnerOrder.push(p.id);
    }
    room.status = "finished";
    room.phase = "finished";
    room.pendingAttack = null;
    room.pendingDefense = null;
    room.pendingAbility = null;
    addLog(room, alive.length ? `${alive[0].name} の勝利！` : "全員脱落しました。");
    return true;
  }
  return false;
}

function eliminatePlayer(room, player) {
  if (player.eliminated) return;
  player.eliminated = true;
  player.field = [];
  player.hand = [];
  if (!room.winnerOrder.includes(player.id)) room.winnerOrder.push(player.id);
  addLog(room, `${player.name} が脱落しました。`);
  finishEliminated(room);
}

function applySummonEffect(room, player, card, {allowSelf = true} = {}) {
  const def = cardDef(card.id);
  switch (def.effect) {
    case "draw_one":
      drawToPlayer(room, player);
      addLog(room, `${player.name} がカードを1枚引きました。`);
      break;
    case "discard_each_enemy":
      for (const p of room.players) {
        if (p.id !== player.id && !p.eliminated) discardRandomHand(p);
      }
      addLog(room, `${player.name} の効果で他プレイヤーの手札を1枚ずつ捨てました。`);
      break;
    case "heal_one":
      player.life += 1;
      addLog(room, `${player.name} のライフが1回復しました。`);
      break;
    case "lose_life_one":
      player.life = Math.max(0, player.life - 1);
      addLog(room, `${player.name} のライフが1減少しました。`);
      break;
    case "discard_self_random":
      if (player.hand.length) {
        discardRandomHand(player);
        addLog(room, `${player.name} は手札を1枚捨てました。`);
      }
      break;
    case "destroy_self_field_one": {
      // 召喚したばかりのこのカード自身は対象外。
      const candidates = player.field.filter(c => c.uid !== card.uid);
      if (candidates.length) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        destroyCard(player, target.uid);
        addLog(room, `${player.name} の効果で自分のフィールドカードを1枚破壊しました。`);
      }
      break;
    }
    case "destroy_enemy_one":
      // 対象をプレイヤーに選択してもらう。
      askAbility(room, player, card, "destroy_enemy_one");
      break;
    default:
      break;
  }
}

function summonCard(room, player, card) {
  if (player.field.length >= FIELD_LIMIT) {
    const removed = destroyRandomField(player);
    if (removed) addLog(room, `${player.name} のフィールドが満杯のため、既存カードをランダムに1枚破壊しました。`);
  }
  card.source = "field";
  card.summonedTurn = room.turnNumber;
  card.attacksThisTurn = 0;
  player.field.push(card);
  addLog(room, `${player.name} が No.${card.id}（POWER ${card.power}）を召喚しました。`);
  applySummonEffect(room, player, card);
}

function summonRandom(room, player, reason = "特殊召喚") {
  const card = newCard(null, "special");
  summonCard(room, player, card);
  addLog(room, `${reason}：No.${card.id} が召喚されました。`);
  return card;
}

function runTurnStartEvent(room, player) {
  const event = weightedPick(TURN_EVENTS);
  room.maxSummons = 1;
  room.turnSummonsUsed = 0;
  room.attacksAllowed = true;
  addLog(room, `${player.name} のターン開始時抽選：${eventName(event.id)}`);

  switch (event.id) {
    case "auto_summon":
      summonRandom(room, player, "ターン開始時特殊召喚");
      break;
    case "double_summon":
      room.maxSummons = 2;
      break;
    case "destroy_all":
      destroyAllFields(room);
      addLog(room, "全員のフィールドのカードを破壊しました（No.20は効果破壊されません）。");
      break;
    case "destroy_self_one":
      if (player.field.length) {
        destroyRandomField(player);
        addLog(room, `${player.name} のフィールドカードを1枚破壊しました。`);
      }
      break;
    case "discard_self_one":
      if (discardRandomHand(player)) addLog(room, `${player.name} は手札をランダムに1枚捨てました。`);
      break;
    case "no_attack":
      room.attacksAllowed = false;
      addLog(room, `${player.name} はこのターン攻撃できません。`);
      break;
  }
}

function startTurn(room) {
  if (room.status !== "playing") return;
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    finishEliminated(room);
    broadcast(room);
    return;
  }

  let idx = room.turnIndex;
  if (!room.players[idx] || room.players[idx].eliminated) {
    idx = nextAliveIndex(room, idx);
  }
  room.turnIndex = idx;
  const player = currentPlayer(room);

  room.turnNumber += 1;
  room.phase = "main";
  room.pendingDefense = null;
  room.pendingAbility = null;
  room.pendingAttack = null;
  room.maxSummons = 1;
  room.turnSummonsUsed = 0;
  room.attacksAllowed = true;

  for (const p of room.players) {
    for (const c of p.field) c.attacksThisTurn = 0;
  }

  runTurnStartEvent(room, player);
  drawToPlayer(room, player);
  addLog(room, `${player.name} が通常ドローしました。`);
  broadcast(room);
}

function startGame(room) {
  if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return false;
  room.status = "playing";
  room.phase = "main";
  room.turnIndex = 0;
  room.turnNumber = 0;
  room.winnerOrder = [];
  room.log = [];
  for (const p of room.players) {
    p.life = INITIAL_LIFE;
    p.hand = [];
    p.field = [];
    p.eliminated = false;
    p.connected = true;
    for (let i = 0; i < 3; i++) drawToPlayer(room, p);
  }
  addLog(room, "ゲーム開始！");
  startTurn(room);
  return true;
}

function eventName(id) {
  return {
    auto_summon: "山札からランダムに1枚召喚",
    double_summon: "このターン2回召喚可能",
    destroy_all: "全員のフィールドを全破壊",
    destroy_self_one: "自分のフィールドを1枚破壊",
    discard_self_one: "自分の手札を1枚捨てる",
    no_attack: "このターン攻撃不可",
    destroy_attacker: "攻撃中のカードを破壊",
    miss: "ハズレ"
  }[id] || id;
}

function resetForRematch(room) {
  room.status = "waiting";
  room.phase = "waiting";
  room.turnIndex = 0;
  room.turnNumber = 0;
  room.turnSummonsUsed = 0;
  room.maxSummons = 1;
  room.attacksAllowed = true;
  room.pendingDefense = null;
  room.pendingAbility = null;
  room.pendingAttack = null;
  room.winnerOrder = [];
  room.invalidReason = null;
  room.log = [];
  for (const p of room.players) {
    p.life = INITIAL_LIFE;
    p.hand = [];
    p.field = [];
    p.eliminated = false;
  }
}

function invalidateRoom(room, reason) {
  room.status = "invalid";
  room.phase = "invalid";
  room.invalidReason = reason;
  room.pendingAttack = null;
  room.pendingDefense = null;
  room.pendingAbility = null;
  addLog(room, reason);
  broadcast(room);
}

function validatePlayer(socket, room) {
  const playerId = socket.data.playerId;
  return room?.players.find(p => p.id === playerId) || null;
}

function validateTurn(room, player) {
  return room.status === "playing" && currentPlayer(room)?.id === player.id && room.phase === "main";
}

function askAbility(room, player, card, type, payload = {}) {
  room.phase = "ability";
  room.pendingAbility = {playerId: player.id, cardUid: card.uid, type, payload};
  io.to(player.socketId).emit("abilityRequired", {
    type,
    card: publicCard(card),
    ...payload
  });
  broadcast(room);
}

function performAbilityChoice(room, player, choice) {
  const pending = room.pendingAbility;
  if (!pending || pending.playerId !== player.id) return false;
  const card = player.field.find(c => c.uid === pending.cardUid);
  if (!card) {
    room.pendingAbility = null;
    room.phase = "main";
    return false;
  }

  if (pending.type === "destroy_enemy_one") {
    const targetPlayer = room.players.find(p => p.id === choice.targetPlayerId && !p.eliminated && p.id !== player.id);
    const targetCard = targetPlayer?.field.find(c => c.uid === choice.targetCardUid);
    if (!targetPlayer || !targetCard) return false;
    if (targetCard.power > card.power) return false;
    if (!canEffectDestroy(targetCard)) return false;
    destroyCard(targetPlayer, targetCard.uid);
    addLog(room, `${player.name} の No.${card.id} が ${targetPlayer.name} のカードを1枚破壊しました。`);
  }

  room.pendingAbility = null;
  room.phase = "main";
  broadcast(room);
  return true;
}

function availableAttackCards(player, room) {
  if (!room.attacksAllowed) return [];
  return player.field.filter(c => {
    const def = cardDef(c.id);
    if (!def.attack) return false;
    if (c.summonedTurn === room.turnNumber && def.effect !== "rush") return false;
    const max = def.effect === "double_attack" ? 2 : 1;
    return c.attacksThisTurn < max;
  });
}

function executeAttack(room, attackerPlayer, attackerCard, targetPlayer) {
  attackerCard.attacksThisTurn += 1;
  room.pendingAttack = {
    attackerPlayerId: attackerPlayer.id,
    attackerCardUid: attackerCard.uid,
    targetPlayerId: targetPlayer.id
  };

  if (targetPlayer.life === 0) {
    const event = weightedPick(ZERO_LIFE_EVENTS);
    addLog(room, `${targetPlayer.name} はライフ0のため特殊抽選：${eventName(event.id)}`);
    if (event.id === "destroy_attacker") {
      destroyCard(attackerPlayer, attackerCard.uid);
      room.pendingAttack = null;
      room.phase = "main";
      addLog(room, `攻撃中の No.${attackerCard.id} を破壊しました。`);
      broadcast(room);
      return;
    }
    if (event.id === "destroy_all") {
      destroyAllFields(room, attackerCard.uid);
      addLog(room, "全員のフィールドを破壊しました。");
    } else if (event.id === "auto_summon") {
      summonRandom(room, targetPlayer, "ライフ0時特殊召喚");
    }
    // 攻撃は続行
  }

  const defenders = targetPlayer.field.filter(c => cardDef(c.id).defend);
  if (defenders.length) {
    room.phase = "defense";
    room.pendingDefense = {
      attackerPlayerId: attackerPlayer.id,
      attackerCardUid: attackerCard.uid,
      targetPlayerId: targetPlayer.id
    };
    io.to(targetPlayer.socketId).emit("defenseRequired", {
      attacker: {
        playerName: attackerPlayer.name,
        card: publicCard(attackerCard)
      },
      defenders: defenders.map(publicCard)
    });
  } else {
    resolveNoDefense(room);
  }
  broadcast(room);
}

function resolveNoDefense(room) {
  const p = room.players.find(x => x.id === room.pendingAttack.targetPlayerId);
  if (!p) return;
  p.life = Math.max(0, p.life - 1);
  addLog(room, `${p.name} は攻撃を受け、ライフが1減りました。`);
  room.pendingAttack = null;
  room.pendingDefense = null;
  room.phase = "main";
  if (p.life === 0) {
    addLog(room, `${p.name} のライフが0になりました。次に攻撃を受けた場合、防御できなければ敗北します。`);
  }
  broadcast(room);
}

function resolveDefense(room, targetPlayer, defenderUid) {
  const pd = room.pendingDefense;
  if (!pd || pd.targetPlayerId !== targetPlayer.id) return false;
  const defender = targetPlayer.field.find(c => c.uid === defenderUid);
  const attackerPlayer = room.players.find(p => p.id === pd.attackerPlayerId);
  const attacker = attackerPlayer?.field.find(c => c.uid === pd.attackerCardUid);
  if (!defender || !attacker || !cardDef(defender.id).defend) return false;

  targetPlayer.field = targetPlayer.field.filter(c => c.uid !== defender.uid);
  addLog(room, `${targetPlayer.name} が No.${defender.id} で防御しました。防御カードは消滅します。`);

  if (defender.power >= attacker.power) {
    destroyCard(attackerPlayer, attacker.uid);
    addLog(room, `防御側のPOWERが同値以上のため、攻撃カードも破壊されました。`);
  } else {
    addLog(room, `防御側のPOWERが下回りましたが、ライフは減りません。`);
  }

  room.pendingDefense = null;
  room.pendingAttack = null;
  room.phase = "main";
  broadcast(room);
  return true;
}

function endTurn(room, player) {
  if (!validateTurn(room, player)) return;
  if (room.pendingAbility || room.pendingDefense || room.pendingAttack) return;
  room.phase = "turn_end";
  const next = nextAliveIndex(room, room.turnIndex);
  if (next < 0) {
    finishEliminated(room);
    broadcast(room);
    return;
  }
  room.turnIndex = next;
  startTurn(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}, cb) => {
    name = String(name || "").trim().slice(0, 20);
    if (!name) return cb?.({ok:false, error:"プレイヤー名を入力してください。"});
    let code;
    do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (rooms.has(code));
    const room = newRoom(code, null);
    const p = newPlayer(crypto.randomUUID(), name, socket.id);
    room.hostId = p.id;
    room.players.push(p);
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.playerId = p.id;
    socket.data.reconnectToken = p.reconnectToken;
    socket.join(code);
    cb?.({ok:true, code, reconnectToken:p.reconnectToken});
    broadcast(room);
  });

  socket.on("joinRoom", ({code, name}, cb) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 20);
    const room = rooms.get(code);
    if (!name) return cb?.({ok:false,error:"プレイヤー名を入力してください。"});
    if (!room) return cb?.({ok:false,error:"ルームが見つかりません。"});
    if (room.status !== "waiting") return cb?.({ok:false,error:"このルームは参加受付中ではありません。"});
    if (room.players.length >= MAX_PLAYERS) return cb?.({ok:false,error:"ルームは満員です。"});
    const p = newPlayer(crypto.randomUUID(), name, socket.id);
    room.players.push(p);
    socket.data.roomCode = code;
    socket.data.playerId = p.id;
    socket.data.reconnectToken = p.reconnectToken;
    socket.join(code);
    addLog(room, `${name} が参加しました。`);
    cb?.({ok:true, code, reconnectToken:p.reconnectToken});
    broadcast(room);
  });

  socket.on("reconnectGame", ({code, playerId, reconnectToken}, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room?.players.find(x => x.id === playerId);
    if (!room || !p || p.reconnectToken !== reconnectToken || p.connected || !p.disconnectedAt) {
      return cb?.({ok:false,error:"再接続できません。"});
    }
    if (Date.now() - p.disconnectedAt > RECONNECT_MS) {
      invalidateRoom(room, `${p.name} が60秒以内に復帰しなかったため、このゲームは無効になりました。`);
      return cb?.({ok:false,error:"再接続時間を超えました。"});
    }
    p.connected = true;
    p.disconnectedAt = null;
    p.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = p.id;
    socket.data.reconnectToken = p.reconnectToken;
    socket.join(room.code);
    addLog(room, `${p.name} が再接続しました。`);
    cb?.({ok:true});
    broadcast(room);
  });

  socket.on("startGame", cb => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p || room.hostId !== p.id) return cb?.({ok:false,error:"ゲームを開始できません。"});
    if (room.players.length < MIN_PLAYERS) return cb?.({ok:false,error:"2人以上必要です。"});
    startGame(room);
    cb?.({ok:true});
    broadcast(room);
  });

  socket.on("summonFromHand", ({uid}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p || !validateTurn(room,p)) return cb?.({ok:false,error:"今は召喚できません。"});
    if (room.turnSummonsUsed >= room.maxSummons) return cb?.({ok:false,error:"このターンの召喚回数を使い切っています。"});
    const idx = p.hand.findIndex(c => c.uid === uid);
    if (idx < 0) return cb?.({ok:false,error:"そのカードは手札にありません。"});
    const card = p.hand.splice(idx,1)[0];
    summonCard(room,p,card);
    room.turnSummonsUsed++;
    cb?.({ok:true});
    broadcast(room);
  });

  socket.on("attack", ({uid}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p || !validateTurn(room,p)) return cb?.({ok:false,error:"今は攻撃できません。"});
    if (!room.attacksAllowed) return cb?.({ok:false,error:"このターンは攻撃できません。"});
    const card = p.field.find(c => c.uid === uid);
    if (!card || !availableAttackCards(p,room).some(c => c.uid === uid)) return cb?.({ok:false,error:"そのカードは攻撃できません。"});
    const target = randomOtherPlayer(room,p.id);
    if (!target) return cb?.({ok:false,error:"攻撃対象がいません。"});
    addLog(room, `${p.name} が No.${card.id} で ${target.name} を攻撃しました。`);
    executeAttack(room,p,card,target);
    cb?.({ok:true});
  });

  socket.on("defend", ({uid}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p) return cb?.({ok:false,error:"無効な操作です。"});
    if (resolveDefense(room,p,uid)) cb?.({ok:true});
    else cb?.({ok:false,error:"そのカードでは防御できません。"});
  });

  socket.on("takeAttack", cb => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p || room.pendingDefense?.targetPlayerId !== p.id) return cb?.({ok:false,error:"無効な操作です。"});
    resolveNoDefense(room);
    cb?.({ok:true});
  });

  socket.on("abilityChoice", ({choice}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p || !performAbilityChoice(room,p,choice)) return cb?.({ok:false,error:"無効な選択です。"});
    cb?.({ok:true});
  });

  socket.on("endTurn", cb => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p) return cb?.({ok:false,error:"無効な操作です。"});
    endTurn(room,p);
    cb?.({ok:true});
  });

  socket.on("rematch", cb => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p || room.status !== "finished") return cb?.({ok:false,error:"再戦できません。"});
    p.rematchReady = true;
    const connected = room.players.filter(x => x.connected && !x.eliminated || x.connected);
    if (room.players.length >= MIN_PLAYERS && room.players.every(x => x.rematchReady && x.connected)) {
      for (const x of room.players) x.rematchReady = false;
      resetForRematch(room);
      startGame(room);
    } else {
      addLog(room, `${p.name} が再戦を希望しました。`);
    }
    cb?.({ok:true});
    broadcast(room);
  });

  socket.on("leaveRoom", cb => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p) return cb?.({ok:true});
    if (room.status === "playing") {
      invalidateRoom(room, `${p.name} が退出したため、このゲームは無効になりました。`);
    } else {
      room.players = room.players.filter(x => x.id !== p.id);
      if (!room.players.length) rooms.delete(room.code);
      else if (room.hostId === p.id) room.hostId = room.players[0].id;
      broadcast(room);
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    cb?.({ok:true});
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    const p = validatePlayer(socket, room);
    if (!room || !p) return;
    if (p.socketId !== socket.id) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    addLog(room, `${p.name} が切断しました。60秒以内に復帰してください。`);
    broadcast(room);

    setTimeout(() => {
      const current = rooms.get(room.code)?.players.find(x => x.id === p.id);
      if (!current || current.connected || !current.disconnectedAt) return;
      if (Date.now() - current.disconnectedAt >= RECONNECT_MS && room.status === "playing") {
        invalidateRoom(room, `${p.name} が60秒以内に復帰しなかったため、このゲームは無効になりました。`);
      }
    }, RECONNECT_MS + 500);
  });
});

httpServer.listen(PORT, () => {
  console.log(`CARD BATTLE server listening on port ${PORT}`);
});
