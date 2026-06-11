import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'coup-online', at: new Date().toISOString() }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const ROLES = {
  duke: 'Duke',
  assassin: 'Assassin',
  captain: 'Captain',
  ambassador: 'Ambassador',
  contessa: 'Contessa'
};

const ACTIONS = {
  income: { label: 'Income', requiresTarget: false, cost: 0, claim: null, blockableBy: [] },
  foreignAid: { label: 'Foreign Aid', requiresTarget: false, cost: 0, claim: null, blockableBy: ['duke'] },
  coup: { label: 'Coup', requiresTarget: true, cost: 7, claim: null, blockableBy: [] },
  tax: { label: 'Tax', requiresTarget: false, cost: 0, claim: 'duke', blockableBy: [] },
  assassinate: { label: 'Assassinate', requiresTarget: true, cost: 3, claim: 'assassin', blockableBy: ['contessa'] },
  exchange: { label: 'Exchange', requiresTarget: false, cost: 0, claim: 'ambassador', blockableBy: [] },
  steal: { label: 'Steal', requiresTarget: true, cost: 0, claim: 'captain', blockableBy: ['captain', 'ambassador'] }
};

const ROLE_LIST = Object.keys(ROLES);
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

function makeRoomId() {
  let id = '';
  for (let i = 0; i < 5; i += 1) id += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
  return id;
}

function shuffle(items) {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function createDeck() {
  const cards = [];
  for (const role of ROLE_LIST) {
    for (let copy = 0; copy < 3; copy += 1) cards.push({ id: `${role}-${copy}-${randomUUID()}`, role, alive: true });
  }
  return shuffle(cards);
}

function draw(room, count) {
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    if (room.deck.length === 0) break;
    cards.push(room.deck.pop());
  }
  return cards;
}

function aliveCardCount(player) {
  return player.cards.filter((card) => card.alive).length;
}

function alivePlayers(room) {
  return room.players.filter((player) => aliveCardCount(player) > 0);
}

function findPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function playerHasAliveRole(player, role) {
  return player.cards.some((card) => card.alive && card.role === role);
}

function addLog(room, message) {
  room.log.push({ at: new Date().toISOString(), message });
  room.log = room.log.slice(-100);
}

function requireRoom(roomId) {
  const room = rooms.get(String(roomId || '').trim().toUpperCase());
  if (!room) throw new Error('部屋が見つかりません。');
  return room;
}

function sanitizePending(pending) {
  if (!pending) return null;
  return {
    type: pending.type,
    action: pending.action,
    actorId: pending.actorId,
    targetId: pending.targetId,
    claim: pending.claim,
    blockerId: pending.blockerId,
    blockRole: pending.blockRole,
    responded: [...(pending.responded || [])],
    playerId: pending.playerId ?? null
  };
}

function publicStateFor(room, viewerId) {
  const me = findPlayer(room, viewerId);
  return {
    roomId: room.id,
    phase: room.phase,
    hostId: room.hostId,
    currentTurnPlayerId: room.players[room.currentTurnIndex]?.id ?? null,
    winnerId: room.winnerId,
    actions: ACTIONS,
    roles: ROLES,
    pending: sanitizePending(room.pending),
    log: room.log,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      coins: player.coins,
      aliveCards: aliveCardCount(player),
      revealed: player.cards.filter((card) => !card.alive).map((card) => ({ id: card.id, role: card.role })),
      connected: player.connected
    })),
    me: me ? {
      id: me.id,
      name: me.name,
      coins: me.coins,
      cards: me.cards.map((card) => ({ id: card.id, role: card.role, alive: card.alive }))
    } : null,
    exchangeOptions: room.exchange?.playerId === viewerId ? room.exchange.options.map((card) => ({ id: card.id, role: card.role })) : []
  };
}

function emitRoom(roomId) {
  const room = requireRoom(roomId);
  for (const player of room.players) io.to(player.id).emit('roomState', publicStateFor(room, player.id));
}

function finishIfNeeded(room) {
  const alive = alivePlayers(room);
  if (alive.length === 1) {
    room.phase = 'finished';
    room.winnerId = alive[0].id;
    room.pending = null;
    room.awaitingLoss = null;
    room.exchange = null;
    addLog(room, `${alive[0].name} が勝利しました。`);
    return true;
  }
  return false;
}

function nextLivingTurn(room) {
  if (finishIfNeeded(room)) return;
  for (let step = 1; step <= room.players.length; step += 1) {
    const nextIndex = (room.currentTurnIndex + step) % room.players.length;
    if (aliveCardCount(room.players[nextIndex]) > 0) {
      room.currentTurnIndex = nextIndex;
      break;
    }
  }
  room.phase = 'action';
  room.pending = null;
  room.awaitingLoss = null;
  room.exchange = null;
}

function allRequiredResponded(room) {
  const pending = room.pending;
  const responders = alivePlayers(room).filter((player) => player.id !== pending.actorId);
  return responders.every((player) => pending.responded.has(player.id));
}

function validBlockers(room, pending) {
  const action = ACTIONS[pending.action];
  const candidates = alivePlayers(room).filter((player) => player.id !== pending.actorId);
  if (pending.action === 'assassinate' || pending.action === 'steal') return candidates.filter((player) => player.id === pending.targetId);
  return action.blockableBy.length ? candidates : [];
}

function canRespond(room, playerId) {
  const pending = room.pending;
  if (!pending || pending.responded.has(playerId)) return false;
  return alivePlayers(room).some((player) => player.id === playerId) && playerId !== pending.actorId;
}

function blockResponders(room, pending = room.pending) {
  if (!pending) return [];
  return alivePlayers(room).filter((player) => player.id !== pending.blockerId);
}

function canRespondToBlock(room, playerId) {
  const pending = room.pending;
  if (!pending || room.phase !== 'blockChallenge') return false;
  if (pending.responded.has(playerId)) return false;
  return blockResponders(room, pending).some((player) => player.id === playerId);
}

function allBlockResponded(room) {
  const pending = room.pending;
  if (!pending) return false;
  return blockResponders(room, pending).every((player) => pending.responded.has(player.id));
}

function beginLoss(room, playerId, after) {
  const player = findPlayer(room, playerId);
  if (!player || aliveCardCount(player) === 0) return;
  room.phase = 'loseInfluence';
  room.awaitingLoss = { playerId, after };
  room.pending = { type: 'loseInfluence', playerId, responded: new Set() };
  addLog(room, `${player.name} は失う影響力を選びます。`);
}

function replaceRevealedClaimCard(room, player, role) {
  const card = player.cards.find((item) => item.alive && item.role === role);
  if (!card) return;
  player.cards = player.cards.filter((item) => item.id !== card.id);
  room.deck.push({ ...card, alive: true });
  room.deck = shuffle(room.deck);
  const replacement = draw(room, 1)[0];
  if (replacement) player.cards.push(replacement);
  addLog(room, `${player.name} は ${ROLES[role]} を公開して山札に戻し、新しいカードを1枚引きました。`);
}

function continueAfterLoss(room) {
  const after = room.awaitingLoss?.after;
  room.awaitingLoss = null;
  if (finishIfNeeded(room)) return;
  if (!after || after.kind === 'nextTurn') return nextLivingTurn(room);
  if (after.kind === 'continueAction') return completeAction(room, after.pending);
  if (after.kind === 'resumeReaction') {
    room.pending = after.pending;
    room.phase = 'reaction';
    if (allRequiredResponded(room)) {
      const pending = room.pending;
      room.pending = null;
      return completeAction(room, pending);
    }
    return;
  }
  if (after.kind === 'cancelAction') return nextLivingTurn(room);
  if (after.kind === 'blockSucceeded') {
    addLog(room, 'ブロックが成立し、アクションは無効になりました。');
    return nextLivingTurn(room);
  }
}

function maybeResolveReaction(room) {
  if (!room.pending) return;
  if (allRequiredResponded(room)) {
    const pending = room.pending;
    room.pending = null;
    completeAction(room, pending);
  }
}

function completeAction(room, pending) {
  const actor = findPlayer(room, pending.actorId);
  const target = findPlayer(room, pending.targetId);
  if (!actor || aliveCardCount(actor) === 0) return nextLivingTurn(room);
  switch (pending.action) {
    case 'income':
      actor.coins += 1;
      addLog(room, `${actor.name} は Income で1コイン得ました。`);
      return nextLivingTurn(room);
    case 'foreignAid':
      actor.coins += 2;
      addLog(room, `${actor.name} は Foreign Aid で2コイン得ました。`);
      return nextLivingTurn(room);
    case 'tax':
      actor.coins += 3;
      addLog(room, `${actor.name} は Tax で3コイン得ました。`);
      return nextLivingTurn(room);
    case 'coup':
      addLog(room, `${target.name} は Coup により影響力を1つ失います。`);
      return beginLoss(room, target.id, { kind: 'nextTurn' });
    case 'assassinate':
      addLog(room, `${target.name} は Assassinate により影響力を1つ失います。`);
      return beginLoss(room, target.id, { kind: 'nextTurn' });
    case 'steal': {
      const amount = Math.min(2, target.coins);
      target.coins -= amount;
      actor.coins += amount;
      addLog(room, `${actor.name} は ${target.name} から${amount}コイン盗みました。`);
      return nextLivingTurn(room);
    }
    case 'exchange': {
      room.phase = 'exchange';
      room.exchange = { playerId: actor.id, options: [...actor.cards.filter((card) => card.alive), ...draw(room, 2)] };
      room.pending = { type: 'exchange', playerId: actor.id, responded: new Set() };
      addLog(room, `${actor.name} は交換するカードを選びます。`);
      return;
    }
    default:
      return nextLivingTurn(room);
  }
}

function createRoom(socket, name) {
  let roomId = makeRoomId();
  while (rooms.has(roomId)) roomId = makeRoomId();
  const room = {
    id: roomId,
    hostId: socket.id,
    phase: 'waiting',
    players: [],
    deck: [],
    log: [],
    currentTurnIndex: 0,
    pending: null,
    awaitingLoss: null,
    exchange: null,
    winnerId: null
  };
  rooms.set(roomId, room);
  joinRoom(socket, roomId, name);
  return roomId;
}

function joinRoom(socket, roomId, name) {
  const room = requireRoom(roomId);
  if (room.phase !== 'waiting') throw new Error('この部屋はすでにゲーム開始済みです。');
  if (room.players.length >= MAX_PLAYERS) throw new Error('この部屋は満員です。');
  const existing = findPlayer(room, socket.id);
  if (existing) return room.id;
  const playerName = String(name || 'Player').slice(0, 24);
  room.players.push({ id: socket.id, name: playerName, coins: 2, cards: [], connected: true });
  socket.join(room.id);
  addLog(room, `${playerName} が参加しました。`);
  emitRoom(room.id);
  return room.id;
}

function startGame(socket, roomId) {
  const room = requireRoom(roomId);
  if (socket.id !== room.hostId) throw new Error('ホストだけが開始できます。');
  if (room.players.length < MIN_PLAYERS) throw new Error('2人以上で開始できます。');
  room.deck = createDeck();
  for (const player of room.players) {
    player.coins = 2;
    player.cards = draw(room, 2);
  }
  room.phase = 'action';
  room.currentTurnIndex = 0;
  addLog(room, 'ゲームを開始しました。');
  emitRoom(room.id);
}

function takeAction(socket, roomId, { action, targetId }) {
  const room = requireRoom(roomId);
  const actor = findPlayer(room, socket.id);
  const actionDef = ACTIONS[action];
  if (!actionDef) throw new Error('不明なアクションです。');
  if (room.phase !== 'action') throw new Error('今はアクションできません。');
  if (room.players[room.currentTurnIndex]?.id !== socket.id) throw new Error('あなたのターンではありません。');
  if (aliveCardCount(actor) === 0) throw new Error('脱落済みです。');
  if (actor.coins >= 10 && action !== 'coup') throw new Error('10コイン以上ある場合はCoupが必須です。');
  if (actionDef.cost && actor.coins < actionDef.cost) throw new Error('コインが足りません。');
  if (actionDef.requiresTarget) {
    const target = findPlayer(room, targetId);
    if (!target || target.id === actor.id || aliveCardCount(target) === 0) throw new Error('有効な対象を選んでください。');
  }
  actor.coins -= actionDef.cost ?? 0;
  const pending = { action, actorId: actor.id, targetId: targetId ?? null, claim: actionDef.claim, responded: new Set() };
  addLog(room, `${actor.name} は ${actionDef.label}${targetId ? ` を ${findPlayer(room, targetId).name} に実行` : ''}しました。`);
  if (!actionDef.claim && actionDef.blockableBy.length === 0) completeAction(room, pending);
  else {
    pending.type = 'reaction';
    room.pending = pending;
    room.phase = 'reaction';
  }
  emitRoom(room.id);
}

function pass(socket, roomId) {
  const room = requireRoom(roomId);
  if (room.phase !== 'reaction') throw new Error('今はパスできません。');
  if (!canRespond(room, socket.id)) throw new Error('あなたはリアクションできません。');
  room.pending.responded.add(socket.id);
  addLog(room, `${findPlayer(room, socket.id).name} はパスしました。`);
  maybeResolveReaction(room);
  emitRoom(room.id);
}

function block(socket, roomId, { role }) {
  const room = requireRoom(roomId);
  if (room.phase !== 'reaction') throw new Error('今はブロックできません。');
  if (!canRespond(room, socket.id)) throw new Error('あなたはブロックできません。');
  const action = ACTIONS[room.pending.action];
  if (!action.blockableBy.includes(role)) throw new Error('その役職ではブロックできません。');
  if (!validBlockers(room, room.pending).some((player) => player.id === socket.id)) throw new Error('このアクションをブロックできる立場ではありません。');
  room.pending.type = 'blockChallenge';
  room.pending.blockerId = socket.id;
  room.pending.blockRole = role;
  room.pending.responded = new Set([socket.id]);
  room.phase = 'blockChallenge';
  addLog(room, `${findPlayer(room, socket.id).name} は ${ROLES[role]} を主張してブロックしました。`);
  emitRoom(room.id);
}

function challenge(socket, roomId) {
  const room = requireRoom(roomId);
  const challenger = findPlayer(room, socket.id);
  if (!challenger || aliveCardCount(challenger) === 0) throw new Error('チャレンジできません。');
  if (room.phase === 'reaction') {
    if (!canRespond(room, socket.id)) throw new Error('あなたはチャレンジできません。');
    const pending = room.pending;
    if (!pending.claim) throw new Error('このアクションはチャレンジできません。');
    const actor = findPlayer(room, pending.actorId);
    addLog(room, `${challenger.name} は ${actor.name} の ${ROLES[pending.claim]} 主張にチャレンジしました。`);
    if (playerHasAliveRole(actor, pending.claim)) {
      replaceRevealedClaimCard(room, actor, pending.claim);
      pending.claim = null;
      pending.responded.add(challenger.id);
      const after = ACTIONS[pending.action].blockableBy.length > 0 ? { kind: 'resumeReaction', pending } : { kind: 'continueAction', pending };
      return resolveChallengeLoss(room, challenger.id, after);
    }
    addLog(room, `${actor.name} は ${ROLES[pending.claim]} を持っていませんでした。`);
    return resolveChallengeLoss(room, actor.id, { kind: 'cancelAction' });
  }
  if (room.phase === 'blockChallenge') {
    const pending = room.pending;
    if (!canRespondToBlock(room, socket.id)) throw new Error('あなたはこのブロックにリアクションできません。');
    const blocker = findPlayer(room, pending.blockerId);
    addLog(room, `${challenger.name} は ${blocker.name} の ${ROLES[pending.blockRole]} ブロックにチャレンジしました。`);
    if (playerHasAliveRole(blocker, pending.blockRole)) {
      replaceRevealedClaimCard(room, blocker, pending.blockRole);
      return resolveChallengeLoss(room, challenger.id, { kind: 'blockSucceeded' });
    }
    addLog(room, `${blocker.name} は ${ROLES[pending.blockRole]} を持っていませんでした。`);
    return resolveChallengeLoss(room, blocker.id, { kind: 'continueAction', pending });
  }
  throw new Error('今はチャレンジできません。');
}

function resolveChallengeLoss(room, loserId, after) {
  const loser = findPlayer(room, loserId);
  if (aliveCardCount(loser) === 1) {
    loser.cards.find((card) => card.alive).alive = false;
    addLog(room, `${loser.name} は最後の影響力を失いました。`);
    room.awaitingLoss = { playerId: loserId, after };
    continueAfterLoss(room);
  } else beginLoss(room, loserId, after);
  emitRoom(room.id);
}

function acceptBlock(socket, roomId) {
  const room = requireRoom(roomId);
  if (room.phase !== 'blockChallenge') throw new Error('今はブロック承認できません。');
  if (!canRespondToBlock(room, socket.id)) throw new Error('あなたはこのブロックにリアクションできません。');
  room.pending.responded.add(socket.id);
  addLog(room, `${findPlayer(room, socket.id).name} はブロックを受け入れました。`);
  if (allBlockResponded(room)) {
    addLog(room, '全員がブロックを受け入れたため、ブロックが成立しました。');
    nextLivingTurn(room);
  }
  emitRoom(room.id);
}

function chooseCardToLose(socket, roomId, { cardId }) {
  const room = requireRoom(roomId);
  if (room.phase !== 'loseInfluence' || room.awaitingLoss?.playerId !== socket.id) throw new Error('今はカードを失う場面ではありません。');
  const player = findPlayer(room, socket.id);
  const card = player.cards.find((item) => item.id === cardId && item.alive);
  if (!card) throw new Error('有効なカードを選んでください。');
  card.alive = false;
  addLog(room, `${player.name} は ${ROLES[card.role]} を公開して影響力を失いました。`);
  continueAfterLoss(room);
  emitRoom(room.id);
}

function chooseExchange(socket, roomId, { keepCardIds }) {
  const room = requireRoom(roomId);
  if (room.phase !== 'exchange' || room.exchange?.playerId !== socket.id) throw new Error('今は交換できません。');
  if (!Array.isArray(keepCardIds) || keepCardIds.length !== 2) throw new Error('残すカードを2枚選んでください。');
  const actor = findPlayer(room, socket.id);
  const uniqueIds = [...new Set(keepCardIds)];
  if (uniqueIds.length !== 2) throw new Error('別々のカードを2枚選んでください。');
  const options = room.exchange.options;
  const keep = uniqueIds.map((id) => options.find((card) => card.id === id));
  if (keep.some((card) => !card)) throw new Error('有効なカードを選んでください。');
  const deadCards = actor.cards.filter((card) => !card.alive);
  const returned = options.filter((card) => !uniqueIds.includes(card.id)).map((card) => ({ ...card, alive: true }));
  actor.cards = [...deadCards, ...keep.map((card) => ({ ...card, alive: true }))];
  room.deck = shuffle([...room.deck, ...returned]);
  room.exchange = null;
  addLog(room, `${actor.name} はカード交換を完了しました。`);
  nextLivingTurn(room);
  emitRoom(room.id);
}

function handleDisconnect(socket) {
  for (const room of rooms.values()) {
    const player = findPlayer(room, socket.id);
    if (player) {
      player.connected = false;
      addLog(room, `${player.name} の接続が切れました。`);
      emitRoom(room.id);
    }
  }
}

function safe(socket, callback, fn) {
  try {
    const value = fn();
    callback?.({ ok: true, value });
  } catch (error) {
    callback?.({ ok: false, error: error.message });
    socket.emit('errorMessage', error.message);
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name } = {}, callback = () => {}) => safe(socket, callback, () => ({ roomId: createRoom(socket, name) })));
  socket.on('joinRoom', ({ roomId, name } = {}, callback = () => {}) => safe(socket, callback, () => ({ roomId: joinRoom(socket, roomId, name) })));
  socket.on('startGame', ({ roomId } = {}, callback = () => {}) => safe(socket, callback, () => startGame(socket, roomId)));
  socket.on('takeAction', ({ roomId, action, targetId } = {}, callback = () => {}) => safe(socket, callback, () => takeAction(socket, roomId, { action, targetId })));
  socket.on('passReaction', ({ roomId } = {}, callback = () => {}) => safe(socket, callback, () => pass(socket, roomId)));
  socket.on('block', ({ roomId, role } = {}, callback = () => {}) => safe(socket, callback, () => block(socket, roomId, { role })));
  socket.on('challenge', ({ roomId } = {}, callback = () => {}) => safe(socket, callback, () => challenge(socket, roomId)));
  socket.on('acceptBlock', ({ roomId } = {}, callback = () => {}) => safe(socket, callback, () => acceptBlock(socket, roomId)));
  socket.on('chooseCardToLose', ({ roomId, cardId } = {}, callback = () => {}) => safe(socket, callback, () => chooseCardToLose(socket, roomId, { cardId })));
  socket.on('chooseExchange', ({ roomId, keepCardIds } = {}, callback = () => {}) => safe(socket, callback, () => chooseExchange(socket, roomId, { keepCardIds })));
  socket.on('disconnect', () => handleDisconnect(socket));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Coup Online running on port ${port}`));
