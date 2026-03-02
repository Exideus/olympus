import { useState, useRef } from 'react';
import type { WarRoomMessage } from '@/lib/war-room/types';

interface Props {
  message: WarRoomMessage;
  isOwnMessage: boolean;
}

const AVATARS: Record<string, { emoji: string; bg: string }> = {
  Juan: { emoji: '👤', bg: 'bg-[rgba(59,130,246,0.25)]' },
  Nathanael: { emoji: '👤', bg: 'bg-[rgba(34,197,94,0.25)]' },
  ARGOS: { emoji: '🔱', bg: 'bg-[rgba(184,150,90,0.25)]' },
  ATLAS: { emoji: '🏛️', bg: 'bg-[rgba(184,150,90,0.25)]' },
  ATHENA: { emoji: '🦉', bg: 'bg-[rgba(139,92,246,0.25)]' },
  HERCULOS: { emoji: '⚙️', bg: 'bg-[rgba(184,150,90,0.25)]' },
  PROMETHEUS: { emoji: '🔥', bg: 'bg-[rgba(245,158,11,0.25)]' },
  APOLLO: { emoji: '🎨', bg: 'bg-[rgba(236,72,153,0.25)]' },
  HERMES: { emoji: '📜', bg: 'bg-[rgba(184,150,90,0.25)]' },
  Claude: { emoji: '🧠', bg: 'bg-[rgba(139,92,246,0.25)]' },
  System: { emoji: '⚙️', bg: 'bg-[rgba(118,122,132,0.25)]' },
};

export function MessageBubble({ message, isOwnMessage }: Props) {
  const avatar = AVATARS[message.sender_name] ?? { emoji: '❓', bg: 'bg-[rgba(118,122,132,0.25)]' };
  const time = new Date(message.created_at).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const isVoiceTranscribed = message.metadata?.voice_transcribed;
  const [isPlaying, setIsPlaying] = useState(false);
  const [showTranscript, setShowTranscript] = useState(true); // Always show text — audio is supplemental, not replacement
  const audioRef = useRef<HTMLAudioElement | null>(null);

  return (
    <div className={`flex gap-2 md:gap-3 px-2 md:px-4 py-1.5 md:py-2 ${isOwnMessage ? 'flex-row-reverse' : ''}`}>
      {/* Avatar — smaller on mobile */}
      <div
        className={`w-8 h-8 md:w-10 md:h-10 rounded-full ${avatar.bg} border border-primary/20 flex items-center justify-center text-base md:text-lg shrink-0`}
      >
        {avatar.emoji}
      </div>

      <div className={`max-w-[85%] md:max-w-[70%] flex flex-col ${isOwnMessage ? 'items-end' : 'items-start'}`}>
        {/* Header: name, model badge, voice badge, time */}
        <div className="flex items-center gap-1.5 md:gap-2 mb-0.5 md:mb-1 flex-wrap">
          <span className="text-[11px] md:text-xs font-mono uppercase tracking-[0.1em] text-text-primary">{message.sender_name}</span>
          {message.metadata?.model_used && (
            <span className="text-[9px] md:text-[10px] px-1 md:px-1.5 py-0.5 rounded bg-[rgba(22,22,32,0.6)] border border-border text-text-muted font-mono hidden sm:inline">
              {message.metadata.model_used}
            </span>
          )}
          {message.metadata?.discussion_summary && (
            <span className="text-[9px] md:text-[10px] px-1 py-0.5 rounded bg-[rgba(139,92,246,0.15)] border border-[rgba(139,92,246,0.3)] text-[rgba(139,92,246,0.9)] font-mono">
              📋 Summary
            </span>
          )}
          {isVoiceTranscribed && (
            <span className="text-[9px] md:text-[10px] px-1 py-0.5 rounded bg-[rgba(184,150,90,0.15)] border border-primary/20 text-primary font-mono">
              🎤
            </span>
          )}
          <span className="text-[9px] md:text-[10px] font-mono text-text-muted">{time}</span>
        </div>

        {/* Bubble */}
        <div
          className={`rounded-xl px-3 py-2 md:px-4 md:py-2.5 ${
            message.sender_type === 'system'
              ? message.metadata?.error
                ? 'bg-[rgba(239,68,68,0.1)] text-error border border-error/20'
                : message.metadata?.event === 'agent_added' || message.content?.includes('was added') || message.content?.includes('created') || message.content?.includes('joined')
                  ? 'bg-[rgba(184,150,90,0.08)] text-primary border border-primary/20'
                  : message.content?.includes('✅') || message.content?.includes('success')
                    ? 'bg-[rgba(34,197,94,0.08)] text-success border border-success/20'
                    : 'bg-[rgba(118,122,132,0.08)] text-text-secondary border border-border/30'
              : isOwnMessage
                ? 'bg-[rgba(184,150,90,0.15)] text-text-primary border border-primary/20'
                : message.sender_type === 'agent'
                  ? 'bg-[rgba(22,22,32,0.6)] text-text-primary border border-border/50'
                  : 'bg-[rgba(22,22,32,0.4)] text-text-primary'
          }`}
        >
          {isVoiceTranscribed && !message.audio_url && (
            <div className="flex items-center gap-1.5 mb-1 text-primary/70">
              <span className="text-sm">🎤</span>
              <span className="text-[10px] font-mono uppercase tracking-[0.1em]">Voice transcription</span>
            </div>
          )}
          
          {/* Transcript text - collapsible when audio exists */}
          {showTranscript && (
            <p className="text-[13px] md:text-sm leading-relaxed whitespace-pre-wrap font-mono">{message.content}</p>
          )}

          {/* Audio player + Transcript toggle */}
          {message.audio_url && (
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => {
                  if (!audioRef.current) {
                    audioRef.current = new Audio(message.audio_url!);
                    audioRef.current.onended = () => setIsPlaying(false);
                    audioRef.current.onerror = () => setIsPlaying(false);
                  }
                  if (isPlaying) {
                    audioRef.current.pause();
                    audioRef.current.currentTime = 0;
                    setIsPlaying(false);
                  } else {
                    audioRef.current.play();
                    setIsPlaying(true);
                  }
                }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[rgba(184,150,90,0.12)] border border-primary/20 text-primary text-[11px] font-mono hover:bg-[rgba(184,150,90,0.2)] transition-colors w-fit"
                title={isPlaying ? 'Stop audio' : 'Play audio'}
              >
                <span className="text-sm">{isPlaying ? '⏹' : '▶️'}</span>
                <span className="uppercase tracking-[0.1em]">{isPlaying ? 'Stop' : 'Play voice'}</span>
              </button>
              
              {/* Transcript toggle link */}
              <button
                onClick={() => setShowTranscript(!showTranscript)}
                className="text-[10px] font-mono text-text-muted hover:text-primary transition-colors w-fit"
              >
                {showTranscript ? 'Transcript ▲' : 'Transcript ▼'}
              </button>
            </div>
          )}
        </div>

        {message.metadata?.routing_reason && (
          <span className="text-[9px] md:text-[10px] font-mono text-text-muted mt-1">{message.metadata.routing_reason}</span>
        )}
      </div>
    </div>
  );
}
