const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require('@supabase/supabase-js');
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/auth.html', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

const SB_URL = process.env.SB_URL || 'https://caossvejzjutuwqsjdxc.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_-I-ilTRgOdHHcHv2s7rJ7g_ecncNr46';
const sb = createClient(SB_URL, SB_KEY);

const rooms = {};
const suits = ['♥', '♦', '♣', '♠'];

// ── GAME HELPERS ──────────────────────────────────────────────────────────────

function buildDeck() {
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null }); // 3 Jokers
    return d.sort(() => Math.random() - 0.5);
}

function calcHand(hand) {
    return hand.filter(x => x).reduce((acc, c) => {
        if (c.v === 0)  return acc;        // Joker  = 0
        if (c.v === 1)  return acc + 1;    // Aas    = 1
        if (c.v === 11) return acc - 1;    // Boer   = -1
        if (c.v >= 12)  return acc + 10;   // V/H    = 10
        return acc + c.v;                  // 2-10   = waarde
    }, 0);
}

function cardPoints(v) {
    if (v === 0)  return 0;
    if (v === 1)  return 1;
    if (v === 11) return -1;
    if (v >= 12)  return 10;
    return v;
}

// ── STATE BROADCASTING ────────────────────────────────────────────────────────

function sendState(roomCode) {
    const g = rooms[roomCode];
    if (!g) return;

    g.playerOrder.forEach(id => {
        const view = {
            status:           g.status,
            playerOrder:      g.playerOrder,
            players:          {},
            tableStack:       g.tableStack,
            turn:             g.turn,
            roundState:       g.roundState,
            lastDiscardCount: g.lastDiscardCount,
            totals:           g.totals,
            rules:            g.rules,
            revealData:       g.revealData,
            hostId:           g.hostId,
            deckCount:        g.deck.length,
            myRoomCode:       roomCode,
        };

        g.playerOrder.forEach(pid => {
            view.players[pid] = {
                name:      g.players[pid].name,
                handCount: g.players[pid].hand.filter(x => x).length,
                // Only send own hand; others see null (hidden)
                hand:      pid === id ? g.players[pid].hand : null,
            };
        });

        io.to(id).emit('updateState', view);
    });
}

function sendError(socketId, msg) {
    io.to(socketId).emit('gameError', msg);
}

// ── ROUND MANAGEMENT ─────────────────────────────────────────────────────────

function startRound(roomCode) {
    const g = rooms[roomCode];
    g.deck = buildDeck();

    g.playerOrder.forEach(id => {
        const count = 5 + (g.extraCards[id] || 0);
        g.players[id].hand = g.deck.splice(0, count);
        g.extraCards[id] = 0;
    });

    g.tableStack       = [g.deck.pop()];
    g.turnIndex        = 0;
    g.turn             = g.playerOrder[0];
    g.roundState       = 'DISCARD';
    g.lastDiscardCount = 0;
    g.status           = 'PLAYING';
    g.revealData       = null;
}

function nextTurn(roomCode) {
    const g = rooms[roomCode];
    g.turnIndex        = (g.turnIndex + 1) % g.playerOrder.length;
    g.turn             = g.playerOrder[g.turnIndex];
    g.roundState       = 'DISCARD';
    g.lastDiscardCount = 0;
    sendState(roomCode);
}

function resolveRound(roomCode, callerId) {
    const g = rooms[roomCode];
    const scores      = {};
    const callerScore = calcHand(g.players[callerId].hand);

    g.playerOrder.forEach(id => { scores[id] = calcHand(g.players[id].hand); });

    // Kamo check: did any OTHER player match or beat the caller?
    const kamoFail = g.playerOrder.some(id => id !== callerId && scores[id] <= callerScore);

    const results  = {};
    const losers   = [];

    g.playerOrder.forEach(id => {
        const s = scores[id];
        let ptsThisRound = s;
        let badge = null;

        if (kamoFail && id === callerId) {
            ptsThisRound     = s + 20;
            badge            = 'KAMO';
            g.extraCards[id] = 1; // Strafkaart: volgende ronde 6 kaarten
        } else if (!kamoFail && id === callerId) {
            ptsThisRound = 0;
            badge        = 'WIN';
        } else if (kamoFail && id !== callerId) {
            // All non-callers pay their own score when caller failed
            ptsThisRound = s;
        }

        g.totals[id] = (g.totals[id] || 0) + ptsThisRound;
        if (g.totals[id] >= g.rules.limit) losers.push(id);

        results[id] = {
            handScore:     s,
            ptsThisRound,
            total:         g.totals[id],
            hand:          g.players[id].hand.filter(x => x),
            badge,
            isLoser:       g.totals[id] >= g.rules.limit,
        };
    });

    g.revealData = { callerId, kamoFail, results, losers };
    g.status     = losers.length > 0 ? 'GAMEOVER' : 'REVEAL';
    sendState(roomCode);
}

// ── SOCKET HANDLERS ───────────────────────────────────────────────────────────

io.on("connection", (socket) => {

    // ── Auth & Room joining ──
    async function getUsername(userId) {
        try {
            const { data, error } = await sb.from('profiles').select('username').eq('id', userId).single();
            if (error) throw error;
            return data.username || "Speler";
        } catch {
            return "Speler";
        }
    }

    function joinPlayerToRoom(socket, code, username) {
        const g = rooms[code];
        if (!g) return;
        socket.join(code);
        socket.roomCode   = code;
        g.players[socket.id] = { id: socket.id, name: username, hand: [] };
        if (!g.playerOrder.includes(socket.id)) g.playerOrder.push(socket.id);
        g.totals[socket.id]    = g.totals[socket.id]    || 0;
        g.extraCards[socket.id] = g.extraCards[socket.id] || 0;
        sendState(code);
    }

    socket.on("createRoom", async ({ userId }) => {
        const username = await getUsername(userId);
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[code] = {
            players: {}, playerOrder: [], deck: [], tableStack: [],
            turnIndex: 0, status: 'LOBBY', turn: null, roundState: 'DISCARD',
            lastDiscardCount: 0, extraCards: {}, totals: {},
            rules: { limit: 100, straf: { n: 5, t: 'slokken' } },
            revealData: null, hostId: socket.id,
        };
        joinPlayerToRoom(socket, code, username);
    });

    socket.on("joinRoom", async ({ code, userId }) => {
        const g = rooms[code];
        if (!g)                          return sendError(socket.id, 'Code niet gevonden!');
        if (g.status !== 'LOBBY')        return sendError(socket.id, 'Spel is al bezig!');
        if (g.playerOrder.length >= 6)   return sendError(socket.id, 'Kamer is vol!');
        const username = await getUsername(userId);
        joinPlayerToRoom(socket, code, username);
    });

    socket.on("setRules", ({ limit, strafN, strafT }) => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.hostId || g.status !== 'LOBBY') return;
        g.rules = { limit: parseInt(limit) || 100, straf: { n: parseInt(strafN) || 5, t: strafT || 'slokken' } };
        sendState(socket.roomCode);
    });

    socket.on("startGame", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.hostId) return;
        if (g.playerOrder.length < 2)     return sendError(socket.id, 'Minimaal 2 spelers nodig!');
        startRound(socket.roomCode);
        sendState(socket.roomCode);
    });

    // ── Gameplay ──
    socket.on("discard", ({ indices }) => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.turn || g.roundState !== 'DISCARD') return;

        const hand  = g.players[socket.id].hand;
        const cards = indices.map(i => hand[i]).filter(c => c);

        if (cards.length === 0) return sendError(socket.id, 'Geen geldige kaarten!');
        if (!cards.every(c => c.v === cards[0].v))
            return sendError(socket.id, 'ALLEEN DEZELFDE KAARTEN!');

        // Push cards to table
        g.tableStack.push(...cards);
        g.lastDiscardCount = cards.length;

        // Remove from hand: set first to null (keep slot), splice the rest
        const sorted = [...indices].sort((a, b) => b - a);
        const first  = Math.min(...indices);
        sorted.forEach(i => {
            if (i === first) hand[i] = null;
            else hand.splice(i, 1);
        });

        g.roundState = 'DRAW';
        sendState(socket.roomCode);
    });

    socket.on("drawFromDeck", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.turn || g.roundState !== 'DRAW') return;

        if (g.deck.length === 0) g.deck = buildDeck();
        const card = g.deck.pop();
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);

        nextTurn(socket.roomCode);
    });

    socket.on("drawFromOpen", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.turn || g.roundState !== 'DRAW') return;

        // Available = everything BEFORE own discards
        const available = g.tableStack.length - g.lastDiscardCount;
        if (available <= 0) return sendError(socket.id, 'Geen kaart beschikbaar — pak van het deck!');

        const card = g.tableStack.splice(available - 1, 1)[0]; // remove that specific card
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);

        g.lastDiscardCount = 0;
        nextTurn(socket.roomCode);
    });

    socket.on("call", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.turn || g.roundState !== 'DISCARD') return;
        if (calcHand(g.players[socket.id].hand) > 5)
            return sendError(socket.id, 'Je hebt meer dan 5 punten — je kunt niet callen!');
        resolveRound(socket.roomCode, socket.id);
    });

    socket.on("nextRound", () => {
        const g = rooms[socket.roomCode];
        if (!g || socket.id !== g.hostId || g.status !== 'REVEAL') return;
        startRound(socket.roomCode);
        sendState(socket.roomCode);
    });

    // ── Disconnect ──
    socket.on("disconnect", () => {
        const code = socket.roomCode;
        const g    = rooms[code];
        if (!g) return;

        g.playerOrder = g.playerOrder.filter(id => id !== socket.id);
        delete g.players[socket.id];

        if (g.playerOrder.length === 0) {
            delete rooms[code];
            return;
        }

        // If host left, assign new host
        if (g.hostId === socket.id) g.hostId = g.playerOrder[0];

        // If it was this player's turn, advance
        if (g.status === 'PLAYING' && g.turn === socket.id) {
            g.turnIndex = g.turnIndex % g.playerOrder.length;
            g.turn      = g.playerOrder[g.turnIndex];
            g.roundState = 'DISCARD';
        }

        sendState(code);
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('Drankspel server draait op poort', process.env.PORT || 3000);
});
