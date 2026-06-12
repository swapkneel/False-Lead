const { io } = require("socket.io-client");

const socket = io("http://localhost:5000");

socket.on("connect", () => {
    console.log("Connected:", socket.id);

    socket.emit("room:join", {
        sessionToken: "f88ee5fc-994a-47e5-a3b5-45dda5693a75"
    });
});

socket.on("room:joined", (data) => {
    console.log("ROOM JOINED");
    console.log(data);
});

socket.on("round:created", (data) => {
    console.log("ROUND CREATED");
    console.log(data);
});

socket.on("round:info", (data) => {
    console.log("PRIVATE ROLE");
    console.log(data);

    setTimeout(() => {
  console.log("SENDING READY");
  socket.emit("player:ready");
}, 3000);
});

socket.on("round:created", (data) => {
  console.log("========== ROUND CREATED ==========");
  console.log(data);
});

socket.on("round:info", (data) => {
  console.log("========== PRIVATE ROLE ==========");
  console.log(data);
});

socket.on("error", (data) => {
  console.log("========== ERROR ==========");
  console.log(data);
});

socket.on("ready:update", (data) => {
  console.log("READY UPDATE", data);
});

socket.on("voting:start", (data) => {
  console.log("VOTING START", data);
});

socket.on("round:result", (data) => {
  console.log("ROUND RESULT", data);
});

socket.on("voting:start", () => {
  setTimeout(() => {
    socket.emit("vote:submit", {
      targetPlayerId: 19
    });
  }, 1000);
});