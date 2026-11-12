import { io } from "socket.io-client";

export const apiUrl = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:3002" : "");

export async function createMeeting() {
  let response;
  try {
    response = await fetch(`${apiUrl}/api/meetings`, { method: "POST" });
  } catch {
    throw new Error("Cannot reach the meeting service. Make sure the backend is running, then try again.");
  }
  if (!response.ok) {
    throw new Error(`Meeting creation failed (${response.status}). Please try again.`);
  }
  return response.json();
}

export function connectToMeeting() {
  return io(apiUrl, {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelayMax: 5_000,
  });
}