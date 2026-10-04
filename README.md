## VMeet video calls

This workspace contains a responsive, browser-based, peer-to-peer video meeting app. Its landing, account, join, and call screens adapt to phone and tablet layouts, with meeting controls and panels sized for touch. A host creates a private room and shares its link; guests join with a display name. Calls support microphone/camera controls, front/rear camera switching on compatible mobile devices, screen sharing, participant status and hand raising, in-call text/emoji/file chat, host mute/remove/lock/co-host controls, and chat/screen-share permissions. Browser echo cancellation and noise suppression are requested for microphone capture. Peer connection statistics drive a basic outgoing-video bitrate adaptation.

### Accounts

The app includes email-and-password registration and login. Accounts are stored in `backend/data/accounts.sqlite`; passwords are hashed with bcrypt, authentication attempts are rate-limited, and sessions use an HTTP-only cookie that lasts up to seven days. Existing meeting creation and joining remain available without signing in.

For production, set a strong random `JWT_SECRET` (at least 32 random bytes) and use HTTPS. The session cookie is marked `Secure` when `NODE_ENV=production`. Local development stores a generated signing key in `backend/data/session.secret` so sessions survive server restarts.

### Run locally

Use Node.js 20 or newer.

1. In `backend`, run `npm install` and then `npm start` (listens on port 3002 by default).
2. In `frontend`, run `npm install` and then `npm run dev` (Vite listens on port 5173).
3. Open `http://localhost:5173`. Microphone and camera access require HTTPS in production (localhost is permitted by browsers).

Set `PORT` and `FRONTEND_ORIGIN` on the signaling server to change its port or allowed web origin. In development, localhost frontend origins are allowed on any port. Set `VITE_API_URL` in the frontend environment to the signaling server URL when it is not `http://localhost:3002`.

### Deployment and limitations

- Meeting rooms, hashed host credentials, lock state, and sharing/chat permissions are stored in `backend/data/accounts.sqlite`. After a server restart, rooms with no active connections get a one-hour reconnect grace period; empty rooms then expire after one hour.
- In-call chat messages and attachments are stored in `backend/data/accounts.sqlite`; the latest 100 messages per room are retained for 30 days and restored when a participant rejoins. Meeting room membership itself remains in memory, so the original room must still be active to rejoin it.
- Peer-to-peer mesh calls are capped at 8 participants. Each participant uploads media directly to every other participant; use an SFU for larger calls, stronger low-bandwidth performance, or server-side recording.
- The default ICE configuration uses a public STUN server only. Production deployments should configure a TURN service with short-lived credentials for restrictive NATs and corporate firewalls. Without TURN, some participants may be unable to connect.
- WebRTC media is encrypted in transit (DTLS-SRTP), but this mesh implementation does not provide separately verified end-to-end identity/key management. Meeting links are bearer invitations, and anyone possessing a link can join unless the host locks the room.
- File chat attachments are relayed through the signaling server and stored with chat history; the server limits individual attachments to 1 MB. No call recording is implemented.
- Browser refresh returns participants to the join screen; the display name and host's room credential are retained in session storage so they can rejoin. A network interruption reconnects the socket and renegotiates peer connections.

### Author

[GitHub profile](https://github.com/srustiyogeshjogalekar)