const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "battle_game.html"));
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

function makeRoomCode() {
  let code;

  do {
    code = String(
      Math.floor(
        1000 + Math.random() * 9000
      )
    );
  } while (rooms.has(code));

  return code;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  for (const player of room.players) {
    send(player.ws, data);
  }
}

function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id,
    ready: p.ready,
    selections: p.selections
  }));
}

function broadcastRoomState(room) {
  broadcast(room, {
    type: "room_state",
    roomCode: room.code,
    mode: room.mode,
    hostId: room.hostId,
    started: room.started,
    count: room.players.length,
    players: publicPlayers(room)
  });
}

function requiredSelectionCount(mode) {
  return mode === "team3" ? 3 : 1;
}

function canStart(room) {

  if (
    room.mode === "pending" ||
    room.started
  ) {
    return false;
  }

  if (room.mode === "ffa4") {

    if (room.players.length < 2) {
      return false;
    }

  } else {

    if (room.players.length !== 2) {
      return false;
    }
  }

  const need =
    requiredSelectionCount(room.mode);

  return room.players.every(
    p =>
      p.ready &&
      Array.isArray(p.selections) &&
      p.selections.length === need
  );
}

function tryStart(room) {

  if (!canStart(room)) {
    return;
  }

  room.started = true;
  room.actions = {};

  room.alivePlayerIds =
    room.players.map(p => p.id);

  broadcast(room, {
    type: "battle_start",
    mode: room.mode,
    hostId: room.hostId,
    players:
      room.players.map(p => ({
        id: p.id,
        selections: p.selections
      }))
  });
}

wss.on("connection", (ws) => {

  let currentRoom = null;
  let currentPlayer = null;

  ws.on("message", (raw) => {

    let message;

    try {
      message =
        JSON.parse(
          raw.toString()
        );
    } catch {
      return send(ws, {
        type: "error",
        message: "不正な通信データです"
      });
    }

    if (message.type === "create_room") {

      const code =
        makeRoomCode();

      const player = {
        id: crypto.randomUUID(),
        ws,
        selections: [],
        ready: false
      };

      const room = {
        code,
        mode: "pending",
        hostId: player.id,
        players: [player],
        actions: {},
        alivePlayerIds: [player.id],
        started: false
      };

      rooms.set(
        code,
        room
      );

      currentRoom =
        room;

      currentPlayer =
        player;

      send(ws, {
        type: "room_created",
        roomCode: code,
        playerId: player.id,
        hostId: room.hostId,
        mode: room.mode
      });

      broadcastRoomState(room);

      return;
    }

    if (message.type === "join_room") {

      const code =
        String(
          message.roomCode || ""
        ).trim();

      const room =
        rooms.get(code);

      if (!room) {
        return send(ws, {
          type: "error",
          message: "その部屋は存在しません"
        });
      }

      if (room.started) {
        return send(ws, {
          type: "error",
          message: "この部屋はすでに対戦中です"
        });
      }

      if (
        (
          room.mode === "duel" ||
          room.mode === "team3"
        ) &&
        room.players.length >= 2
      ) {
        return send(ws, {
          type: "error",
          message: "このモードは2人までです"
        });
      }

      const player = {
        id: crypto.randomUUID(),
        ws,
        selections: [],
        ready: false
      };

      room.players.push(player);

      currentRoom =
        room;

      currentPlayer =
        player;

      send(ws, {
        type: "room_joined",
        roomCode: code,
        playerId: player.id,
        hostId: room.hostId,
        mode: room.mode
      });

      broadcastRoomState(room);

      return;
    }

    if (message.type === "set_mode") {

      if (
        !currentRoom ||
        !currentPlayer
      ) {
        return;
      }

      if (
        currentPlayer.id !==
        currentRoom.hostId
      ) {
        return send(ws, {
          type: "error",
          message:
            "ゲームモードは部屋を作った人が選択します"
        });
      }

      if (currentRoom.started) {
        return;
      }

      const mode =
        message.mode;

      if (
        ![
          "duel",
          "team3",
          "ffa4"
        ].includes(mode)
      ) {
        return;
      }

      if (
        mode !== "ffa4" &&
        currentRoom.players.length > 2
      ) {
        return send(ws, {
          type: "error",
          message:
            "3人以上いるため、タイマン/3vs3は選べません。乱闘を選んでください"
        });
      }

      currentRoom.mode =
        mode;

      for (
        const p of
        currentRoom.players
      ) {
        p.ready = false;
        p.selections = [];
      }

      broadcast(
        currentRoom,
        {
          type: "mode_set",
          mode,
          hostId:
            currentRoom.hostId
        }
      );

      broadcastRoomState(
        currentRoom
      );

      return;
    }

    if (message.type === "ready") {

      if (
        !currentRoom ||
        !currentPlayer ||
        currentRoom.started
      ) {
        return;
      }

      const need =
        requiredSelectionCount(
          currentRoom.mode
        );

      const selections =
        Array.isArray(
          message.selections
        )
          ? message.selections
          : [];

      if (
        currentRoom.mode ===
        "pending"
      ) {
        return send(ws, {
          type: "error",
          message:
            "先にゲームモードを選択してください"
        });
      }

      if (
        selections.length !== need ||
        selections.some(
          x =>
            !Number.isInteger(x) ||
            x < 0
        )
      ) {
        return send(ws, {
          type: "error",
          message:
            `キャラを${need}人選択してください`
        });
      }

      currentPlayer.selections =
        selections.slice(
          0,
          need
        );

      currentPlayer.ready =
        true;

      broadcast(
        currentRoom,
        {
          type: "ready_state",
          readyCount:
            currentRoom.players
              .filter(p => p.ready)
              .length,
          total:
            currentRoom.players.length,
          players:
            publicPlayers(
              currentRoom
            )
        }
      );

      tryStart(
        currentRoom
      );

      return;
    }

    if (message.type === "action") {

      if (
        !currentRoom ||
        !currentPlayer ||
        !currentRoom.started
      ) {
        return;
      }

      if (
        !currentRoom
          .alivePlayerIds
          .includes(
            currentPlayer.id
          )
      ) {
        return;
      }

      if (
        currentRoom.actions[
          currentPlayer.id
        ]
      ) {
        return;
      }

      currentRoom.actions[
        currentPlayer.id
      ] =
        message.action ||
        { type: "none" };

      broadcast(
        currentRoom,
        {
          type: "action_selected",
          playerId:
            currentPlayer.id,
          selectedCount:
            Object.keys(
              currentRoom.actions
            ).length,
          total:
            currentRoom
              .alivePlayerIds
              .length
        }
      );

      const allSelected =
        currentRoom
          .alivePlayerIds
          .every(
            id =>
              currentRoom.actions[
                id
              ]
          );

      if (allSelected) {

        const actions =
          currentRoom.actions;

        currentRoom.actions =
          {};

        broadcast(
          currentRoom,
          {
            type:
              "all_actions_selected",
            actions
          }
        );
      }

      return;
    }

    if (
      message.type ===
      "battle_state"
    ) {

      if (
        !currentRoom ||
        !currentPlayer ||
        !currentRoom.started
      ) {
        return;
      }

      if (
        currentPlayer.id !==
        currentRoom.hostId
      ) {
        return;
      }

      if (
        !message.battle ||
        typeof message.battle !==
          "object"
      ) {
        return;
      }

      if (
        Array.isArray(
          message.alivePlayerIds
        )
      ) {
        currentRoom
          .alivePlayerIds =
          message.alivePlayerIds;
      }

      broadcast(
        currentRoom,
        {
          type:
            "battle_state",
          battle:
            message.battle,
          alivePlayerIds:
            currentRoom
              .alivePlayerIds
        }
      );

      return;
    }
  });

  ws.on("close", () => {

    if (
      !currentRoom ||
      !currentPlayer
    ) {
      return;
    }

    currentRoom.players =
      currentRoom.players.filter(
        p =>
          p.id !==
          currentPlayer.id
      );

    delete currentRoom.actions[
      currentPlayer.id
    ];

    currentRoom.alivePlayerIds =
      currentRoom
        .alivePlayerIds
        .filter(
          id =>
            id !==
            currentPlayer.id
        );

    if (
      currentRoom.players.length ===
      0
    ) {
      rooms.delete(
        currentRoom.code
      );

      return;
    }

    if (
      currentRoom.hostId ===
      currentPlayer.id
    ) {
      currentRoom.hostId =
        currentRoom.players[0].id;
    }

    broadcast(
      currentRoom,
      {
        type: "player_left",
        playerId:
          currentPlayer.id,
        count:
          currentRoom.players.length,
        hostId:
          currentRoom.hostId
      }
    );

    broadcastRoomState(
      currentRoom
    );
  });

  ws.on(
    "error",
    error => {
      console.error(
        "WebSocketエラー:",
        error
      );
    }
  );
});

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Battle Game Server started on port ${PORT}`
    );
  }
);
