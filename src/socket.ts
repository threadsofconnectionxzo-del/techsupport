import { io } from 'socket.io-client';

// Connect to the same host that serves the frontend
const URL = window.location.origin;

export const socket = io(URL, {
  autoConnect: false,
});
