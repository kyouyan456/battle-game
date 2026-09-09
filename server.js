const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 部屋を保存
const rooms = new Map();

// ゲーム本体を表示
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "battle_game.html"));
});

// サーバー動作確認用
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// 4桁の部屋番号を作成
function makeRoomCode() {
  let code;

  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));

  return code;
}

// 1人にデータ送信
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// 部屋全員に送信
function broadcast(room, data) {
  for (const player of room.players) {
    send(player.ws, data);
  }
}

// 接続
wss.on("connection", (ws) => {
  let currentRoom = null;
  let currentPlayer = null;

  console.log("プレイヤーが接続しました");

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, {
        type: "error",
        message: "不正な通信データです"
      });
      return;
    }

    // =========================
    // 部屋を作る
    // =========================

    if (message.type === "create_room") {
      const code = makeRoomCode();

      const player = {
        id: crypto.randomUUID(),
        ws,
        character: null
      };

      const room = {
        code,
        mode: message.mode || "1v1",
        players: [player],
        actions: {}
      };

      rooms.set(code, room);

      currentRoom = room;
      currentPlayer = player;

      send(ws, {
        type: "room_created",
        roomCode: code,
        playerId: player.id,
        mode: room.mode
      });

      console.log(`部屋 ${code} が作成されました`);
      return;
    }

    // =========================
    // 部屋に参加
    // =========================

    if (message.type === "join_room") {
      const code = String(message.roomCode || "").trim();
      const room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: "error",
          message: "その部屋は存在しません"
        });
        return;
      }

      let maxPlayers = 2;

      if (room.mode === "4ffa") {
        maxPlayers = 4;
      }

      if (room.players.length >= maxPlayers) {
        send(ws, {
          type: "error",
          message: "この部屋は満員です"
        });
        return;
      }

      const player = {
        id: crypto.randomUUID(),
        ws,
        character: null
      };

      room.players.push(player);

      currentRoom = room;
      currentPlayer = player;

      send(ws, {
        type: "room_joined",
        roomCode: code,
        playerId: player.id,
        mode: room.mode
      });

      broadcast(room, {
        type: "player_count",
        count: room.players.length,
        maxPlayers
      });

      console.log(`部屋 ${code} にプレイヤーが参加しました`);
      return;
    }

    // =========================
    // キャラクター選択
    // =========================

    if (message.type === "select_character") {
      if (!currentRoom || !currentPlayer) return;

      currentPlayer.character = message.character;

      broadcast(currentRoom, {
        type: "character_selected",
        playerId: currentPlayer.id,
        character: message.character
      });

      return;
    }

    // =========================
    // 技選択
    // =========================

    if (message.type === "action") {
      if (!currentRoom || !currentPlayer) return;

      currentRoom.actions[currentPlayer.id] = {
        move: message.move,
        target: message.target ?? null
      };

      // 技そのものは相手にはまだ公開しない
      broadcast(currentRoom, {
        type: "action_selected",
        playerId: currentPlayer.id
      });

      // 全員が行動を選択したか
      const allSelected = currentRoom.players.every(
        (player) => currentRoom.actions[player.id]
      );

      if (allSelected) {
        broadcast(currentRoom, {
          type: "all_actions_selected",
          actions: currentRoom.actions
        });

        currentRoom.actions = {};
      }

      return;
    }
  });

  // =========================
  // 切断
  // =========================

  ws.on("close", () => {
    if (!currentRoom || !currentPlayer) return;

    currentRoom.players = currentRoom.players.filter(
      (player) => player.id !== currentPlayer.id
    );

    delete currentRoom.actions[currentPlayer.id];

    if (currentRoom.players.length === 0) {
      rooms.delete(currentRoom.code);

      console.log(`部屋 ${currentRoom.code} を削除しました`);
      return;
    }

    broadcast(currentRoom, {
      type: "player_left",
      playerId: currentPlayer.id,
      count: currentRoom.players.length
    });

    console.log(`部屋 ${currentRoom.code} からプレイヤーが退出しました`);
  });

  ws.on("error", (error) => {
    console.error("WebSocketエラー:", error);
  });
});

// Renderが指定するPORTを使用
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Battle Game Server started on port ${PORT}`);
});
