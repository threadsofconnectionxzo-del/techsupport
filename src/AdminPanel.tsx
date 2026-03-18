import React, { useState, useEffect, useRef } from 'react';
import { socket } from './socket';
import { Send, User as UserIcon, MessageSquare, Clock, Circle } from 'lucide-react';
import { format } from 'date-fns';

interface Message {
  id: string;
  userId: string;
  text: string;
  timestamp: number;
  sender: 'user' | 'admin';
}

interface ChatSession {
  userId: string;
  messages: Message[];
  status: 'online' | 'offline';
  lastActivity: number;
  unreadCount: number;
  isTyping: boolean;
}

export default function AdminPanel() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('admin_token'));
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [sessions, setSessions] = useState<Map<string, ChatSession>>(new Map());
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const activeUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeUserIdRef.current = activeUserId;
  }, [activeUserId]);

  useEffect(() => {
    if (!token) return;

    socket.connect();

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('admin-join', token);
    });

    socket.on('admin-error', (msg: string) => {
      setLoginError(msg);
      setToken(null);
      localStorage.removeItem('admin_token');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('admin-sync-sessions', (data: ChatSession[]) => {
      setSessions(new Map(data.map(session => [session.userId, session])));
    });

    socket.on('admin-receive-message', (message: Message) => {
      setSessions((prev) => {
        const newSessions = new Map<string, ChatSession>(prev);
        const existingSession = newSessions.get(message.userId);
        
        const session: ChatSession = existingSession ? {
          ...existingSession,
          messages: [...existingSession.messages]
        } : {
          userId: message.userId,
          messages: [],
          status: 'online',
          lastActivity: message.timestamp,
          unreadCount: 0,
          isTyping: false,
        };

        if (!session.messages.some(m => m.id === message.id)) {
          session.messages.push(message);
        }
        
        session.lastActivity = message.timestamp;
        
        if (activeUserIdRef.current !== message.userId && message.sender === 'user') {
          session.unreadCount += 1;
        }

        newSessions.set(message.userId, session);
        return newSessions;
      });
    });

    socket.on('user-status', (data: { userId: string; status: 'online' | 'offline' }) => {
      setSessions((prev) => {
        const newSessions = new Map<string, ChatSession>(prev);
        const existingSession = newSessions.get(data.userId);
        if (existingSession) {
          newSessions.set(data.userId, { ...existingSession, status: data.status });
        } else if (data.status === 'online') {
          // New user connected but hasn't messaged yet
          newSessions.set(data.userId, {
            userId: data.userId,
            messages: [],
            status: 'online',
            lastActivity: Date.now(),
            unreadCount: 0,
            isTyping: false,
          });
        }
        return newSessions;
      });
    });

    socket.on('user-typing', (data: { userId: string; isTyping: boolean }) => {
      setSessions((prev) => {
        const newSessions = new Map<string, ChatSession>(prev);
        const existingSession = newSessions.get(data.userId);
        if (existingSession) {
          newSessions.set(data.userId, { ...existingSession, isTyping: data.isTyping });
        }
        return newSessions;
      });
    });

    return () => {
      socket.off('connect');
      socket.off('admin-error');
      socket.off('disconnect');
      socket.off('admin-sync-sessions');
      socket.off('admin-receive-message');
      socket.off('user-status');
      socket.off('user-typing');
      socket.disconnect();
    };
  }, [token]);

  useEffect(() => {
    if (activeUserId) {
      // Clear unread count when selecting a user
      setSessions((prev) => {
        const newSessions = new Map<string, ChatSession>(prev);
        const session = newSessions.get(activeUserId);
        if (session && session.unreadCount > 0) {
          newSessions.set(activeUserId, { ...session, unreadCount: 0 });
          socket.emit('admin-mark-read', activeUserId);
        }
        return newSessions;
      });
    }
  }, [activeUserId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeUserId, sessions]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeUserId) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      userId: activeUserId,
      text: input,
      timestamp: Date.now(),
      sender: 'admin',
    };

    // Optimistically update UI
    setSessions((prev) => {
      const newSessions = new Map<string, ChatSession>(prev);
      const existingSession = newSessions.get(activeUserId);
      if (existingSession) {
        newSessions.set(activeUserId, {
          ...existingSession,
          messages: [...existingSession.messages, newMessage],
          lastActivity: newMessage.timestamp
        });
      }
      return newSessions;
    });

    // Send to server
    socket.emit('admin-reply', {
      userId: activeUserId,
      text: input,
      timestamp: newMessage.timestamp,
    });

    setInput('');
    socket.emit('typing', { userId: activeUserId, isTyping: false, sender: 'admin' });
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
    if (!activeUserId) return;

    socket.emit('typing', { userId: activeUserId, isTyping: true, sender: 'admin' });

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('typing', { userId: activeUserId, isTyping: false, sender: 'admin' });
    }, 1500);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (res.ok) {
        setToken(data.token);
        localStorage.setItem('admin_token', data.token);
        setLoginError('');
      } else {
        setLoginError(data.error || 'Login failed');
      }
    } catch (err) {
      setLoginError('Network error');
    }
  };

  if (!token) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="w-full max-w-md p-8 bg-white rounded-xl shadow-lg">
          <div className="flex justify-center mb-6">
            <div className="bg-indigo-100 p-3 rounded-full">
              <UserIcon className="w-8 h-8 text-indigo-600" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center text-gray-900 mb-8">Admin Login</h2>
          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Enter admin password"
              />
            </div>
            {loginError && (
              <p className="text-red-500 text-sm">{loginError}</p>
            )}
            <button
              type="submit"
              className="w-full bg-indigo-600 text-white py-2 px-4 rounded-lg hover:bg-indigo-700 transition-colors font-medium"
            >
              Sign In
            </button>
          </form>
        </div>
      </div>
    );
  }

  const activeSession = activeUserId ? sessions.get(activeUserId) : null;
  const sortedSessions = Array.from(sessions.values() as IterableIterator<ChatSession>).sort((a, b) => b.lastActivity - a.lastActivity);

  return (
    <div className="flex h-[calc(100vh-4rem)] max-w-6xl mx-auto bg-white border border-gray-200 shadow-xl rounded-2xl overflow-hidden my-8">
      {/* Sidebar - User List */}
      <div className="w-1/3 border-r border-gray-200 bg-gray-50 flex flex-col">
        <div className="p-4 border-b border-gray-200 bg-white flex justify-between items-center">
          <h2 className="font-semibold text-gray-800 flex items-center">
            <MessageSquare className="mr-2 h-5 w-5 text-indigo-600" />
            Active Chats
          </h2>
          <div className="flex items-center text-xs text-gray-500">
            <Circle className={`h-3 w-3 mr-1 ${isConnected ? 'text-green-500 fill-green-500' : 'text-red-500 fill-red-500'}`} />
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {sortedSessions.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              No active users currently.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {sortedSessions.map((session) => (
                <li 
                  key={session.userId}
                  onClick={() => setActiveUserId(session.userId)}
                  className={`p-4 cursor-pointer hover:bg-indigo-50 transition-colors ${
                    activeUserId === session.userId ? 'bg-indigo-50 border-l-4 border-indigo-600' : 'border-l-4 border-transparent'
                  }`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-center">
                      <div className="relative">
                        <div className="bg-gray-200 p-2 rounded-full mr-3">
                          <UserIcon size={16} className="text-gray-600" />
                        </div>
                        <div className={`absolute bottom-0 right-2 w-3 h-3 rounded-full border-2 border-white ${
                          session.status === 'online' ? 'bg-green-500' : 'bg-gray-400'
                        }`}></div>
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-gray-900 truncate w-32">
                          {session.userId}
                        </h3>
                        <p className="text-xs text-gray-500 flex items-center mt-0.5">
                          <Clock className="w-3 h-3 mr-1" />
                          {format(session.lastActivity, 'HH:mm')}
                        </p>
                      </div>
                    </div>
                    {session.unreadCount > 0 && (
                      <span className="bg-indigo-600 text-white text-xs font-bold px-2 py-1 rounded-full">
                        {session.unreadCount}
                      </span>
                    )}
                  </div>
                  
                  <div className="pl-11 pr-2">
                    {session.isTyping ? (
                      <p className="text-xs text-indigo-600 italic">typing...</p>
                    ) : (
                      <p className="text-xs text-gray-500 truncate">
                        {session.messages.length > 0 
                          ? session.messages[session.messages.length - 1].text 
                          : 'No messages yet'}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-white">
        {activeSession ? (
          <>
            {/* Chat Header */}
            <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-white">
              <div className="flex items-center">
                <div className="bg-indigo-100 p-2 rounded-full mr-3 text-indigo-600">
                  <UserIcon size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-gray-800">{activeSession.userId}</h2>
                  <p className="text-xs text-gray-500">
                    {activeSession.status === 'online' ? 'Online' : 'Offline'}
                  </p>
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 p-6 overflow-y-auto bg-gray-50 space-y-4">
              {activeSession.messages.length === 0 ? (
                <div className="text-center text-gray-400 mt-10 text-sm">
                  No messages in this conversation yet.
                </div>
              ) : (
                activeSession.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.sender === 'admin' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                        msg.sender === 'admin'
                          ? 'bg-indigo-600 text-white rounded-br-sm'
                          : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm'
                      }`}
                    >
                      <p className="text-sm">{msg.text}</p>
                      <p className={`text-[10px] mt-1 text-right ${msg.sender === 'admin' ? 'text-indigo-200' : 'text-gray-400'}`}>
                        {format(msg.timestamp, 'HH:mm')}
                      </p>
                    </div>
                  </div>
                ))
              )}
              
              {activeSession.isTyping && (
                <div className="flex justify-start">
                  <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm flex items-center space-x-1">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 bg-white border-t border-gray-200">
              <form onSubmit={handleSend} className="flex items-center space-x-3">
                <input
                  type="text"
                  value={input}
                  onChange={handleTyping}
                  placeholder={`Reply to ${activeSession.userId}...`}
                  className="flex-1 bg-gray-100 border-transparent focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 rounded-full px-4 py-3 text-sm transition-all outline-none"
                  disabled={!isConnected || activeSession.status === 'offline'}
                />
                <button
                  type="submit"
                  disabled={!input.trim() || !isConnected || activeSession.status === 'offline'}
                  className="bg-indigo-600 text-white p-3 rounded-full hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex-shrink-0"
                >
                  <Send size={20} />
                </button>
              </form>
              {activeSession.status === 'offline' && (
                <p className="text-xs text-red-500 mt-2 text-center">User is offline. Cannot send messages.</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 bg-gray-50">
            <MessageSquare className="w-16 h-16 mb-4 text-gray-300" />
            <p className="text-lg font-medium text-gray-500">Select a conversation</p>
            <p className="text-sm">Choose a user from the sidebar to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
}
