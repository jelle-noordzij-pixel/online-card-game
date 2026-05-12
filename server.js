socket.on("drawFromOpen", () => {
        const g = gameState;
        if (g.status !== 'PLAYING' || socket.id !== g.turn || g.roundState !== 'DRAW') return;
        
        // Je mag de kaart pakken die er lag VOORDAT de huidige speler gooide
        // De tableStack bevat nu [oude kaarten..., kaarten_net_gegooid]
        const availableIndex = g.tableStack.length - g.lastDiscardCount - 1;
        
        if (availableIndex < 0) {
            return socket.emit('actionError', 'Er ligt geen kaart onder om te pakken!');
        }

        const card = g.tableStack.splice(availableIndex, 1)[0];
        const hand = g.players[socket.id].hand;
        const slot = hand.indexOf(null);
        if (slot !== -1) hand[slot] = card; else hand.push(card);
        
        nextTurn();
    });
