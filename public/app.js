const socket = io({transports:["websocket","polling"]});

let state = null;
let roomCode = null;
let reconnectToken = localStorage.getItem("cb_reconnectToken");
let savedPlayerId = localStorage.getItem("cb_playerId");
let savedRoomCode = localStorage.getItem("cb_roomCode");

const $ = id => document.getElementById(id);

function show(id, yes=true){$(id).classList.toggle("hidden", !yes);}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}

function setError(text){$("lobbyError").textContent=text||"";}

function cardHtml(c, mode="view"){
  const defText = {
    none:"なし", destroy_enemy_one:"POWER以下の相手カードを1枚破壊",
    draw_one:"召喚時：1枚ドロー", discard_each_enemy:"召喚時：他全員が1枚捨てる",
    heal_one:"召喚時：ライフ+1", lose_life_one:"召喚時：ライフ-1",
    discard_self_random:"召喚時：自分の手札を1枚捨てる",
    destroy_self_field_one:"召喚時：自分の別カードを1枚破壊",
    rush:"速攻", double_attack:"1ターン2回攻撃", effect_immune:"効果破壊されない"
  }[c.effect] || c.effect;
  const attack = c.attack ? "攻撃○" : "攻撃×";
  const defend = c.defend ? "防御○" : "防御×";
  let button = "";
  if(mode==="hand"){
    button = `<button onclick="summon('${c.uid}')">召喚</button>`;
  } else if(mode==="field"){
    button = c.attack ? `<button ${canAttack(c)?"":"disabled"} onclick="attack('${c.uid}')">攻撃</button>` : "";
  } else if(mode==="defense"){
    button = `<button onclick="defend('${c.uid}')">このカードで防御</button>`;
  }
  return `<div class="card ${mode==='field'&&canAttack(c)?'attackable':''} ${mode==='defense'?'defender':''}">
    <div class="num">No.${c.id}</div>
    <div class="power">${c.power}</div>
    <div class="meta">${attack} / ${defend}</div>
    <div class="meta">${escapeHtml(defText)}</div>
    ${button}
  </div>`;
}

function canAttack(c){
  if(!state || !state.room.attacksAllowed || state.room.currentPlayerId !== state.me.id) return false;
  if(c.summonedTurn === state.room.turnNumber && c.effect !== "rush") return false;
  const max = c.effect === "double_attack" ? 2 : 1;
  return c.attack && c.attacksThisTurn < max && state.room.phase === "main";
}

function render(){
  if(!state) return;
  show("lobby", false);
  show("roomPanel", state.room.status==="waiting");
  show("gamePanel", state.room.status==="playing" || state.room.status==="finished" || state.room.status==="invalid");

  $("roomCodeView").textContent = state.room.code;

  if(state.room.status==="waiting"){
    $("playersList").innerHTML = state.players.map((p,i)=>`
      <div class="player-row">
        <span>${i===0?"👑 ":""}${escapeHtml(p.name)}</span>
        <span>${p.connected?"接続中":"切断中"}</span>
      </div>`).join("");
    show("startBtn", state.players.some(p=>p.id===state.me.id) && state.players[0]?.id===state.me.id && state.players.length>=2);
    $("roomMessage").textContent = `${state.players.length}/4 人。2人以上でゲーム開始できます。`;
    return;
  }

  const current = state.players.find(p=>p.id===state.room.currentPlayerId);
  $("gameHeader").innerHTML = `
    <div><b>ルーム ${state.room.code}</b><br><span class="muted">ターン ${state.room.turnNumber}</span></div>
    <div>${current?`現在のターン：<b>${escapeHtml(current.name)}</b>`:""}</div>
  `;

  $("opponents").innerHTML = state.players.filter(p=>p.id!==state.me.id).map(p=>`
    <div class="player-board ${p.id===state.room.currentPlayerId?"current":""} ${p.connected?"":"disconnected"}">
      <div><b>${escapeHtml(p.name)}</b> ${p.connected?"":"（切断中）"}</div>
      <div>❤️ ${p.life}　🂠 手札 ${p.handCount}枚</div>
      <div class="card-grid">${p.field.map(c=>cardHtml(c)).join("") || '<span class="muted">フィールドなし</span>'}</div>
    </div>`).join("");

  $("myInfo").innerHTML = `あなた：${escapeHtml(state.me.name)}　❤️ ${state.me.life}　`+
    `<span class="badge">${state.room.currentPlayerId===state.me.id?"自分のターン":"相手のターン"}</span>`+
    ` <span class="badge">召喚 ${state.room.turnSummonsUsed}/${state.room.maxSummons}</span>`+
    (!state.room.attacksAllowed?` <span class="badge">攻撃不可</span>`:"");

  $("myField").innerHTML = state.me.field.map(c=>cardHtml(c,"field")).join("") || '<span class="muted">フィールドにカードがありません</span>';
  $("myHand").innerHTML = state.me.hand.map(c=>cardHtml(c,"hand")).join("") || '<span class="muted">手札がありません</span>';

  $("phaseText").textContent =
    state.room.status==="finished" ? "ゲーム終了" :
    state.room.status==="invalid" ? "このゲームは無効です" :
    state.room.phase==="defense" ? "防御を選択してください" :
    state.room.phase==="ability" ? "能力の対象を選択してください" :
    state.room.currentPlayerId===state.me.id ? "あなたのターン" : `${escapeHtml(current?.name||"")} のターン`;

  $("log").innerHTML = state.room.log.map(x=>`<div>${escapeHtml(x)}</div>`).join("");
  $("log").scrollTop = $("log").scrollHeight;

  const myTurn = state.room.currentPlayerId===state.me.id && state.room.phase==="main";
  $("endTurnBtn").disabled = !myTurn;
  show("rematchBtn", state.room.status==="finished");

  if(state.room.status==="finished"){
    const order = state.room.winnerOrder.map((id,i)=>{
      const p=state.players.find(x=>x.id===id);
      return `<div>${i===0?"🏆":(i+1)+"位："} ${escapeHtml(p?.name||"")}</div>`;
    }).join("");
    openModal("ゲーム終了", `<div class="winner">${order||"結果なし"}</div>`,
      `<button class="primary" onclick="closeModal()">閉じる</button>`);
  } else if(state.room.status==="invalid"){
    openModal("ゲーム無効", `<p>${escapeHtml(state.room.invalidReason||"ゲームが無効になりました。")}</p>`,
      `<button class="primary" onclick="closeModal()">閉じる</button>`);
  }
}

let modalKind=null;
function openModal(title, body, actions="", kind=null){
  modalKind=kind;
  $("modalTitle").textContent=title;
  $("modalBody").innerHTML=body;
  $("modalActions").innerHTML=actions;
  show("modal",true);
}
// kind指定時は、そのモーダルが現在表示中の場合のみ閉じる。
// (能力選択の応答が届く前に防御モーダルが開かれることがあり、それを誤って閉じないため)
function closeModal(kind=null){
  if(typeof kind==="string" && modalKind!==kind) return;
  modalKind=null;
  show("modal",false);
}

window.summon = uid => {
  socket.emit("summonFromHand",{uid},res=>{if(!res?.ok) alert(res?.error||"召喚できません");});
};
window.attack = uid => {
  socket.emit("attack",{uid},res=>{if(!res?.ok) alert(res?.error||"攻撃できません");});
};
window.defend = uid => {
  socket.emit("defend",{uid},res=>{if(!res?.ok) alert(res?.error||"防御できません"); else closeModal("defense");});
};

$("createBtn").onclick=()=>{
  const name=$("playerName").value.trim();
  socket.emit("createRoom",{name},res=>{
    if(!res?.ok)return setError(res?.error);
    roomCode=res.code; reconnectToken=res.reconnectToken;
    localStorage.setItem("cb_reconnectToken",reconnectToken);
    setError("");
  });
};
$("joinBtn").onclick=()=>{
  const name=$("playerName").value.trim();
  const code=$("roomCode").value.trim().toUpperCase();
  socket.emit("joinRoom",{name,code},res=>{
    if(!res?.ok)return setError(res?.error);
    roomCode=res.code; reconnectToken=res.reconnectToken;
    localStorage.setItem("cb_reconnectToken",reconnectToken);
    setError("");
  });
};
$("startBtn").onclick=()=>socket.emit("startGame",res=>{if(!res?.ok)alert(res?.error);});
$("leaveBtn").onclick=()=>socket.emit("leaveRoom");
$("endTurnBtn").onclick=()=>socket.emit("endTurn");
$("rematchBtn").onclick=()=>socket.emit("rematch",res=>{if(!res?.ok)alert(res?.error);});

socket.on("connect",()=>{
  $("connectionStatus").textContent="接続中";
  $("connectionStatus").style.color="#86efac";
  if(savedRoomCode && savedPlayerId && reconnectToken){
    socket.emit("reconnectGame",{code:savedRoomCode,playerId:savedPlayerId,reconnectToken},res=>{
      if(!res?.ok){
        localStorage.removeItem("cb_roomCode");
        localStorage.removeItem("cb_playerId");
        if(state){
          // 切断中にルームから退出扱いになった場合は、古い画面を残さずロビーへ戻す。
          state=null; roomCode=null; savedRoomCode=null; savedPlayerId=null;
          closeModal();
          show("gamePanel",false); show("roomPanel",false); show("lobby",true);
          setError(res?.error||"ルームから退出になりました。");
        }
      }
    });
  }
});
socket.on("disconnect",()=>{
  $("connectionStatus").textContent="切断・再接続待機中";
  $("connectionStatus").style.color="#fca5a5";
});
socket.on("state",s=>{
  state=s;
  roomCode=s.room.code;
  savedRoomCode=roomCode;
  savedPlayerId=s.me?.id || savedPlayerId;
  reconnectToken=s.me?.reconnectToken || reconnectToken;
  if(savedRoomCode)localStorage.setItem("cb_roomCode",savedRoomCode);
  if(savedPlayerId)localStorage.setItem("cb_playerId",savedPlayerId);
  if(reconnectToken)localStorage.setItem("cb_reconnectToken",reconnectToken);
  render();
  syncPendingModal();
});
// 防御選択・能力選択のモーダルは、サーバーから届く state.pending を元に表示する。
// (再接続直後や、イベントと状態の到着順が前後した場合でも常に正しく復元・同期できる)
function showAbilityModal(data){
  if(data.type!=="destroy_enemy_one") return;
  const html=state.players.filter(p=>p.id!==state.me.id&&!p.eliminated).map(p=>`
    <h3>${escapeHtml(p.name)}</h3>
    ${p.field.map(c=>`<button class="choice-card" onclick="chooseAbility('${p.id}','${c.uid}')">No.${c.id} / POWER ${c.power} を選択</button>`).join("")||"<p>対象カードなし</p>"}
  `).join("");
  openModal("No.03 / No.04 の効果", "<p>POWER以下の相手カードを1枚選択してください。</p>"+html+`<div class="modal-actions"><button onclick="skipAbility()">選択しない</button></div>`, "", "ability");
}
function showDefenseModal(data){
  openModal("防御を選択",`
    <p>${escapeHtml(data.attacker.playerName)} の No.${data.attacker.card.id}（POWER ${data.attacker.card.power}）の攻撃です。</p>
    <p>防御する場合はカードを1枚選択してください。防御カードは必ず消滅します。</p>
    <button class="danger" onclick="takeAttack()">防御せず攻撃を受ける</button>
    <hr>
    ${data.defenders.map(c=>cardHtml(c,"defense")).join("")}
  `, "", "defense");
}
function syncPendingModal(){
  const pend=state?.pending||null;
  if(pend?.kind==="defense"){
    if(modalKind!=="defense") showDefenseModal(pend);
  }else if(pend?.kind==="ability"){
    if(modalKind!=="ability") showAbilityModal(pend);
  }else if(modalKind==="defense"||modalKind==="ability"){
    closeModal(); // 選択待ちが解消済みなのに残っている古いモーダルを閉じる
  }
}
window.takeAttack=()=>{
  socket.emit("takeAttack",res=>{if(!res?.ok)alert(res?.error||"操作できません");else closeModal("defense");});
};
window.chooseAbility=(targetPlayerId,targetCardUid)=>{
  socket.emit("abilityChoice",{choice:{targetPlayerId,targetCardUid}},res=>{
    if(!res?.ok)alert(res?.error||"選択できません"); else closeModal("ability");
  });
};
window.skipAbility=()=>{
  socket.emit("abilityChoice",{choice:{skip:true}},res=>{
    if(!res?.ok)alert(res?.error||"操作できません"); else closeModal("ability");
  });
};

function returnToLobby(){
  if(!state || !state.room || state.room.status==="waiting") {
    show("gamePanel",false); show("roomPanel",false); show("lobby",true);
    return;
  }
  const ok=confirm("ゲームを退出して、最初のルーム作成・参加画面に戻りますか？");
  if(!ok)return;
  socket.emit("leaveRoom",()=>{
    state=null; roomCode=null; savedRoomCode=null; savedPlayerId=null; reconnectToken=null;
    localStorage.removeItem("cb_roomCode");
    localStorage.removeItem("cb_playerId");
    localStorage.removeItem("cb_reconnectToken");
    closeModal();
    show("gamePanel",false); show("roomPanel",false); show("lobby",true);
    setError("");
  });
}
$("brandLogo").onclick=returnToLobby;
$("brandLogo").onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();returnToLobby();}};

function showSpecialResult(data){
  $("specialTitle").textContent=data.title||"特殊抽選";
  $("specialResult").textContent=data.result||"";
  show("specialOverlay",true);
}
$("specialClose").onclick=()=>show("specialOverlay",false);
socket.on("specialResult",showSpecialResult);
