const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
 
const app = express();
const server = http.createServer(app);
const io = new Server(server);
 
app.use(express.static(__dirname));
 
// ── GAME STATE ──
let gameState = {
    players: {},
    playerOrder: [],
    deck: [],
    tableStack: [],
    turnIndex: 0,
    status: 'LOBBY',       // LOBBY | PLAYING | REVEAL | GAMEOVER
    turn: null,            // socket.id of current player
    roundState: 'DISCARD', // DISCARD | DRAW
    lastDiscardCount: 0,
    extraCards: {},        // socket.id -> extra cards for next round
    totals: {},            // socket.id -> cumulative score
    rules: { limit: 100, straf: { n: 5, t: 'slokken' } },
    revealData: null,
    pendingLosers: [],
    hostId: null,
};
 
// ── HELPERS ──
const suits = ['♥', '♦', '♣', '♠'];
 
function buildDeck() {
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}
 
function calcHand(hand) {
    return hand.filter(x => x).reduce((acc, c) => {
        if (c.v === 0)  return acc;       // Joker = 0
        if (c.v === 1)  return acc + 1;   // Aas = 1
        if (c.v === 11) return acc - 1;   // Boer = -1
        if (c.v >= 12)  return acc + 10;  // Vrouw/Heer = 10
        return acc + c.v;
    }, 0);
}
 
function sendState() {
    // Each player gets a view where only THEIR hand is visible; others show count only
    const g = gameState;
    g.playerOrder.forEach(id => {
        const view = {
            playerOrder: g.playerOrder,
            players: {},
            tableStack: g.tableStack,
            turn: g.turn,
            roundState: g.roundState,
            lastDiscardCount: g.lastDiscardCount,
            status: g.status,
            totals: g.totals,
            rules: g.rules,
            revealData: g.revealData,
            hostId: g.hostId,
            deckCount: g.deck.length,
        };
        g.playerOrder.forEach(pid => {
            view.players[pid] = {
                name: g.players[pid].name,
                handCount: g.players[pid].hand.filter(x => x).length,
                hand: pid === id ? g.players[pid].hand : null, // only own hand
            };
        });
        io.to(id).emit('updateState', view);
    });
}
 
function resetRound() {
    const g = gameState;
    g.deck = buildDeck();
    g.playerOrder.forEach(id => {
        const extra = g.extraCards[id] || 0;
        g.players[id].hand = g.deck.splice(0, 5 + extra);
        g.extraCards[id] = 0;
    });
    g.tableStack = [g.deck.pop()];
    g.turn = g.playerOrder[0];
    g.turnIndex = 0;
    g.roundState = 'DISCARD';
    g.lastDiscardCount = 0;
    g.status = 'PLAYING';
    g.revealData = null;
    g.pendingLosers = [];
    sendState();
}
 
function nextTurn() {
    const g = gameState;
    g.turnIndex = (g.turnIndex + 1) % g.playerOrder.length;
    g.turn = g.playerOrder[g.turnIndex];
    g.roundState = 'DISCARD';
    g.lastDiscardCount = 0;
    sendState();
}
 
function resolveRound(callerId) {
    const g = gameState;
    const scores = {};
    g.playerOrder.forEach(id => {
        scores[id] = calcHand(g.players[id].hand);
    });
    const callerScore = scores[callerId];
    const kamoFail = g.playerOrder.some(id => id !== callerId && scores[id] <= callerScore);
    const results = {};
    g.pendingLosers = [];
 
    g.playerOrder.forEach(id => {
        let ptsThisRound = scores[id];
        let badge = '';
        if (kamoFail && id === callerId) {
            ptsThisRound = scores[id] + 20;
            badge = 'KAMO';
            g.extraCards[id] = 1;
        } else if (!kamoFail && id === callerId) {
            ptsThisRound = 0;
            badge = 'WIN';
        } else if (kamoFail && id !== callerId && scores[id] === Math.min(...g.playerOrder.map(x => scores[x]))) {
            ptsThisRound = 0;
            badge = 'WIN';
        }
        g.totals[id] = (g.totals[id] || 0) + ptsThisRound;
        if (g.totals[id] >= g.rules.limit) g.pendingLosers.push(id);
        results[id] = {
            score: scores[id],
            ptsThisRound,
            total: g.totals[id],
            badge,
            hand: g.players[id].hand.filter(x => x),
        };
    });
 
    g.revealData = { caller: callerId, results, kamoFail };
    g.status = g.pendingLosers.length > 0 ? 'GAMEOVER' : 'REVEAL';
    sendState();
}
 
// ── SOCKET EVENTS ──
io.on("connection", (socket) => {
    console.log("Connected:", socket.id);
 
    socket.on("joinGame", ({ name }) => {
        const g = gameState;
        if (g.status !== 'LOBBY') {
            socket.emit('error', 'Spel is al bezig');
            return;
        }
        g.players[socket.id] = { id: socket.id, name: name || "Speler", hand: [] };
        if (!g.playerOrder.includes(socket.id)) g.playerOrder.push(socket.id);
        g.totals[socket.id] = 0;
        g.extraCards[socket.id] = 0;
        if (!g.hostId) g.hostId = socket.id;
        sendState();
    });
 
    socket.on("updateRules", ({ limit, timerVal, strafN, strafT }) => {
        if (socket.id !== gameState.hostId) return;
        gameState.rules = {
            limit: parseInt(limit) || 100,
            timer: parseInt(timerVal) || 0,
            straf: { n: parseInt(strafN) || 5, t: strafT || 'slokken' }
        };
        sendState();
    });
 
    socket.on("startGame", () => {
        const g = gameState;
        if (socket.id !== g.hostId) return;
        if (g.playerOrder.length < 2) {
            socket.emit('error', 'Minimaal 2 spelers nodig');
            return;
        }
        resetRound();
    });
 
    socket.on("discard", ({ indices }) => {
        const g = gameState;
        if (g.status !== 'PLAYING') return;
        if (socket.id !== g.turn) return;
        if (g.roundState !== 'DISCARD') return;
 
        const hand = g.players[socket.id].hand;
        if (!indices || !indices.length) return;
 
        const cards = indices.map(i => hand[i]).filter(Boolean);
        if (!cards.length) return;
 
        // Validate: all same value
        if (!cards.every(c => c.v === cards[0].v)) {
            socket.emit('actionError', 'ALLEEN DEZELFDE KAARTEN!');
            return;
        }
 
        tableStack; // push to tableStack
        g.tableStack.push(...cards);
        g.lastDiscardCount = cards.length;
 
        // Remove from hand
        const sortedDesc = [...indices].sort((a, b) => b - a);
        const firstIdx = Math.min(...indices);
        sortedDesc.forEach(i => {
            if (i === firstIdx) hand[i] = null;
            else hand.splice(i, 1);
        });
 
        g.roundState = 'DRAW';
        sendState();
    });
 
    socket.on("drawFromDeck", () => {
        const g = gameState;
        if (g.status !== 'PLAYING') return;
        if (socket.id !== g.turn) return;
        if (g.roundState !== 'DRAW') return;
 
        if (g.deck.length === 0) g.deck = buildDeck();
        const card = g.deck.pop();
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
 
        g.lastDiscardCount = 0;
        nextTurn();
    });
 
    socket.on("drawFromOpen", () => {
        const g = gameState;
        if (g.status !== 'PLAYING') return;
        if (socket.id !== g.turn) return;
        if (g.roundState !== 'DRAW') return;
 
        const available = g.tableStack.length - g.lastDiscardCount;
        if (available <= 0) {
            socket.emit('actionError', 'PAK VAN HET DECK!');
            return;
        }
        const card = g.tableStack.splice(available - 1, 1)[0];
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
 
        g.lastDiscardCount = 0;
        nextTurn();
    });
 
    socket.on("call", () => {
        const g = gameState;
        if (g.status !== 'PLAYING') return;
        if (socket.id !== g.turn) return;
        if (g.roundState !== 'DISCARD') return;
 
        const score = calcHand(g.players[socket.id].hand);
        if (score > 5) {
            socket.emit('actionError', 'JE HEBT MEER DAN 5 PUNTEN!');
            return;
        }
        resolveRound(socket.id);
    });
 
    socket.on("nextRound", () => {
        const g = gameState;
        if (socket.id !== g.hostId) return;
        if (g.status === 'REVEAL') resetRound();
    });
 
    socket.on("newGame", () => {
        if (socket.id !== gameState.hostId) return;
        // Reset everything except player list
        const g = gameState;
        g.playerOrder.forEach(id => {
            g.totals[id] = 0;
            g.extraCards[id] = 0;
        });
        g.status = 'LOBBY';
        g.revealData = null;
        g.pendingLosers = [];
        sendState();
    });
 
    socket.on("disconnect", () => {
        const g = gameState;
        g.playerOrder = g.playerOrder.filter(id => id !== socket.id);
        delete g.players[socket.id];
        delete g.totals[socket.id];
        delete g.extraCards[socket.id];
        if (g.hostId === socket.id) g.hostId = g.playerOrder[0] || null;
        if (g.status === 'PLAYING' && g.turn === socket.id) nextTurn();
        else sendState();
        console.log("Disconnected:", socket.id);
    });
});
 
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server draait op poort ${PORT}`));
