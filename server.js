const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// ── SUPABASE CONFIG ──
const SUPABASE_URL = 'https://caossvejzjutuwqsjdxc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-I-ilTRgOdHHcHv2s7rJ7g_ecncNr46'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── GAME STATE ──
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

// ── HELPERS ──
const suits = ['♥', '♦', '♣', '♠'];

async function getPremiumStatus(userId) {
    if (!userId) return false;
    const { data, error } = await supabase
        .from('profiles')
        .select('is_premium')
        .eq('id', userId)
        .single();
    if (error) return false;
    return data?.is_premium || false;
}

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
                hand: pid === id ? g.players[pid].hand : null,
                isPremium: g.players[pid].isPremium || false
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
    g.playerOrder.forEach(id => { scores[id] = calcHand(g.players[id].hand); });
    const callerScore = scores[callerId];
    const kamoFail = g.playerOrder.some(id => id !== callerId && scores[id] <= callerScore);
    const results = {};
    g.pendingLosers = [];

    g.playerOrder.forEach(id => {
        let ptsThisRound = scores[id];
        let badge = '';
        if (kamoFail && id === callerId) { ptsThisRound = scores[id] + 20; badge = 'KAMO'; g.extraCards[id] = 1; }
        else if (!kamoFail && id === callerId) { ptsThisRound = 0; badge = 'WIN'; }
        else if (kamoFail && id !== callerId && scores[id] === Math.min(...g.playerOrder.map(x => scores[x]))) { ptsThisRound = 0; badge = 'WIN'; }
        
        g.totals[id] = (g.totals[id] || 0) + ptsThisRound;
        if (g.totals[id] >= g.rules.limit) g.pendingLosers.push(id);
        results[id] = { score: scores[id], ptsThisRound, total: g.totals[id], badge, hand: g.players[id].hand.filter(x => x) };
    });

    g.revealData = { caller: callerId, results, kamoFail };
    g.status = g.pendingLosers.length > 0 ? 'GAMEOVER' : 'REVEAL';
    sendState();
}

io.on("connection", (socket) => {
    socket.on("joinGame", async ({ name, userId }) => {
        const g = gameState;
        if (g.status !== 'LOBBY') return socket.emit('error', 'Spel is al bezig');
        
        const isPremium = await getPremiumStatus(userId);
        g.players[socket.id] = { id: socket.id, supabaseId: userId, name: name || "Speler", hand: [], isPremium: isPremium };
        
        if (!g.playerOrder.includes(socket.id)) g.playerOrder.push(socket.id);
        g.totals[socket.id] = 0;
        g.extraCards[socket.id] = 0;
        if (!g.hostId) g.hostId = socket.id;
        sendState();
    });

    socket.on("startGame", async () => {
        const g = gameState;
        if (socket.id !== g.hostId) return;
        if (g.playerOrder.length < 2) return socket.emit('error', 'Minimaal 2 spelers nodig');

        const hostPremium = g.players[socket.id].isPremium;
        if (!hostPremium && g.playerOrder.length > 4) {
            return socket.emit('error', 'Gratis limiet: max 4 spelers. De host heeft Premium nodig voor meer!');
        }
        resetRound();
    });

    socket.on("discard", ({ indices }) => {
        const g = gameState;
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DISCARD') return;
        const hand = g.players[socket.id].hand;
        const cards = indices.map(i => hand[i]).filter(c => c);
        if (!cards.length || !cards.every(c => c.v === cards[0].v)) return socket.emit('actionError', 'Ongeldige kaarten!');

        g.tableStack.push(...cards);
        g.lastDiscardCount = cards.length;
        const sortedDesc = [...indices].sort((a, b) => b - a);
        const lowestIdx = sortedDesc[sortedDesc.length - 1];
        sortedDesc.forEach(i => { if (i === lowestIdx) hand[i] = null; else hand.splice(i, 1); });
        g.roundState = 'DRAW';
        sendState();
    });

    socket.on("drawFromDeck", () => {
        const g = gameState;
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DRAW') return;
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
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DRAW') return;
        const available = g.tableStack.length - g.lastDiscardCount;
        if (available <= 0) return socket.emit('actionError', 'Pak van het deck!');
        const card = g.tableStack.splice(available - 1, 1)[0];
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        g.lastDiscardCount = 0;
        nextTurn();
    });

    socket.on("call", () => {
        const g = gameState;
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DISCARD') return;
        if (calcHand(g.players[socket.id].hand) > 5) return socket.emit('actionError', 'Te veel punten om te callen!');
        resolveRound(socket.id);
    });

    socket.on("nextRound", () => { if (socket.id === gameState.hostId && gameState.status === 'REVEAL') resetRound(); });
    socket.on("newGame", () => {
        if (socket.id !== gameState.hostId) return;
        gameState.playerOrder.forEach(id => { gameState.totals[id] = 0; gameState.extraCards[id] = 0; });
        gameState.status = 'LOBBY';
        sendState();
    });

    socket.on("disconnect", () => {
        const g = gameState;
        g.playerOrder = g.playerOrder.filter(id => id !== socket.id);
        delete g.players[socket.id];
        if (g.hostId === socket.id) g.hostId = g.playerOrder[0] || null;
        sendState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
