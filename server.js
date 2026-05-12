const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let gameState = {
    players: {},
    playerOrder: [],
    deck: [],
    tableStack: [],
    turnIndex: 0,
    status: 'LOBBY',       
    turn: null,            
    roundState: 'DISCARD', 
    lastDiscardCount: 0,
    extraCards: {},        
    totals: {},            
    rules: { limit: 100, straf: { n: 5, t: 'slokken' } },
    revealData: null,
    pendingLosers: [],
    hostId: null,
};

const suits = ['♥', '♦', '♣', '♠'];

function buildDeck() {
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}

function calcHand(hand) {
    return hand.filter(x => x).reduce((acc, c) => {
        if (c.v === 0)  return acc;       
        if (c.v === 1)  return acc + 1;   
        if (c.v === 11) return acc - 1;   
        if (c.v >= 12)  return acc + 10;  
        return acc + c.v;
    }, 0);
}

function sendState() {
    gameState.playerOrder.forEach(id => {
        const view = {
            playerOrder: gameState.playerOrder,
            players: {},
            tableStack: gameState.tableStack,
            turn: gameState.turn,
            roundState: gameState.roundState,
            lastDiscardCount: gameState.lastDiscardCount,
            status: gameState.status,
            totals: gameState.totals,
            rules: gameState.rules,
            revealData: gameState.revealData,
            hostId: gameState.hostId,
            deckCount: gameState.deck.length,
        };
        gameState.playerOrder.forEach(pid => {
            view.players[pid] = {
                name: gameState.players[pid].name,
                handCount: gameState.players[pid].hand.filter(x => x).length,
                hand: pid === id ? gameState.players[pid].hand : null, 
            };
        });
        io.to(id).emit('updateState', view);
    });
}

function resetRound() {
    gameState.deck = buildDeck();
    gameState.playerOrder.forEach(id => {
        const extra = gameState.extraCards[id] || 0;
        gameState.players[id].hand = gameState.deck.splice(0, 5 + extra);
        gameState.extraCards[id] = 0;
    });
    gameState.tableStack = [gameState.deck.pop()];
    gameState.turnIndex = 0;
    gameState.turn = gameState.playerOrder[0];
    gameState.roundState = 'DISCARD';
    gameState.lastDiscardCount = 0;
    gameState.status = 'PLAYING';
    gameState.revealData = null;
    sendState();
}

function nextTurn() {
    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.playerOrder.length;
    gameState.turn = gameState.playerOrder[gameState.turnIndex];
    gameState.roundState = 'DISCARD';
    gameState.lastDiscardCount = 0;
    sendState();
}

function resolveRound(callerId) {
    const scores = {};
    gameState.playerOrder.forEach(id => {
        scores[id] = calcHand(gameState.players[id].hand);
    });
    const callerScore = scores[callerId];
    const kamoFail = gameState.playerOrder.some(id => id !== callerId && scores[id] <= callerScore);
    const results = {};
    gameState.pendingLosers = [];

    gameState.playerOrder.forEach(id => {
        let ptsThisRound = scores[id];
        let badge = '';
        if (kamoFail && id === callerId) {
            ptsThisRound = scores[id] + 20;
            badge = 'KAMO';
            gameState.extraCards[id] = 1;
        } else if (!kamoFail && id === callerId) {
            ptsThisRound = 0;
            badge = 'WIN';
        } else if (kamoFail && scores[id] === Math.min(...Object.values(scores))) {
            ptsThisRound = 0;
            badge = 'WIN';
        }
        gameState.totals[id] = (gameState.totals[id] || 0) + ptsThisRound;
        if (gameState.totals[id] >= gameState.rules.limit) gameState.pendingLosers.push(id);
        results[id] = { score: scores[id], ptsThisRound, total: gameState.totals[id], badge };
    });

    gameState.revealData = { caller: callerId, results, kamoFail };
    gameState.status = gameState.pendingLosers.length > 0 ? 'GAMEOVER' : 'REVEAL';
    sendState();
}

io.on("connection", (socket) => {
    socket.on("joinGame", ({ name }) => {
        if (gameState.status !== 'LOBBY') return;
        gameState.players[socket.id] = { id: socket.id, name: name || "Speler", hand: [] };
        if (!gameState.playerOrder.includes(socket.id)) gameState.playerOrder.push(socket.id);
        gameState.totals[socket.id] = 0;
        if (!gameState.hostId) gameState.hostId = socket.id;
        sendState();
    });

    socket.on("startGame", () => {
        if (socket.id === gameState.hostId) resetRound();
    });

    socket.on("discard", ({ indices }) => {
        const g = gameState;
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DISCARD') return;
        const hand = g.players[socket.id].hand;
        const cards = indices.map(i => hand[i]).filter(c => c !== null);
        if (!cards.length) return;
        if (!cards.every(c => c.v === cards[0].v)) {
            socket.emit('actionError', 'ALLEEN DEZELFDE KAARTEN!');
            return;
        }
        g.tableStack.push(...cards);
        g.lastDiscardCount = cards.length;
        indices.sort((a, b) => b - a).forEach(i => {
            if (i === Math.min(...indices)) hand[i] = null;
            else hand.splice(i, 1);
        });
        g.roundState = 'DRAW';
        sendState();
    });

    socket.on("drawFromDeck", () => {
        if (gameState.status !== 'PLAYING' || socket.id !== gameState.turn || gameState.roundState !== 'DRAW') return;
        if (gameState.deck.length === 0) gameState.deck = buildDeck();
        const card = gameState.deck.pop();
        const hand = gameState.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        nextTurn();
    });

    socket.on("drawFromOpen", () => {
        const g = gameState;
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DRAW') return;
        const availableIndex = g.tableStack.length - g.lastDiscardCount - 1;
        if (availableIndex < 0) return socket.emit('actionError', 'PAK VAN HET DECK!');
        const card = g.tableStack.splice(availableIndex, 1)[0];
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        nextTurn();
    });

    socket.on("call", () => {
        if (gameState.status !== 'PLAYING' || socket.id !== gameState.turn) return;
        if (calcHand(gameState.players[socket.id].hand) > 5) return socket.emit('actionError', 'TE VEEL PUNTEN!');
        resolveRound(socket.id);
    });

    socket.on("nextRound", () => {
        if (socket.id === gameState.hostId) resetRound();
    });

    socket.on("disconnect", () => {
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        if (gameState.hostId === socket.id) gameState.hostId = gameState.playerOrder[0] || null;
        sendState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server live op poort ${PORT}`));
