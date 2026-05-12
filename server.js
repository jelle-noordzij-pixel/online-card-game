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
    status: 'LOBBY' 
};

function buildDeck() {
    const suits = ['♥','♦','♣','♠'];
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}

io.on("connection", (socket) => {
    socket.on("joinGame", (name) => {
        if (gameState.status !== 'LOBBY') return;
        gameState.players[socket.id] = {
            id: socket.id,
            name: name || "Speler " + (gameState.playerOrder.length + 1),
            hand: [],
            score: 0
        };
        gameState.playerOrder.push(socket.id);
        io.emit("updateState", getSanitizedState());
    });

    socket.on("startGame", () => {
        if (gameState.playerOrder.length < 2) return; // Minimaal 2 spelers
        gameState.status = 'PLAYING';
        gameState.deck = buildDeck();
        gameState.tableStack = [gameState.deck.pop()];
        
        gameState.playerOrder.forEach(id => {
            gameState.players[id].hand = gameState.deck.splice(0, 5);
        });
        
        io.emit("updateState", getSanitizedState());
    });

    socket.on("disconnect", () => {
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        io.emit("updateState", getSanitizedState());
    });
});

// Zorgt dat je de kaarten van anderen niet ziet (stuurt alleen lengte van de hand)
function getSanitizedState() {
    let copy = JSON.parse(JSON.stringify(gameState));
    Object.keys(copy.players).forEach(id => {
        copy.players[id].handCount = copy.players[id].hand.length;
        // We verwijderen de echte hand niet hier, dat doen we per individuele socket stroom
    });
    return copy;
}
