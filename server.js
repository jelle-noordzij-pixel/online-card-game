const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// ── GAME STATE (ROOMS) ──
const rooms = {};       // roomCode -> gameState
const socketRooms = {}; // socket.id -> roomCode

function createGameState(hostId, roomCode) {
    return {
        roomCode,
        players: {},
        playerOrder: [],
        deck: [],
        tableStack: [],
        turnIndex: 0,
        status: 'LOBBY',
        turn: null,
        roundState: 'DISCARD',
        lastActionText: 'Lobby aangemaakt.',
        lastDiscard: { type: null, cards: [], player: null },
        lastDiscardCount: 0,
        extraCards: {},
        totals: {},
        rules: { limit: 100, straf: { n: 5, t: 'slokken' } },
        revealData: null,
        pendingLosers: [],
        hostId: hostId,
    };
}

// ── HELPERS ──
const suits = ['♥', '♦', '♣', '♠'];

function buildDeck() {
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}

function reshuffleDeck(g) {
    const topCard = g.tableStack.pop();
    g.deck = g.tableStack.sort(() => Math.random() - 0.5);
    g.tableStack = [topCard];
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

function cardLabel(v) {
    if (v === 0)  return 'Joker';
    if (v === 1)  return 'A';
    if (v === 11) return 'B';
    if (v === 12) return 'V';
    if (v === 13) return 'H';
    return v;
}

function isStraight(cards) {
    if (cards.length < 3) return false;
    const suit = cards[0].s;
    if (!suit) return false;
    if (!cards.every(c => c.s === suit)) return false;
    const sorted = [...cards].sort((a, b) => a.v - b.v);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].v !== sorted[i-1].v + 1) return false;
    }
    return true;
}

function sendState(g) {
    g.playerOrder.forEach(id => {
        const view = {
            roomCode: g.roomCode,
            playerOrder: g.playerOrder,
            players: {},
            tableStack: g.tableStack,
            turn: g.turn,
            roundState: g.roundState,
            lastActionText: g.lastActionText,
            lastDiscard: g.lastDiscard,
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
            };
        });
        io.to(id).emit('updateState', view);
    });
}

function resetRound(g) {
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
    g.lastDiscard = { type: null, cards: [], player: null };
    g.lastDiscardCount = 0;
    g.lastActionText = 'Ronde gestart!';
    g.status = 'PLAYING';
    g.revealData = null;
    g.pendingLosers = [];
    sendState(g);
}

function nextTurn(g) {
    g.turnIndex = (g.turnIndex + 1) % g.playerOrder.length;
    g.turn = g.playerOrder[g.turnIndex];
    g.roundState = 'DISCARD';
    g.lastDiscardCount = 0;
    sendState(g);
}

function resolveRound(g, callerId) {
    const scores = {};
    g.playerOrder.forEach(id => scores[id] = calcHand(g.players[id].hand));
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
    sendState(g);
}

io.on("connection", (socket) => {
    socket.on("joinGame", ({ name, room }) => {
        let roomCode = room ? room.trim() : null;
        if (!roomCode) {
            do { roomCode = Math.floor(1000 + Math.random() * 9000).toString(); } while (rooms[roomCode]);
            rooms[roomCode] = createGameState(socket.id, roomCode);
        } else if (!rooms[roomCode]) {
            return socket.emit('error', 'Lobby bestaat niet!');
        }

        const g = rooms[roomCode];
        socket.join(roomCode);
        socketRooms[socket.id] = roomCode;
        g.players[socket.id] = { id: socket.id, name: name || "Speler", hand: [] };
        if (!g.playerOrder.includes(socket.id)) g.playerOrder.push(socket.id);
        g.totals[socket.id] = g.totals[socket.id] || 0;
        sendState(g);
    });

    socket.on("updateRules", (rulesData) => {
        const g = rooms[socketRooms[socket.id]];
        if (g && socket.id === g.hostId) {
            g.rules = { limit: parseInt(rulesData.limit), straf: { n: parseInt(rulesData.strafN), t: rulesData.strafT } };
            sendState(g);
        }
    });

    socket.on("startGame", () => {
        const g = rooms[socketRooms[socket.id]];
        if (g && socket.id === g.hostId && g.playerOrder.length >= 2) resetRound(g);
    });

    socket.on("discard", ({ indices }) => {
        const g = rooms[socketRooms[socket.id]];
        if (!g || g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DISCARD') return;

        const hand = g.players[socket.id].hand;
        const cards = indices.map(i => hand[i]).filter(Boolean);
        let type = null;
        if (cards.every(c => c.v === cards[0].v)) type = 'set';
        else if (isStraight(cards)) type = 'straight';
        else return socket.emit('actionError', 'ONGELDIGE COMBINATIE!');

        g.tableStack.push(...cards);
        g.lastDiscardCount = cards.length;
        g.lastDiscard = { type, cards, player: socket.id };
        g.lastActionText = `${g.players[socket.id].name} gooide ${cards.map(c => cardLabel(c.v)+c.s).join(', ')}`;

        const sortedDesc = [...indices].sort((a, b) => b - a);
        const lowestIdx = sortedDesc[sortedDesc.length - 1];
        sortedDesc.forEach(i => { if (i === lowestIdx) hand[i] = null; else hand.splice(i, 1); });

        g.roundState = 'DRAW';
        sendState(g);
    });

    socket.on("drawFromDeck", () => {
        const g = rooms[socketRooms[socket.id]];
        if (!g || g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DRAW') return;

        if (g.deck.length === 0) reshuffleDeck(g);
        const card = g.deck.pop();

        if (g.lastDiscard?.type === 'set' && g.lastDiscard.player === socket.id && card.v === g.lastDiscard.cards[0].v) {
            g.tableStack.push(card);
            g.lastDiscardCount++;
            g.lastActionText = `${g.players[socket.id].name} trok een ${cardLabel(card.v)} en gooide deze direct bij!`;
            return nextTurn(g);
        }

        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        g.lastActionText = `${g.players[socket.id].name} pakte een blinde kaart.`;
        nextTurn(g);
    });

    socket.on("drawFromOpen", () => {
        const g = rooms[socketRooms[socket.id]];
        if (!g || g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DRAW') return;
        const available = g.tableStack.length - g.lastDiscardCount;
        if (available <= 0) return socket.emit('actionError', 'PAK VAN HET DECK!');
        
        const card = g.tableStack.splice(available - 1, 1)[0];
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        g.lastActionText = `${g.players[socket.id].name} pakte van de open stapel.`;
        nextTurn(g);
    });

    socket.on("invallen", ({ index }) => {
        const g = rooms[socketRooms[socket.id]];
        if (!g || g.status !== 'PLAYING') return;
        const hand = g.players[socket.id].hand;
        const c = hand[index];
        if (!c || g.lastDiscard?.type !== 'straight') return;

        const highest = g.lastDiscard.cards.slice().sort((a,b)=>a.v - b.v).pop();
        if (c.s === highest.s && c.v === highest.v + 1) {
            g.tableStack.push(c);
            g.lastDiscard.cards.push(c);
            g.lastDiscardCount++;
            g.lastActionText = `${g.players[socket.id].name} VIEL IN met ${cardLabel(c.v)}${c.s}!`;
            hand.splice(index, 1);
            sendState(g);
        }
    });

    socket.on("call", () => {
        const g = rooms[socketRooms[socket.id]];
        if (g && socket.id === g.turn && calcHand(g.players[socket.id].hand) <= 5) resolveRound(g, socket.id);
    });

    socket.on("nextRound", () => {
        const g = rooms[socketRooms[socket.id]];
        if (g && socket.id === g.hostId && g.status === 'REVEAL') resetRound(g);
    });

    socket.on("newGame", () => {
        const g = rooms[socketRooms[socket.id]];
        if (g && socket.id === g.hostId) {
            g.playerOrder.forEach(id => { g.totals[id] = 0; });
            g.status = 'LOBBY';
            sendState(g);
        }
    });

    socket.on("disconnect", () => {
        const rc = socketRooms[socket.id];
        if (rc && rooms[rc]) {
            const g = rooms[rc];
            g.playerOrder = g.playerOrder.filter(id => id !== socket.id);
            delete g.players[socket.id];
            if (g.playerOrder.length === 0) delete rooms[rc];
            else { if (g.hostId === socket.id) g.hostId = g.playerOrder[0]; sendState(g); }
        }
        delete socketRooms[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server poort ${PORT}`));
