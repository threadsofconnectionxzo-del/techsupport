import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';
const MONGODB_URI = process.env.MONGODB_URI;

// Mongoose Schemas
const messageSchema = new mongoose.Schema({
  id: String,
  userId: String,
  text: String,
  timestamp: Number,
  sender: String
});
const MessageModel = mongoose.model('Message', messageSchema);

const sessionSchema = new mongoose.Schema({
  userId: String,
  status: String,
  lastActivity: Number,
  unreadCount: Number,
  isTyping: Boolean,
  hasBeenGreeted: { type: Boolean, default: false }
});
const SessionModel = mongoose.model('Session', sessionSchema);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const httpServer = createServer(app);
  
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log('Connected to MongoDB Atlas');
    } catch (err) {
      console.error('MongoDB connection error:', err);
    }
  } else {
    console.warn('MONGODB_URI is not set. Database operations will fail until it is configured.');
  }

  // Initialize Socket.IO
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Map to store socket.id -> userId
  const userSockets = new Map<string, string>();
  // Map to store userId -> socket.id
  const socketUsers = new Map<string, string>();

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Admin joins to get all history
    socket.on('admin-join', async (token: string) => {
      try {
        jwt.verify(token, JWT_SECRET);
        if (!MONGODB_URI) return socket.emit('admin-error', 'MongoDB not configured');
        
        const sessions = await SessionModel.find().lean();
        const messages = await MessageModel.find().lean();
        
        const chatSessions = sessions.map(s => ({
          ...s,
          messages: messages.filter(m => m.userId === s.userId).sort((a, b) => a.timestamp - b.timestamp)
        }));
        
        socket.emit('admin-sync-sessions', chatSessions);
      } catch (err) {
        socket.emit('admin-error', 'Authentication failed');
      }
    });

    // a) "join-user" -> store userId
    socket.on('join-user', async (userId: string) => {
      userSockets.set(socket.id, userId);
      socketUsers.set(userId, socket.id);
      console.log(`User ${userId} joined with socket ${socket.id}`);
      
      if (!MONGODB_URI) return;

      let session = await SessionModel.findOne({ userId });
      if (!session) {
        session = await SessionModel.create({
          userId,
          status: 'online',
          lastActivity: Date.now(),
          unreadCount: 0,
          isTyping: false,
          hasBeenGreeted: false
        });
      } else {
        await SessionModel.updateOne({ userId }, { status: 'online' });
        session.status = 'online';
      }

      // Notify admin about online status
      io.emit('user-status', { userId, status: 'online' });

      const messages = await MessageModel.find({ userId }).sort({ timestamp: 1 }).lean();

      // Send automated greeting if not already sent
      if (!session.hasBeenGreeted) {
        await SessionModel.updateOne({ userId }, { hasBeenGreeted: true, lastActivity: Date.now() });
        const greetingId = `greeting-${Date.now()}`;
        const timestamp = Date.now();
        
        const greetingMsg = {
          id: greetingId,
          userId: userId,
          text: "Hello! What is your name and how may I assist you today?",
          timestamp,
          sender: 'admin'
        };

        await MessageModel.create(greetingMsg);
        messages.push(greetingMsg);

        // Send to the specific user
        socket.emit('user-reply', greetingMsg);

        // Send to admin so they see the greeting in the chat history
        io.emit('admin-receive-message', greetingMsg);
      }

      // Sync history to user
      socket.emit('user-sync-history', messages);
    });

    // b) "user-message" -> send message to admin
    socket.on('user-message', async (data: { userId: string, text: string, timestamp: number }) => {
      console.log(`Message from ${data.userId}: ${data.text}`);
      if (!MONGODB_URI) return;

      const msg = {
        id: Date.now().toString(),
        userId: data.userId,
        text: data.text,
        timestamp: data.timestamp,
        sender: 'user'
      };

      await MessageModel.create(msg);
      await SessionModel.updateOne(
        { userId: data.userId },
        { lastActivity: data.timestamp, $inc: { unreadCount: 1 } }
      );

      // Broadcast to all admins
      io.emit('admin-receive-message', msg);
    });

    // c) "admin-reply" -> send reply back to specific user using socketId
    socket.on('admin-reply', async (data: { userId: string, text: string, timestamp: number }) => {
      console.log(`Admin reply to ${data.userId}: ${data.text}`);
      if (!MONGODB_URI) return;

      const msg = {
        id: Date.now().toString(),
        userId: data.userId,
        text: data.text,
        timestamp: data.timestamp,
        sender: 'admin'
      };

      await MessageModel.create(msg);
      await SessionModel.updateOne(
        { userId: data.userId },
        { lastActivity: data.timestamp }
      );

      const targetSocketId = socketUsers.get(data.userId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('user-reply', msg);
      }
    });

    // Admin marks messages as read
    socket.on('admin-mark-read', async (userId: string) => {
      if (!MONGODB_URI) return;
      await SessionModel.updateOne({ userId }, { unreadCount: 0 });
    });

    // Extra: Typing indicator
    socket.on('typing', async (data: { userId: string, isTyping: boolean, sender: 'user' | 'admin' }) => {
      if (data.sender === 'user') {
        if (MONGODB_URI) {
          await SessionModel.updateOne({ userId: data.userId }, { isTyping: data.isTyping });
        }
        io.emit('user-typing', { userId: data.userId, isTyping: data.isTyping });
      } else {
        const targetSocketId = socketUsers.get(data.userId);
        if (targetSocketId) {
          io.to(targetSocketId).emit('admin-typing', { isTyping: data.isTyping });
        }
      }
    });

    socket.on('disconnect', async () => {
      console.log(`Socket disconnected: ${socket.id}`);
      const userId = userSockets.get(socket.id);
      if (userId) {
        userSockets.delete(socket.id);
        socketUsers.delete(userId);
        
        if (MONGODB_URI) {
          await SessionModel.updateOne({ userId }, { status: 'offline', isTyping: false });
        }
        
        io.emit('user-status', { userId, status: 'offline' });
        io.emit('user-typing', { userId, isTyping: false });
      }
    });
  });

  app.use(express.json());

  // API routes FIRST
  app.post("/api/admin/login", (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '1d' });
      res.json({ token });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
