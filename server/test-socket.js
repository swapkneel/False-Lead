console.log("Test socket script started");

const { io } = require("socket.io-client");

const socket = io("http://localhost:5000");

socket.on("connect", () => {
  console.log("Connected:", socket.id);

  socket.emit("room:join", {
    sessionToken: "087a7303-2e14-47ca-bc50-ba1e16b42e02"
  });
});

socket.on("room:joined", (data) => {
  console.log("ROOM JOINED");
  console.log(data);
});

socket.on("lobby:updated", (data) => {
  console.log("LOBBY UPDATED");
  console.log(data);
});

socket.on("connect_error", (err) => {
  console.error("CONNECT ERROR:", err.message);
});