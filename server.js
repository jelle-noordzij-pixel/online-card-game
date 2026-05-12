const socket = io();
    let selectedIndices = [];
    let currentGameState = null;

    function join() {
        const name = document.getElementById("p-name").value;
        if(!name) return;
        socket.emit("joinGame", { name });
    }

    function start() {
        socket.emit("updateRules", { limit: document.getElementById("p-limit").value });
        socket.emit("startGame");
    }

    function confirmDiscard() {
        console.log("Verstuur discard voor indices:", selectedIndices);
        socket.emit("discard", { indices: selectedIndices });
        selectedIndices = []; // Reset selectie na versturen
    }

    // NIEUW: Deze functie ververst alleen je hand zonder de hele state te hertekenen
    function renderHandUI() {
        const handDiv = document.getElementById("player-hand");
        handDiv.innerHTML = "";
        const myData = currentGameState.players[socket.id];
        const isMyTurn = socket.id === currentGameState.turn;

        if (myData && myData.hand) {
            myData.hand.forEach((card, i) => {
                if (card === null) return; // Sla lege plekken over
                const slot = document.createElement("div");
                slot.className = "hand-slot";
                const isRed = card.s === '♥' || card.s === '♦';
                const cEl = document.createElement("div");
                cEl.className = `card ${isRed ? 'red' : ''} ${selectedIndices.includes(i) ? 'selected' : ''}`;
                
                // Mooiere weergave van cijfers en tekens
                const displayVal = card.v === 0 ? 'J' : (card.v === 1 ? 'A' : (card.v === 11 ? 'B' : (card.v === 12 ? 'V' : (card.v === 13 ? 'H' : card.v))));
                cEl.innerHTML = `<div>${displayVal}</div><div>${card.s || ''}</div>`;
                
                cEl.onclick = () => {
                    if (isMyTurn && currentGameState.roundState === 'DISCARD') {
                        if (selectedIndices.includes(i)) {
                            selectedIndices = selectedIndices.filter(x => x !== i);
                        } else {
                            selectedIndices.push(i);
                        }
                        renderHandUI(); // Ververs hand direct
                    }
                };
                slot.appendChild(cEl);
                handDiv.appendChild(slot);
            });
        }
        // Update knop zichtbaarheid
        document.getElementById("discard-btn").style.visibility = (isMyTurn && selectedIndices.length > 0) ? "visible" : "hidden";
    }

    socket.on("updateState", (state) => {
        currentGameState = state;
        const isMyTurn = socket.id === state.turn;
        
        // Lobby check
        document.getElementById("setup-menu").style.display = (state.status === 'LOBBY') ? "flex" : "none";
        if (socket.id === state.hostId) document.getElementById("host-controls").style.display = "block";

        // Scorebar
        const bar = document.getElementById("score-bar");
        bar.innerHTML = "";
        state.playerOrder.forEach(id => {
            const p = state.players[id];
            bar.innerHTML += `
                <div class="score-pill ${state.turn === id ? 'active' : ''}">
                    <div class="name">${p.name}</div>
                    <div style="font-size:0.9rem">${state.totals[id] || 0}</div>
                    <div style="font-size:0.5rem">🎴 ${p.handCount}</div>
                </div>`;
        });

        if (state.status === 'PLAYING') {
            document.getElementById("status-msg").innerText = isMyTurn ? `JOUW BEURT: ${state.roundState === 'DISCARD' ? 'GOOI KAARTEN' : 'PAK EEN KAART'}` : `WACHTEN OP ${state.players[state.turn].name}`;
            
            // Open kaart
            const openDiv = document.getElementById("open-stack");
            const top = state.tableStack[state.tableStack.length - 1];
            if (top) {
                const isRed = top.s === '♥' || top.s === '♦';
                openDiv.innerHTML = `<div class="card" style="color:${isRed ? 'var(--danger)' : 'black'}">
                    ${top.v === 0 ? 'J' : top.v}<br>${top.s || ''}
                </div>`;
            }
            renderHandUI();
        }

        // Reveal/GameOver overlays
        document.getElementById("reveal-overlay").style.display = (state.status === 'REVEAL' || state.status === 'GAMEOVER') ? "flex" : "none";
        if (state.revealData) {
            const resDiv = document.getElementById("results-list");
            resDiv.innerHTML = Object.values(state.revealData.results).map(r => `<div>${r.ptsThisRound} pt</div>`).join("");
        }
    });

    socket.on("actionError", (msg) => alert(msg));
