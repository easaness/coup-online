const socket = io();

let state = null;
let selectedTargetId = '';
let selectedAction = '';
let exchangeSelection = new Set();

const $ = (id) => document.getElementById(id);
const roleName = (role) => state?.roles?.[role] || role;
const actionName = (action) => state?.actions?.[action]?.label || action;

const ACTION_HELP = {
  income: { summary: '安全に1コイン獲得。誰にも止められません。', effect: '+1 coin', risk: '安全' },
  foreignAid: { summary: '2コイン獲得。Dukeにブロックされます。', effect: '+2 coins', risk: 'ブロックあり' },
  coup: { summary: '7コイン支払い、対象の影響力を1枚失わせます。', effect: '対象-1', risk: '不可避' },
  tax: { summary: 'Dukeを主張して3コイン獲得。チャレンジされます。', effect: '+3 coins', risk: 'チャレンジあり' },
  assassinate: { summary: 'Assassinを主張。3コイン支払い、対象を暗殺します。', effect: '対象-1', risk: 'チャレンジ/ブロック' },
  exchange: { summary: 'Ambassadorを主張。山札から2枚引き、2枚を残します。', effect: '交換', risk: 'チャレンジあり' },
  steal: { summary: 'Captainを主張。対象から最大2コイン奪います。', effect: '奪取', risk: 'チャレンジ/ブロック' }
};

const PHASE_TEXT = {
  waiting: '参加待ち',
  action: 'アクション選択',
  reaction: 'リアクション待ち',
  blockChallenge: 'ブロック確認',
  loseInfluence: '影響力喪失',
  exchange: 'カード交換',
  finished: 'ゲーム終了'
};

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
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

function playerById(id) {
  return state?.players?.find((p) => p.id === id);
}

function aliveOpponents() {
  return (state?.players || []).filter((p) => p.id !== state.me?.id && p.aliveCards > 0);
}

function isAliveMe() {
  return (state?.players || []).some((p) => p.id === state.me?.id && p.aliveCards > 0);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

function makeChip(text, kind = '') {
  const span = document.createElement('span');
  span.className = `phase-chip ${kind}`.trim();
  span.textContent = text;
  return span;
}

function phaseKind(phase) {
  if (phase === 'finished') return 'success';
  if (phase === 'loseInfluence' || phase === 'blockChallenge') return 'danger';
  if (phase === 'reaction' || phase === 'exchange') return 'warning';
  return '';
}

function pendingSentence() {
  const pending = state.pending;
  if (!pending) return '';
  const actor = playerById(pending.actorId)?.name || '不明';
  const target = playerById(pending.targetId)?.name;
  const blocker = playerById(pending.blockerId)?.name;

  if (state.phase === 'reaction') {
    return target
      ? `${actor} が ${target} に ${actionName(pending.action)} を宣言しました。`
      : `${actor} が ${actionName(pending.action)} を宣言しました。`;
  }
  if (state.phase === 'blockChallenge') return `${blocker || '誰か'} が ${roleName(pending.blockRole)} でブロックしています。`;
  if (state.phase === 'loseInfluence') return `${playerById(pending.playerId)?.name || '対象者'} が失うカードを選びます。`;
  return '';
}

function waitList(responders) {
  const names = responders.map((id) => playerById(id)?.name).filter(Boolean);
  return names.length ? `未対応: ${names.join('、')}` : '全員の入力待ちです。';
}

function currentRespondersForReaction() {
  if (!state.pending) return [];
  return state.players
    .filter((p) => p.aliveCards > 0 && p.id !== state.pending.actorId && !(state.pending.responded || []).includes(p.id))
    .map((p) => p.id);
}

function currentRespondersForBlock() {
  if (!state.pending) return [];
  return state.players
    .filter((p) => p.aliveCards > 0 && p.id !== state.pending.blockerId && !(state.pending.responded || []).includes(p.id))
    .map((p) => p.id);
}

function render() {
  if (!state) return;

  $('lobby').classList.add('hidden');
  $('roomBadge').classList.remove('hidden');
  $('statusBoard').classList.remove('hidden');
  $('gameLayout').classList.remove('hidden');
  $('logPanel').classList.remove('hidden');
  $('roomIdLabel').textContent = state.roomId;
  $('myCoins').textContent = state.me?.coins ?? 0;

  const me = state.me;
  const current = playerById(state.currentTurnPlayerId);
  const winner = playerById(state.winnerId);
  const phase = PHASE_TEXT[state.phase] || state.phase;
  $('phaseLabel').textContent = phase;

  let headline = 'ゲーム待機中';
  let status = '2〜6人で開始できます。ホストが「ゲーム開始」を押してください。';
  if (state.phase === 'action') {
    headline = state.currentTurnPlayerId === me?.id ? 'あなたのターンです' : `${current?.name || '誰か'} のターンです`;
    status = state.currentTurnPlayerId === me?.id ? 'アクションを選び、必要なら対象を指定してください。' : '他プレイヤーの選択を待っています。';
  } else if (state.phase === 'reaction' || state.phase === 'blockChallenge' || state.phase === 'loseInfluence') {
    headline = pendingSentence();
    status = state.phase === 'reaction' ? waitList(currentRespondersForReaction()) : state.phase === 'blockChallenge' ? waitList(currentRespondersForBlock()) : '対象者が公開するカードを選択中です。';
  } else if (state.phase === 'exchange') {
    headline = 'カード交換中です';
    status = state.exchangeOptions?.length ? '残したい2枚を選んで確定してください。' : '交換するプレイヤーの選択を待っています。';
  } else if (state.phase === 'finished') {
    headline = `${winner?.name || ''} の勝利！`;
    status = 'ゲームが終了しました。新しく遊ぶ場合はページを開き直して部屋を作成してください。';
  }
  $('headline').textContent = headline;
  $('status').textContent = status;

  const startVisible = state.phase === 'waiting' && state.hostId === me?.id;
  $('startBtn').style.display = startVisible ? 'inline-block' : 'none';
  $('startBtn').onclick = () => emit('startGame', { roomId: state.roomId });
  $('copyRoomBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.roomId);
      toast('部屋IDをコピーしました。');
    } catch {
      toast(`部屋ID: ${state.roomId}`);
    }
  };

  renderPlayers();
  renderCards();
  renderActions();
  renderReactions();
  renderSpecials();
  renderActionGuide();
  renderLog();
}

function renderPlayers() {
  const root = $('players');
  root.innerHTML = '';
  $('playerCount').textContent = `${state.players.length}人`;
  for (const p of state.players) {
    const div = document.createElement('div');
    div.className = ['player', p.id === state.currentTurnPlayerId ? 'current' : '', p.id === state.me?.id ? 'me' : '', p.aliveCards === 0 ? 'dead' : ''].filter(Boolean).join(' ');
    const badges = [];
    if (p.id === state.hostId) badges.push('<span class="stat">Host</span>');
    if (p.id === state.currentTurnPlayerId && state.phase !== 'waiting') badges.push('<span class="stat">Turn</span>');
    if (!p.connected) badges.push('<span class="stat">切断</span>');
    if (p.aliveCards === 0) badges.push('<span class="stat">脱落</span>');
    const revealed = p.revealed.length
      ? `<div class="revealed">${p.revealed.map((c) => `<span class="role-tag">${escapeHtml(roleName(c.role))}</span>`).join('')}</div>`
      : '<span class="muted">公開カードなし</span>';
    div.innerHTML = `
      <div class="player-top">
        <span class="player-name">${escapeHtml(p.name)}${p.id === state.me?.id ? '（あなた）' : ''}</span>
        <div class="player-stats">${badges.join('')}</div>
      </div>
      <div class="player-stats">
        <span class="stat">🪙 ${p.coins}</span>
        <span class="stat">影響力 ${p.aliveCards}</span>
      </div>
      ${revealed}
    `;
    root.appendChild(div);
  }
}

function renderCards() {
  const root = $('myCards');
  root.innerHTML = '';
  const cards = state.me?.cards || [];
  if (!cards.length) {
    root.innerHTML = '<p class="muted">ゲーム開始後、自分のカードがここに表示されます。</p>';
    return;
  }
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `card ${card.alive ? '' : 'dead'}`;
    div.innerHTML = `<small>${card.alive ? 'Alive' : 'Revealed'}</small><strong>${escapeHtml(roleName(card.role))}</strong>`;
    root.appendChild(div);
  }
}

function actionDisabledReason(key, def) {
  if (state.phase !== 'action') return '今は選べません';
  if (state.currentTurnPlayerId !== state.me?.id) return '他プレイヤーのターン';
  if (!isAliveMe()) return '脱落済み';
  if (state.me.coins >= 10 && key !== 'coup') return '10コイン以上はCoup必須';
  if (def.cost && state.me.coins < def.cost) return 'コイン不足';
  if (def.requiresTarget && aliveOpponents().length === 0) return '対象なし';
  return '';
}

function targetSelect() {
  const select = document.createElement('select');
  select.innerHTML = '<option value="">対象を選択</option>';
  for (const p of aliveOpponents()) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.name}（🪙${p.coins} / 影響力${p.aliveCards}）`;
    select.appendChild(option);
  }
  select.value = selectedTargetId;
  select.onchange = () => { selectedTargetId = select.value; renderActions(); };
  return select;
}

function renderActions() {
  const root = $('actionArea');
  root.innerHTML = '';
  if (state.phase !== 'action') return;

  if (state.currentTurnPlayerId !== state.me?.id) {
    root.innerHTML = `<div class="actionBox waiting-box"><h3>待機中</h3><p>${escapeHtml(playerById(state.currentTurnPlayerId)?.name || '他プレイヤー')} のアクションを待っています。</p></div>`;
    return;
  }

  const box = document.createElement('div');
  box.className = 'actionBox';
  box.innerHTML = '<h3>アクションを選択</h3><p>カードを持っていなくても役職アクションを主張できます。ただしチャレンジされる可能性があります。</p>';

  if (state.me.coins >= 10) {
    const warning = document.createElement('div');
    warning.className = 'actionBox urgent-box';
    warning.innerHTML = '<strong>10コイン以上です。</strong><p>Coupを必ず選ぶ必要があります。</p>';
    box.appendChild(warning);
  }

  const grid = document.createElement('div');
  grid.className = 'action-grid';
  for (const [key, def] of Object.entries(state.actions)) {
    const help = ACTION_HELP[key] || { summary: '', effect: '', risk: '' };
    const reason = actionDisabledReason(key, def);
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = Boolean(reason);
    button.className = ['action-card', selectedAction === key ? 'selected-action' : '', state.me.coins >= 10 && key === 'coup' ? 'forced' : ''].filter(Boolean).join(' ');
    button.innerHTML = `
      <span class="name">${escapeHtml(def.label)}${def.cost ? ` · ${def.cost} coins` : ''}</span>
      <span class="desc">${escapeHtml(help.summary)}</span>
      <span class="meta">
        <span class="phase-chip">${escapeHtml(help.effect)}</span>
        <span class="phase-chip ${help.risk.includes('チャレンジ') || help.risk.includes('ブロック') ? 'warning' : ''}">${escapeHtml(help.risk)}</span>
      </span>
    `;
    button.onclick = () => {
      selectedAction = key;
      if (!def.requiresTarget) selectedTargetId = '';
      renderActions();
    };
    if (reason) button.title = reason;
    grid.appendChild(button);
  }
  box.appendChild(grid);

  if (selectedAction) {
    const def = state.actions[selectedAction];
    const detail = document.createElement('div');
    detail.className = 'action-detail';
    detail.appendChild(makeChip(`${def.label} を実行します`, phaseKind(state.phase)));
    if (def.requiresTarget) detail.appendChild(targetSelect());
    const confirm = createButton('このアクションを宣言', () => {
      emit('takeAction', { roomId: state.roomId, action: selectedAction, targetId: def.requiresTarget ? selectedTargetId : null });
    }, selectedAction === 'coup' || selectedAction === 'assassinate' ? 'danger' : 'primary');
    const missingTarget = def.requiresTarget && !selectedTargetId;
    confirm.disabled = Boolean(actionDisabledReason(selectedAction, def)) || missingTarget;
    if (missingTarget) confirm.title = '対象を選択してください';
    detail.appendChild(confirm);
    box.appendChild(detail);
  } else {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'まず上のカードからアクションを1つ選んでください。';
    box.appendChild(hint);
  }

  root.appendChild(box);
}

function canReact() {
  if (!state.pending) return false;
  if ((state.pending.responded || []).includes(state.me?.id)) return false;
  return isAliveMe() && state.pending.actorId !== state.me?.id;
}

function renderReactions() {
  const root = $('reactionArea');
  root.innerHTML = '';
  if (state.phase !== 'reaction') return;

  const pending = state.pending;
  const actor = playerById(pending.actorId);
  const target = playerById(pending.targetId);
  const blockRoles = state.actions[pending.action]?.blockableBy || [];
  const targetOnly = pending.action === 'assassinate' || pending.action === 'steal';
  const canBlock = blockRoles.length > 0 && (!targetOnly || pending.targetId === state.me?.id);

  const box = document.createElement('div');
  box.className = canReact() ? 'actionBox urgent-box' : 'actionBox waiting-box';
  box.innerHTML = `
    <h3>${canReact() ? 'あなたのリアクション' : 'リアクション待ち'}</h3>
    <p>${escapeHtml(actor?.name || '')} が ${target ? `${escapeHtml(target.name)} に ` : ''}${escapeHtml(actionName(pending.action))} を宣言しました。</p>
  `;

  const buttons = document.createElement('div');
  buttons.className = 'actions';
  if (canReact()) {
    buttons.appendChild(createButton('パス', () => emit('passReaction', { roomId: state.roomId }), 'secondary'));
    if (pending.claim) buttons.appendChild(createButton(`${roleName(pending.claim)}を疑う`, () => emit('challenge', { roomId: state.roomId }), 'danger'));
    if (canBlock) {
      for (const role of blockRoles) {
        buttons.appendChild(createButton(`${roleName(role)}でブロック`, () => emit('block', { roomId: state.roomId, role }), 'warning'));
      }
    }
  } else {
    box.appendChild(makeChip(waitList(currentRespondersForReaction()), 'warning'));
  }
  box.appendChild(buttons);
  root.appendChild(box);
}

function renderSpecials() {
  const root = $('specialArea');
  root.innerHTML = '';

  if (state.phase === 'blockChallenge' && state.pending) {
    const box = document.createElement('div');
    box.className = canBlockReact() ? 'actionBox urgent-box' : 'actionBox waiting-box';
    const blocker = playerById(state.pending.blockerId);
    box.innerHTML = `<h3>${canBlockReact() ? 'ブロックへの対応' : 'ブロック確認中'}</h3><p>${escapeHtml(blocker?.name || '')} が ${escapeHtml(roleName(state.pending.blockRole))} でブロックしています。全リアクション対象者が受け入れると、元のアクションは失敗します。</p>`;
    const buttons = document.createElement('div');
    buttons.className = 'actions';
    if (canBlockReact()) {
      buttons.appendChild(createButton('ブロックを受け入れる', () => emit('acceptBlock', { roomId: state.roomId }), 'secondary'));
      buttons.appendChild(createButton('ブロックを疑う', () => emit('challenge', { roomId: state.roomId }), 'danger'));
    } else {
      box.appendChild(makeChip(waitList(currentRespondersForBlock()), 'warning'));
    }
    box.appendChild(buttons);
    root.appendChild(box);
  }

  if (state.phase === 'loseInfluence') {
    const mustChoose = state.pending?.playerId === state.me?.id;
    const box = document.createElement('div');
    box.className = mustChoose ? 'actionBox urgent-box' : 'actionBox waiting-box';
    box.innerHTML = `<h3>${mustChoose ? '失うカードを選択' : '影響力喪失待ち'}</h3><p>${mustChoose ? '公開して失うカードを1枚選んでください。' : `${escapeHtml(playerById(state.pending?.playerId)?.name || '対象者')} がカードを選択中です。`}</p>`;
    if (mustChoose) {
      const cards = document.createElement('div');
      cards.className = 'cards';
      for (const card of state.me.cards.filter((c) => c.alive)) {
        const cardButton = document.createElement('button');
        cardButton.className = 'card selectable';
        cardButton.innerHTML = `<small>Reveal</small><strong>${escapeHtml(roleName(card.role))}</strong>`;
        cardButton.onclick = () => emit('chooseCardToLose', { roomId: state.roomId, cardId: card.id });
        cards.appendChild(cardButton);
      }
      box.appendChild(cards);
    }
    root.appendChild(box);
  }

  if (state.phase === 'exchange') {
    const isMine = state.exchangeOptions.length > 0;
    const box = document.createElement('div');
    box.className = isMine ? 'actionBox urgent-box' : 'actionBox waiting-box';
    box.innerHTML = `<h3>${isMine ? '交換するカードを選択' : 'カード交換待ち'}</h3><p>${isMine ? '手札と引いたカードの中から、残す2枚を選択してください。' : '交換アクションのプレイヤーが選択中です。'}</p>`;

    if (isMine) {
      const cards = document.createElement('div');
      cards.className = 'cards';
      for (const card of state.exchangeOptions) {
        const div = document.createElement('div');
        div.className = `card selectable ${exchangeSelection.has(card.id) ? 'selected' : ''}`;
        div.innerHTML = `<small>${exchangeSelection.has(card.id) ? 'Keep' : 'Option'}</small><strong>${escapeHtml(roleName(card.role))}</strong>`;
        div.onclick = () => {
          if (exchangeSelection.has(card.id)) exchangeSelection.delete(card.id);
          else if (exchangeSelection.size < 2) exchangeSelection.add(card.id);
          renderSpecials();
        };
        cards.appendChild(div);
      }
      box.appendChild(cards);
      const confirm = createButton(`この2枚を残す（${exchangeSelection.size}/2）`, () => {
        emit('chooseExchange', { roomId: state.roomId, keepCardIds: [...exchangeSelection] });
        exchangeSelection = new Set();
      }, 'primary');
      confirm.disabled = exchangeSelection.size !== 2;
      box.appendChild(confirm);
    }
    root.appendChild(box);
  }
}

function canBlockReact() {
  if (state.phase !== 'blockChallenge' || !state.pending) return false;
  if ((state.pending.responded || []).includes(state.me?.id)) return false;
  return isAliveMe() && state.pending.blockerId !== state.me?.id;
}

function renderActionGuide() {
  const root = $('actionGuide');
  root.innerHTML = '';
  if (!state.actions) return;
  for (const [key, def] of Object.entries(state.actions)) {
    const help = ACTION_HELP[key] || { summary: '', risk: '' };
    const row = document.createElement('div');
    row.className = 'guide-row';
    row.innerHTML = `<div><strong>${escapeHtml(def.label)}</strong><br><span>${escapeHtml(help.summary)}</span></div><span class="small-pill">${def.claim ? roleName(def.claim) : 'No claim'}</span>`;
    root.appendChild(row);
  }
}

function renderLog() {
  const root = $('log');
  root.innerHTML = '';
  for (const item of [...state.log].reverse()) {
    const li = document.createElement('li');
    const time = new Date(item.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<span class="log-time">${escapeHtml(time)}</span>${escapeHtml(item.message)}`;
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

$('roomInput').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});

socket.on('roomState', (next) => {
  const previousPhase = state?.phase;
  state = next;
  if (previousPhase !== state.phase) {
    selectedAction = '';
    if (state.phase !== 'action') selectedTargetId = '';
  }
  render();
});
socket.on('errorMessage', toast);
