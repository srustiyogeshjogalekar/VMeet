import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Check, Copy, File, Hand, Link2, Lock, LogOut, MessageCircle,
  Mic, MicOff, MonitorUp, MoreHorizontal, Paperclip, Send, Settings2,
  Shield, Signal, UserPlus, Users, Video, VideoOff, X,
} from "lucide-react";
import VideoPlayer from "../components/VideoPlayer";
import { connectToMeeting } from "../services/socket";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const MAX_FILE_BYTES = 1_000_000;
const CHAT_EMOJIS = ["😊", "😂", "😍", "🥳", "🎉", "❤️", "👍", "👎", "👏", "🙏", "🔥", "🤔", "👀", "💯", "😢", "😮"];

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export default function MeetingRoom() {
  const { roomId = "" } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState(() => sessionStorage.getItem(`vmeet-name:${roomId}`) || "");
  const [callRequest, setCallRequest] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [localStream, setLocalStream] = useState(null);
  const [selfId, setSelfId] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [permissions, setPermissions] = useState({ screenShare: true, chat: true });
  const [locked, setLocked] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [panel, setPanel] = useState("people");
  const [notice, setNotice] = useState("");
  const [joinError, setJoinError] = useState("");
  const [joining, setJoining] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [copied, setCopied] = useState(false);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnections = useRef(new Map());
  const pendingCandidates = useRef(new Map());
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  const chatEndRef = useRef(null);
  const selfIdRef = useRef("");
  const audioEnabledRef = useRef(true);
  const videoEnabledRef = useRef(true);
  const hostToken = sessionStorage.getItem(`vmeet-host:${roomId}`) || "";
  const shareLink = useMemo(() => `${window.location.origin}/room/${roomId}`, [roomId]);

  const updateSelf = useCallback((updates) => {
    const socket = socketRef.current;
    if (socket?.connected) socket.emit("participant:update", updates);
    const id = selfIdRef.current;
    if (id) setParticipants((current) => current.map((person) => person.id === id ? { ...person, ...updates } : person));
  }, []);

  useEffect(() => {
    if (!connected) return undefined;
    const id = window.setInterval(() => setCallSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(id);
  }, [connected]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, panel]);

  useEffect(() => () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenTrackRef.current?.stop();
  }, []);

  useEffect(() => {
    if (permissions.screenShare || !sharingScreen || isHost) return;
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    replaceOutgoingVideo(cameraTrackRef.current).catch((error) => setNotice(`Could not stop screen sharing: ${error.message}`));
    setSharingScreen(false);
    setLocalStream(new MediaStream(localStreamRef.current?.getTracks() || []));
    updateSelf({ video: videoEnabledRef.current });
  }, [isHost, permissions.screenShare, sharingScreen, updateSelf]);

  useEffect(() => {
    if (!callRequest || !localStreamRef.current) return undefined;

    const socket = connectToMeeting();
    socketRef.current = socket;
    let disposed = false;
    let joinedOnce = false;
    const mediaContext = window.AudioContext ? new AudioContext() : null;
    const activeLocalStream = localStreamRef.current;
    let speakingInterval;
    let statsInterval;

    const closePeer = (id) => {
      const peer = peerConnections.current.get(id);
      if (peer) peer.close();
      peerConnections.current.delete(id);
      pendingCandidates.current.delete(id);
      setRemoteStreams((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    };

    const connectPeer = (participantId, initiateOffer) => {
      if (!participantId || participantId === selfIdRef.current || peerConnections.current.has(participantId)) return;
      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnections.current.set(participantId, peer);
      const tracks = localStreamRef.current?.getTracks() || [];
      for (const track of tracks) peer.addTrack(track, localStreamRef.current);
      for (const kind of ["audio", "video"]) {
        if (!tracks.some((track) => track.kind === kind)) peer.addTransceiver(kind, { direction: "sendrecv" });
      }
      peer.onicecandidate = (event) => {
        if (event.candidate) socket.emit("signal", { to: participantId, candidate: event.candidate });
      };
      peer.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        setRemoteStreams((current) => ({ ...current, [participantId]: stream }));
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") peer.restartIce();
      };
      if (initiateOffer) {
        peer.createOffer()
          .then((offer) => peer.setLocalDescription(offer))
          .then(() => socket.emit("signal", { to: participantId, description: peer.localDescription }))
          .catch((error) => setNotice(`Could not connect to a participant: ${error.message}`));
      }
    };

    const joinRoom = () => {
      if (!socket.connected) return;
      if (joinedOnce) {
        peerConnections.current.forEach((peer) => peer.close());
        peerConnections.current.clear();
        pendingCandidates.current.clear();
        setRemoteStreams({});
      }
      socket.emit("room:join", { roomId, name: callRequest.name, hostToken }, (response) => {
        if (disposed) return;
        if (response?.error) {
          setJoinError(response.error);
          setConnected(false);
          socket.disconnect();
          return;
        }
        joinedOnce = true;
        selfIdRef.current = response.selfId;
        setSelfId(response.selfId);
        setIsHost(response.host);
        setParticipants(response.participants);
        setPermissions(response.permissions);
        setLocked(response.locked);
        setChatMessages(response.chatHistory || []);
        setConnected(true);
        setJoinError("");
        socket.emit("participant:update", {
          audio: audioEnabledRef.current,
          video: videoEnabledRef.current,
        });
        response.participants
          .filter((person) => person.id !== response.selfId)
          .forEach((person) => connectPeer(person.id, true));
      });
    };

    const onSignal = async ({ from, description, candidate }) => {
      if (!from) return;
      connectPeer(from, false);
      const peer = peerConnections.current.get(from);
      if (!peer) return;
      try {
        if (description) {
          await peer.setRemoteDescription(description);
          const queued = pendingCandidates.current.get(from) || [];
          for (const queuedCandidate of queued) await peer.addIceCandidate(queuedCandidate);
          pendingCandidates.current.delete(from);
          if (description.type === "offer") {
            await peer.setLocalDescription(await peer.createAnswer());
            socket.emit("signal", { to: from, description: peer.localDescription });
          }
        } else if (candidate) {
          if (peer.remoteDescription) await peer.addIceCandidate(candidate);
          else pendingCandidates.current.set(from, [...(pendingCandidates.current.get(from) || []), candidate]);
        }
      } catch (error) {
        setNotice(`A connection could not be negotiated: ${error.message}`);
      }
    };

    socket.on("connect", joinRoom);
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (error) => setNotice(`Signaling connection failed: ${error.message}`));
    socket.on("signal", onSignal);
    socket.on("participant:joined", (person) => {
      setParticipants((current) => current.some((item) => item.id === person.id) ? current : [...current, person]);
      connectPeer(person.id, false);
    });
    socket.on("participant:left", (id) => {
      closePeer(id);
      setParticipants((current) => current.filter((person) => person.id !== id));
    });
    socket.on("room:participants", setParticipants);
    socket.on("participant:role", ({ participantId, cohost }) => {
      setParticipants((current) => current.map((person) => person.id === participantId ? { ...person, cohost } : person));
    });
    socket.on("room:permissions", setPermissions);
    socket.on("room:locked", setLocked);
    socket.on("room:chat", (message) => setChatMessages((current) => [...current, message].slice(-100)));
    socket.on("room:chat:error", ({ error }) => setNotice(error));
    socket.on("moderation:mute", () => {
      localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
      audioEnabledRef.current = false;
      setAudioEnabled(false);
      updateSelf({ audio: false });
      setNotice("The host muted your microphone.");
    });
    socket.on("moderation:removed", () => {
      setNotice("You were removed from the meeting.");
      socket.disconnect();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      window.setTimeout(() => navigate("/"), 1_200);
    });
    socket.on("room:ended", () => {
      setEnded(true);
      setConnected(false);
      setCallRequest(null);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    });

    socket.connect();

    if (mediaContext && activeLocalStream.getAudioTracks().length) {
      const analyser = mediaContext.createAnalyser();
      analyser.fftSize = 512;
      const source = mediaContext.createMediaStreamSource(activeLocalStream);
      source.connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      let lastSpeaking = false;
      speakingInterval = window.setInterval(() => {
        analyser.getByteFrequencyData(samples);
        const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
        const speaking = audioEnabledRef.current && average > 18;
        if (speaking !== lastSpeaking) {
          lastSpeaking = speaking;
          updateSelf({ speaking });
        }
      }, 300);
    }

    statsInterval = window.setInterval(async () => {
      for (const [participantId, peer] of peerConnections.current) {
        if (peer.connectionState !== "connected") continue;
        try {
          const stats = await peer.getStats();
          let quality = "good";
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime > 0.4) {
              quality = "fair";
            }
            if (report.type === "remote-inbound-rtp" && report.fractionLost > 0.08) quality = "poor";
          });
          const senders = peer.getSenders();
          for (const sender of senders) {
            if (sender.track?.kind !== "video") continue;
            const parameters = sender.getParameters();
            if (!parameters.encodings?.length) parameters.encodings = [{}];
            parameters.encodings[0].maxBitrate = quality === "poor" ? 250_000 : quality === "fair" ? 650_000 : 1_200_000;
            await sender.setParameters(parameters);
          }
          setParticipants((current) => current.map((person) => person.id === participantId ? { ...person, quality } : person));
          socket.emit("participant:update", { quality });
        } catch (error) {
          console.warn("Could not read peer connection quality.", error);
        }
      }
    }, 4_000);

    return () => {
      disposed = true;
      window.clearInterval(speakingInterval);
      window.clearInterval(statsInterval);
      mediaContext?.close().catch((error) => console.warn("Could not close audio context.", error));
      socket.removeAllListeners();
      socket.disconnect();
      peerConnections.current.forEach((peer) => peer.close());
      peerConnections.current.clear();
      pendingCandidates.current.clear();
      socketRef.current = null;
    };
  }, [callRequest, hostToken, navigate, roomId, updateSelf]);

  async function enterMeeting(event) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setJoinError("Enter your name to join the meeting.");
      return;
    }
    setJoining(true);
    setJoinError("");
    sessionStorage.setItem(`vmeet-name:${roomId}`, cleanName);
    const stream = new MediaStream();
    let gotAudio = false;
    let gotVideo = false;
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
      gotAudio = true;
    } catch (error) {
      setNotice(`Microphone unavailable (${error.name || "permission denied"}). You can still join without audio.`);
    }
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const track = videoStream.getVideoTracks()[0];
      if (track) {
        stream.addTrack(track);
        cameraTrackRef.current = track;
        gotVideo = true;
      }
    } catch (error) {
      setNotice(`Camera unavailable (${error.name || "permission denied"}). You can still join without video.`);
    }
    localStreamRef.current = stream;
    audioEnabledRef.current = gotAudio;
    videoEnabledRef.current = gotVideo;
    setAudioEnabled(gotAudio);
    setVideoEnabled(gotVideo);
    setLocalStream(stream);
    setCallRequest({ name: cleanName });
    setJoining(false);
  }

  async function toggleAudio() {
    const next = !audioEnabledRef.current;
    if (next && !localStreamRef.current?.getAudioTracks().length) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        const track = stream.getAudioTracks()[0];
        localStreamRef.current.addTrack(track);
        for (const peer of peerConnections.current.values()) {
          const transceiver = peer.getTransceivers().find((item) => item.receiver.track.kind === "audio");
          if (transceiver) await transceiver.sender.replaceTrack(track);
        }
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        setNotice("");
      } catch (error) {
        setNotice(`Could not enable microphone: ${error.message}`);
        return;
      }
    }
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
    audioEnabledRef.current = next;
    setAudioEnabled(next);
    updateSelf({ audio: next });
  }

  async function toggleVideo() {
    const next = !videoEnabledRef.current;
    if (next && !cameraTrackRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
        const track = stream.getVideoTracks()[0];
        localStreamRef.current.addTrack(track);
        cameraTrackRef.current = track;
        await replaceOutgoingVideo(track);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        setNotice("");
      } catch (error) {
        setNotice(`Could not enable camera: ${error.message}`);
        return;
      }
    }
    cameraTrackRef.current && (cameraTrackRef.current.enabled = next);
    videoEnabledRef.current = next;
    setVideoEnabled(next);
    updateSelf({ video: sharingScreen || next });
  }

  async function switchCamera() {
    if (sharingScreen) return;
    try {
        const nextFacing = cameraTrackRef.current?.getSettings().facingMode === "user" ? "environment" : "user";
      const freshStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: nextFacing }, width: { ideal: 1280 } },
      });
      const freshTrack = freshStream.getVideoTracks()[0];
      const oldTrack = cameraTrackRef.current;
      await replaceOutgoingVideo(freshTrack);
      if (oldTrack) {
        localStreamRef.current.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localStreamRef.current.addTrack(freshTrack);
      cameraTrackRef.current = freshTrack;
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
      setNotice("");
    } catch (error) {
      setNotice(`Could not switch camera: ${error.message}`);
    }
  }

  async function replaceOutgoingVideo(track) {
    for (const peer of peerConnections.current.values()) {
      const videoTransceiver = peer.getTransceivers().find((item) => item.receiver.track.kind === "video");
      if (videoTransceiver) await videoTransceiver.sender.replaceTrack(track);
      else if (track) peer.addTrack(track, new MediaStream([track]));
    }
  }

  async function toggleScreenShare() {
    if (sharingScreen) {
      const screenTrack = screenTrackRef.current;
      screenTrack?.stop();
      screenTrackRef.current = null;
      await replaceOutgoingVideo(cameraTrackRef.current);
      setSharingScreen(false);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
      updateSelf({ video: videoEnabledRef.current });
      return;
    }
    if (!permissions.screenShare && !isHost && !selfParticipant.cohost) {
      setNotice("The host has disabled screen sharing.");
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      const track = display.getVideoTracks()[0];
      screenTrackRef.current = track;
      await replaceOutgoingVideo(track);
      setSharingScreen(true);
      setLocalStream(new MediaStream([...localStreamRef.current.getAudioTracks(), track]));
      updateSelf({ video: true });
      track.onended = () => {
        if (screenTrackRef.current !== track) return;
        screenTrackRef.current = null;
        replaceOutgoingVideo(cameraTrackRef.current).catch((error) => setNotice(`Could not restore camera: ${error.message}`));
        setSharingScreen(false);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        updateSelf({ video: videoEnabledRef.current });
      };
    } catch (error) {
      if (error.name !== "NotAllowedError") setNotice(`Could not share your screen: ${error.message}`);
    }
  }

  function sendMessage(event) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    const socket = socketRef.current;
    if (!socket?.connected) {
      setNotice("You're not connected to the meeting. Your message wasn't sent.");
      return;
    }
    setChatSending(true);
    socket.timeout(5_000).emit("room:chat", { text }, (timeoutError, response) => {
      setChatSending(false);
      if (timeoutError) {
        setNotice("Your message could not be sent. Check your connection and try again.");
      } else if (response?.error) {
        setNotice(response.error);
      } else {
        setNotice("");
        setChatText((current) => current === text ? "" : current);
      }
    });
  }

  async function attachFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setNotice("Files must be 1 MB or smaller.");
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) {
      setNotice("You're not connected to the meeting. Your attachment wasn't sent.");
      return;
    }
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("File could not be read."));
        reader.readAsDataURL(file);
      });
      socket.timeout(5_000).emit("room:chat", { file: { name: file.name, data } }, (timeoutError, response) => {
        if (timeoutError) setNotice("Your attachment could not be sent. Check your connection and try again.");
        else if (response?.error) setNotice(response.error);
        else setNotice("");
      });
    } catch (error) {
      setNotice(`Could not attach file: ${error.message}`);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      setNotice(`Could not copy the invite link: ${error.message}`);
    }
  }

  async function leaveMeeting() {
    if (isHost && socketRef.current?.connected) {
      await new Promise((resolve) => {
        socketRef.current.timeout(1_000).emit("moderation:end", (error) => resolve(error));
      });
    }
    socketRef.current?.disconnect();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    sessionStorage.removeItem(`vmeet-host:${roomId}`);
    navigate("/");
  }

  function setMeetingLock() {
    socketRef.current?.emit("moderation:lock", { locked: !locked });
  }

  function setPermission(permission) {
    socketRef.current?.emit("moderation:permissions", { [permission]: !permissions[permission] });
  }

  const selfParticipant = participants.find((person) => person.id === selfId) || {
    id: selfId,
    name: callRequest?.name || name,
    host: isHost,
    audio: audioEnabled,
    video: videoEnabled || sharingScreen,
    speaking: false,
  };
  const remoteParticipants = participants.filter((person) => person.id !== selfId);
  const videoParticipants = [selfParticipant, ...remoteParticipants];

  if (ended) {
    return <main className="ended-screen"><span className="brand-mark"><Video size={20} /></span><h1>This meeting has ended</h1><p>The host ended the call for everyone.</p><button className="primary-button" onClick={() => navigate("/")}>Back to VMeet</button></main>;
  }

  if (!callRequest) {
    return (
      <main className="join-shell">
        <header className="home-nav"><a className="brand" href="/"><span className="brand-mark"><Video size={20} /></span>vmeet</a><span className="secure-note"><Lock size={14} /> Secure meeting link</span></header>
        <section className="join-card">
          <div className="join-icon"><Video size={24} /></div>
          <span className="eyebrow">YOU'RE INVITED</span>
          <h1>Join the conversation</h1>
          <p>Meeting code <strong>{roomId}</strong></p>
          <form onSubmit={enterMeeting}>
            <label className="field-label" htmlFor="display-name">Your name</label>
            <input id="display-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Alex Morgan" maxLength={60} autoComplete="name" />
            <button className="primary-button join-submit" type="submit" disabled={joining}>{joining ? "Checking your devices…" : "Join meeting"}<ArrowLeft className="join-arrow" size={17} /></button>
          </form>
          {joinError && <p className="form-error" role="alert">{joinError}</p>}
          {notice && <p className="permission-note" role="status">{notice}</p>}
          <span className="device-note">Your browser may ask for microphone and camera access.</span>
        </section>
      </main>
    );
  }

  return (
    <main className="call-shell">
      <header className="call-header">
        <a className="brand" href="/" aria-label="VMeet home"><span className="brand-mark"><Video size={18} /></span>vmeet</a>
        <div className="room-meta"><span className={`connection-indicator${connected ? "" : " offline"}`} />{connected ? "Connected" : "Reconnecting…"}<span className="meta-divider" /><span>{formatDuration(callSeconds)}</span><span className="meta-divider" /><span className="room-code">Meeting {roomId}</span></div>
        <button className="invite-button" onClick={() => setShowInvite(true)}><UserPlus size={16} /> Invite</button>
      </header>
      {notice && <div className="notice-banner" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={16} /></button></div>}
      {joinError && <div className="notice-banner error-banner" role="alert">{joinError}</div>}
      <section className={`call-body${panel ? " has-panel" : ""}`}>
        <div className="stage-column">
          <div className="stage-topline"><div><span className="live-indicator" /> LIVE MEETING</div><span>{participants.length}/8 participants</span></div>
          <div className={`video-grid grid-${Math.min(videoParticipants.length, 4)}`}>
            <VideoPlayer participant={{ ...selfParticipant, audio: audioEnabled, video: videoEnabled || sharingScreen, speaking: selfParticipant.speaking }} stream={localStream} local speaking={selfParticipant.speaking} />
            {remoteParticipants.map((person) => remoteStreams[person.id] && <VideoPlayer key={person.id} participant={person} stream={remoteStreams[person.id]} speaking={person.speaking} />)}
            {remoteParticipants.filter((person) => !remoteStreams[person.id]).map((person) => (
              <VideoPlayer key={person.id} participant={person} stream={null} speaking={person.speaking} />
            ))}
          </div>
          <div className="control-bar">
            <div className="control-group">
              <button className={`control-button${audioEnabled ? "" : " control-off"}`} onClick={toggleAudio} title={audioEnabled ? "Mute microphone" : "Unmute microphone"} aria-label={audioEnabled ? "Mute microphone" : "Unmute microphone"}>{audioEnabled ? <Mic size={20} /> : <MicOff size={20} />}</button>
              <button className={`control-button${videoEnabled ? "" : " control-off"}`} onClick={toggleVideo} title={videoEnabled ? "Turn camera off" : "Turn camera on"} aria-label={videoEnabled ? "Turn camera off" : "Turn camera on"}>{videoEnabled ? <Video size={20} /> : <VideoOff size={20} />}</button>
              <button className={`control-button${sharingScreen ? " control-active" : ""}`} onClick={toggleScreenShare} title="Share screen" aria-label="Share screen"><MonitorUp size={20} /></button>
              <button className="control-button" onClick={switchCamera} disabled={sharingScreen || !videoEnabled} title="Switch front/rear camera" aria-label="Switch camera"><Settings2 size={19} /></button>
              <button className={`control-button${selfParticipant.handRaised ? " control-active" : ""}`} onClick={() => updateSelf({ handRaised: !selfParticipant.handRaised })} title="Raise hand" aria-label="Raise hand"><Hand size={19} /></button>
            </div>
            <div className="control-group secondary-controls">
              <button className={`control-button${panel === "people" ? " control-active" : ""}`} onClick={() => setPanel(panel === "people" ? "" : "people")} title="Participants" aria-label="Participants"><Users size={19} /><span>{participants.length}</span></button>
              <button className={`control-button${panel === "chat" ? " control-active" : ""}`} onClick={() => setPanel(panel === "chat" ? "" : "chat")} title="Chat" aria-label="Chat"><MessageCircle size={19} /></button>
              <button className="leave-button" onClick={leaveMeeting} title={isHost ? "End meeting for everyone" : "Leave meeting"} aria-label={isHost ? "End meeting for everyone" : "Leave meeting"}><LogOut size={18} /><span>{isHost ? "End" : "Leave"}</span></button>
            </div>
          </div>
          <div className="stage-footer"><span><Shield size={14} /> Calls are encrypted in transit</span><button onClick={() => setShowInvite(true)}><Link2 size={14} /> Copy invite link</button></div>
        </div>
        {panel && (
          <aside className="side-panel">
            <div className="panel-heading">
              <div><strong>{panel === "people" ? "People" : "In-call messages"}</strong><span>{panel === "people" ? `${participants.length} in this meeting` : "Messages are visible to everyone"}</span></div>
              <button className="icon-button" onClick={() => setPanel("")} aria-label="Close panel"><X size={18} /></button>
            </div>
            {panel === "people" ? (
              <>
                <button className="panel-invite" onClick={() => setShowInvite(true)}><UserPlus size={17} /> Invite someone</button>
                {isHost && <div className="host-tools">
                  <div className="host-tools-title"><Shield size={15} /> Host controls</div>
                  <button className="setting-row" onClick={setMeetingLock}><span><Lock size={15} /> Lock meeting</span><span className={`toggle-switch${locked ? " on" : ""}`} /></button>
                  <button className="setting-row" onClick={() => setPermission("screenShare")}><span><MonitorUp size={15} /> Allow screen sharing</span><span className={`toggle-switch${permissions.screenShare ? " on" : ""}`} /></button>
                  <button className="setting-row" onClick={() => setPermission("chat")}><span><MessageCircle size={15} /> Allow chat</span><span className={`toggle-switch${permissions.chat ? " on" : ""}`} /></button>
                </div>}
                <div className="participant-list">
                  {[selfParticipant, ...remoteParticipants].map((person) => (
                    <div className="participant-row" key={person.id}>
                      <span className="avatar participant-avatar">{person.name?.charAt(0)?.toUpperCase()}</span>
                      <div className="participant-info"><strong>{person.name}{person.id === selfId ? " (You)" : ""}</strong><span>{person.host ? "Host" : person.cohost ? "Co-host" : person.speaking ? "Speaking" : person.handRaised ? "✋ Hand raised" : "In the meeting"}</span></div>
                      <div className="participant-status">{person.audio ? <Mic size={15} /> : <MicOff size={15} />}<Signal size={15} className={`signal-${person.quality || "good"}`} /></div>
                      {(isHost || selfParticipant.cohost) && person.id !== selfId && !person.host && <details className="participant-menu"><summary aria-label={`Actions for ${person.name}`}><MoreHorizontal size={18} /></summary><div className="menu-popover"><button onClick={() => socketRef.current?.emit("moderation:mute", { participantId: person.id })}><MicOff size={14} /> Mute</button>{isHost && <button onClick={() => socketRef.current?.emit("moderation:cohost", { participantId: person.id, cohost: !person.cohost })}><Shield size={14} /> {person.cohost ? "Remove co-host" : "Make co-host"}</button>}<button className="danger-action" onClick={() => socketRef.current?.emit("moderation:remove", { participantId: person.id })}><X size={14} /> Remove</button></div></details>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="chat-feed">
                  {chatMessages.length === 0 && <div className="chat-empty"><MessageCircle size={26} /><span>No messages yet</span><small>Say hello to everyone in the meeting.</small></div>}
                  {chatMessages.map((message) => <article className={`chat-message${message.senderId === selfId ? " own-message" : ""}`} key={message.id}>
                    <div className="message-byline"><strong>{message.senderName}</strong><time>{new Date(message.sentAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>
                    {message.text && <p>{message.text}</p>}
                    {message.file && <a className="file-attachment" href={message.file.data} download={message.file.name}><File size={16} /><span>{message.file.name}</span></a>}
                  </article>)}
                  <div ref={chatEndRef} />
                </div>
                <form className="chat-compose" onSubmit={sendMessage}>
                  {!permissions.chat && !isHost && !selfParticipant.cohost ? <p>The host has disabled chat.</p> : <>
                    <textarea aria-label="Write a message" value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Send a message…" maxLength={5000} rows={2} disabled={chatSending} />
                    <div className="compose-actions"><label className="attach-button" title="Attach a file"><Paperclip size={17} /><input type="file" onChange={attachFile} /></label><div className="emoji-buttons" aria-label="Quick emojis">{CHAT_EMOJIS.map((emoji) => <button key={emoji} type="button" aria-label={`Add ${emoji}`} title={`Add ${emoji}`} disabled={chatSending} onClick={() => setChatText((value) => `${value}${value ? " " : ""}${emoji}`)}>{emoji}</button>)}</div><button className="send-button" type="submit" disabled={!chatText.trim() || chatSending} aria-label="Send message"><Send size={17} /></button></div>
                    <span className="file-hint">Share a file up to 1 MB</span>
                  </>}
                </form>
              </>
            )}
          </aside>
        )}
      </section>
      {showInvite && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowInvite(false); }}>
        <section className="invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title">
          <button className="icon-button modal-close" onClick={() => setShowInvite(false)} aria-label="Close"><X size={19} /></button>
          <div className="join-icon"><UserPlus size={22} /></div>
          <h2 id="invite-title">Invite people</h2>
          <p>Anyone with this link can join while the meeting is unlocked.</p>
          <div className="invite-link"><span>{shareLink}</span><button onClick={copyInvite}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? "Copied" : "Copy"}</button></div>
          <span className="invite-footnote"><Lock size={14} /> {locked ? "Meeting is locked" : "Keep your invite link private"}</span>
        </section>
      </div>}
    </main>
  );
}