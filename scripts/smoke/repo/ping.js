const net = require("node:net");
const socket = net.connect(6379, "redis", () => { socket.write("PING\r\n"); });
socket.on("data", (data) => { console.log("redis says", data.toString().trim()); socket.end(); });
socket.on("error", (error) => { console.error("redis error", error.message); process.exit(1); });
