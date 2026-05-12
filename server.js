const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let gameState = {
    players: {}, // id: { name, hand, score }
    deck: [],
    tableStack: [],
    turn: 0,
    playerOrder: []
};

function buildDeck() {
    const suits = ['♥','♦','♣','♠'];
    let d = [];
    for (let v = 1; v <= 13; v++) for (let s of suits) d.push({ v, s });
    for (let i = 0; i < 3; i++) d.push({ v: 0, s: null });
    return d.sort(() => Math.random() - 0.5);
}

io.on("connection", (socket) => {
    console.log("Nieuwe connectie:", socket.id);

    socket.on("joinGame", (name) => {
        gameState.players[socket.id] = {
            id: socket.id,
            name: name || "Anoniem",
            hand: [],
            score: 0
        };
        gameState.playerOrder.push(socket.id);
        io.emit("updateState", gameState);
    });

    socket.on("startGame", () => {
        gameState.deck = buildDeck();
        gameState.tableStack = [gameState.deck.pop()];
        
        // Deel kaarten uit aan alle verbonden spelers
        Object.keys(gameState.players).forEach(id => {
            gameState.players[id].hand = gameState.deck.splice(0, 5);
        });
        
        gameState.turn = 0;
        io.emit("updateState", gameState);
    });

    socket.on("disconnect", () => {
        delete gameState.players[socket.id];
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        io.emit("updateState", gameState);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server draait op poort ${PORT}`));
