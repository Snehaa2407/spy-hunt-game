const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));

const rooms = new Map();
const GAME_DURATION = 180000;

const locations = [
  'Secret Laboratory', 'Casino', 'Space Station', 'Submarine',
  'Bank Vault', 'Embassy', 'Military Base', 'Airport',
  'Museum', 'Hotel', 'Restaurant', 'Hospital',
  'School', 'Theater', 'Beach', 'Mountain Resort'
];

class GameRoom {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.players = new Map();
    this.gameStarted = false;
    this.spies = [];
    this.location = null;
    this.gameTimer = null;
    this.votes = new Map();
  }

  addPlayer(socketId, playerName) {
    this.players.set(socketId, {
      id: socketId,
      name: playerName,
      isSpy: false,
      isAlive: true,
      votedFor: null
    });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  startGame() {
    if (this.players.size < 1) return false;
    
    this.gameStarted = true;
    this.location = locations[Math.floor(Math.random() * locations.length)];
    
    const spyCount = Math.max(1, Math.floor(this.players.size * 0.1));
    const playerIds = Array.from(this.players.keys());
    
    for (let i = 0; i < spyCount; i++) {
      const randomIndex = Math.floor(Math.random() * playerIds.length);
      const spyId = playerIds.splice(randomIndex, 1)[0];
      this.players.get(spyId).isSpy = true;
      this.spies.push(spyId);
    }

    return true;
  }

  vote(voterId, targetId) {
    if (!this.players.has(voterId) || !this.players.has(targetId)) return;
    
    const voter = this.players.get(voterId);
    if (!voter.isAlive) return;
    
    voter.votedFor = targetId;
    this.votes.set(voterId, targetId);
  }

  getVoteResults() {
    const voteCounts = new Map();
    
    for (const [voter, target] of this.votes) {
      if (this.players.get(voter).isAlive) {
        voteCounts.set(target, (voteCounts.get(target) || 0) + 1);
      }
    }

    let maxVotes = 0;
    let eliminated = null;

    for (const [playerId, votes] of voteCounts) {
      if (votes > maxVotes) {
        maxVotes = votes;
        eliminated = playerId;
      }
    }

    return { eliminated, voteCounts };
  }

  getGameState() {
    return {
      roomCode: this.roomCode,
      playerCount: this.players.size,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive
      })),
      gameStarted: this.gameStarted,
      spyCount: this.spies.length
    };
  }
}

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('createRoom', (playerName) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const room = new GameRoom(roomCode);
    room.addPlayer(socket.id, playerName);
    rooms.set(roomCode, room);
    
    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, isHost: true });
    io.to(roomCode).emit('gameState', room.getGameState());
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }

    if (room.gameStarted) {
      socket.emit('error', 'Game already started');
      return;
    }

    if (room.players.size >= 80) {
      socket.emit('error', 'Room is full');
      return;
    }

    room.addPlayer(socket.id, playerName);
    socket.join(roomCode);
    socket.emit('roomJoined', { roomCode, isHost: false });
    io.to(roomCode).emit('gameState', room.getGameState());
  });

  socket.on('startGame', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.startGame()) {
      for (const [playerId, player] of room.players) {
        io.to(playerId).emit('roleAssigned', {
          isSpy: player.isSpy,
          location: player.isSpy ? 'You are a SPY!' : room.location,
          spyCount: room.spies.length
        });
      }

      io.to(roomCode).emit('gameStarted', {
        duration: GAME_DURATION,
        playerCount: room.players.size,
        spyCount: room.spies.length
      });

      room.gameTimer = setTimeout(() => {
        io.to(roomCode).emit('votingPhase');
      }, GAME_DURATION);
    }
  });

  socket.on('vote', ({ roomCode, targetId }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.gameStarted) return;

    room.vote(socket.id, targetId);
    io.to(roomCode).emit('voteUpdate', {
      voterId: socket.id,
      voterName: room.players.get(socket.id).name
    });
  });

  socket.on('endVoting', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const { eliminated, voteCounts } = room.getVoteResults();
    
    let gameResult = 'continue';
    let winner = null;

    if (eliminated) {
      const eliminatedPlayer = room.players.get(eliminated);
      eliminatedPlayer.isAlive = false;

      if (eliminatedPlayer.isSpy) {
        const aliveSpies = room.spies.filter(id => room.players.get(id).isAlive);
        if (aliveSpies.length === 0) {
          gameResult = 'end';
          winner = 'Citizens';
        }
      }
    }

    io.to(roomCode).emit('gameEnd', {
      eliminated: eliminated ? {
        id: eliminated,
        name: room.players.get(eliminated).name,
        wasSpy: room.players.get(eliminated).isSpy
      } : null,
      voteCounts: Array.from(voteCounts.entries()).map(([id, votes]) => ({
        playerId: id,
        playerName: room.players.get(id).name,
        votes
      })),
      spies: room.spies.map(id => ({
        id,
        name: room.players.get(id).name
      })),
      winner,
      location: room.location
    });

    if (room.gameTimer) clearTimeout(room.gameTimer);
  });

  socket.on('disconnect', () => {
    for (const [roomCode, room] of rooms) {
      if (room.players.has(socket.id)) {
        room.removePlayer(socket.id);
        
        if (room.players.size === 0) {
          rooms.delete(roomCode);
        } else {
          io.to(roomCode).emit('gameState', room.getGameState());
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Spy Hunt Game server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
