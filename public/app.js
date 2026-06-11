const socket = io({ reconnection: true });

const STORAGE_KEYS = {
  playerId: 'coup.playerId',
  roomId: 'coup.roomId',
  name: 'coup.name'
};

function getClientId() {
  let id = localStorage.getItem(STORAGE_KEYS.playerId);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(STORAGE_KEYS.playerId, id);
  }
  return id;
}

function saveSession(roomId, name) {
  localStorage.setItem(STORAGE_KEYS.roomId, roomId);
  if (name) localStorage.setItem(STORAGE_KEYS.name, name);
}

function clearRoomSession() {
  localStorage.removeItem(STORAGE_KEYS.roomId);
}

let state = null;
let selectedTargetId = '';
let selectedAction = '';
let exchangeSelection = new Set();

const $ = (id) => document.getElementById(id);
const roleName = (role) => state?.roles?.[role] || role;
const actionName = (action) => state?.actions?.[action]?.label || action;

const ACTION_HELP = {
  income: {
    effect: '国庫から +1 coin',
    block: 'ブロック不可',
    tone: 'safe'
  },
  foreignAid: {
    effect: '国庫から +2 coins',
    block: 'Dukeでブロック可',
    tone: 'safe'
  },
  coup: {
    effect: '7 coins支払い / 対象の影響力 -1',
    block: 'ブロック不可',
    tone: 'danger'
  },
  tax: {
    effect: '国庫から +3 coins',
    block: 'ブロック不可',
    tone: 'claim'
  },
  assassinate: {
    effect: '3 coins支払い / 対象の影響力 -1',
    block: 'Contessaでブロック可',
    tone: 'danger'
  },
  exchange: {
    effect: '山札から2枚引いて交換',
    block: 'ブロック不可',
    tone: 'claim'
  },
  steal: {
    effect: '対象から最大2 coins奪う',
    block: 'Captain / Ambassadorでブロック可',
    tone: 'claim'
  }
};

function roleToken(role, kind = '') {
  return `<span class="role-token ${kind}">${escapeHtml(roleName(role))}</span>`;
}

function hasAliveRole(role) {
  return Boolean((state?.me?.cards || []).some((card) => card.alive && card.role === role));
}

function actionRequirement(def, key) {
  const help = ACTION_HELP[key] || {};
  if (!def.claim) return {
    label: 'カード不要',
    status: 'リスクなし',
    detail: 'カード不要のアクションです。',
    className: 'free-safe'
  };

  const owned = hasAliveRole(def.claim);
  if (owned) return {
    label: `${roleName(def.claim)}`,
    status: 'リスクなし',
    detail: `${roleName(def.claim)}を宣言するアクションです。`,
    className: 'owned-safe'
  };

  return {
    label: `${roleName(def.claim)}`,
    status: 'ダウトリスクあり',
    detail: `${roleName(def.claim)}を宣言するアクションです。`,
    className: 'bluff-risk'
  };
}

function blockText(def) {
  if (!def.blockableBy || !def.blockableBy.length) return 'ブロック不可';
  return `${def.blockableBy.map((role) => roleName(role)).join(' / ')} でブロック可`;
}

function cardSlotHtml({ face = 'back', role = '', label = '', mine = false } = {}) {
  if (face === 'back') {
    return `<div class="influence-card back" title="未公開の生存カード"><span class="card-pattern">COUP</span></div>`;
  }
  const title = label || (face === 'dead' ? '公開済み・失ったカード' : '生存中の自分のカード');
  const labelHtml = label ? `<small>${escapeHtml(label)}</small>` : '';
  return `<div class="influence-card ${face}" title="${escapeHtml(title)}">${labelHtml}<strong>${escapeHtml(roleName(role))}</strong>${mine && face === 'alive' ? '<span class="alive-ribbon">生存</span>' : ''}</div>`;
}

function influenceSlotsForPlayer(player) {
  const slots = [];
  for (let i = 0; i < player.aliveCards; i++) slots.push(cardSlotHtml({ face: 'back' }));
  for (const card of player.revealed || []) slots.push(cardSlotHtml({ face: 'dead', role: card.role }));
  while (slots.length < 2) slots.push('<div class="influence-card empty"><small>なし</small></div>');
  return slots.slice(0, 2).join('');
}

function cardStateLabel(card) {
  return card.alive ? '生存中・非公開' : '公開済み・失ったカード';
}

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

function emit(event, payload = {}, onSuccess = null) {
  socket.emit(event, { ...payload, clientId: getClientId() }, (res) => {
    if (res && res.ok === false) toast(res.error || 'エラーが発生しました。');
    else if (res && res.ok && onSuccess) onSuccess(res.value);
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
    status = state.hostId === me?.id ? '同じメンバーでもう一度対戦できます。' : 'ホストが再戦を開始できます。';
  }
  $('headline').textContent = headline;
  $('status').textContent = status;

  const startVisible = state.phase === 'waiting' && state.hostId === me?.id;
  const rematchVisible = state.phase === 'finished' && state.hostId === me?.id;
  $('startBtn').style.display = startVisible ? 'inline-block' : 'none';
  $('rematchBtn').style.display = rematchVisible ? 'inline-block' : 'none';
  $('startBtn').onclick = () => emit('startGame', { roomId: state.roomId });
  $('rematchBtn').onclick = () => emit('rematch', { roomId: state.roomId });
  $('copyRoomBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.roomId);
      toast('部屋IDをコピーしました。');
    } catch {
      toast(`部屋ID: ${state.roomId}`);
    }
  };
  $('leaveRoomBtn').onclick = () => {
    if (!state?.roomId) return;
    emit('leaveRoom', { roomId: state.roomId }, () => {
      clearRoomSession();
      resetToLobby('部屋を抜けました。');
    });
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
    const isTargetable = Boolean(selectedAction && state.phase === 'action' && state.currentTurnPlayerId === state.me?.id && p.id !== state.me?.id && p.aliveCards > 0);
    div.className = ['player', p.id === state.currentTurnPlayerId ? 'current' : '', p.id === state.me?.id ? 'me' : '', p.aliveCards === 0 ? 'dead' : '', isTargetable ? 'targetable-player' : ''].filter(Boolean).join(' ');
    if (isTargetable) {
      div.tabIndex = 0;
      div.title = `${p.name} に ${actionName(selectedAction)} を実行`;
      div.onclick = () => emit('takeAction', { roomId: state.roomId, action: selectedAction, targetId: p.id });
      div.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          emit('takeAction', { roomId: state.roomId, action: selectedAction, targetId: p.id });
        }
      };
    }
    const badges = [];
    if (p.id === state.hostId) badges.push('<span class="stat">Host</span>');
    if (p.id === state.currentTurnPlayerId && state.phase !== 'waiting') badges.push('<span class="stat turn-stat">Turn</span>');
    if (!p.connected) badges.push('<span class="stat">切断</span>');
    if (p.aliveCards === 0) badges.push('<span class="stat dead-stat">脱落</span>');
    div.innerHTML = `
      <div class="player-top">
        <span class="player-name">${escapeHtml(p.name)}${p.id === state.me?.id ? '（あなた）' : ''}</span>
        <div class="player-stats">${badges.join('')}</div>
      </div>
      <div class="table-influence" aria-label="${escapeHtml(p.name)}の影響力カード">${influenceSlotsForPlayer(p)}</div>
      <div class="player-stats">
        <span class="stat coin-stat">🪙 ${p.coins}</span>
        <span class="stat alive-stat">生存 ${p.aliveCards}枚</span>
      </div>
    `;
    root.appendChild(div);
  }
}

function renderCards() {
  const root = $('myCards');
  root.innerHTML = '';
  const cards = state.me?.cards || [];
  if (!cards.length) {
    root.innerHTML = '<p class="muted">ゲーム開始後、自分のカードがここに表示されます。相手のカードは裏向きで表示されます。</p>';
    return;
  }
  const legend = document.createElement('div');
  legend.className = 'card-legend';
  legend.innerHTML = `
    <span><i class="legend-dot alive"></i>生存中の自分のカード</span>
    <span><i class="legend-dot back"></i>相手の裏向きカード</span>
    <span><i class="legend-dot dead"></i>失ったカード</span>
  `;
  root.appendChild(legend);
  const wrap = document.createElement('div');
  wrap.className = 'cards';
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `card ${card.alive ? 'alive' : 'dead'}`;
    div.innerHTML = `<strong>${escapeHtml(roleName(card.role))}</strong>`;
    wrap.appendChild(div);
  }
  root.appendChild(wrap);
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

function targetButtonsForAction(actionKey) {
  const wrap = document.createElement('div');
  wrap.className = 'target-button-grid';
  for (const p of aliveOpponents()) {
    const btn = createButton(`${p.name} を対象にする`, () => {
      selectedTargetId = p.id;
      emit('takeAction', { roomId: state.roomId, action: actionKey, targetId: p.id });
    }, 'target-button primary');
    btn.innerHTML = `<strong>${escapeHtml(p.name)}</strong><span>🪙${p.coins} / 影響力${p.aliveCards}</span>`;
    wrap.appendChild(btn);
  }
  return wrap;
}

function executeOrAskTarget(actionKey, def) {
  const reason = actionDisabledReason(actionKey, def);
  if (reason) {
    toast(reason);
    return;
  }
  if (def.requiresTarget) {
    selectedAction = actionKey;
    selectedTargetId = '';
    renderActions();
    return;
  }
  selectedAction = '';
  selectedTargetId = '';
  emit('takeAction', { roomId: state.roomId, action: actionKey, targetId: null });
}

function blockRisk(role) {
  if (hasAliveRole(role)) return {
    className: 'owned-safe',
    label: `${roleName(role)}でブロック`,
    note: '安全'
  };
  return {
    className: 'bluff-risk',
    label: `${roleName(role)}でブロック`,
    note: 'ダウトリスク'
  };
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
  box.innerHTML = '<h3>アクションをクリックして実行</h3><p>対象が必要なアクションは、アクションをクリックした後に対象プレイヤーをクリックすると実行されます。</p><div class="action-safety-legend"><span class="small-pill free-safe">緑: カード不要</span><span class="small-pill owned-safe">青: 安全</span><span class="small-pill bluff-risk">赤: ダウトリスク</span></div>';

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
    const req = actionRequirement(def, key);
    button.className = ['action-card', req.className, selectedAction === key ? 'selected-action' : '', state.me.coins >= 10 && key === 'coup' ? 'forced' : ''].filter(Boolean).join(' ');
    button.innerHTML = `
      <span class="name">${escapeHtml(def.label)}${def.cost ? ` · ${def.cost} coins` : ''}</span>
      <span class="claim-line ${req.className}">
        <span class="claim-badge">${escapeHtml(req.label)}</span>
      </span>
      <span class="meta concise-action-info">
        <span class="phase-chip">${escapeHtml(help.effect)}</span>
        <span class="phase-chip ${def.blockableBy?.length ? 'danger' : 'success'}">${escapeHtml(help.block || blockText(def))}</span>
      </span>
    `;
    button.onclick = () => executeOrAskTarget(key, def);
    if (reason) button.title = reason;
    grid.appendChild(button);
  }
  box.appendChild(grid);

  if (selectedAction) {
    const def = state.actions[selectedAction];
    const detail = document.createElement('div');
    detail.className = 'action-detail';
    const req = actionRequirement(def, selectedAction);
    detail.appendChild(makeChip(`${def.label} の対象をクリック`, phaseKind(state.phase)));
    const note = document.createElement('div');
    note.className = `claim-note ${req.className}`;
    note.innerHTML = `<strong>${escapeHtml(req.label)}</strong><span>${escapeHtml(req.detail)}</span>`;
    detail.appendChild(note);
    if (def.requiresTarget) {
      const targetHint = document.createElement('p');
      targetHint.className = 'muted';
      targetHint.textContent = '右のプレイヤーカード、または下の対象ボタンをクリックすると実行されます。';
      detail.appendChild(targetHint);
      detail.appendChild(targetButtonsForAction(selectedAction));
    }
    box.appendChild(detail);
  } else {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = '対象が必要なアクションは、次にプレイヤーカードをクリックしてください。';
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
        const risk = blockRisk(role);
        const blockButton = createButton(`${risk.label}｜${risk.note}`, () => emit('block', { roomId: state.roomId, role }), `block-button ${risk.className}`);
        blockButton.title = risk.note;
        buttons.appendChild(blockButton);
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
    box.innerHTML = `<h3>${mustChoose ? '失うカードを選択' : '影響力喪失待ち'}</h3><p>${mustChoose ? '失うカードを1枚選んでください。' : `${escapeHtml(playerById(state.pending?.playerId)?.name || '対象者')} がカードを選択中です。`}</p>`;
    if (mustChoose) {
      const cards = document.createElement('div');
      cards.className = 'cards';
      for (const card of state.me.cards.filter((c) => c.alive)) {
        const cardButton = document.createElement('button');
        cardButton.className = 'card alive selectable lose-choice';
        cardButton.innerHTML = `<strong>${escapeHtml(roleName(card.role))}</strong>`;
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
        div.className = `card alive selectable ${exchangeSelection.has(card.id) ? 'selected' : ''}`;
        div.innerHTML = `<small>${exchangeSelection.has(card.id) ? '残すカード' : '交換候補'}</small><strong>${escapeHtml(roleName(card.role))}</strong>`;
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
    const help = ACTION_HELP[key] || { effect: '', block: '' };
    const row = document.createElement('div');
    row.className = 'guide-row';
    const req = actionRequirement(def, key);
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(def.label)}</strong><br>
        <span>${escapeHtml(help.effect)}</span>
        <div class="guide-mini">${escapeHtml(help.block || blockText(def))}</div>
      </div>
      <span class="small-pill ${req.className}">${escapeHtml(req.label)}</span>
    `;
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
  emit('createRoom', { name }, (value) => saveSession(value.roomId, name));
};

$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim() || 'Player';
  const roomId = $('roomInput').value.trim().toUpperCase();
  if (!roomId) return toast('部屋IDを入力してください。');
  emit('joinRoom', { name, roomId }, (value) => saveSession(value.roomId, name));
};

$('roomInput').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});


function resetToLobby(message = '') {
  state = null;
  selectedTargetId = '';
  selectedAction = '';
  exchangeSelection = new Set();
  $('lobby').classList.remove('hidden');
  $('roomBadge').classList.add('hidden');
  $('statusBoard').classList.add('hidden');
  $('gameLayout').classList.add('hidden');
  $('logPanel').classList.add('hidden');
  if (message) toast(message);
}

socket.on('connect', () => {
  const savedRoomId = localStorage.getItem(STORAGE_KEYS.roomId);
  const savedName = localStorage.getItem(STORAGE_KEYS.name);
  if (savedName && !$('nameInput').value) $('nameInput').value = savedName;
  if (savedRoomId) {
    socket.emit('reconnectRoom', { roomId: savedRoomId, clientId: getClientId() }, (res) => {
      if (res?.ok) saveSession(res.value.roomId, savedName || $('nameInput').value || 'Player');
      else {
        clearRoomSession();
        toast(res?.error || '保存された部屋には復帰できませんでした。');
      }
    });
  }
});

socket.on('leftRoom', () => {
  clearRoomSession();
  resetToLobby('部屋を抜けました。');
});

socket.on('roomState', (next) => {
  const previousPhase = state?.phase;
  state = next;
  if (state.roomId) saveSession(state.roomId, state.me?.name || localStorage.getItem(STORAGE_KEYS.name) || 'Player');
  if (previousPhase !== state.phase) {
    selectedAction = '';
    if (state.phase !== 'action') selectedTargetId = '';
  }
  render();
});
socket.on('errorMessage', toast);
