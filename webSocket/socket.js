let io;
exports.init = (server) => {
    io = require('socket.io')(server);
    return io
}
exports.nameSpace=(name)=>{
    io.of(name)
    return io;
}
exports.getIO = () => {
    if (!io) {
        throw new Error('Socket.io not initialized!');
    }
    return io;
}