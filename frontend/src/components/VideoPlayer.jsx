import { useEffect, useRef, useState } from "react";
import { MicOff, Play, Signal, VideoOff } from "lucide-react";

export default function VideoPlayer({ participant, stream, local = false, speaking = false }) {
  const videoRef = useRef(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream || null;
    setPlaybackBlocked(false);
    setPlaybackError(false);
    if (!stream) return undefined;

    let active = true;
    video.play().catch(() => {
      if (active) setPlaybackBlocked(true);
    });
    return () => { active = false; };
  }, [stream]);

  async function startPlayback() {
    try {
      await videoRef.current?.play();
      setPlaybackBlocked(false);
      setPlaybackError(false);
    } catch {
      setPlaybackError(true);
    }
  }

  const displayName = participant.name || "Guest";

  return (
    <article className={`video-tile${speaking ? " speaking" : ""}${local ? " local-tile" : ""}`}>
      {stream && <video
        ref={videoRef}
        className={participant.video ? "" : "audio-only-video"}
        aria-label={`${displayName}${local ? " (You)" : ""} ${participant.video ? "video" : "audio"}`}
        autoPlay
        playsInline
        muted={local}
      />}
      {(!stream || !participant.video) && (
        <div className="video-placeholder"><span className="avatar avatar-large">{displayName.charAt(0).toUpperCase()}</span></div>
      )}
      {playbackBlocked && (
        <button className="playback-prompt" onClick={startPlayback} aria-describedby={playbackError ? `playback-error-${participant.id}` : undefined}>
          <Play size={15} fill="currentColor" /> {participant.video ? "Start playback" : "Enable audio"}
        </button>
      )}
      {playbackError && <span className="playback-error" id={`playback-error-${participant.id}`} role="status">Playback is blocked by your browser.</span>}
      <div className="tile-label">
        <span>{displayName}{local ? " (You)" : ""}{participant.host ? " · Host" : participant.cohost ? " · Co-host" : ""}</span>
        <span className="tile-icons">
          {!participant.audio && <MicOff size={15} aria-label="Microphone off" />}
          {!participant.video && <VideoOff size={15} aria-label="Camera off" />}
          {!local && participant.quality && <Signal size={15} className={`signal-${participant.quality}`} aria-label={`Connection ${participant.quality}`} />}
        </span>
      </div>
      {speaking && <span className="speaking-label">Speaking</span>}
    </article>
  );
}