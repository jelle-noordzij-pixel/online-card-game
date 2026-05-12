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
    console.log("Connectie:", socket.id);

    socket.on("joinGame", (name) => {
        gameState.players[socket.id] = {
            id: socket.id,
            name: name || "Speler",
            hand: [],
            score: 0
        };
        if (!gameState.playerOrder.includes(socket.id)) {
            gameState.playerOrder.push(socket.id);
        }
        io.emit("updateState", gameState);
    });

    socket.on("startGame", () => {
        console.log("SERVER: Starten van het spel...");
        gameState.status = 'PLAYING';
        gameState.deck = buildDeck();
        gameState.tableStack = [gameState.deck.pop()];
        
        gameState.playerOrder.forEach(id => {
            if (gameState.players[id]) {
                gameState.players[id].hand = gameState.deck.splice(0, 5);
            }
        });
        
        gameState.turnIndex = 0;
        // We sturen de VOLLEDIGE state naar IEDEREEN (geen geheimhouding nu, eerst testen of het werkt)
        io.emit("updateState", gameState);
    });

    socket.on("disconnect", () => {
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        io.emit("updateState", gameState);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server draait`));
