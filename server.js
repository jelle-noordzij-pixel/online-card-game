const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// Game State op de server
let gameState = {
    players: {}, // id: { name: "", hand: [], score: 0 }
    deck: [],
    tableStack: [],
    turn: null,
    state: 'LOBBY' // LOBBY, STARTING, DISCARD, DRAW
};

io.on("connection", (socket) => {
    console.log("Speler verbonden:", socket.id);

    // Als een speler joinen
    socket.on("join", (playerName) => {
        gameState.players[socket.id] = {
            id: socket.id,
            name: playerName,
            hand: [],
            score: 0
        };
        io.emit("updateState", gameState);
    });

    // Start het spel (stuur naar iedereen)
    socket.on("startGame", () => {
        // Hier voeg je later de buildDeck() logica toe op de server
        gameState.state = 'DISCARD';
        io.emit("updateState", gameState);
    });

    socket.on("disconnect", () => {
        delete gameState.players[socket.id];
        io.emit("updateState", gameState);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server live!"));
