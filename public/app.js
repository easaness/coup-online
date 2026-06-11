const socket = io();
let state = null;
let selectedTargetId = '';
let exchangeSelection = new Set();

const $ = (id) => document.getElementById(id);
const roleName = (role) => state?.roles?.[role] || role;
const actionName = (action) => state?.actions?.[action]?.label || action;

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

function emit(event, payload = {}) {
  socket.emit(event, payload, (res) => {
    if (res && res.ok === false) toast(res.error || 'エラーが発生しました。');
  });
}

function createButton(label, onClick, className = '') {
  const button = document.createElement('button');
  button.textContent = label;
  button.className = className;
  button.onclick = onClick;
  return button;
}

function aliveOpponents() {
  return (state?.players || []).filter((p) => p.id !== state.me?.id && p.aliveCards > 0);
}

function render() {
  if (!state) return;
  $('lobby').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('controls').classList.remove('hidden');
  $('logPanel').classList.remove('hidden');
  $('roomIdLabel').textContent = state.roomId;

  const me = state.me;
  const current = state.players.find((p) => p.id === state.currentTurnPlayerId);
  const winner = state.players.find((p) => p.id === state.winnerId);
  $('status').textContent = state.phase === 'finished'
    ? `勝者: ${winner?.name || ''}`
    : `状態: ${state.phase} / 現在のターン: ${current?.name || '未開始'}`;

  $('startBtn').style.display = state.phase === 'waiting' && state.hostId === me?.id ? 'inline-block' : 'none';
  $('startBtn').onclick = () => emit('startGame', { roomId: state.roomId });

  renderPlayers();
  renderCards();
  renderActions();
  renderReactions();
  renderSpecials();
  renderLog();
}

function renderPlayers() {
  const root = $('players');
  root.innerHTML = '';
  for (const p of state.players) {
    const div = document.createElement('div');
    div.className = `player ${p.id === state.currentTurnPlayerId ? 'current' : ''}`;
    const revealed = p.revealed.length ? ` / 公開: ${p.revealed.map((c) => roleName(c.role)).join(', ')}` : '';
    div.innerHTML = `<strong>${p.name}${p.id === state.me?.id ? '（あなた）' : ''}</strong><br>コイン: ${p.coins} / 残り影響力: ${p.aliveCards}${revealed}<br>${p.connected ? '接続中' : '切断'}`;
    root.appendChild(div);
  }
}

function renderCards() {
  const root = $('myCards');
  root.innerHTML = '';
  for (const card of state.me?.cards || []) {
    const div = document.createElement('div');
    div.className = `card ${card.alive ? '' : 'dead'}`;
    div.textContent = roleName(card.role);
    root.appendChild(div);
  }
}

function targetSelect() {
  const select = document.createElement('select');
  select.innerHTML = '<option value="">対象を選択</option>';
  for (const p of aliveOpponents()) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.name} (${p.coins} coins)`;
    select.appendChild(option);
  }
  select.value = selectedTargetId;
  select.onchange = () => { selectedTargetId = select.value; };
  return select;
}

function renderActions() {
  const root = $('actionArea');
  root.innerHTML = '';
  if (state.phase !== 'action') return;
  if (state.currentTurnPlayerId !== state.me?.id) {
    root.textContent = '他プレイヤーのターンです。';
    return;
  }

  const box = document.createElement('div');
  box.className = 'actionBox';
  box.innerHTML = '<h3>アクション</h3>';
  box.appendChild(targetSelect());

  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [key, def] of Object.entries(state.actions)) {
    const button = createButton(`${def.label}${def.cost ? ` (${def.cost})` : ''}`, () => {
      emit('takeAction', { roomId: state.roomId, action: key, targetId: def.requiresTarget ? selectedTargetId : null });
    });
    actions.appendChild(button);
  }
  box.appendChild(actions);
  root.appendChild(box);
}

function canReact() {
  if (!state.pending) return false;
  if ((state.pending.responded || []).includes(state.me?.id)) return false;
  return state.players.some((p) => p.id === state.me?.id && p.aliveCards > 0) && state.pending.actorId !== state.me?.id;
}

function renderReactions() {
  const root = $('reactionArea');
  root.innerHTML = '';
  if (state.phase !== 'reaction' || !canReact()) return;
  const pending = state.pending;
  const box = document.createElement('div');
  box.className = 'actionBox';
  box.innerHTML = `<h3>リアクション</h3><p>${actionName(pending.action)} への対応を選んでください。</p>`;
  const buttons = document.createElement('div');
  buttons.className = 'actions';
  buttons.appendChild(createButton('パス', () => emit('passReaction', { roomId: state.roomId }), 'secondary'));
  if (pending.claim) buttons.appendChild(createButton('チャレンジ', () => emit('challenge', { roomId: state.roomId }), 'danger'));

  const blockRoles = state.actions[pending.action]?.blockableBy || [];
  const targetOnly = pending.action === 'assassinate' || pending.action === 'steal';
  if (!targetOnly || pending.targetId === state.me?.id) {
    for (const role of blockRoles) {
      buttons.appendChild(createButton(`${roleName(role)}でブロック`, () => emit('block', { roomId: state.roomId, role })));
    }
  }
  box.appendChild(buttons);
  root.appendChild(box);
}

function renderSpecials() {
  const root = $('specialArea');
  root.innerHTML = '';

  if (state.phase === 'blockChallenge' && state.pending) {
    const box = document.createElement('div');
    box.className = 'actionBox';
    const blocker = state.players.find((p) => p.id === state.pending.blockerId);
    box.innerHTML = `<h3>ブロック確認</h3><p>${blocker?.name || ''} が ${roleName(state.pending.blockRole)} でブロックしています。</p>`;
    const buttons = document.createElement('div');
    buttons.className = 'actions';
    if (state.pending.blockerId !== state.me?.id) {
      buttons.appendChild(createButton('ブロックを受け入れる', () => emit('acceptBlock', { roomId: state.roomId }), 'secondary'));
      buttons.appendChild(createButton('ブロックにチャレンジ', () => emit('challenge', { roomId: state.roomId }), 'danger'));
    } else {
      box.appendChild(document.createTextNode('他プレイヤーの判断を待っています。'));
    }
    box.appendChild(buttons);
    root.appendChild(box);
  }

  if (state.phase === 'loseInfluence' && state.pending?.playerId === state.me?.id) {
    const box = document.createElement('div');
    box.className = 'actionBox';
    box.innerHTML = '<h3>失うカードを選択</h3>';
    const cards = document.createElement('div');
    cards.className = 'cards';
    for (const card of state.me.cards.filter((c) => c.alive)) {
      cards.appendChild(createButton(roleName(card.role), () => emit('chooseCardToLose', { roomId: state.roomId, cardId: card.id }), 'danger'));
    }
    box.appendChild(cards);
    root.appendChild(box);
  }

  if (state.phase === 'exchange' && state.exchangeOptions.length > 0) {
    const box = document.createElement('div');
    box.className = 'actionBox';
    box.innerHTML = '<h3>交換: 残すカードを2枚選択</h3>';
    const cards = document.createElement('div');
    cards.className = 'cards';
    for (const card of state.exchangeOptions) {
      const div = document.createElement('div');
      div.className = `card selectable ${exchangeSelection.has(card.id) ? 'selected' : ''}`;
      div.textContent = roleName(card.role);
      div.onclick = () => {
        if (exchangeSelection.has(card.id)) exchangeSelection.delete(card.id);
        else if (exchangeSelection.size < 2) exchangeSelection.add(card.id);
        render();
      };
      cards.appendChild(div);
    }
    box.appendChild(cards);
    box.appendChild(createButton('この2枚を残す', () => {
      emit('chooseExchange', { roomId: state.roomId, keepCardIds: [...exchangeSelection] });
      exchangeSelection = new Set();
    }));
    root.appendChild(box);
  }
}

function renderLog() {
  const root = $('log');
  root.innerHTML = '';
  for (const item of [...state.log].reverse()) {
    const li = document.createElement('li');
    const time = new Date(item.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    li.textContent = `${time} ${item.message}`;
    root.appendChild(li);
  }
}

$('createBtn').onclick = () => {
  const name = $('nameInput').value.trim() || 'Player';
  emit('createRoom', { name });
};

$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim() || 'Player';
  const roomId = $('roomInput').value.trim().toUpperCase();
  if (!roomId) return toast('部屋IDを入力してください。');
  emit('joinRoom', { name, roomId });
};

socket.on('roomState', (next) => { state = next; render(); });
socket.on('errorMessage', toast);
