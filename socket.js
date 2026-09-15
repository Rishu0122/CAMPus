const jwt = require('jsonwebtoken');

/**
 * Attach authenticated Socket.IO handlers to the application socket server.
 * The database connection is passed in so socket events use the same SQLite
 * connection as the HTTP API.
 */
function attachSocket(io, { db, secret, now }) {
  const sockets = new Map();

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) throw new Error('Missing socket token');
      socket.user = jwt.verify(token, secret);
      next();
    } catch (error) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', socket => {
    const userId = socket.user.id;
    const previousSocketId = sockets.get(userId);

    if (previousSocketId && previousSocketId !== socket.id) {
      io.sockets.sockets.get(previousSocketId)?.disconnect(true);
    }

    sockets.set(userId, socket.id);
    socket.join(`user:${userId}`);
    db.prepare('UPDATE users SET online=1,last_seen=? WHERE id=?').run(now(), userId);
    io.emit('presence', { user_id: userId, online: true });

    socket.on('typing', payload => {
      const recipient = Number(payload?.to);
      if (!Number.isInteger(recipient) || recipient <= 0 || recipient === userId) return;
      const blocked = db.prepare(`SELECT 1 FROM user_blocks
        WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)`).get(userId, recipient, recipient, userId);
      if (!blocked) io.to(`user:${recipient}`).emit('typing', { from: userId, typing: Boolean(payload?.typing) });
    });

    socket.on('disconnect', () => {
      if (sockets.get(userId) !== socket.id) return;
      sockets.delete(userId);
      db.prepare('UPDATE users SET online=0,last_seen=? WHERE id=?').run(now(), userId);
      io.emit('presence', { user_id: userId, online: false });
    });
  });

  return sockets;
}

module.exports = { attachSocket };
