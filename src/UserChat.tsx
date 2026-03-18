import React, { useState, useEffect, useRef } from 'react';
import { socket } from './socket';
import { Send, User as UserIcon, Bot, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

interface Message {
  id: string;
  text: string;
  timestamp: number;
  sender: 'user' | 'admin';
}

export default function UserChat() {
  const [userId] = useState(() => {
    const saved = localStorage.getItem('chat_userId');
    if (saved) return saved;
    const newId = `user_${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem('chat_userId', newId);
    return newId;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isAdminTyping, setIsAdminTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    socket.connect();

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('join-user', userId);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('user-sync-history', (history: Message[]) => {
      setMessages(history);
    });

    socket.on('user-reply', (message: Message) => {
      setMessages((prev) => {
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      });
    });

    socket.on('admin-typing', (data: { isTyping: boolean }) => {
      setIsAdminTyping(data.isTyping);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('user-sync-history');
      socket.off('user-reply');
      socket.off('admin-typing');
      socket.disconnect();
    };
  }, [userId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAdminTyping]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      text: input,
      timestamp: Date.now(),
      sender: 'user',
    };

    // Optimistically add to UI
    setMessages((prev) => [...prev, newMessage]);
    
    // Send to server
    socket.emit('user-message', {
      userId,
      text: input,
      timestamp: newMessage.timestamp,
    });

    setInput('');
    socket.emit('typing', { userId, isTyping: false, sender: 'user' });
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);

    socket.emit('typing', { userId, isTyping: true, sender: 'user' });

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('typing', { userId, isTyping: false, sender: 'user' });
    }, 1500);
  };

  return (
    <div className="flex flex-col h-full max-w-md mx-auto bg-white border border-gray-200 shadow-xl rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="bg-indigo-600 text-white p-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-white/20 p-2 rounded-full">
            <Bot size={20} />
          </div>
          <div>
            <h2 className="font-semibold">Customer Support</h2>
            <div className="flex items-center text-xs text-indigo-100">
              <span className={`w-2 h-2 rounded-full mr-1 ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></span>
              {isConnected ? 'Online' : 'Reconnecting...'}
            </div>
          </div>
        </div>
        <div className="text-xs text-indigo-200">ID: {userId.slice(-4)}</div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 p-4 overflow-y-auto bg-gray-50 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-10 text-sm">
            Send a message to start chatting with support.
          </div>
        )}
        
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                msg.sender === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-sm'
                  : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm'
              }`}
            >
              <p className="text-sm">{msg.text}</p>
              <p className={`text-[10px] mt-1 text-right ${msg.sender === 'user' ? 'text-indigo-200' : 'text-gray-400'}`}>
                {format(msg.timestamp, 'HH:mm')}
              </p>
            </div>
          </div>
        ))}

        {isAdminTyping && (
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

      {/* Input Area */}
      <div className="p-3 bg-white border-t border-gray-100">
        <form onSubmit={handleSend} className="flex items-center space-x-2">
          <input
            type="text"
            value={input}
            onChange={handleTyping}
            placeholder="Type your message..."
            className="flex-1 bg-gray-100 border-transparent focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 rounded-full px-4 py-2 text-sm transition-all outline-none"
            disabled={!isConnected}
          />
          <button
            type="submit"
            disabled={!input.trim() || !isConnected}
            className="bg-indigo-600 text-white p-2 rounded-full hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}
